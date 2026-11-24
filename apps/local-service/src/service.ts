import type { Server, Socket } from 'node:net';
import { ChannelService, RunSupervisor, TaskService, type AdapterFactory, type CredentialPort } from '@paldock/application';
import {
  ClientFrame,
  CodedError,
  CommandArgs,
  SCHEMA_VERSION,
  type CommandName,
  type EphemeralEvent,
  type ErrorCode,
  type PersistentEvent,
  type RuntimeAdapter,
  type ServerFrame,
} from '@paldock/contracts';
import { acquirePidLock, listenIpc, readFrames, serializeFrame, tokensEqual, writeFrame } from '@paldock/platform';
import { P1_DEFAULTS, type P2Limits } from '@paldock/domain';
import { CodexAdapter } from '@paldock/runtime-codex';
import { openStore, type Store } from '@paldock/storage-sqlite';
import { createAdapter, systemCredentials } from './channels.js';
import { createHandlers, type Handlers } from './commands.js';

export const SERVICE_VERSION = '0.2.0-p2';
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
  /** 执行器适配器；缺省为按环境变量 PALDOCK_CODEX_PATH 或 PATH 查找的 Codex。 */
  runtime?: RuntimeAdapter;
  /** 覆盖占位默认值（测试用）。 */
  limits?: ConstructorParameters<typeof RunSupervisor>[0]['limits'];
  /** 外部渠道的适配器工厂、凭据库与默认值；缺省为飞书/Telegram 适配器与系统凭据库（测试注入假的）。 */
  channels?: { createAdapter?: AdapterFactory; credentials?: CredentialPort; limits?: Partial<P2Limits> };
}

type Outcome = { value: unknown } | { error: { code: ErrorCode; message: string } };

const eventFrames = (events: PersistentEvent[]) =>
  events.map((event) => serializeFrame({ kind: 'event', event } satisfies ServerFrame)).join('');

/**
 * 本地服务：持有唯一的数据库写连接，经本机 IPC 接收命令并广播持久事件。
 * 连接后的第一帧必须是带正确令牌的 hello，否则断开。
 */
export class LocalService {
  private readonly clients = new Set<Socket>();
  private server: Server | undefined;

  private handlers!: Handlers;
  private supervisor!: RunSupervisor;
  private channels!: ChannelService;

  private constructor(
    private readonly store: Store,
    private readonly token: string,
    private readonly releaseLock: () => void,
    readonly interruptedRuns: number,
    private readonly log: (message: string) => void,
  ) {}

  static async start(options: ServiceOptions): Promise<LocalService> {
    const { dataRoot, ipcPath, token, log = () => {} } = options;
    const lock = acquirePidLock(dataRoot);
    if (!lock.acquired) throw new DataRootLockedError(lock.holderPid);
    try {
      const store = await openStore(dataRoot);
      // 启动时没有任何执行器连接：未结束的 Run 一律中断，由用户在「待我处理」里选择恢复、重新开始或放弃
      const interruptedRuns = store.interruptActiveWork('服务重启').interruptedRuns.length;
      const service = new LocalService(store, token, lock.release, interruptedRuns, log);
      const runtime =
        options.runtime ??
        new CodexAdapter({
          ...(process.env.PALDOCK_CODEX_PATH ? { configuredPath: process.env.PALDOCK_CODEX_PATH } : {}),
          cancelWaitMs: P1_DEFAULTS.cancelWaitForTurnMs,
        });
      // 持久事件同时送给管理窗口和外部渠道（从外部建的任务的进度、审批处理结果）
      const publish = (events: PersistentEvent[]) => {
        service.broadcast(events);
        service.channels.onEvents(events);
      };
      service.supervisor = new RunSupervisor({
        store,
        runtime,
        dataRoot,
        publish,
        publishEphemeral: (event) => service.broadcastEphemeral(event),
        log,
        ...(options.limits ? { limits: options.limits } : {}),
      });
      const tasks = new TaskService({ store, supervisor: service.supervisor, dataRoot, publish });
      service.channels = new ChannelService({
        store,
        tasks,
        credentials: options.channels?.credentials ?? systemCredentials,
        createAdapter: options.channels?.createAdapter ?? createAdapter,
        publish,
        publishEphemeral: (event) => service.broadcastEphemeral(event),
        log,
        ...(options.channels?.limits ? { limits: options.channels.limits } : {}),
      });
      service.handlers = createHandlers(store, tasks, service.channels, {
        version: SERVICE_VERSION,
        startedAt: new Date().toISOString(),
        interruptedRuns,
        runtime: runtime.name,
      });
      service.supervisor.start();
      service.channels.start();
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

      const id = frame.id;
      void this.execute(frame.name, frame.args).then((result) =>
        'error' in result
          ? send({ kind: 'result', id, ok: false, error: result.error })
          : send({ kind: 'result', id, ok: true, value: result.value ?? null }),
      );
    }, (error) => drop(error.message));
  }

  private async execute(name: CommandName, rawArgs: unknown): Promise<Outcome> {
    const args = CommandArgs[name].safeParse(rawArgs ?? {});
    if (!args.success) return { error: { code: 'bad_request', message: args.error.issues[0]?.message ?? '参数错误' } };
    try {
      return { value: await (this.handlers[name] as (a: unknown) => unknown)(args.data) };
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

  /** 临时事件（流式输出片段）只发给当前在线的客户端，不入库、不重放。 */
  private broadcastEphemeral(event: EphemeralEvent): void {
    const text = serializeFrame({ kind: 'ephemeral', event } satisfies ServerFrame);
    for (const client of this.clients) client.write(text);
  }

  /** 桌面状态由 Electron 主进程经控制通道送来。 */
  setPresence(presence: { locked: boolean; idle: boolean }): void {
    this.channels.setPresence({ uiRunning: true, ...presence });
  }

  /** 正常退出：先停渠道（不再接收外部消息），再结束执行器进程树，让未结束的 Run 进入 interrupted 并落库，最后关闭连接、数据库和锁。 */
  async stop(): Promise<void> {
    await this.channels.stop();
    await this.supervisor.stop();
    this.broadcast(this.store.interruptActiveWork('应用退出').events);
    for (const client of this.clients) client.end();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.store.close();
    this.releaseLock();
  }
}
