import type { InterruptedRun, RecoveryReport, RunStatus } from '@paldock/contracts';
import type { Clock } from './clock.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';

/**
 * 「未结束且未中断」的 Run 状态。必须与部分索引 runs_active 的条件逐字一致（SQLite 按文本匹配部分索引），
 * 测试校验它与 runMachine 推导出的集合相同，新增状态时会提醒同步。
 */
export const ACTIVE_RUN_STATUSES = ['starting', 'running', 'waiting_approval', 'unconfirmed'] as const;
const ACTIVE = `status IN (${ACTIVE_RUN_STATUSES.map((s) => `'${s}'`).join(', ')})`;

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
  blockSubtask: `
    UPDATE subtasks SET status = 'blocked', status_reason = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND status = 'running'
    RETURNING task_id AS taskId`,
  blockTask: `
    UPDATE tasks SET status = 'blocked', version = version + 1, updated_at = ?
     WHERE id = ? AND status = 'running'
    RETURNING id`,
  reopenInbox: `
    UPDATE inbox SET status = 'pending', lease_until = NULL
     WHERE status = 'processing'`,
} as const;

/**
 * 服务启动时（此时没有任何执行器连接）和正常退出前运行，同一事务：
 * - 未结束的 Run 置为 interrupted，挂起的审批置为 cancelled（执行器侧请求已失效，恢复后会重新请求）；
 * - 对应的子任务和任务置为 blocked，于是出现在「待我处理」里，由用户选择恢复、重新开始或放弃；
 * - 处理中的入站事件放回队列重做。
 * 外部副作用是否已发生在这里无法判定，交给后续核实。
 */
export function interruptActiveWork(db: Database, events: EventLog, clock: Clock, reason: string): RecoveryReport {
  return db.transaction(() => {
    const at = clock.iso();
    const active = db.all<InterruptedRun & { status: RunStatus }>(SQL.activeRuns);
    db.run(SQL.markRunsInterrupted, reason);
    const emitted = active.map((run) =>
      events.append(run.id, { type: 'run.status_changed', payload: { from: run.status, to: 'interrupted', reason } }),
    );
    for (const { id } of db.all<{ id: string }>(SQL.cancelPendingApprovals, at)) {
      emitted.push(events.append(id, { type: 'approval.decided', payload: { status: 'cancelled', via: 'policy' } }));
    }
    for (const subtaskId of new Set(active.map((run) => run.subtaskId))) {
      const blocked = db.get<{ taskId: string }>(SQL.blockSubtask, reason, at, subtaskId);
      if (!blocked) continue;
      emitted.push(events.append(subtaskId, { type: 'subtask.status_changed', payload: { from: 'running', to: 'blocked', reason } }));
      if (db.get(SQL.blockTask, at, blocked.taskId)) {
        emitted.push(events.append(blocked.taskId, { type: 'task.status_changed', payload: { from: 'running', to: 'blocked', reason } }));
      }
    }
    return {
      interruptedRuns: active.map(({ id, subtaskId, nativeThreadId }) => ({ id, subtaskId, nativeThreadId })),
      reopenedInbox: db.run(SQL.reopenInbox),
      events: emitted,
    };
  });
}
