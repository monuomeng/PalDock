import { z } from 'zod';
import { EphemeralEvent, PersistentEvent } from './events.js';
import {
  ChannelProvider,
  type ChannelAccountRecord,
  type ChannelOverview,
  type ConversationRecord,
  type PairingRecord,
} from './channels.js';
import { CheckCommand, type AgentOverrideRecord, type AgentSettings, type AttentionItem, type MessageRecord, type TaskDetail, type TaskSummary, type WorkspaceRecord } from './records.js';
import { AgentRole, ApprovalDecision, AttentionKind, Executor, RemoteApprovalLevel, ReviewDecision, SCHEMA_VERSION } from './states.js';

/** 单帧上限；超长帧直接断开，防止本机客户端撑爆内存。 */
export const MAX_FRAME_BYTES = 1024 * 1024;

const Id = z.string().min(1).max(200);
const Version = z.number().int().nonnegative();

/** 命令名 → 参数 schema。新增命令只在这里登记，服务端和客户端共用。 */
export const CommandArgs = {
  'service.status': z.object({}),
  'task.create': z
    .object({
      /** 用户在桌面选的项目目录（git 仓库）；接续任务时不填，项目取自来源任务。 */
      rootPath: z.string().min(1).max(1000).optional(),
      goal: z.string().trim().min(1).max(8000),
      check: CheckCommand.optional(),
      /** 用户已看过完整命令和「以你的账户权限运行」的提示并确认；未确认的命令不会运行。 */
      checkConfirmed: z.boolean().default(false),
      /** 客户端为每次提交生成；重复提交返回同一个任务。 */
      idempotencyKey: z.string().min(8).max(100),
      /** 基于这个已结束的任务继续：同一项目，worktree 从它的分支出发。 */
      continuedFromTaskId: z.string().min(1).max(100).optional(),
    })
    .strict()
    .refine((v) => (v.rootPath === undefined) !== (v.continuedFromTaskId === undefined), {
      message: '新建任务请选择项目目录；接续任务时项目取自来源任务',
    }),
  'task.list': z.object({ limit: z.number().int().positive().max(500).default(100) }),
  'task.get': z.object({ taskId: Id }),
  'task.cancel': z.object({ taskId: Id }),
  'approval.decide': z.object({ approvalId: Id, expectedVersion: Version, decision: ApprovalDecision }),
  'review.decide': z
    .object({ subtaskId: Id, expectedVersion: Version, decision: ReviewDecision, note: z.string().trim().max(2000).optional() })
    .refine((v) => v.decision === 'accept' || (v.note?.length ?? 0) > 0, { message: '继续时需要写下一步要做什么' }),
  /** 服务重启后被中断的子任务：恢复（续做同一 thread）、重新开始（新 thread）或放弃。 */
  'run.recover': z.object({ subtaskId: Id, expectedVersion: Version, action: z.enum(['resume', 'restart', 'abandon']) }),
  'run.checkOutput': z.object({ runId: Id }),
  /** 合入集成分支冲突的节点交回开发助手：把集成分支最新提交合进节点 worktree（留冲突标记），回原会话处理。 */
  'merge.redo': z.object({ subtaskId: Id, expectedVersion: Version }),
  /** 确认协调助手提出的计划：按节点建子任务并开始派单。 */
  'plan.confirm': z.object({ planId: Id, expectedVersion: Version }),
  /** 退回计划，任务留在草稿，协调助手可以再提一版。 */
  'plan.reject': z.object({ planId: Id, expectedVersion: Version, note: z.string().trim().max(500).optional() }),
  'events.since': z.object({
    afterSeq: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(1000).default(200),
  }),
  'attention.list': z.object({}),
  'attention.markRead': z.object({ itemKind: AttentionKind, itemId: Id }),
  'messages.search': z.object({ query: z.string().min(1).max(200), limit: z.number().int().positive().max(100).default(20) }),
  'maintenance.backup': z.object({}),
  'workspace.list': z.object({}),
  /** 远程审批等级只能在桌面修改：这条命令只在管理窗口里有入口，外部渠道没有对应命令。 */
  'workspace.setRemoteApprovalLevel': z.object({ workspaceId: Id, expectedVersion: Version, level: RemoteApprovalLevel }),
  'channel.overview': z.object({}),
  'channel.configure': z
    .object({
      provider: ChannelProvider,
      expectedVersion: Version,
      enabled: z.boolean(),
      /** 只支持 http(s) 代理；空串表示不用代理。 */
      proxyUrl: z
        .string()
        .trim()
        .max(500)
        .refine((v) => v === '' || /^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(v), { message: '代理地址格式应为 http://主机:端口' })
        .transform((v) => v || null)
        .default(''),
      /** 飞书 App ID；与 secret 一起填写时更新凭据。 */
      appId: z.string().trim().min(1).max(200).optional(),
      /** 飞书 App Secret 或 Telegram Bot Token；只写不回显。 */
      secret: z.string().trim().min(1).max(500).optional(),
      forgetCredential: z.boolean().default(false),
    })
    .strict()
    .refine((v) => v.provider !== 'feishu' || (v.secret === undefined) === (v.appId === undefined), {
      message: '飞书需要同时填写 App ID 和 App Secret',
    }),
  'channel.pairings': z.object({}),
  'channel.decidePairing': z.object({ code: z.string().regex(/^[A-Z0-9]{8}$/), approve: z.boolean() }),
  'channel.accounts': z.object({}),
  /** 解绑（revoked），或让已解绑的账号可以重新配对（unbound）。 */
  'channel.setAccountStatus': z.object({ accountId: Id, expectedVersion: Version, status: z.enum(['revoked', 'unbound']) }),
  'channel.groups': z.object({}),
  'channel.setGroupAllowed': z.object({ conversationId: Id, expectedVersion: Version, allowed: z.boolean() }),
  'agent.settings': z.object({}),
  'agent.setExecutor': z.object({ role: AgentRole, expectedVersion: Version, executor: Executor }),
  'agent.overrides': z.object({ workspaceId: Id }),
  /** executor 为 null 时取消该项目对这个角色的覆盖。 */
  'agent.setOverride': z.object({ workspaceId: Id, role: AgentRole, executor: Executor.nullable() }),
} as const;
export type CommandName = keyof typeof CommandArgs;
export const COMMAND_NAMES = Object.keys(CommandArgs) as [CommandName, ...CommandName[]];
export type CommandArgsOf<N extends CommandName> = z.input<(typeof CommandArgs)[N]>;

/** 各命令的返回值；服务端处理函数与客户端调用共用，返回 void 的命令结果为 null。 */
export interface CommandResults {
  'service.status': { version: string; startedAt: string; interruptedRuns: number; runtime: string };
  'task.create': TaskDetail;
  'task.list': TaskSummary[];
  'task.get': TaskDetail;
  'task.cancel': void;
  'approval.decide': void;
  'review.decide': void;
  'run.recover': void;
  'run.checkOutput': string;
  'merge.redo': void;
  'plan.confirm': void;
  'plan.reject': void;
  'events.since': PersistentEvent[];
  'attention.list': AttentionItem[];
  'attention.markRead': void;
  'messages.search': MessageRecord[];
  'maintenance.backup': { path: string };
  'workspace.list': WorkspaceRecord[];
  'workspace.setRemoteApprovalLevel': void;
  'channel.overview': ChannelOverview[];
  'channel.configure': ChannelOverview[];
  'channel.pairings': PairingRecord[];
  'channel.decidePairing': void;
  'channel.accounts': ChannelAccountRecord[];
  'channel.setAccountStatus': void;
  'channel.groups': ConversationRecord[];
  'channel.setGroupAllowed': void;
  'agent.settings': AgentSettings;
  'agent.setExecutor': void;
  'agent.overrides': AgentOverrideRecord[];
  'agent.setOverride': void;
}
export type CommandResultOf<N extends CommandName> = CommandResults[N];

/** 桌面主进程转给渲染进程的命令结果（跨 contextBridge 的异常会丢掉错误码，所以用结果对象）。 */
export type RendererResult<T = unknown> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string };

export const ClientFrame = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hello'),
    schemaVersion: z.literal(SCHEMA_VERSION),
    token: z.string().min(32),
    client: z.string().min(1).max(64),
    /** 断线重连时带上最后收到的持久事件序号，服务端先补发其后的事件再回 welcome。首次连接不带。 */
    afterSeq: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal('command'), id: Id, name: z.enum(COMMAND_NAMES), args: z.unknown() }),
  /** MCP 桥的握手：只带这次 Run 的一次性令牌，连接之后只能列出、调用这个角色的工具，收不到事件。 */
  z.object({ kind: z.literal('mcp_hello'), schemaVersion: z.literal(SCHEMA_VERSION), token: z.string().min(32).max(200) }),
  z.object({ kind: z.literal('mcp_list'), id: Id }),
  z.object({ kind: z.literal('mcp_call'), id: Id, tool: z.string().min(1).max(64), args: z.unknown() }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/** MCP 桥暴露给执行器的一个工具（MCP tools/list 的条目）。 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const ErrorCode = z.enum([
  'unauthorized',
  'bad_request',
  'not_found',
  'conflict',
  'invalid_transition',
  'internal',
  /** 桌面端：本地服务未连接。 */
  'unavailable',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ResultFrame = z.discriminatedUnion('ok', [
  z.object({ kind: z.literal('result'), id: Id, ok: z.literal(true), value: z.unknown() }),
  z.object({
    kind: z.literal('result'),
    id: Id,
    ok: z.literal(false),
    error: z.object({ code: ErrorCode, message: z.string() }),
  }),
]);
export type ResultFrame = z.infer<typeof ResultFrame>;

export const ServerFrame = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('welcome'),
    schemaVersion: z.literal(SCHEMA_VERSION),
    serviceVersion: z.string(),
    /** 当前最大持久事件序号。首次连接（未带 afterSeq）不补发历史，客户端从这里开始续拉。 */
    headSeq: z.number().int().nonnegative(),
  }),
  ResultFrame,
  z.object({ kind: z.literal('event'), event: PersistentEvent }),
  z.object({ kind: z.literal('ephemeral'), event: EphemeralEvent }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
