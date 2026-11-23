import { randomUUID } from 'node:crypto';
import type {
  ApprovalChannel,
  ApprovalStatus,
  RemoteApprovalLevel,
  RiskLevel,
  RunStatus,
  SubtaskStatus,
  TaskStatus,
} from '@paldock/contracts';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import { STATUS_TABLES, transitionStatus, type Change } from './status-transition.js';

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
  version: number;
}

const SQL = {
  insertWorkspace: `
    INSERT INTO workspaces (id, name, root_path, created_at) VALUES (?, ?, ?, ?)
    RETURNING id, name, root_path AS rootPath, remote_approval_level AS remoteApprovalLevel, version`,
  insertTask: `
    INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?)
    RETURNING id, workspace_id AS workspaceId, title, status, version, updated_at AS updatedAt`,
  insertSubtask: `
    INSERT INTO subtasks (id, task_id, role, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)
    RETURNING id, task_id AS taskId, role, goal, status, rework_count AS reworkCount, version`,
  // 每次 Run 是独立尝试，attempt 在子任务内递增；旧 Run 及其证据保留
  insertRun: `
    INSERT INTO runs (id, subtask_id, attempt, runtime, status, started_at)
    VALUES (?1, ?2, (SELECT coalesce(max(attempt), 0) + 1 FROM runs WHERE subtask_id = ?2), ?3, 'starting', ?4)
    RETURNING id, subtask_id AS subtaskId, attempt, runtime, native_session_id AS nativeSessionId, status, version`,
  insertApproval: `
    INSERT INTO approvals (id, run_id, risk_level, summary, status, requested_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    RETURNING id, run_id AS runId, risk_level AS riskLevel, summary, status, version`,
  setApprovalChannel: `UPDATE approvals SET decided_via = ? WHERE id = ?`,
  selectTask: `SELECT id, workspace_id AS workspaceId, title, status, version, updated_at AS updatedAt FROM tasks WHERE id = ?`,
} as const;

/**
 * 任务板的写入口：任务、子任务、Run、审批。每个写方法一个事务，
 * 状态表与事件同时提交；返回值直接来自 RETURNING，不回查。
 */
export class TaskRepository {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private at(): string {
    return this.now().toISOString();
  }

  createWorkspace(name: string, rootPath: string): WorkspaceRecord {
    return this.db.get<WorkspaceRecord>(SQL.insertWorkspace, `ws_${randomUUID()}`, name, rootPath, this.at())!;
  }

  createTask(workspaceId: string, title: string): Change<TaskRecord> {
    return this.db.transaction(() => {
      const at = this.at();
      const record = this.db.get<TaskRecord>(SQL.insertTask, `task_${randomUUID()}`, workspaceId, title, at, at)!;
      const event = this.events.append(record.id, { type: 'task.created', payload: { workspaceId, title } });
      return { record, events: [event] };
    });
  }

  createSubtask(taskId: string, role: string, goal: string): Change<SubtaskRecord> {
    return this.db.transaction(() => {
      const at = this.at();
      const record = this.db.get<SubtaskRecord>(SQL.insertSubtask, `sub_${randomUUID()}`, taskId, role, goal, at, at)!;
      const event = this.events.append(record.id, { type: 'subtask.created', payload: { taskId, role } });
      return { record, events: [event] };
    });
  }

  createRun(subtaskId: string, runtime: string): Change<RunRecord> {
    return this.db.transaction(() => {
      const record = this.db.get<RunRecord>(SQL.insertRun, `run_${randomUUID()}`, subtaskId, runtime, this.at())!;
      const event = this.events.append(record.id, {
        type: 'run.created',
        payload: { subtaskId, runtime, attempt: record.attempt },
      });
      return { record, events: [event] };
    });
  }

  requestApproval(runId: string, riskLevel: RiskLevel, summary: string, ttlMs: number): Change<ApprovalRecord> {
    return this.db.transaction(() => {
      const now = this.now();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      const record = this.db.get<ApprovalRecord>(
        SQL.insertApproval,
        `appr_${randomUUID()}`,
        runId,
        riskLevel,
        summary,
        now.toISOString(),
        expiresAt,
      )!;
      const event = this.events.append(record.id, {
        type: 'approval.requested',
        payload: { runId, riskLevel, summary, expiresAt },
      });
      return { record, events: [event] };
    });
  }

  /** 先到者为准：两端同时处理时只有带着正确 version 的一方成功，另一方得到 conflict。 */
  decideApproval(
    approvalId: string,
    expectedVersion: number,
    status: Exclude<ApprovalStatus, 'pending'>,
    via: ApprovalChannel,
  ): Change<ApprovalRecord> {
    return this.db.transaction(() => {
      const change = transitionStatus<ApprovalStatus, ApprovalRecord>(
        this.db, this.events, STATUS_TABLES.approval, approvalId, expectedVersion, status, this.at(),
      );
      this.db.run(SQL.setApprovalChannel, via, approvalId);
      const event = this.events.append(approvalId, { type: 'approval.decided', payload: { status, via } });
      return { record: change.record, events: [event] };
    });
  }

  transitionTask(id: string, expectedVersion: number, to: TaskStatus, reason?: string): Change<TaskRecord> {
    return this.db.transaction(() =>
      transitionStatus(this.db, this.events, STATUS_TABLES.task, id, expectedVersion, to, this.at(), reason),
    );
  }

  transitionSubtask(id: string, expectedVersion: number, to: SubtaskStatus, reason?: string): Change<SubtaskRecord> {
    return this.db.transaction(() =>
      transitionStatus(this.db, this.events, STATUS_TABLES.subtask, id, expectedVersion, to, this.at(), reason),
    );
  }

  transitionRun(id: string, expectedVersion: number, to: RunStatus, reason?: string): Change<RunRecord> {
    return this.db.transaction(() =>
      transitionStatus(this.db, this.events, STATUS_TABLES.run, id, expectedVersion, to, this.at(), reason),
    );
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.db.get<TaskRecord>(SQL.selectTask, taskId);
  }
}
