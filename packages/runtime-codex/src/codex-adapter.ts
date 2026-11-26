import type {
  McpServerSpec,
  RunStartRequest,
  RuntimeAdapter,
  RuntimeApprovalDecision,
  RuntimeDiscovery,
  RuntimeEvent,
  RuntimeRun,
  TurnCheck,
} from '@paldock/contracts';
import { codexVersion, commandEnv, meetsMinimum, MIN_CODEX_VERSION, resolveCodexCommand } from './discover.js';
import { JsonRpcStdioClient, RpcError, type RpcHandlers } from './json-rpc.js';
import { approvalResponse, CodexUsageMeter, finalTurnEvent, toApprovalRequest, toTurnCheck, type CodexTurn } from './event-mapping.js';

export interface CodexAdapterOptions {
  /** 设置里填写的 codex 可执行文件或 .js 入口；为空时在 PATH 上查找。 */
  configuredPath?: string;
  /** 取消时最多等 turn/started 多久，之后直接结束进程树。 */
  cancelWaitMs?: number;
  /** 中断请求发出后最多等 turn/completed 多久。 */
  interruptWaitMs?: number;
  /** 初始化、建 thread 等短请求的超时。 */
  requestTimeoutMs?: number;
  /** 额外的环境变量（例如测试用的 MOCK_CODEX_HOME），仍在白名单之上合并。 */
  extraEnv?: Record<string, string>;
}

const CAPABILITIES = {
  resume: true,
  streaming: true,
  approvals: true,
  cancel: true,
  workingDirectoryRestriction: true,
  attachments: false,
} as const;

/** 写入限制在 worktree 内、无网络；越界操作经 on-request 送来审批。 */
const THREAD_POLICY = { sandbox: 'workspace-write', approvalPolicy: 'on-request' } as const;

const CLIENT_INFO = { name: 'paldock', title: 'PalDock', version: '0.1.0' };

/** Codex app-server 适配器：每次 Run 一个 app-server 进程，Run 结束即结束整个进程树。 */
export class CodexAdapter implements RuntimeAdapter {
  readonly name = 'codex';
  private readonly options: ResolvedOptions;
  private readonly configuredPath: string | undefined;

  constructor({ configuredPath, ...options }: CodexAdapterOptions = {}) {
    this.configuredPath = configuredPath;
    this.options = { cancelWaitMs: 10_000, interruptWaitMs: 10_000, requestTimeoutMs: 60_000, extraEnv: {}, ...options };
  }

  async discover(): Promise<RuntimeDiscovery> {
    const cmd = resolveCodexCommand(this.configuredPath);
    if (!cmd) return { runtime: this.name, available: false, reason: '未找到 codex 可执行文件', capabilities: CAPABILITIES };
    const version = await codexVersion(cmd, this.options.extraEnv);
    if (!version) return { runtime: this.name, available: false, reason: '无法运行 codex --version', capabilities: CAPABILITIES };
    if (!meetsMinimum(version)) {
      const reason = `Codex ${version} 版本过低，需要 ${MIN_CODEX_VERSION} 或更高，请升级（npm i -g @openai/codex）`;
      return { runtime: this.name, available: false, version, reason, capabilities: CAPABILITIES };
    }
    return { runtime: this.name, available: true, version, capabilities: CAPABILITIES };
  }

  /** 每个适配器只检查一次版本；不满足时不缓存，升级后下一次 Run 重新检查。 */
  private supported: Promise<void> | undefined;
  private ensureSupported(): Promise<void> {
    this.supported ??= this.discover().then((d) => {
      if (!d.available) {
        this.supported = undefined;
        throw new Error(d.reason);
      }
    });
    return this.supported;
  }

  async start(request: RunStartRequest, onEvent: (event: RuntimeEvent) => void): Promise<RuntimeRun> {
    await this.ensureSupported();
    const run = new CodexRun(this.open.bind(this), this.options, onEvent);
    await run.start(request);
    return run;
  }

  /** 新开一个 app-server 读 thread 历史，只看指定的 turn。 */
  async checkTurn(threadId: string, turnId: string): Promise<TurnCheck> {
    const rpc = await this.open({});
    try {
      const { thread } = await rpc.request<{ thread: { turns?: CodexTurn[] } }>(
        'thread/read',
        { threadId, includeTurns: true },
        this.options.requestTimeoutMs,
      );
      return toTurnCheck(thread.turns?.find((t) => t.id === turnId));
    } catch (error) {
      if (error instanceof RpcError) return { status: 'not_found' };
      throw error;
    } finally {
      await rpc.dispose();
    }
  }

  /** 归档 PalDock 换下的角色会话（不删除，Codex 应用里可以在归档里找到）。 */
  async archiveThread(threadId: string): Promise<void> {
    const rpc = await this.open({});
    try {
      await rpc.request('thread/archive', { threadId }, this.options.requestTimeoutMs);
    } finally {
      await rpc.dispose();
    }
  }

  /** 启动 app-server 并完成 initialize 握手。 */
  private async open(handlers: RpcHandlers): Promise<JsonRpcStdioClient> {
    const cmd = resolveCodexCommand(this.configuredPath);
    if (!cmd) throw new Error('未找到 codex 可执行文件');
    const env = commandEnv(cmd, this.options.extraEnv);
    const rpc = new JsonRpcStdioClient(cmd.command, [...cmd.prefixArgs, 'app-server', '--listen', 'stdio://'], handlers, env);
    try {
      await rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false } }, this.options.requestTimeoutMs);
      rpc.notify('initialized');
      return rpc;
    } catch (error) {
      await rpc.dispose();
      throw error;
    }
  }
}

type ResolvedOptions = Required<Omit<CodexAdapterOptions, 'configuredPath'>>;

/**
 * 按 thread 注入 MCP 服务器（不改用户的 config.toml，P3-00 实测）。approvalPolicy 为 on-request 时每次 MCP 调用都会发审批请求，
 * 服务器级的 default_tools_approval_mode 让这些调用直接放行：权限由 PalDock 服务端按令牌和角色判定，桥也不提供写文件的工具。
 */
function mcpConfig(server: McpServerSpec | undefined) {
  if (!server) return {};
  const { name, command, args, env } = server;
  return { config: { mcp_servers: { [name]: { command, args, env, default_tools_approval_mode: 'approve' } } } };
}
type Opener = (handlers: RpcHandlers) => Promise<JsonRpcStdioClient>;

/** 一次 Run 的状态：thread / turn 身份、挂起的审批、取消请求。 */
class CodexRun implements RuntimeRun {
  private rpc: JsonRpcStdioClient | undefined;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private started = false;
  private finished = false;
  private disposing = false;
  private lastAgentMessage: string | null = null;
  private readonly usage = new CodexUsageMeter();
  /** fileChange 条目的路径（审批请求本身不带路径，要从 item/started 里取）。 */
  private readonly fileChanges = new Map<string, string[]>();
  /** 执行器请求 ID → 回复函数。 */
  private readonly approvals = new Map<string, (decision: RuntimeApprovalDecision) => void>();
  private readonly earlyCompletions = new Map<string, CodexTurn>();
  private readonly startedWaiters: (() => void)[] = [];
  private readonly completedWaiters: (() => void)[] = [];

  constructor(
    private readonly open: Opener,
    private readonly options: ResolvedOptions,
    private readonly emit: (event: RuntimeEvent) => void,
  ) {}

  async start(request: RunStartRequest): Promise<void> {
    this.rpc = await this.open({
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (method, params, id) => this.onServerRequest(method, params, String(id)),
      onExit: () => this.onExit(),
    });
    const timeout = this.options.requestTimeoutMs;
    try {
      const threadParams = { cwd: request.cwd, ...THREAD_POLICY, ...(request.readOnly ? { sandbox: 'read-only' } : {}), ...mcpConfig(request.mcpServer) };
      const { thread } = request.resumeThreadId
        ? await this.rpc.request<{ thread: { id: string } }>('thread/resume', { threadId: request.resumeThreadId, ...threadParams }, timeout)
        : await this.rpc.request<{ thread: { id: string } }>(
            'thread/start',
            { ...threadParams, ephemeral: false, ...(request.instructions ? { developerInstructions: request.instructions } : {}) },
            timeout,
          );
      this.threadId = thread.id;
      this.emit({ type: 'thread', threadId: thread.id });

      const { turn } = await this.rpc.request<{ turn: { id: string } }>(
        'turn/start',
        { threadId: thread.id, input: [{ type: 'text', text: request.prompt, text_elements: [] }] },
        timeout,
      );
      this.adoptTurn(turn.id);
      const early = this.earlyCompletions.get(turn.id);
      if (early) this.complete(early);
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async cancel(): Promise<void> {
    if (this.finished) return;
    // 中断要等 turn/started：turn/start 返回时 turn 不一定已开始（P0-01 实测会报 no active turn）
    if (!this.started && !(await this.waitFor(this.startedWaiters, this.options.cancelWaitMs))) return this.forceStop();
    await this.interrupt();
  }

  respondApproval(nativeRequestId: string, decision: RuntimeApprovalDecision): void {
    const reply = this.approvals.get(nativeRequestId);
    if (!reply) return;
    this.approvals.delete(nativeRequestId);
    reply(decision);
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    for (const id of [...this.approvals.keys()]) this.respondApproval(id, 'cancel');
    await this.rpc?.dispose();
  }

  private async interrupt(): Promise<void> {
    if (this.finished || !this.rpc || !this.threadId || !this.turnId) return;
    try {
      await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, this.options.requestTimeoutMs);
    } catch {
      return this.forceStop();
    }
    if (!(await this.waitFor(this.completedWaiters, this.options.interruptWaitMs))) await this.forceStop();
  }

  /** 执行器不响应时直接结束进程树，按「已中断」上报。 */
  private async forceStop(): Promise<void> {
    if (this.finished) return;
    this.finish({ type: 'interrupted' });
    await this.dispose();
  }

  private isOurs(params: { threadId?: string; turnId?: string }): boolean {
    return params.threadId === this.threadId && (params.turnId === undefined || params.turnId === this.turnId);
  }

  /**
   * 记下这次 Run 的 turn（只记一次）。turn/start 的响应和随后的 turn/started、输出通知可能在同一批数据里到达，
   * 通知会先于 await 之后的代码处理，所以两处都可能先拿到 turn ID。
   */
  private adoptTurn(turnId: string): void {
    if (this.turnId) return;
    this.turnId = turnId;
    this.emit({ type: 'turn', turnId });
  }

  private onNotification(method: string, raw: unknown): void {
    const params = (raw ?? {}) as Record<string, unknown> & { threadId?: string; turnId?: string };
    switch (method) {
      case 'turn/started': {
        const turn = params.turn as CodexTurn | undefined;
        if (params.threadId !== this.threadId || !turn?.id || (this.turnId && turn.id !== this.turnId)) return;
        this.adoptTurn(turn.id);
        this.started = true;
        this.release(this.startedWaiters);
        return;
      }
      case 'item/agentMessage/delta':
        if (this.isOurs(params) && typeof params.delta === 'string') this.emit({ type: 'output_delta', text: params.delta });
        return;
      case 'item/started':
      case 'item/completed': {
        const item = params.item as { type?: string; id?: string; text?: string; changes?: { path: string }[] } | undefined;
        if (!item?.id || params.threadId !== this.threadId) return;
        if (item.type === 'fileChange' && item.changes) this.fileChanges.set(item.id, item.changes.map((c) => c.path));
        if (method === 'item/completed' && item.type === 'agentMessage' && typeof item.text === 'string') this.lastAgentMessage = item.text;
        return;
      }
      case 'thread/tokenUsage/updated':
        // 本连接只服务这一次 Run，子代理的 thread 也在这上面，一并计入
        if (typeof params.threadId === 'string') this.usage.update(params.threadId, params.tokenUsage as Parameters<CodexUsageMeter['update']>[1]);
        return;
      case 'serverRequest/resolved': {
        const id = String(params.requestId);
        if (this.approvals.delete(id)) this.emit({ type: 'approval_withdrawn', nativeRequestId: id });
        return;
      }
      case 'turn/completed': {
        const turn = params.turn as CodexTurn | undefined;
        if (params.threadId !== this.threadId || !turn) return;
        // 极快的 turn 可能在 turn/start 响应之前就结束，先记下，拿到 turn ID 后再处理
        if (this.turnId === undefined) this.earlyCompletions.set(turn.id, turn);
        else if (turn.id === this.turnId) this.complete(turn);
        return;
      }
    }
  }

  private complete(turn: CodexTurn): void {
    this.finish(finalTurnEvent(turn, this.lastAgentMessage, this.usage.usage()));
    void this.dispose();
  }

  private onServerRequest(method: string, params: unknown, nativeRequestId: string): Promise<unknown> {
    const request = toApprovalRequest(method, params, nativeRequestId, this.fileChanges);
    if (!request) {
      // 未识别的请求立即回错误（等同拒绝），不让执行器一直等
      this.emit({ type: 'notice', code: 'unknown_request', detail: method });
      return Promise.reject(new Error(`PalDock 不处理 ${method}`));
    }
    return new Promise((resolve) => {
      this.approvals.set(nativeRequestId, (decision) => resolve(approvalResponse(request.kind, decision)));
      this.emit({ type: 'approval_request', request });
    });
  }

  private onExit(): void {
    // 拿到 turn 之前退出：start() 会因请求失败而拒绝，由调用方按启动失败处理，这里不再上报断线
    if (this.disposing || this.finished || this.turnId === undefined) return;
    this.finish({ type: 'disconnected', message: 'Codex app-server 意外退出' });
  }

  private finish(event: RuntimeEvent): void {
    if (this.finished) return;
    this.finished = true;
    this.release(this.startedWaiters);
    this.release(this.completedWaiters);
    this.emit(event);
  }

  private waitFor(waiters: (() => void)[], ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private release(waiters: (() => void)[]): void {
    for (const waiter of waiters.splice(0)) waiter();
  }
}
