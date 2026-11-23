import { connect, type Socket } from 'node:net';
import {
  SCHEMA_VERSION,
  ServerFrame,
  type CommandArgsOf,
  type CommandName,
  type ErrorCode,
  type PersistentEvent,
} from '@paldock/contracts';
import { readFrames, writeFrame } from './ipc.js';

export class IpcCommandError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * 本机 IPC 客户端（Electron 主进程使用）。记录最后收到的持久事件序号，
 * 重连时带上 afterSeq 由服务端补发，保证断线期间的事件不丢；connect() 在补发完成后才返回。
 */
export class IpcClient {
  private socket: Socket | undefined;
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  lastSeq = 0;

  constructor(
    private readonly path: string,
    private readonly token: string,
    private readonly onEvent: (event: PersistentEvent) => void,
    private readonly client = 'desktop-main',
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.path);
      this.socket = socket;
      socket.once('error', reject);
      socket.once('connect', () => {
        writeFrame(socket, { kind: 'hello', schemaVersion: SCHEMA_VERSION, token: this.token, client: this.client, afterSeq: this.lastSeq });
      });
      socket.on('close', () => this.failPending(new Error('IPC 连接已断开')));
      readFrames(
        socket,
        (raw) => {
          const parsed = ServerFrame.safeParse(raw);
          if (!parsed.success) return socket.destroy();
          const frame = parsed.data;
          if (frame.kind === 'welcome') {
            socket.off('error', reject);
            resolve();
          } else if (frame.kind === 'event') {
            this.lastSeq = Math.max(this.lastSeq, frame.event.seq);
            this.onEvent(frame.event);
          } else if (frame.kind === 'result') {
            const pending = this.pending.get(frame.id);
            this.pending.delete(frame.id);
            if (frame.ok) pending?.resolve(frame.value);
            else pending?.reject(new IpcCommandError(frame.error.code, frame.error.message));
          }
        },
        () => socket.destroy(),
      );
    });
  }

  request<N extends CommandName>(name: N, args: CommandArgsOf<N>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error('IPC 未连接'));
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      writeFrame(socket, { kind: 'command', id, name, args });
    });
  }

  /** 等连接真正关闭后再返回，之后不会再收到任何事件。 */
  close(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.resolve();
    return new Promise((resolve) => socket.destroy().once('close', () => resolve()));
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
