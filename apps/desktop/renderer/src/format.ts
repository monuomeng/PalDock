import type { ApprovalStatus, AttentionKind, CheckStatus, PlanStatus, RiskLevel, RunStatus, SubtaskStatus, TaskRecord } from '@paldock/contracts';

/** 状态与类别的中文名。颜色不是唯一提示：界面上同时显示文字。 */
export const SUBTASK_LABEL: Record<SubtaskStatus, string> = {
  draft: '草稿',
  queued: '排队中',
  running: '执行中',
  waiting_approval: '等待审批',
  waiting_dependency: '等待依赖',
  blocked: '阻塞',
  review: '待命中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export const PLAN_LABEL: Record<PlanStatus, string> = { proposed: '待确认', confirmed: '已确认', rejected: '已退回', superseded: '已被新一版取代' };

export const RUN_LABEL: Record<RunStatus, string> = {
  starting: '启动中',
  running: '执行中',
  waiting_approval: '等待审批',
  unconfirmed: '执行状态待确认',
  interrupted: '已中断',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export const APPROVAL_LABEL: Record<ApprovalStatus, string> = {
  pending: '待审批',
  approved: '已允许',
  denied: '已拒绝',
  expired: '已过期（自动拒绝）',
  cancelled: '已取消',
};

export const RISK_LABEL: Record<RiskLevel, string> = { low: '低风险', medium: '中风险', high: '高风险' };

export const ATTENTION_LABEL: Record<AttentionKind, string> = {
  approval: '审批',
  review: '待命中',
  blocked: '阻塞',
  unconfirmed_run: '执行状态待确认',
};

export const CHECK_LABEL: Record<CheckStatus, string> = {
  not_configured: '未设置检查命令',
  not_confirmed: '检查命令未确认，未运行',
  passed: '通过',
  failed: '未通过',
  timed_out: '超时',
  cancelled: '已取消',
  error: '无法运行',
};

/** 任务详情里显示的检查命令（参数按空格拼接，仅供阅读）。 */
export function checkCommandText({ checkCommand, checkConfirmedAt }: TaskRecord): string {
  if (!checkCommand) return '未设置';
  const text = [checkCommand.executable, ...checkCommand.args].join(' ');
  return checkConfirmedAt ? text : `${text}（未确认，不会运行）`;
}

const timeFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const time = (iso: string | null | undefined) => (iso ? timeFormat.format(new Date(iso)) : '—');

export function duration(fromIso: string, toIso: string | null): string {
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}
