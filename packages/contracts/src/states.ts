import { z } from 'zod';

/** 所有跨进程、可持久化的数据结构都带此版本号；不兼容变更时递增并补迁移。 */
export const SCHEMA_VERSION = 1;

export const TASK_STATUSES = [
  'draft',
  'queued',
  'running',
  'waiting_approval',
  'waiting_dependency',
  'blocked',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** 子任务比任务多一个 `review`：助手交付后只能进入 review，由验收闸门或用户推进。 */
export const SUBTASK_STATUSES = [...TASK_STATUSES, 'review'] as const;
export const SubtaskStatus = z.enum(SUBTASK_STATUSES);
export type SubtaskStatus = z.infer<typeof SubtaskStatus>;

/**
 * `interrupted`：服务重启时恢复程序标记；
 * `unconfirmed`：服务仍在但与执行器断线（「执行状态待确认」），查实后再更新。
 */
export const RUN_STATUSES = [
  'starting',
  'running',
  'waiting_approval',
  'unconfirmed',
  'interrupted',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export const RunStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatus>;

export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired', 'cancelled'] as const;
export const ApprovalStatus = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const RiskLevel = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevel>;

/** 按项目配置的远程审批等级，只能在桌面修改。 */
export const RemoteApprovalLevel = z.enum(['L0', 'L1', 'L2']);
export type RemoteApprovalLevel = z.infer<typeof RemoteApprovalLevel>;

export const ApprovalChannel = z.enum(['desktop', 'feishu', 'telegram', 'policy']);
export type ApprovalChannel = z.infer<typeof ApprovalChannel>;

export const MessageRole = z.enum(['user', 'assistant', 'system']);
export type MessageRole = z.infer<typeof MessageRole>;

/** 「待我处理」的条目类型，与 attention_items 视图的 kind 列一致。 */
export const AttentionKind = z.enum(['approval', 'blocked', 'review', 'unconfirmed_run']);
export type AttentionKind = z.infer<typeof AttentionKind>;

/** 执行器审批请求的类别；`permissions` 是权限扩展（放开沙箱、联网），P1 一律只能拒绝。 */
export const APPROVAL_KINDS = ['command', 'file_change', 'permissions', 'check_command', 'other'] as const;
export const ApprovalKind = z.enum(APPROVAL_KINDS);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

/** 审批的用户决定。「本会话允许」P1 不开放。 */
export const ApprovalDecision = z.enum(['allow_once', 'deny']);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/** 检查命令的结果；`not_confirmed` 表示用户未确认，命令不会运行。 */
export const CHECK_STATUSES = ['not_configured', 'not_confirmed', 'passed', 'failed', 'timed_out', 'cancelled', 'error'] as const;
export const CheckStatus = z.enum(CHECK_STATUSES);
export type CheckStatus = z.infer<typeof CheckStatus>;

export const ReviewDecision = z.enum(['accept', 'rework']);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

export const SESSION_KINDS = ['main', 'agent'] as const;
export const SessionKind = z.enum(SESSION_KINDS);
export type SessionKind = z.infer<typeof SessionKind>;
