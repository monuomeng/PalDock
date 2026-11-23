import type { PersistentEvent, PersistentEventBody } from '@paldock/contracts';
import { DomainError, approvalMachine, runMachine, subtaskMachine, taskMachine, type StateMachine } from '@paldock/domain';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';

/** 写操作的统一返回：最新状态（来自 RETURNING）+ 同事务写入的事件，供调用方广播。 */
export interface Change<T> {
  record: T;
  events: PersistentEvent[];
}

type StatusEventType = Extract<PersistentEventBody['type'], `${string}.status_changed`>;

interface StatusTable<S extends string> {
  machine: StateMachine<S>;
  eventType: StatusEventType | undefined;
  select: string;
  update: string;
}

/** 表名来自固定白名单，不接受外部输入，因此可以安全地拼进 SQL。 */
function statusTable<S extends string>(
  table: string,
  machine: StateMachine<S>,
  eventType: StatusEventType | undefined,
  returning: string,
  extraSet = '',
): StatusTable<S> {
  return {
    machine,
    eventType,
    select: `SELECT status, version FROM ${table} WHERE id = ?`,
    update: `UPDATE ${table} SET status = $to, version = version + 1${extraSet} WHERE id = $id AND version = $version RETURNING ${returning}`,
  };
}

export const STATUS_TABLES = {
  task: statusTable(
    'tasks',
    taskMachine,
    'task.status_changed',
    'id, workspace_id AS workspaceId, title, status, version, updated_at AS updatedAt',
    ', updated_at = $at',
  ),
  subtask: statusTable(
    'subtasks',
    subtaskMachine,
    'subtask.status_changed',
    'id, task_id AS taskId, role, goal, status, rework_count AS reworkCount, version',
    // 从 review 退回重做（→ queued）时累计次数，不设上限
    `, updated_at = $at, rework_count = rework_count + (status = 'review' AND $to = 'queued')`,
  ),
  run: statusTable(
    'runs',
    runMachine,
    'run.status_changed',
    'id, subtask_id AS subtaskId, attempt, runtime, native_session_id AS nativeSessionId, status, version',
    `, ended_at = CASE WHEN $to IN ('succeeded', 'failed', 'cancelled') THEN $at ELSE ended_at END`,
  ),
  // 审批决定的事件是 approval.decided（带渠道），由调用方追加
  approval: statusTable(
    'approvals',
    approvalMachine,
    undefined,
    'id, run_id AS runId, risk_level AS riskLevel, summary, status, version',
    ', decided_at = $at',
  ),
} as const;

/**
 * 状态迁移：读当前状态 → 校验版本与状态机 → 带 version 条件更新 → 追加事件。
 * 必须在调用方的事务内执行；version 不符返回 conflict，由调用方重新读取后决定。
 * update 语句统一使用命名参数 $to / $id / $at / $version。
 */
export function transitionStatus<S extends string, T>(
  db: Database,
  events: EventLog,
  spec: StatusTable<S>,
  id: string,
  expectedVersion: number,
  to: S,
  at: string,
  reason?: string,
): Change<T> {
  const current = db.get<{ status: S; version: number }>(spec.select, id);
  if (!current) throw new DomainError('not_found', `${spec.machine.name} 不存在：${id}`);
  if (current.version !== expectedVersion) {
    throw new DomainError('conflict', `${spec.machine.name} 已被修改（当前版本 ${current.version}）`);
  }
  spec.machine.assertTransition(current.status, to);

  const record = db.statement(spec.update).get({ to, id, at, version: expectedVersion }) as T;
  if (!spec.eventType) return { record, events: [] };
  const payload = reason === undefined ? { from: current.status, to } : { from: current.status, to, reason };
  const event = events.append(id, { type: spec.eventType, payload } as PersistentEventBody);
  return { record, events: [event] };
}
