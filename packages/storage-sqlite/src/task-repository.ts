import { randomUUID } from 'node:crypto';
import type {
  Change,
  CreatedTask,
  NewTask,
  SessionRecord,
  SubtaskRecord,
  SubtaskStatus,
  TaskRecord,
  TaskStatus,
  TaskStorePort,
  TaskSummary,
  WorkspaceRecord,
} from '@paldock/contracts';
import { subtaskMachine, taskMachine } from '@paldock/domain';
import type { Clock } from './clock.js';
import { COLUMNS, toTask, type TaskRow } from './columns.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import { applyTransition, statusChanged, type TransitionSpec } from './writes.js';

const SQL = {
  // 按项目路径找到或创建；DO UPDATE 让 RETURNING 在已存在时也返回该行
  upsertWorkspace: `
    INSERT INTO workspaces (id, name, root_path, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (root_path) DO UPDATE SET name = name
    RETURNING ${COLUMNS.workspace()}`,
  selectWorkspace: `SELECT ${COLUMNS.workspace()} FROM workspaces WHERE id = ?`,
  insertTask: `
    INSERT INTO tasks (id, workspace_id, title, goal, status, check_command, check_confirmed_at, idempotency_key, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?7, ?8, ?8)
    RETURNING ${COLUMNS.task()}`,
  // 条件与部分索引 tasks_by_idempotency_key 一致（= 隐含 IS NOT NULL）
  selectTaskByKey: `SELECT ${COLUMNS.task()} FROM tasks WHERE idempotency_key = ?`,
  selectTask: `SELECT ${COLUMNS.task()} FROM tasks WHERE id = ?`,
  insertSubtask: `
    INSERT INTO subtasks (id, task_id, role, goal, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?5)
    RETURNING ${COLUMNS.subtask()}`,
  selectSubtask: `SELECT ${COLUMNS.subtask()} FROM subtasks WHERE id = ?`,
  selectSubtaskByTask: `SELECT ${COLUMNS.subtask()} FROM subtasks WHERE task_id = ? ORDER BY created_at LIMIT 1`,
  setWorktree: `
    UPDATE subtasks SET worktree_path = ?, branch = ?, base_commit = ?, version = version + 1
     WHERE id = ? AND worktree_path IS NULL
    RETURNING ${COLUMNS.subtask()}`,
  insertSession: `
    INSERT INTO sessions (id, kind, subtask_id, role, created_at) VALUES (?, 'agent', ?, ?, ?)
    RETURNING ${COLUMNS.session()}`,
  selectSessionBySubtask: `SELECT ${COLUMNS.session()} FROM sessions WHERE subtask_id = ?`,
  // P1 一个任务一个子任务；最新 Run 走 UNIQUE (subtask_id, attempt) 索引倒序取一条
  listTasks: `
    SELECT ${COLUMNS.task('t.')}, s.status AS subtaskStatus,
           (SELECT r.status FROM runs r WHERE r.subtask_id = s.id ORDER BY r.attempt DESC LIMIT 1) AS latestRunStatus
      FROM tasks t
      JOIN subtasks s ON s.task_id = t.id
     ORDER BY t.created_at DESC
     LIMIT ?`,
} as const;

const TRANSITIONS = {
  task: {
    machine: taskMachine,
    select: `SELECT status, version FROM tasks WHERE id = ?`,
    update: `
      UPDATE tasks SET status = $to, version = version + 1, updated_at = $at
       WHERE id = $id AND version = $version
      RETURNING ${COLUMNS.task()}`,
  },
  subtask: {
    machine: subtaskMachine,
    select: `SELECT status, version FROM subtasks WHERE id = ?`,
    update: `
      UPDATE subtasks SET status = $to, status_reason = $reason, version = version + 1, updated_at = $at,
             rework_count = rework_count + $rework
       WHERE id = $id AND version = $version
      RETURNING ${COLUMNS.subtask()}`,
  },
} satisfies { task: TransitionSpec<TaskStatus>; subtask: TransitionSpec<SubtaskStatus> };

const newId = (prefix: string) => `${prefix}_${randomUUID()}`;

/**
 * 项目、任务、子任务与助手会话的写入口。每个写方法一个事务，状态表与事件同时提交；
 * 返回值直接来自 RETURNING，不回查。
 */
export class TaskRepository implements TaskStorePort {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly clock: Clock,
  ) {}

  ensureWorkspace(name: string, rootPath: string): WorkspaceRecord {
    return this.db.get<WorkspaceRecord>(SQL.upsertWorkspace, newId('ws'), name, rootPath, this.clock.iso())!;
  }

  getWorkspace(id: string): WorkspaceRecord | undefined {
    return this.db.get<WorkspaceRecord>(SQL.selectWorkspace, id);
  }

  /** 任务、开发子任务和它的助手会话同一事务创建；P1 不经草稿与计划确认，直接排队。 */
  createTask(input: NewTask): Change<CreatedTask> {
    return this.db.transaction(() => {
      const at = this.clock.iso();
      const task = toTask(
        this.db.get<TaskRow>(
          SQL.insertTask,
          newId('task'),
          input.workspaceId,
          input.title,
          input.goal,
          input.checkCommand && JSON.stringify(input.checkCommand),
          input.checkCommand && input.checkConfirmed ? at : null,
          input.idempotencyKey,
          at,
        )!,
      );
      const subtask = this.db.get<SubtaskRecord>(SQL.insertSubtask, newId('sub'), task.id, input.role, input.goal, at)!;
      const session = this.db.get<SessionRecord>(SQL.insertSession, newId('sess'), subtask.id, input.role, at)!;
      return {
        record: { task, subtask, session },
        events: [
          this.events.append(task.id, { type: 'task.created', payload: { workspaceId: task.workspaceId, title: task.title } }),
          this.events.append(subtask.id, { type: 'subtask.created', payload: { taskId: task.id, role: input.role } }),
        ],
      };
    });
  }

  findTaskByIdempotencyKey(key: string): TaskRecord | undefined {
    const row = this.db.get<TaskRow>(SQL.selectTaskByKey, key);
    return row && toTask(row);
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.get<TaskRow>(SQL.selectTask, id);
    return row && toTask(row);
  }

  getSubtask(id: string): SubtaskRecord | undefined {
    return this.db.get<SubtaskRecord>(SQL.selectSubtask, id);
  }

  getSubtaskOfTask(taskId: string): SubtaskRecord | undefined {
    return this.db.get<SubtaskRecord>(SQL.selectSubtaskByTask, taskId);
  }

  getSessionOfSubtask(subtaskId: string): SessionRecord | undefined {
    return this.db.get<SessionRecord>(SQL.selectSessionBySubtask, subtaskId);
  }

  listTasks(limit: number): TaskSummary[] {
    return this.db
      .all<TaskRow & Omit<TaskSummary, 'task'>>(SQL.listTasks, limit)
      .map(({ subtaskStatus, latestRunStatus, ...task }) => ({ task: toTask(task), subtaskStatus, latestRunStatus }));
  }

  /** worktree 只设置一次；之后各次 Run 共用。 */
  setWorktree(subtaskId: string, worktreePath: string, branch: string, baseCommit: string): SubtaskRecord | undefined {
    return this.db.get<SubtaskRecord>(SQL.setWorktree, worktreePath, branch, baseCommit, subtaskId);
  }

  transitionTask(id: string, expectedVersion: number, to: TaskStatus, reason?: string): Change<TaskRecord> {
    const change = applyTransition<TaskStatus, TaskRow>(this.db, this.events, TRANSITIONS.task, id, expectedVersion, to, (from) => ({
      params: { at: this.clock.iso() },
      event: { type: 'task.status_changed', payload: statusChanged(from, to, reason) },
    }));
    return { record: toTask(change.record), events: change.events };
  }

  /** 原因随状态一起更新（缺省清空）；从 review 退回重做（→ queued）时累计次数，不设上限。 */
  transitionSubtask(id: string, expectedVersion: number, to: SubtaskStatus, reason?: string): Change<SubtaskRecord> {
    return applyTransition(this.db, this.events, TRANSITIONS.subtask, id, expectedVersion, to, (from) => ({
      params: { at: this.clock.iso(), reason: reason ?? null, rework: Number(from === 'review' && to === 'queued') },
      event: { type: 'subtask.status_changed', payload: statusChanged(from, to, reason) },
    }));
  }
}
