import { z } from 'zod';
import { EphemeralEvent, PersistentEvent } from './events.js';
import { SCHEMA_VERSION, TaskStatus } from './states.js';

/** 单帧上限；超长帧直接断开，防止本机客户端撑爆内存。 */
export const MAX_FRAME_BYTES = 1024 * 1024;

const Id = z.string().min(1);

/** 命令名 → 参数 schema。新增命令只在这里登记，服务端和客户端共用。 */
export const CommandArgs = {
  'service.status': z.object({}),
  'workspace.create': z.object({ name: z.string().min(1).max(100), rootPath: z.string().min(1) }),
  'task.create': z.object({ workspaceId: Id, title: z.string().min(1).max(200) }),
  'task.transition': z.object({
    taskId: Id,
    expectedVersion: z.number().int().nonnegative(),
    to: TaskStatus,
    reason: z.string().max(500).optional(),
  }),
  'events.since': z.object({
    afterSeq: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(1000).default(200),
  }),
  'attention.list': z.object({}),
  'attention.markRead': z.object({ itemKind: z.string().min(1), itemId: Id }),
  'messages.search': z.object({ query: z.string().min(1).max(200), limit: z.number().int().positive().max(100).default(20) }),
} as const;
export type CommandName = keyof typeof CommandArgs;
export const COMMAND_NAMES = Object.keys(CommandArgs) as [CommandName, ...CommandName[]];
export type CommandArgsOf<N extends CommandName> = z.input<(typeof CommandArgs)[N]>;

export const ClientFrame = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hello'),
    schemaVersion: z.literal(SCHEMA_VERSION),
    token: z.string().min(32),
    client: z.string().min(1).max(64),
    /** 断线重连时带上最后收到的持久事件序号，服务端补发其后的事件。 */
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
  z.object({ kind: z.literal('welcome'), schemaVersion: z.literal(SCHEMA_VERSION), serviceVersion: z.string() }),
  ResultFrame,
  z.object({ kind: z.literal('event'), event: PersistentEvent }),
  z.object({ kind: z.literal('ephemeral'), event: EphemeralEvent }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
