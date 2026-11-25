import { createHash } from 'node:crypto';
import {
  type AgentRole,
  CodedError,
  isMcpTool,
  MCP_TOOLS,
  mcpToolsFor,
  type McpToolArgs,
  type McpToolDefinition,
  type McpToolName,
  type PersistentEvent,
  type StorePort,
} from '@paldock/contracts';
import { createToken } from '@paldock/platform';

/** 令牌对应的调用者：只认服务签发时记下的 Run 和角色，不信模型自报身份。 */
export interface McpCaller {
  runId: string;
  role: AgentRole;
}

export interface McpGatewayDeps {
  store: StorePort;
  publish(events: PersistentEvent[]): void;
  now?: () => number;
}

interface Grant extends McpCaller {
  expiresAt: number;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * MCP 桥的服务端：给每次 Run 签发一次性令牌，按令牌对应的角色列出、校验、执行工具，每次调用都写审计。
 * 令牌只存哈希、只在内存里；Run 结束即作废，服务重启后全部失效（那时所有 Run 都已中断）。
 */
export class McpGateway {
  private readonly grants = new Map<string, Grant>();
  private readonly byRun = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly deps: McpGatewayDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** 为一次 Run 签发令牌；同一 Run 再签发时旧令牌作废。 */
  issue(runId: string, role: AgentRole, ttlMs: number): string {
    this.revoke(runId);
    const token = createToken();
    this.grants.set(hash(token), { runId, role, expiresAt: this.now() + ttlMs });
    this.byRun.set(runId, hash(token));
    return token;
  }

  revoke(runId: string): void {
    const key = this.byRun.get(runId);
    if (key) this.grants.delete(key);
    this.byRun.delete(runId);
  }

  /** 握手：令牌无效或过期时返回 undefined，并写审计。 */
  authenticate(token: string): McpCaller | undefined {
    const grant = this.grants.get(hash(token));
    if (!grant || grant.expiresAt <= this.now()) {
      this.deps.store.audit.append('mcp:unknown', 'mcp.hello', null, grant ? 'denied:expired' : 'denied:invalid_token');
      if (grant) this.revoke(grant.runId);
      return undefined;
    }
    return { runId: grant.runId, role: grant.role };
  }

  /** 每次调用前都重新确认令牌仍有效（Run 可能已在连接期间结束）。 */
  private stillValid(caller: McpCaller): boolean {
    const key = this.byRun.get(caller.runId);
    const grant = key ? this.grants.get(key) : undefined;
    return !!grant && grant.expiresAt > this.now();
  }

  list(caller: McpCaller): McpToolDefinition[] {
    return mcpToolsFor(caller.role);
  }

  /** 校验身份、角色与参数后执行；拒绝与成功都写审计（不记参数正文）。 */
  call(caller: McpCaller, tool: string, rawArgs: unknown): unknown {
    const actor = `run:${caller.runId}`;
    const deny = (code: 'unauthorized' | 'bad_request', reason: string, message: string): never => {
      this.deps.store.audit.append(actor, `mcp.${tool.slice(0, 64)}`, caller.runId, `denied:${reason}`);
      throw new CodedError(code, message);
    };
    if (!this.stillValid(caller)) return deny('unauthorized', 'revoked', '这次 Run 已结束，令牌已作废');
    if (!isMcpTool(tool)) return deny('bad_request', 'unknown_tool', `没有工具 ${tool}`);
    const spec = MCP_TOOLS[tool];
    if (!(spec.roles as readonly string[]).includes(caller.role)) return deny('unauthorized', 'role', `${caller.role} 不能调用 ${tool}`);
    const args = spec.args.safeParse(rawArgs ?? {});
    if (!args.success) return deny('bad_request', 'invalid_args', args.error.issues[0]?.message ?? '参数错误');
    try {
      const result = this.run(caller, tool, args.data as never);
      this.deps.store.audit.append(actor, `mcp.${tool}`, caller.runId, 'ok');
      return result;
    } catch (error) {
      this.deps.store.audit.append(actor, `mcp.${tool}`, caller.runId, `error:${error instanceof CodedError ? error.code : 'internal'}`);
      throw error;
    }
  }

  private run<N extends McpToolName>(caller: McpCaller, tool: N, args: McpToolArgs<N>): unknown {
    switch (tool) {
      case 'get_task':
        return this.getTask(caller);
      case 'submit_result': {
        const { summary, notes } = args as McpToolArgs<'submit_result'>;
        const { record, events } = this.deps.store.runs.submitHandoff(caller.runId, summary, notes ?? null);
        this.deps.publish(events);
        return { handoffId: record.runId, submittedAt: record.submittedAt, next: 'PalDock 会在 Run 结束后核对检查命令和交付范围' };
      }
      case 'get_status': {
        const { limit } = args as McpToolArgs<'get_status'>;
        return this.deps.store.tasks.listTasks(limit).map((t) => ({ taskId: t.task.id, title: t.task.title, status: t.task.status, subtaskStatus: t.subtaskStatus, lastActivityAt: t.lastActivityAt }));
      }
    }
    throw new CodedError('bad_request', `没有工具 ${tool}`);
  }

  private getTask(caller: McpCaller) {
    const { store } = this.deps;
    const run = store.runs.getRun(caller.runId);
    const subtask = run && store.tasks.getSubtask(run.subtaskId);
    const task = subtask && store.tasks.getTask(subtask.taskId);
    if (!task || !subtask) throw new CodedError('not_found', '找不到这次 Run 的子任务');
    const profile = store.agents.getProfile(caller.role);
    return {
      taskId: task.id,
      title: task.title,
      goal: task.goal,
      subtask: { id: subtask.id, goal: subtask.goal, attempt: run.attempt, reworkCount: subtask.reworkCount },
      role: { name: caller.role, displayName: profile?.displayName, duty: profile?.description, deliveryScope: profile?.deliveryScope ?? [] },
      // 只给已确认的检查命令；未确认的不会运行，也不让助手据此行事
      checkCommand: task.checkConfirmedAt ? task.checkCommand : null,
    };
  }
}
