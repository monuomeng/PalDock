import { z } from 'zod';
import { ChannelAccountStatus, ChannelProvider, ChannelState, InboundRejection } from './channels.js';
import {
  ApprovalChannel,
  ApprovalKind,
  CheckStatus,
  ReviewDecision,
  ApprovalStatus,
  MessageRole,
  RiskLevel,
  RunStatus,
  SCHEMA_VERSION,
  SubtaskStatus,
  RemoteApprovalLevel,
  TaskStatus,
  AgentRole,
  Executor,
} from './states.js';

const Id = z.string().min(1);
const Reason = z.string().max(500).optional();

export const RunNoticeCode = z.enum(['unknown_request', 'resume_failed', 'output_truncated']);
export type RunNoticeCode = z.infer<typeof RunNoticeCode>;

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
    payload: z.object({ runId: Id, kind: ApprovalKind, riskLevel: RiskLevel, expiresAt: z.iso.datetime() }),
  }),
  z.object({
    type: z.literal('approval.decided'),
    payload: z.object({ status: ApprovalStatus.exclude(['pending']), via: ApprovalChannel }),
  }),
  z.object({
    type: z.literal('message.created'),
    payload: z.object({ sessionId: Id, runId: Id.nullable(), role: MessageRole }),
  }),
  /** Run 结束后收集到证据；聚合 ID 为 runId。 */
  z.object({ type: z.literal('run.result_collected'), payload: z.object({ checkStatus: CheckStatus }) }),
  /** 用户验收或退回；聚合 ID 为产生证据的那次 runId。 */
  z.object({ type: z.literal('review.decided'), payload: z.object({ decision: ReviewDecision }) }),
  /** 需要让用户知道、但不改变状态的情况，例如执行器发来未识别的请求、恢复失败。 */
  z.object({
    type: z.literal('run.notice'),
    payload: z.object({ code: RunNoticeCode, detail: z.string().max(500) }),
  }),
  /** 审批已升级到外部单聊；聚合 ID 为 approvalId。 */
  z.object({ type: z.literal('approval.escalated'), payload: z.object({ channels: z.array(ChannelProvider) }) }),
  /** 项目设置（远程审批等级）变更；聚合 ID 为 workspaceId。 */
  z.object({ type: z.literal('workspace.settings_changed'), payload: z.object({ remoteApprovalLevel: RemoteApprovalLevel }) }),
  /** 角色的默认执行器变更；聚合 ID 为角色名。 */
  z.object({ type: z.literal('agent.profile_changed'), payload: z.object({ executor: Executor }) }),
  /** 项目对某个角色的执行器覆盖变更（null 为取消覆盖）；聚合 ID 为 workspaceId。 */
  z.object({ type: z.literal('workspace.agent_override_changed'), payload: z.object({ role: AgentRole, executor: Executor.nullable() }) }),
  /** 外部入站被拒绝（审计）；聚合 ID 为会话 ID，会话还没建立时为 `provider:account`。 */
  z.object({
    type: z.literal('channel.inbound_rejected'),
    payload: z.object({ provider: ChannelProvider, reason: InboundRejection }),
  }),
  /** 陌生账号发来消息，生成了配对码；聚合 ID 为渠道账号 ID。 */
  z.object({ type: z.literal('channel.pairing_requested'), payload: z.object({ provider: ChannelProvider }) }),
  /** 渠道账号绑定、拒绝或解绑；聚合 ID 为渠道账号 ID。 */
  z.object({
    type: z.literal('channel.account_changed'),
    payload: z.object({ provider: ChannelProvider, from: ChannelAccountStatus, to: ChannelAccountStatus }),
  }),
  /** 渠道启用、停用或凭据变更；聚合 ID 为 provider。 */
  z.object({ type: z.literal('channel.settings_changed'), payload: z.object({ provider: ChannelProvider, enabled: z.boolean() }) }),
  /** 会话设置（群白名单、默认项目）变更；聚合 ID 为会话 ID。 */
  z.object({
    type: z.literal('channel.conversation_changed'),
    payload: z.object({ groupAllowed: z.boolean(), defaultWorkspaceId: Id.nullable() }),
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
  z.object({
    type: z.literal('channel.status'),
    provider: ChannelProvider,
    state: ChannelState,
    detail: z.string().nullable(),
    since: z.iso.datetime(),
    recoveredAt: z.iso.datetime().nullable(),
  }),
]);
export type EphemeralEvent = z.infer<typeof EphemeralEvent>;
