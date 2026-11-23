import type { Server, Socket } from 'node:net';
import {
  ClientFrame,
  CodedError,
  CommandArgs,
  SCHEMA_VERSION,
  type CommandName,
  type ErrorCode,
  type PersistentEvent,
  type ServerFrame,
} from '@paldock/contracts';
import { acquirePidLock, listenIpc, readFrames, serializeFrame, tokensEqual, writeFrame } from '@paldock/platform';
import { interruptActiveWork, openStore, type Store } from '@paldock/storage-sqlite';
import { createHandlers, type CommandOutcome, type Handlers } from './commands.js';

export const SERVICE_VERSION = '0.0.0-p0';
const HELLO_TIMEOUT_MS = 5_000;
const REPLAY_BATCH = 500;

export class DataRootLockedError extends Error {
  constructor(readonly holderPid: number) {
    super(`数据根已被进程 ${holderPid} 占用`);
  }
}

export interface ServiceOptions {
  dataRoot: string;
  ipcPath: string;
  token: string;
  log?: (message: string) => void;
}

type Failure = { error: { code: ErrorCode; message: string } };

const eventFrames = (events: PersistentEvent[]) =>
  events.map((event) => serializeFrame({ kind: 'event', event } satisfies ServerFrame)).join('');

/**
 * 本地服务：持有唯一的数据库写连接，经本机 IPC 接收命令并广播持久事件。
 * 连接后的第一帧必须是带正确令牌的 hello，否则断开。
 */
export class LocalService {
  private readonly clients = new Set<Socket>();
  private server: Server | undefined;

  private constructor(
    private readonly store: Store,
    private readonly handlers: Handlers,
    private readonly token: string,
    private readonly releaseLock: () => void,
    readonly interruptedRuns: number,
    private readonly log: (message: string) => void,
  ) {}

  static async start({ dataRoot, ipcPath, token, log = () => {} }: ServiceOptions): Promise<LocalService> {
    const lock = acquirePidLock(dataRoot);
    if (!lock.acquired) throw new DataRootLockedError(lock.holderPid);
    try {
      const store = await openStore(dataRoot);
      const interruptedRuns = interruptActiveWork(store.db, store.events, '服务重启').interruptedRuns.length;
      const handlers = createHandlers(store, { version: SERVICE_VERSION, startedAt: new Date().toISOString(), interruptedRuns });
      const service = new LocalService(store, handlers, token, lock.release, interruptedRuns, log);
      service.server = await listenIpc(ipcPath, (socket) => service.accept(socket));
      log(`migration v${store.migration.from}→v${store.migration.to}, interrupted runs: ${interruptedRuns}`);
      return service;
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  private accept(socket: Socket): void {
    let authed = false;
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    const send = (frame: ServerFrame) => writeFrame(socket, frame);
    const drop = (reason: string) => {
      this.log(`ipc client dropped: ${reason}`);
      socket.destroy();
    };

    socket.on('close', () => {
      clearTimeout(helloTimer);
      this.clients.delete(socket);
    });
    socket.on('error', () => socket.destroy());

    readFrames(socket, (raw) => {
      const parsed = ClientFrame.safeParse(raw);
      if (!parsed.success) return drop('invalid frame');
      const frame = parsed.data;

      if (!authed) {
        if (frame.kind !== 'hello' || !tokensEqual(this.token, frame.token)) return drop('unauthorized');
        authed = true;
        clearTimeout(helloTimer);
        // 先补发断线期间的事件，welcome 表示「已追上」；补发与加入广播集合之间没有 await，不会漏发或重复
        if (frame.afterSeq !== undefined) this.replay(socket, frame.afterSeq);
        send({ kind: 'welcome', schemaVersion: SCHEMA_VERSION, serviceVersion: SERVICE_VERSION, headSeq: this.store.events.headSeq() });
        this.clients.add(socket);
        return;
      }
      if (frame.kind !== 'command') return drop('duplicate hello');

      const result = this.execute(frame.name, frame.args);
      if ('error' in result) return send({ kind: 'result', id: frame.id, ok: false, error: result.error });
      this.broadcast(result.events);
      send({ kind: 'result', id: frame.id, ok: true, value: result.value });
    }, (error) => drop(error.message));
  }

  private execute(name: CommandName, rawArgs: unknown): CommandOutcome | Failure {
    const args = CommandArgs[name].safeParse(rawArgs ?? {});
    if (!args.success) return { error: { code: 'bad_request', message: args.error.issues[0]?.message ?? '参数错误' } };
    try {
      return (this.handlers[name] as (a: unknown) => CommandOutcome)(args.data);
    } catch (error) {
      if (error instanceof CodedError) return { error: { code: error.code, message: error.message } };
      // 不把内部错误细节（可能含路径或 SQL）返回给客户端
      this.log(`command ${name} failed: ${(error as Error).name}`);
      return { error: { code: 'internal', message: '内部错误' } };
    }
  }

  /** 按批读取并一次写出整批，减少系统调用。 */
  private replay(socket: Socket, afterSeq: number): void {
    for (let seq = afterSeq; ; ) {
      const batch = this.store.events.since(seq, REPLAY_BATCH);
      if (batch.length > 0) socket.write(eventFrames(batch));
      if (batch.length < REPLAY_BATCH) return;
      seq = batch.at(-1)!.seq;
    }
  }

  /** 每批事件只序列化一次，再写给所有客户端。 */
  private broadcast(events: PersistentEvent[]): void {
    if (events.length === 0) return;
    const text = eventFrames(events);
    for (const client of this.clients) client.write(text);
  }

  /** 正常退出：先让未结束的 Run 进入 interrupted 并落库，再关闭连接、数据库和锁。 */
  async stop(): Promise<void> {
    this.broadcast(interruptActiveWork(this.store.db, this.store.events, '应用退出').events);
    for (const client of this.clients) client.end();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.store.close();
    this.releaseLock();
  }
}
