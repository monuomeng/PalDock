import { z } from 'zod';
import { EphemeralEvent, PersistentEvent } from './events.js';
import { CheckCommand, type AttentionItem, type MessageRecord, type TaskDetail, type TaskSummary } from './records.js';
import { ApprovalDecision, AttentionKind, ReviewDecision, SCHEMA_VERSION } from './states.js';

/** 单帧上限；超长帧直接断开，防止本机客户端撑爆内存。 */
export const MAX_FRAME_BYTES = 1024 * 1024;

const Id = z.string().min(1).max(200);
const Version = z.number().int().nonnegative();

/** 命令名 → 参数 schema。新增命令只在这里登记，服务端和客户端共用。 */
export const CommandArgs = {
  'service.status': z.object({}),
  'task.create': z
    .object({
      /** 用户在桌面选的项目目录（git 仓库）。 */
      rootPath: z.string().min(1).max(1000),
      goal: z.string().trim().min(1).max(8000),
      check: CheckCommand.optional(),
      /** 用户已看过完整命令和「以你的账户权限运行」的提示并确认；未确认的命令不会运行。 */
      checkConfirmed: z.boolean().default(false),
      /** 客户端为每次提交生成；重复提交返回同一个任务。 */
      idempotencyKey: z.string().min(8).max(100),
    })
    .strict(),
  'task.list': z.object({ limit: z.number().int().positive().max(500).default(100) }),
  'task.get': z.object({ taskId: Id }),
  'task.cancel': z.object({ taskId: Id }),
  'approval.decide': z.object({ approvalId: Id, expectedVersion: Version, decision: ApprovalDecision }),
  'review.decide': z
    .object({ subtaskId: Id, expectedVersion: Version, decision: ReviewDecision, note: z.string().trim().max(2000).optional() })
    .refine((v) => v.decision === 'accept' || (v.note?.length ?? 0) > 0, { message: '退回重做需要写明原因' }),
  /** 服务重启后被中断的子任务：恢复（续做同一 thread）、重新开始（新 thread）或放弃。 */
  'run.recover': z.object({ subtaskId: Id, expectedVersion: Version, action: z.enum(['resume', 'restart', 'abandon']) }),
  'run.checkOutput': z.object({ runId: Id }),
  'events.since': z.object({
    afterSeq: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(1000).default(200),
  }),
  'attention.list': z.object({}),
  'attention.markRead': z.object({ itemKind: AttentionKind, itemId: Id }),
  'messages.search': z.object({ query: z.string().min(1).max(200), limit: z.number().int().positive().max(100).default(20) }),
  'maintenance.backup': z.object({}),
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
  'events.since': PersistentEvent[];
  'attention.list': AttentionItem[];
  'attention.markRead': void;
  'messages.search': MessageRecord[];
  'maintenance.backup': { path: string };
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
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

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
