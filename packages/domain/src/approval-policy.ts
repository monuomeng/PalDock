import type { RemoteApprovalLevel, RiskLevel } from '@paldock/contracts';

/** 远程审批等级决定升级到外部渠道后能批准哪些风险级别；L0 只提醒。 */
const REMOTELY_APPROVABLE: Readonly<Record<RemoteApprovalLevel, ReadonlySet<RiskLevel>>> = {
  L0: new Set(),
  L1: new Set(['low', 'medium']),
  L2: new Set(['low', 'medium', 'high']),
};

export function canApproveRemotely(level: RemoteApprovalLevel, risk: RiskLevel): boolean {
  return REMOTELY_APPROVABLE[level].has(risk);
}

/** 用户 2026-11-24 确认 3 分钟（07 待决事项 5）。 */
export const DEFAULT_ESCALATION_WAIT_MS = 3 * 60 * 1000;

export interface DesktopPresence {
  uiRunning: boolean;
  locked: boolean;
  idle: boolean;
}

/**
 * 桌面优先：满足任一条件才把审批升级到已绑定的外部单聊。
 * 升级后两端都能处理，以先到者为准（由审批的 version 校验，不在此判断）。
 */
export function shouldEscalateApproval(
  requestedAtMs: number,
  nowMs: number,
  desktop: DesktopPresence,
  waitMs = DEFAULT_ESCALATION_WAIT_MS,
): boolean {
  return !desktop.uiRunning || desktop.locked || desktop.idle || nowMs - requestedAtMs >= waitMs;
}

/** 风险分级草案（02「审批路由」），待用户确认；分级由操作类型判定，不采信模型自报。 */
export type OperationKind =
  | 'read'
  | 'write_in_worktree'
  | 'run_tests'
  | 'run_command_in_worktree'
  | 'install_dependencies'
  | 'network_in_worktree'
  | 'push_remote'
  | 'merge_branch'
  | 'write_outside_worktree'
  | 'delete_outside_worktree'
  | 'send_external_message'
  | 'expand_permissions';

const RISK_BY_OPERATION: Readonly<Record<OperationKind, RiskLevel>> = {
  read: 'low',
  write_in_worktree: 'low',
  run_tests: 'low',
  // 沙箱之外的命令（on-request 下才会来审批），无法从命令文本判断副作用，按中风险
  run_command_in_worktree: 'medium',
  install_dependencies: 'medium',
  network_in_worktree: 'medium',
  push_remote: 'high',
  merge_branch: 'high',
  write_outside_worktree: 'high',
  delete_outside_worktree: 'high',
  send_external_message: 'high',
  expand_permissions: 'high',
};

export function classifyRisk(operation: OperationKind): RiskLevel {
  return RISK_BY_OPERATION[operation];
}
