import { randomUUID } from 'node:crypto';
import type {
  ApprovalChannel,
  ApprovalStatus,
  PersistentEventBody,
  RemoteApprovalLevel,
  RiskLevel,
  RunStatus,
  SubtaskStatus,
  TaskStatus,
} from '@paldock/contracts';
import { approvalMachine, runMachine, subtaskMachine, taskMachine } from '@paldock/domain';
import type { Clock } from './clock.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import {
  applyTransition,
  insertWithEvent,
  statusChanged,
  type Change,
  type TransitionPlan,
  type TransitionSpec,
} from './writes.js';

export interface WorkspaceRecord {
  id: string;
  name: string;
  rootPath: string;
  remoteApprovalLevel: RemoteApprovalLevel;
  version: number;
}

export interface TaskRecord {
  id: string;
  workspaceId: string;
  title: string;
  status: TaskStatus;
  version: number;
  updatedAt: string;
}

export interface SubtaskRecord {
  id: string;
  taskId: string;
  role: string;
  goal: string;
  status: SubtaskStatus;
  reworkCount: number;
  version: number;
}

export interface RunRecord {
  id: string;
  subtaskId: string;
  attempt: number;
  runtime: string;
  nativeSessionId: string | null;
  status: RunStatus;
  version: number;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  riskLevel: RiskLevel;
  summary: string;
  status: ApprovalStatus;
  decidedVia: ApprovalChannel | null;
  version: number;
}

/** 每张表的 RETURNING 列只定义一次，插入和更新返回同一形状。 */
const COLUMNS = {
  workspace: `id, name, root_path AS rootPath, remote_approval_level AS remoteApprovalLevel, version`,
  task: `id, workspace_id AS workspaceId, title, status, version, updated_at AS updatedAt`,
  subtask: `id, task_id AS taskId, role, goal, status, rework_count AS reworkCount, version`,
  run: `id, subtask_id AS subtaskId, attempt, runtime, native_session_id AS nativeSessionId, status, version`,
  approval: `id, run_id AS runId, risk_level AS riskLevel, summary, status, decided_via AS decidedVia, version`,
} as const;

const SQL = {
  insertWorkspace: `
    INSERT INTO workspaces (id, name, root_path, created_at) VALUES (?, ?, ?, ?)
    RETURNING ${COLUMNS.workspace}`,
  insertTask: `
    INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'draft', ?4, ?4)
    RETURNING ${COLUMNS.task}`,
  insertSubtask: `
    INSERT INTO subtasks (id, task_id, role, goal, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?5)
    RETURNING ${COLUMNS.subtask}`,
  // 每次 Run 是独立尝试，attempt 在子任务内递增（走 UNIQUE (subtask_id, attempt) 索引）；旧 Run 及其证据保留
  insertRun: `
    INSERT INTO runs (id, subtask_id, attempt, runtime, status, started_at)
    VALUES (?1, ?2, (SELECT coalesce(max(attempt), 0) + 1 FROM runs WHERE subtask_id = ?2), ?3, 'starting', ?4)
    RETURNING ${COLUMNS.run}`,
  insertApproval: `
    INSERT INTO approvals (id, run_id, risk_level, summary, status, requested_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    RETURNING ${COLUMNS.approval}`,
  selectTask: `SELECT ${COLUMNS.task} FROM tasks WHERE id = ?`,
} as const;

const TRANSITIONS = {
  task: {
    machine: taskMachine,
    select: `SELECT status, version FROM tasks WHERE id = ?`,
    update: `
      UPDATE tasks SET status = $to, version = version + 1, updated_at = $at
       WHERE id = $id AND version = $version
      RETURNING ${COLUMNS.task}`,
  },
  subtask: {
    machine: subtaskMachine,
    select: `SELECT status, version FROM subtasks WHERE id = ?`,
    update: `
      UPDATE subtasks SET status = $to, version = version + 1, updated_at = $at, rework_count = rework_count + $rework
       WHERE id = $id AND version = $version
      RETURNING ${COLUMNS.subtask}`,
  },
  run: {
    machine: runMachine,
    select: `SELECT status, version FROM runs WHERE id = ?`,
    update: `
      UPDATE runs SET status = $to, version = version + 1, ended_at = coalesce($endedAt, ended_at)
       WHERE id = $id AND version = $version
      RETURNING ${COLUMNS.run}`,
  },
  approval: {
    machine: approvalMachine,
    select: `SELECT status, version FROM approvals WHERE id = ?`,
    update: `
      UPDATE approvals SET status = $to, version = version + 1, decided_at = $at, decided_via = $via
       WHERE id = $id AND version = $version
      RETURNING ${COLUMNS.approval}`,
  },
} satisfies {
  task: TransitionSpec<TaskStatus>;
  subtask: TransitionSpec<SubtaskStatus>;
  run: TransitionSpec<RunStatus>;
  approval: TransitionSpec<ApprovalStatus>;
};

const newId = (prefix: string) => `${prefix}_${randomUUID()}`;

/**
 * 任务板的写入口：任务、子任务、Run、审批。每个写方法一个事务，
 * 状态表与事件同时提交；返回值直接来自 RETURNING，不回查。
 */
export class TaskRepository {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly clock: Clock,
  ) {}

  createWorkspace(name: string, rootPath: string): WorkspaceRecord {
    return this.db.get<WorkspaceRecord>(SQL.insertWorkspace, newId('ws'), name, rootPath, this.clock.iso())!;
  }

  createTask(workspaceId: string, title: string): Change<TaskRecord> {
    return this.insert(SQL.insertTask, [newId('task'), workspaceId, title, this.clock.iso()], () => ({
      type: 'task.created',
      payload: { workspaceId, title },
    }));
  }

  createSubtask(taskId: string, role: string, goal: string): Change<SubtaskRecord> {
    return this.insert(SQL.insertSubtask, [newId('sub'), taskId, role, goal, this.clock.iso()], () => ({
      type: 'subtask.created',
      payload: { taskId, role },
    }));
  }

  createRun(subtaskId: string, runtime: string): Change<RunRecord> {
    return this.insert<RunRecord>(SQL.insertRun, [newId('run'), subtaskId, runtime, this.clock.iso()], (run) => ({
      type: 'run.created',
      payload: { subtaskId, runtime, attempt: run.attempt },
    }));
  }

  requestApproval(runId: string, riskLevel: RiskLevel, summary: string, ttlMs: number): Change<ApprovalRecord> {
    const expiresAt = this.clock.isoAfter(ttlMs);
    return this.insert(SQL.insertApproval, [newId('appr'), runId, riskLevel, summary, this.clock.iso(), expiresAt], () => ({
      type: 'approval.requested',
      payload: { runId, riskLevel, summary, expiresAt },
    }));
  }

  transitionTask(id: string, expectedVersion: number, to: TaskStatus, reason?: string): Change<TaskRecord> {
    return this.transition(TRANSITIONS.task, id, expectedVersion, to, (from) => ({
      params: { at: this.clock.iso() },
      event: { type: 'task.status_changed', payload: statusChanged(from, to, reason) },
    }));
  }

  /** 从 review 退回重做（→ queued）时累计次数，不设上限。 */
  transitionSubtask(id: string, expectedVersion: number, to: SubtaskStatus, reason?: string): Change<SubtaskRecord> {
    return this.transition(TRANSITIONS.subtask, id, expectedVersion, to, (from) => ({
      params: { at: this.clock.iso(), rework: Number(from === 'review' && to === 'queued') },
      event: { type: 'subtask.status_changed', payload: statusChanged(from, to, reason) },
    }));
  }

  transitionRun(id: string, expectedVersion: number, to: RunStatus, reason?: string): Change<RunRecord> {
    return this.transition(TRANSITIONS.run, id, expectedVersion, to, (from) => ({
      params: { endedAt: runMachine.isTerminal(to) ? this.clock.iso() : null },
      event: { type: 'run.status_changed', payload: statusChanged(from, to, reason) },
    }));
  }

  /** 先到者为准：两端同时处理时只有带着正确 version 的一方成功，另一方得到 conflict。 */
  decideApproval(
    id: string,
    expectedVersion: number,
    status: Exclude<ApprovalStatus, 'pending'>,
    via: ApprovalChannel,
  ): Change<ApprovalRecord> {
    return this.transition(TRANSITIONS.approval, id, expectedVersion, status, () => ({
      params: { at: this.clock.iso(), via },
      event: { type: 'approval.decided', payload: { status, via } },
    }));
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.db.get<TaskRecord>(SQL.selectTask, taskId);
  }

  private insert<T extends { id: string }>(
    sql: string,
    params: (string | number)[],
    toEvent: (record: T) => PersistentEventBody,
  ): Change<T> {
    return insertWithEvent(this.db, this.events, sql, params, toEvent);
  }

  private transition<S extends string, T>(
    spec: TransitionSpec<S>,
    id: string,
    expectedVersion: number,
    to: S,
    plan: (from: S) => TransitionPlan,
  ): Change<T> {
    return applyTransition<S, T>(this.db, this.events, spec, id, expectedVersion, to, plan);
  }
}
