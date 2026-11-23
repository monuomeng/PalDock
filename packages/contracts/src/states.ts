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

export const AggregateKind = z.enum(['task', 'subtask', 'run', 'approval', 'message']);
export type AggregateKind = z.infer<typeof AggregateKind>;
