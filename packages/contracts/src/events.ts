import { z } from 'zod';
import {
  ApprovalChannel,
  ApprovalStatus,
  MessageRole,
  RiskLevel,
  RunStatus,
  SCHEMA_VERSION,
  SubtaskStatus,
  TaskStatus,
} from './states.js';

const Id = z.string().min(1);
const Reason = z.string().max(500).optional();

const transition = <T extends z.ZodType>(status: T) => z.object({ from: status, to: status, reason: Reason });

/**
 * 持久事件的类型与载荷。载荷只放 ID、状态和摘要，不放消息正文或终端输出
 * （正文在 messages 表，按需读取；日志与事件都遵循默认脱敏）。
 */
export const PersistentEventBody = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('task.created'),
    payload: z.object({ workspaceId: Id, title: z.string().min(1).max(200) }),
  }),
  z.object({ type: z.literal('task.status_changed'), payload: transition(TaskStatus) }),
  z.object({
    type: z.literal('subtask.created'),
    payload: z.object({ taskId: Id, role: z.string().min(1) }),
  }),
  z.object({ type: z.literal('subtask.status_changed'), payload: transition(SubtaskStatus) }),
  z.object({
    type: z.literal('run.created'),
    payload: z.object({ subtaskId: Id, runtime: z.string().min(1), attempt: z.number().int().positive() }),
  }),
  z.object({ type: z.literal('run.status_changed'), payload: transition(RunStatus) }),
  z.object({
    type: z.literal('approval.requested'),
    payload: z.object({ runId: Id, riskLevel: RiskLevel, summary: z.string().max(500), expiresAt: z.iso.datetime() }),
  }),
  z.object({
    type: z.literal('approval.decided'),
    payload: z.object({ status: ApprovalStatus.exclude(['pending']), via: ApprovalChannel }),
  }),
  z.object({
    type: z.literal('message.created'),
    payload: z.object({ sessionId: Id, role: MessageRole }),
  }),
]);
export type PersistentEventBody = z.infer<typeof PersistentEventBody>;

/** 写入 events 表后的完整形态：`seq` 全局递增，客户端断线后按序号续拉。 */
export const PersistentEvent = z.intersection(
  z.object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    seq: z.number().int().positive(),
    aggregateId: Id,
    occurredAt: z.iso.datetime(),
  }),
  PersistentEventBody,
);
export type PersistentEvent = z.infer<typeof PersistentEvent>;

/** 临时事件：只在内存中广播，不入库、不重放（流式片段、心跳等）。 */
export const EphemeralEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.output_delta'), runId: Id, text: z.string() }),
  z.object({ type: z.literal('run.heartbeat'), runId: Id, at: z.iso.datetime() }),
  z.object({ type: z.literal('service.health'), status: z.enum(['ok', 'degraded']) }),
]);
export type EphemeralEvent = z.infer<typeof EphemeralEvent>;
