import type { Server, Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { AgentService, ChannelService, CoordinatorService, IntegrationService, RecoveryService, GitOpsService, McpGateway, PlanService, ReviewGate, RunSupervisor, TaskGraphScheduler, TaskService, type McpCaller, type AdapterFactory, type CredentialPort } from '@paldock/application';
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
import { acquirePidLock, listenIpc, nodeRuntimeEnv, readFrames, serializeFrame, tokensEqual, writeFrame } from '@paldock/platform';
import { P1_DEFAULTS, type P2Limits } from '@paldock/domain';
import { ClaudeAdapter } from '@paldock/runtime-claude';
import { CodexAdapter } from '@paldock/runtime-codex';
import { openStore, type Store } from '@paldock/storage-sqlite';
import { createAdapter, systemCredentials } from './channels.js';
import { createHandlers, type Handlers } from './commands.js';

export const SERVICE_VERSION = '0.3.6-p3';
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
  /**
   * 只用这一个执行器（测试、离线模拟）；缺省时 Codex 与 Claude 都接入，各角色按设置选用。
   * Codex 按 PALDOCK_CODEX_PATH 或 PATH 查找；Claude 按 PALDOCK_CLAUDE_PATH、PATH、常见安装位置和桌面版自带的那份查找。
   */
  runtime?: RuntimeAdapter;
  /** 按名字（codex、claude）指定多个执行器（测试用离线模拟），各角色按设置选用；优先于 runtime。 */
  runtimes?: Record<string, RuntimeAdapter>;
  /** 覆盖占位默认值（测试用）。 */
  limits?: ConstructorParameters<typeof RunSupervisor>[0]['limits'];
  /** 协调助手唤醒循环的限额（测试用）。 */
  coordinatorLimits?: ConstructorParameters<typeof CoordinatorService>[0]['limits'];
  /** 外部渠道的适配器工厂、凭据库与默认值；缺省为飞书/Telegram 适配器与系统凭据库（测试注入假的）。 */
  channels?: { createAdapter?: AdapterFactory; credentials?: CredentialPort; limits?: Partial<P2Limits> };
}

type Outcome = { value: unknown } | { error: { code: ErrorCode; message: string } };

/** MCP 桥脚本（src/ 与 dist/ 下都按包根定位）；执行器用本进程的 Node（Electron 下以 Node 模式）运行它。 */
const MCP_BRIDGE_PATH = fileURLToPath(new URL('../bridge/mcp-bridge.mjs', import.meta.url));

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
  private mcp!: McpGateway;
  private scheduler!: TaskGraphScheduler;
  private gate!: ReviewGate;
  private integration!: IntegrationService;
  private coordinator!: CoordinatorService;
  private plans!: PlanService;

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
      const recoveryReport = store.interruptActiveWork('服务重启');
      const interruptedRuns = recoveryReport.interruptedRuns.length;
      const service = new LocalService(store, token, lock.release, interruptedRuns, log);
      const runtimes: Record<string, RuntimeAdapter> = options.runtimes ??
        (options.runtime
        ? { [options.runtime.name]: options.runtime }
        : {
            codex: new CodexAdapter({
              ...(process.env.PALDOCK_CODEX_PATH ? { configuredPath: process.env.PALDOCK_CODEX_PATH } : {}),
              cancelWaitMs: P1_DEFAULTS.cancelWaitForTurnMs,
            }),
            claude: new ClaudeAdapter(process.env.PALDOCK_CLAUDE_PATH ? { configuredPath: process.env.PALDOCK_CLAUDE_PATH } : {}),
          });
      // 持久事件同时送给管理窗口、外部渠道（从外部建的任务的进度、审批处理结果）、
      // 任务图调度器（推进下游）和验收闸门（交付后核对、审阅）
      const publish = (events: PersistentEvent[]) => {
        service.broadcast(events);
        service.channels.onEvents(events);
        service.scheduler.onEvents(events);
        service.gate.onEvents(events);
        service.coordinator.onEvents(events);
      };
      // 计划用例依赖调度器，调度器依赖带这个网关的监管器：propose_plan 的后端延后取
      let plans: PlanService | undefined;
      const gitOps = new GitOpsService({
        store,
        dataRoot,
        publish,
        log,
        indexChanged: (workspaceId) => void service.supervisor?.rebaseIndex(workspaceId).catch(() => {}),
        kick: () => service.supervisor?.kick(),
      });
      service.mcp = new McpGateway({ store, publish, plans: () => plans, coordinator: () => service.coordinator, gitOps: () => gitOps });
      service.supervisor = new RunSupervisor({
        store,
        runtimes,
        mcp: {
          gateway: service.mcp,
          // 令牌经环境变量交给桥：只对这次 Run、这个角色的工具有效，Run 结束即作废（与服务令牌不同，从不进环境变量）
          server: (mcpToken) => ({
            name: 'paldock',
            command: process.execPath,
            args: [MCP_BRIDGE_PATH],
            env: { ...nodeRuntimeEnv(process.execPath), PALDOCK_IPC_PATH: ipcPath, PALDOCK_MCP_TOKEN: mcpToken },
          }),
        },
        dataRoot,
        publish,
        publishEphemeral: (event) => service.broadcastEphemeral(event),
        log,
        gitOps: () => gitOps,
        ...(options.limits ? { limits: options.limits } : {}),
      });
      service.scheduler = new TaskGraphScheduler({ store, supervisor: service.supervisor, publish, log });
      const limits = options.limits ? { limits: options.limits } : {};
      const integration = new IntegrationService({ store, supervisor: service.supervisor, dataRoot, publish, log, ...limits });
      service.integration = integration;
      service.coordinator = new CoordinatorService({ store, supervisor: service.supervisor, publish, log, ...(options.coordinatorLimits ? { limits: options.coordinatorLimits } : {}) });
      service.gate = new ReviewGate({ store, supervisor: service.supervisor, publish, log, integration, ...limits });
      plans = new PlanService({ store, scheduler: service.scheduler, integration, supervisor: service.supervisor, publish, log });
      service.plans = plans;
      const tasks = new TaskService({ store, supervisor: service.supervisor, scheduler: service.scheduler, integration, dataRoot, publish });
      service.channels = new ChannelService({
        store,
        tasks,
        coordinator: service.coordinator,
        plans,
        credentials: options.channels?.credentials ?? systemCredentials,
        createAdapter: options.channels?.createAdapter ?? createAdapter,
        publish,
        publishEphemeral: (event) => service.broadcastEphemeral(event),
        log,
        ...(options.channels?.limits ? { limits: options.channels.limits } : {}),
      });
      const agents = new AgentService({ store, runtimes, publish });
      // P3 的中间状态由恢复程序收拾（P1 / P2 的单子任务仍由用户手动恢复）；它也负责把唤醒放回队列
      const recovery = new RecoveryService({
        store,
        supervisor: service.supervisor,
        scheduler: service.scheduler,
        gate: service.gate,
        integration,
        coordinator: service.coordinator,
        publish,
        log,
      });
      service.handlers = createHandlers(store, tasks, plans, integration, service.coordinator, recovery, service.channels, agents, gitOps, {
        version: SERVICE_VERSION,
        startedAt: new Date().toISOString(),
        interruptedRuns,
        runtime: Object.keys(runtimes).join(', '),
      });
      service.supervisor.start();
      void recovery.recover(recoveryReport).catch((error) => log(`recovery failed: ${(error as Error).message}`));
      service.channels.start();
      // 重启前排定的简单计划自动确认重新排上（过了点的马上确认）
      plans.start();
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
    /** MCP 桥的连接：只能列出、调用这个 Run 角色的工具，不加入事件广播。 */
    let mcp: McpCaller | undefined;
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

      if (!authed && frame.kind === 'mcp_hello') {
        mcp = this.mcp.authenticate(frame.token);
        if (!mcp) return drop('mcp unauthorized');
        authed = true;
        clearTimeout(helloTimer);
        send({ kind: 'welcome', schemaVersion: SCHEMA_VERSION, serviceVersion: SERVICE_VERSION, headSeq: 0 });
        return;
      }
      if (mcp) {
        if (frame.kind !== 'mcp_list' && frame.kind !== 'mcp_call') return drop('mcp client sent a non-mcp frame');
        const caller = mcp;
        const id = frame.id;
        // 提交 / 推送 / 合并卡片要跑 git，结果是异步的
        void this.mcpCall(() => (frame.kind === 'mcp_list' ? this.mcp.list(caller) : this.mcp.call(caller, frame.tool, frame.args))).then((outcome) =>
          send('error' in outcome ? { kind: 'result', id, ok: false, error: outcome.error } : { kind: 'result', id, ok: true, value: outcome.value ?? null }),
        );
        return;
      }
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
      if (frame.kind !== 'command') return drop('unexpected frame');

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

  /** MCP 工具调用的结果：业务错误原样返回给助手，内部错误不带细节。 */
  private async mcpCall(run: () => unknown): Promise<Outcome> {
    try {
      return { value: await run() };
    } catch (error) {
      if (error instanceof CodedError) return { error: { code: error.code, message: error.message } };
      this.log(`mcp call failed: ${(error as Error).name}`);
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
    this.coordinator.stop();
    this.plans.stop();
    await this.supervisor.stop();
    await this.integration.idle();
    this.broadcast(this.store.interruptActiveWork('应用退出').events);
    for (const client of this.clients) client.end();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.store.close();
    this.releaseLock();
  }
}
