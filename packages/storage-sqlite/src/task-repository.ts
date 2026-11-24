import {
  CodedError,
  type Change,
  type CreatedTask,
  type NewTask,
  type SessionRecord,
  type SubtaskRecord,
  type SubtaskStatus,
  type TaskRecord,
  type TaskStatus,
  type TaskStorePort,
  type TaskSummary,
  type RemoteApprovalLevel,
  type WorkspaceRecord,
} from '@paldock/contracts';
import { subtaskMachine, taskMachine } from '@paldock/domain';
import type { Clock } from './clock.js';
import { COLUMNS, toTask, type TaskRow } from './columns.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import { applyTransition, newId, statusChanged, type TransitionSpec } from './writes.js';

/** 任务列表的一行：任务 + 子任务状态、最近活动时间 + 最新 Run 的状态。 */
const SUMMARY_COLUMNS = `${COLUMNS.task('t.')}, s.status AS subtaskStatus, s.updated_at AS lastActivityAt,
       (SELECT r.status FROM runs r WHERE r.subtask_id = s.id ORDER BY r.attempt DESC LIMIT 1) AS latestRunStatus`;

const SQL = {
  // 按项目路径找到或创建；DO UPDATE 让 RETURNING 在已存在时也返回该行
  upsertWorkspace: `
    INSERT INTO workspaces (id, name, root_path, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (root_path) DO UPDATE SET name = name
    RETURNING ${COLUMNS.workspace()}`,
  selectWorkspace: `SELECT ${COLUMNS.workspace()} FROM workspaces WHERE id = ?`,
  // 项目数量很少（每个仓库一行），整表按创建顺序读
  selectWorkspaces: `SELECT ${COLUMNS.workspace()} FROM workspaces ORDER BY created_at`,
  setRemoteApprovalLevel: `
    UPDATE workspaces SET remote_approval_level = ?, version = version + 1 WHERE id = ? AND version = ?
    RETURNING ${COLUMNS.workspace()}`,
  insertTask: `
    INSERT INTO tasks (id, workspace_id, title, goal, status, check_command, check_confirmed_at, idempotency_key, origin_conversation_id,
                       continued_from_task_id, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?7, ?9, ?10, ?8, ?8)
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
  // 两条都按各自的索引倒序取前 N 条（tasks_by_created / subtasks_by_activity）
  listTasks: `
    SELECT ${SUMMARY_COLUMNS}
      FROM tasks t
      JOIN subtasks s ON s.task_id = t.id
     ORDER BY t.created_at DESC
     LIMIT ?`,
  recentTasks: `
    SELECT ${SUMMARY_COLUMNS}
      FROM subtasks s
      JOIN tasks t ON t.id = s.task_id
     ORDER BY s.updated_at DESC
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

  listWorkspaces(): WorkspaceRecord[] {
    return this.db.all<WorkspaceRecord>(SQL.selectWorkspaces);
  }

  /** 远程审批等级只能在桌面修改（命令只对管理窗口开放）；先到者为准。 */
  setRemoteApprovalLevel(id: string, expectedVersion: number, level: RemoteApprovalLevel): Change<WorkspaceRecord> {
    return this.db.transaction(() => {
      const record = this.db.get<WorkspaceRecord>(SQL.setRemoteApprovalLevel, level, id, expectedVersion);
      if (!record) throw new CodedError(this.getWorkspace(id) ? 'conflict' : 'not_found', '项目不存在或已被修改');
      return {
        record,
        events: [this.events.append(id, { type: 'workspace.settings_changed', payload: { remoteApprovalLevel: level } })],
      };
    });
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
          input.originConversationId ?? null,
          input.continuedFromTaskId ?? null,
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
    return this.summaries(SQL.listTasks, limit);
  }

  recentTasks(limit: number): TaskSummary[] {
    return this.summaries(SQL.recentTasks, limit);
  }

  private summaries(sql: string, limit: number): TaskSummary[] {
    return this.db
      .all<TaskRow & Omit<TaskSummary, 'task'>>(sql, limit)
      .map(({ subtaskStatus, latestRunStatus, lastActivityAt, ...task }) => ({ task: toTask(task), subtaskStatus, latestRunStatus, lastActivityAt }));
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
