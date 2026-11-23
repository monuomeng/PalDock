import { connect, type Socket } from 'node:net';
import {
  CodedError,
  SCHEMA_VERSION,
  ServerFrame,
  type CommandArgsOf,
  type CommandName,
  type PersistentEvent,
} from '@paldock/contracts';
import { readFrames, writeFrame } from './ipc.js';
import { PendingRequests } from './pending-requests.js';

/**
 * 本机 IPC 客户端（Electron 主进程使用）。同一个实例可在服务重启后用新的管道名和令牌重连：
 * 它记住最后收到的持久事件序号，重连时由服务端先补发断线期间的事件，connect() 返回时已追上。
 * 首次连接不补发历史，从服务端告知的 headSeq 开始。
 */
export class IpcClient {
  private socket: Socket | undefined;
  private readonly pending = new PendingRequests();
  private lastSeq: number | undefined;

  constructor(private readonly onEvent: (event: PersistentEvent) => void) {}

  connect(path: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      this.socket = socket;
      socket.once('error', reject);
      socket.once('connect', () => {
        const resume = this.lastSeq === undefined ? {} : { afterSeq: this.lastSeq };
        writeFrame(socket, { kind: 'hello', schemaVersion: SCHEMA_VERSION, token, client: 'desktop-main', ...resume });
      });
      socket.on('close', () => this.pending.rejectAll(new Error('IPC 连接已断开')));
      readFrames(
        socket,
        (raw) => {
          const parsed = ServerFrame.safeParse(raw);
          if (!parsed.success) return socket.destroy();
          const frame = parsed.data;
          if (frame.kind === 'welcome') {
            this.lastSeq ??= frame.headSeq;
            socket.off('error', reject);
            resolve();
          } else if (frame.kind === 'event') {
            this.lastSeq = Math.max(this.lastSeq ?? 0, frame.event.seq);
            this.onEvent(frame.event);
          } else if (frame.kind === 'result') {
            if (frame.ok) this.pending.resolve(frame.id, frame.value);
            else this.pending.reject(frame.id, new CodedError(frame.error.code, frame.error.message));
          }
        },
        () => socket.destroy(),
      );
    });
  }

  request<N extends CommandName>(name: N, args: CommandArgsOf<N>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error('IPC 未连接'));
    return this.pending.add((id) => writeFrame(socket, { kind: 'command', id, name, args }));
  }

  /** 等连接真正关闭后再返回，之后不会再收到任何事件。 */
  close(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.resolve();
    return new Promise((resolve) => socket.destroy().once('close', () => resolve()));
  }
}
