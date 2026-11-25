import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
import { killProcessTree, readFrames, writeFrame } from '@paldock/platform';
import { claudeLoggedIn, claudeVersion, commandEnv, meetsMinimum, MIN_CLAUDE_VERSION, resolveClaudeCommand, type ClaudeCommand } from './discover.js';
import { permissionResponse, resultEvent, toApprovalRequest, turnCheckFromTranscript, type ClaudeMessage } from './event-mapping.js';

export interface ClaudeAdapterOptions {
  /** 设置里填写的 claude 可执行文件或 .js 入口；为空时在 PATH 上查找。 */
  configuredPath?: string;
  /** Claude Code 的配置目录（会话记录、登录状态所在）；设置后以 CLAUDE_CONFIG_DIR 传给子进程。缺省 ~/.claude，不从宿主环境继承。 */
  configDir?: string;
  /** 中断请求发出后最多等 result 多久，之后直接结束进程树。 */
  interruptWaitMs?: number;
  /** 等 system/init 的超时（含 CLI 启动、恢复会话）。 */
  requestTimeoutMs?: number;
  /** 额外的环境变量（例如测试用的模拟开关），在白名单之上合并。 */
  extraEnv?: Record<string, string>;
}

/** 越界写入（写文件工具、Shell）全部经宿主审批；Shell 获批后能写到哪里不受限制，见 P3-00 实测记录。 */
const CAPABILITIES = {
  resume: true,
  streaming: true,
  approvals: true,
  cancel: true,
  workingDirectoryRestriction: true,
  attachments: false,
} as const;

/**
 * 固定参数：stream-json 双向流、权限请求经 stdio 交给宿主、默认权限模式；
 * 不加载用户的 MCP 与设置（用户设置里的放行规则会绕过宿主审批）。
 */
const CLI_ARGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--permission-prompt-tool', 'stdio',
  '--permission-mode', 'default',
  '--strict-mcp-config',
  '--setting-sources', '',
];

/** stderr 只留最后一段，启动失败时附在错误信息里。 */
const STDERR_TAIL = 2000;
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;

/** Claude Code CLI 适配器：每次 Run 一个 CLI 进程，发一条用户消息，收到 result 即结束整个进程树。 */
export class ClaudeAdapter implements RuntimeAdapter {
  readonly name = 'claude';
  private readonly options: ResolvedOptions;
  private readonly configuredPath: string | undefined;
  private readonly configDir: string;

  constructor({ configuredPath, configDir, ...options }: ClaudeAdapterOptions = {}) {
    this.configuredPath = configuredPath;
    this.configDir = configDir ?? join(homedir(), '.claude');
    const extraEnv = { ...options.extraEnv, ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) };
    this.options = { interruptWaitMs: 10_000, requestTimeoutMs: 60_000, ...options, extraEnv };
  }

  async discover(): Promise<RuntimeDiscovery> {
    const unavailable = (reason: string, version?: string): RuntimeDiscovery => ({
      runtime: this.name,
      available: false,
      reason,
      ...(version ? { version } : {}),
      capabilities: CAPABILITIES,
    });
    const cmd = resolveClaudeCommand(this.configuredPath);
    if (!cmd) return unavailable('未找到 claude 可执行文件，请安装 Claude Code 或在设置里填写路径');
    const env = commandEnv(cmd, this.options.extraEnv);
    const version = await claudeVersion(cmd, env);
    if (!version) return unavailable('无法运行 claude --version');
    if (!meetsMinimum(version)) return unavailable(`Claude Code ${version} 版本过低，需要 ${MIN_CLAUDE_VERSION} 或更高，请升级`, version);
    if ((await claudeLoggedIn(cmd, env)) === false) return unavailable('Claude Code 未登录，请先在终端运行 claude 登录', version);
    return { runtime: this.name, available: true, version, executable: { path: cmd.prefixArgs[0] ?? cmd.command, source: cmd.source }, capabilities: CAPABILITIES };
  }

  /** 每个适配器只检查一次；不满足时不缓存，升级或登录后下一次 Run 重新检查。 */
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
    const cmd = resolveClaudeCommand(this.configuredPath);
    if (!cmd) throw new Error('未找到 claude 可执行文件');
    const run = new ClaudeRun(cmd, this.options, onEvent);
    await run.start(request);
    return run;
  }

  /** 读会话记录核对指定的 turn；记录按工作目录分在 projects 下的子目录里，按 session_id 文件名找。 */
  async checkTurn(threadId: string, turnId: string): Promise<TurnCheck> {
    if (!SESSION_ID.test(threadId)) return { status: 'not_found' };
    const projects = join(this.configDir, 'projects');
    const dirs = existsSync(projects) ? readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
    const file = dirs.map((d) => join(projects, d.name, `${threadId}.jsonl`)).find((path) => existsSync(path));
    if (!file) return { status: 'not_found' };
    return turnCheckFromTranscript(readFileSync(file, 'utf8').split('\n'), turnId);
  }
}

type ResolvedOptions = Required<Omit<ClaudeAdapterOptions, 'configuredPath' | 'configDir'>>;

/**
 * 按会话注入 MCP 服务器（配合 --strict-mcp-config 只加载这一份，P3-00 实测）。这个服务器的工具整体放行，
 * 不再经 can_use_tool 问宿主：权限由 PalDock 服务端按令牌和角色判定，桥也不提供写文件的工具。
 */
function mcpArgs(server: McpServerSpec | undefined): string[] {
  if (!server) return [];
  const { name, command, args, env } = server;
  return ['--mcp-config', JSON.stringify({ mcpServers: { [name]: { command, args, env } } }), '--allowedTools', `mcp__${name}`];
}

/** 一次 Run 的状态：会话与 turn 身份、挂起的审批、中断请求。 */
class ClaudeRun implements RuntimeRun {
  private child: ChildProcessWithoutNullStreams | undefined;
  private cwd = '';
  private resumeThreadId: string | undefined;
  private threadId: string | undefined;
  private readonly turnId = randomUUID();
  private finished = false;
  private disposing = false;
  private interruptRequested = false;
  private stderrTail = '';
  private nextControlId = 0;
  private init: { resolve: () => void; reject: (error: Error) => void } | undefined;
  /** 执行器请求 ID → 回复函数。 */
  private readonly approvals = new Map<string, (decision: RuntimeApprovalDecision) => void>();
  private readonly completedWaiters: (() => void)[] = [];

  constructor(
    private readonly cmd: ClaudeCommand,
    private readonly options: ResolvedOptions,
    private readonly emit: (event: RuntimeEvent) => void,
  ) {}

  /** 启动 CLI 并发出提示词；CLI 收到第一条输入后才发 system/init，拿到会话 ID 即视为启动成功。 */
  async start(request: RunStartRequest): Promise<void> {
    this.cwd = request.cwd;
    this.resumeThreadId = request.resumeThreadId;
    const args = [
      ...this.cmd.prefixArgs,
      ...CLI_ARGS,
      ...mcpArgs(request.mcpServer),
      ...(request.resumeThreadId ? ['--resume', request.resumeThreadId] : []),
    ];
    // posix 下 detached 让子进程成为进程组组长，便于整树结束
    const child = spawn(this.cmd.command, args, {
      cwd: request.cwd,
      env: commandEnv(this.cmd, this.options.extraEnv),
      stdio: 'pipe',
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    this.child = child;
    const initialized = new Promise<void>((resolve, reject) => (this.init = { resolve, reject }));
    const timer = setTimeout(() => this.failStart(`等待 Claude Code 启动超时（${this.options.requestTimeoutMs} ms）`), this.options.requestTimeoutMs);
    // 非 JSON 行跳过；单行超限说明输出失控，结束进程
    readFrames(child.stdout, (frame) => this.onMessage(frame as ClaudeMessage), (error) => {
      if (error.kind === 'too_large') void this.dispose();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL)));
    child.stdin.on('error', () => {});
    child.on('error', (error) => this.onExit(error.message));
    child.on('exit', (code) => this.onExit(`退出码 ${code}`));
    this.write({
      type: 'user',
      uuid: this.turnId,
      session_id: '',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: request.prompt }] },
    });
    try {
      await initialized;
    } catch (error) {
      await this.dispose();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async cancel(): Promise<void> {
    if (this.finished) return;
    this.interruptRequested = true;
    this.write({ type: 'control_request', request_id: `paldock_${++this.nextControlId}`, request: { subtype: 'interrupt' } });
    if (!(await this.waitForCompletion(this.options.interruptWaitMs))) await this.forceStop();
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
    if (!this.child) return;
    this.child.stdin.end();
    await killProcessTree(this.child);
  }

  private write(frame: unknown): void {
    if (this.child && !this.child.stdin.destroyed) writeFrame(this.child.stdin, frame);
  }

  /** 事件在 onMessage 里同步发出：同一批输出里 init 之后紧跟的流式输出、审批要排在 thread / turn 之后。 */
  private onMessage(message: ClaudeMessage): void {
    if (this.finished) return; // 已上报终态（例如强制结束）后，进程退出前的残余输出一律丢弃
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') this.onInit(String(message.session_id ?? ''));
        return;
      case 'stream_event': {
        const event = message.event as { type?: string; delta?: { type?: string; text?: unknown } } | undefined;
        // 只转发主会话的文字；子代理的输出带 parent_tool_use_id
        if (message.parent_tool_use_id == null && event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
          this.emit({ type: 'output_delta', text: event.delta.text });
        }
        return;
      }
      case 'control_request':
        return this.onControlRequest(String(message.request_id), message.request as ControlRequest | undefined);
      case 'control_cancel_request': {
        const id = String(message.request_id);
        if (this.approvals.delete(id)) this.emit({ type: 'approval_withdrawn', nativeRequestId: id });
        return;
      }
      case 'result':
        if (!this.threadId) return;
        this.finish(resultEvent(message, this.interruptRequested));
        void this.dispose();
        return;
    }
  }

  private onInit(sessionId: string): void {
    if (this.threadId || !this.init) return;
    // 恢复时 CLI 换了会话 ID 等于另起一个会话，上下文和审批边界都变了，按恢复失败处理
    if (!sessionId || (this.resumeThreadId && sessionId !== this.resumeThreadId)) {
      return this.failStart('Claude Code 返回的会话 ID 与要恢复的不一致');
    }
    this.threadId = sessionId;
    this.emit({ type: 'thread', threadId: sessionId });
    this.emit({ type: 'turn', turnId: this.turnId });
    this.init.resolve();
    this.init = undefined;
  }

  private onControlRequest(requestId: string, request: ControlRequest | undefined): void {
    if (request?.subtype !== 'can_use_tool') {
      // 未识别的请求立即回错误（等同拒绝），不让执行器一直等
      this.emit({ type: 'notice', code: 'unknown_request', detail: request?.subtype ?? 'unknown' });
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `PalDock 不处理 ${request?.subtype}` } });
      return;
    }
    const input = request.input ?? {};
    const approval = toApprovalRequest(request.tool_name ?? 'unknown', input, requestId, this.cwd);
    this.approvals.set(requestId, (decision) =>
      this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: permissionResponse(decision, input) } }),
    );
    this.emit({ type: 'approval_request', request: approval });
  }

  private failStart(message: string): void {
    const tail = this.stderrTail.trim();
    this.init?.reject(new Error(tail ? `${message}：${tail}` : message));
    this.init = undefined;
  }

  private onExit(reason: string): void {
    if (this.disposing || this.finished) return;
    // 拿到会话之前退出：start() 按启动失败拒绝（例如要恢复的会话不存在），不上报断线
    if (!this.threadId) return this.failStart(`Claude Code 启动失败（${reason}）`);
    this.finish({ type: 'disconnected', message: `Claude Code 意外退出（${reason}）` });
  }

  /** 执行器不响应中断时直接结束进程树，按「已中断」上报。 */
  private async forceStop(): Promise<void> {
    if (this.finished) return;
    this.finish({ type: 'interrupted' });
    await this.dispose();
  }

  private finish(event: RuntimeEvent): void {
    if (this.finished) return;
    this.finished = true;
    for (const waiter of this.completedWaiters.splice(0)) waiter();
    this.emit(event);
  }

  private waitForCompletion(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.completedWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

interface ControlRequest {
  subtype?: string;
  tool_name?: string;
  input?: Record<string, unknown>;
}
