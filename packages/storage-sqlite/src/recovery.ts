import type { InterruptedRun, RecoveryReport, RunStatus, SubtaskStatus, TaskStatus } from '@paldock/contracts';
import type { Clock } from './clock.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import { statusChanged } from './writes.js';

/**
 * 「未结束且未中断」的 Run 状态。必须与部分索引 runs_active 的条件逐字一致（SQLite 按文本匹配部分索引），
 * 测试校验它与 runMachine 推导出的集合相同，新增状态时会提醒同步。
 */
export const ACTIVE_RUN_STATUSES = ['starting', 'running', 'waiting_approval', 'unconfirmed'] as const;
const ACTIVE = `status IN (${ACTIVE_RUN_STATUSES.map((s) => `'${s}'`).join(', ')})`;
/** 排队中或执行中的子任务与任务；与部分索引 subtasks_in_progress / tasks_in_progress 的条件逐字一致。 */
const IN_PROGRESS = `status IN ('queued', 'running')`;

const SQL = {
  activeRuns: `SELECT id, subtask_id AS subtaskId, status, native_thread_id AS nativeThreadId FROM runs WHERE ${ACTIVE}`,
  markRunsInterrupted: `
    UPDATE runs SET status = 'interrupted', version = version + 1, failure_reason = ?
     WHERE ${ACTIVE}`,
  // 服务或执行器重启后执行器侧的请求已失效；走 approvals_pending
  cancelPendingApprovals: `
    UPDATE approvals SET status = 'cancelled', version = version + 1, decided_at = ?, decided_via = 'policy'
     WHERE status = 'pending'
    RETURNING id`,
  subtasksInProgress: `SELECT id, status FROM subtasks WHERE ${IN_PROGRESS}`,
  blockSubtasks: `
    UPDATE subtasks SET status = 'blocked', status_reason = ?, version = version + 1, updated_at = ?
     WHERE ${IN_PROGRESS}`,
  tasksInProgress: `SELECT id, status FROM tasks WHERE ${IN_PROGRESS}`,
  blockTasks: `
    UPDATE tasks SET status = 'blocked', version = version + 1, updated_at = ?
     WHERE ${IN_PROGRESS}`,
  reopenInbox: `
    UPDATE inbox SET status = 'pending', lease_until = NULL
     WHERE status = 'processing'`,
  // 发送中被打断的出站消息可能已经到达平台：记为 unknown，不重发（走 outbox_sending）
  unknownOutbox: `UPDATE outbox SET status = 'unknown', last_error = ? WHERE status = 'sending'`,
} as const;

/**
 * 服务启动时（此时没有任何执行器连接、排队也只在内存里）和正常退出前运行，同一事务：
 * - 未结束的 Run 置为 interrupted，挂起的审批置为 cancelled（执行器侧请求已失效，恢复后会重新请求）；
 * - 执行中或还在排队的子任务和任务一律置为 blocked，出现在「待我处理」里，由用户选择恢复、重新开始或放弃；
 * - 处理中的入站事件放回队列重做；发送中的出站消息记为 unknown，不重发。
 * 外部副作用是否已发生在这里无法判定，交给后续核实。
 */
export function interruptActiveWork(db: Database, events: EventLog, clock: Clock, reason: string): RecoveryReport {
  return db.transaction(() => {
    const at = clock.iso();
    const active = db.all<InterruptedRun & { status: RunStatus }>(SQL.activeRuns);
    db.run(SQL.markRunsInterrupted, reason);
    const emitted = active.map((run) =>
      events.append(run.id, { type: 'run.status_changed', payload: statusChanged(run.status, 'interrupted', reason) }),
    );
    for (const { id } of db.all<{ id: string }>(SQL.cancelPendingApprovals, at)) {
      emitted.push(events.append(id, { type: 'approval.decided', payload: { status: 'cancelled', via: 'policy' } }));
    }
    const subtasks = db.all<{ id: string; status: SubtaskStatus }>(SQL.subtasksInProgress);
    db.run(SQL.blockSubtasks, reason, at);
    for (const s of subtasks) {
      emitted.push(events.append(s.id, { type: 'subtask.status_changed', payload: statusChanged(s.status, 'blocked', reason) }));
    }
    const tasks = db.all<{ id: string; status: TaskStatus }>(SQL.tasksInProgress);
    db.run(SQL.blockTasks, at);
    for (const t of tasks) {
      emitted.push(events.append(t.id, { type: 'task.status_changed', payload: statusChanged(t.status, 'blocked', reason) }));
    }
    return {
      interruptedRuns: active.map(({ id, subtaskId, nativeThreadId }) => ({ id, subtaskId, nativeThreadId })),
      blockedSubtasks: subtasks.map(({ id, status }) => ({ id, from: status })),
      reopenedInbox: db.run(SQL.reopenInbox),
      unknownOutbox: db.run(SQL.unknownOutbox, reason),
      events: emitted,
    };
  });
}
