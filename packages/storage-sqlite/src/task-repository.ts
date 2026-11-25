import {
  CodedError,
  type Change,
  type CheckCommand,
  type CreatedTask,
  type GateDecision,
  type GateStage,
  type PersistentEvent,
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
import { COLUMNS, toTask, toWorkspace, type TaskRow, type WorkspaceRow } from './columns.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import { applyTransition, newId, statusChanged, type TransitionSpec } from './writes.js';

/**
 * 任务列表的一行：任务 + 子任务状态、最近活动时间 + 最新 Run 的状态。
 * 按计划拆分的任务没有单子任务（左联接为空），状态与时间取任务自己的。
 */
const SUMMARY_COLUMNS = `${COLUMNS.task('t.')}, coalesce(s.status, t.status) AS subtaskStatus, coalesce(s.updated_at, t.updated_at) AS lastActivityAt,
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
  setPrepareCommand: `
    UPDATE workspaces SET prepare_command = ?, version = version + 1 WHERE id = ? AND version = ?
    RETURNING ${COLUMNS.workspace()}`,
  markPrepared: `UPDATE subtasks SET prepared_at = ? WHERE id = ? AND prepared_at IS NULL`,
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
  // 主键范围：'~' 排在十六进制数字和连字符之后
  selectTasksByIdPrefix: `SELECT ${COLUMNS.task()} FROM tasks WHERE id >= ?1 AND id < ?1 || '~' ORDER BY id LIMIT ?2`,
  insertSubtask: `
    INSERT INTO subtasks (id, task_id, role, goal, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?5)
    RETURNING ${COLUMNS.subtask()}`,
  selectSubtask: `SELECT ${COLUMNS.subtask()} FROM subtasks WHERE id = ?`,
  // 单子任务（P1 / P2）：不属于任何计划的那个
  selectSubtaskByTask: `SELECT ${COLUMNS.subtask()} FROM subtasks WHERE task_id = ? AND plan_id IS NULL ORDER BY created_at LIMIT 1`,
  selectSubtasksOfTask: `SELECT ${COLUMNS.subtask()} FROM subtasks WHERE task_id = ? ORDER BY created_at`,
  setWorktree: `
    UPDATE subtasks SET worktree_path = ?, branch = ?, base_commit = ?, version = version + 1
     WHERE id = ? AND worktree_path IS NULL
    RETURNING ${COLUMNS.subtask()}`,
  insertSession: `
    INSERT INTO sessions (id, kind, subtask_id, role, created_at) VALUES (?, 'agent', ?, ?, ?)
    RETURNING ${COLUMNS.session()}`,
  selectSessionBySubtask: `SELECT ${COLUMNS.session()} FROM sessions WHERE subtask_id = ?`,
  // 集成分支只写一次
  setIntegration: `
    UPDATE tasks SET integration_branch = ?2, integration_worktree = ?3, integration_base = ?4, version = version + 1
     WHERE id = ?1 AND integration_branch IS NULL
    RETURNING ${COLUMNS.task()}`,
  rebaseSubtask: `
    UPDATE subtasks SET base_commit = ?3, version = version + 1 WHERE id = ?1 AND version = ?2
    RETURNING ${COLUMNS.subtask()}`,
  insertLooseSession: `
    INSERT INTO sessions (id, kind, role, created_at) VALUES (?, 'agent', ?, ?)
    RETURNING ${COLUMNS.session()}`,
  // 只在 review 内设置；版本条件保证先到者为准
  setGateStage: `
    UPDATE subtasks SET gate_stage = ?, status_reason = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND status = 'review'
    RETURNING ${COLUMNS.subtask()}`,
  // 最新 Run 走 UNIQUE (subtask_id, attempt) 索引倒序取一条
  // 两条都按各自的索引倒序取前 N 条（tasks_by_created / subtasks_by_activity）
  listTasks: `
    SELECT ${SUMMARY_COLUMNS}
      FROM tasks t
      LEFT JOIN subtasks s ON s.task_id = t.id AND s.plan_id IS NULL
     WHERE t.kind = 'work'
     ORDER BY t.created_at DESC
     LIMIT ?`,
  // 外部渠道的 /continue 列表只列单子任务的任务（任务图在渠道里的入口随 P3-10）
  recentTasks: `
    SELECT ${SUMMARY_COLUMNS}
      FROM subtasks s
      JOIN tasks t ON t.id = s.task_id
     WHERE s.plan_id IS NULL AND t.kind = 'work'
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
             rework_count = rework_count + $rework, gate_stage = NULL
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
    return toWorkspace(this.db.get<WorkspaceRow>(SQL.upsertWorkspace, newId('ws'), name, rootPath, this.clock.iso())!);
  }

  getWorkspace(id: string): WorkspaceRecord | undefined {
    const row = this.db.get<WorkspaceRow>(SQL.selectWorkspace, id);
    return row && toWorkspace(row);
  }

  listWorkspaces(): WorkspaceRecord[] {
    return this.db.all<WorkspaceRow>(SQL.selectWorkspaces).map(toWorkspace);
  }

  /** 远程审批等级只能在桌面修改（命令只对管理窗口开放）；先到者为准。 */
  setRemoteApprovalLevel(id: string, expectedVersion: number, level: RemoteApprovalLevel): Change<WorkspaceRecord> {
    return this.db.transaction(() => {
      const row = this.db.get<WorkspaceRow>(SQL.setRemoteApprovalLevel, level, id, expectedVersion);
      if (!row) throw new CodedError(this.getWorkspace(id) ? 'conflict' : 'not_found', '项目不存在或已被修改');
      const record = toWorkspace(row);
      return {
        record,
        events: [this.events.append(id, { type: 'workspace.settings_changed', payload: { remoteApprovalLevel: level } })],
      };
    });
  }

  setPrepareCommand(id: string, expectedVersion: number, command: CheckCommand | null): Change<WorkspaceRecord> {
    return this.db.transaction(() => {
      const row = this.db.get<WorkspaceRow>(SQL.setPrepareCommand, command && JSON.stringify(command), id, expectedVersion);
      if (!row) throw new CodedError(this.getWorkspace(id) ? 'conflict' : 'not_found', '项目不存在或已被修改');
      return {
        record: toWorkspace(row),
        events: [this.events.append(id, { type: 'workspace.prepare_command_changed', payload: { configured: command !== null } })],
      };
    });
  }

  markPrepared(subtaskId: string): void {
    this.db.run(SQL.markPrepared, this.clock.iso(), subtaskId);
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

  listSubtasks(taskId: string): SubtaskRecord[] {
    return this.db.all<SubtaskRecord>(SQL.selectSubtasksOfTask, taskId);
  }

  getSessionOfSubtask(subtaskId: string): SessionRecord | undefined {
    return this.db.get<SessionRecord>(SQL.selectSessionBySubtask, subtaskId);
  }

  listTasks(limit: number): TaskSummary[] {
    return this.summaries(SQL.listTasks, limit);
  }

  findTasksByIdPrefix(prefix: string, limit: number): TaskRecord[] {
    return this.db.all<TaskRow>(SQL.selectTasksByIdPrefix, prefix, limit).map(toTask);
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

  setGateStage(subtaskId: string, expectedVersion: number, stage: GateStage, decision: GateDecision): Change<SubtaskRecord> {
    return this.db.transaction(() => {
      const record = this.db.get<SubtaskRecord>(SQL.setGateStage, stage, decision.reason ?? null, this.clock.iso(), subtaskId, expectedVersion);
      if (!record) throw new CodedError(this.getSubtask(subtaskId) ? 'conflict' : 'not_found', '子任务不存在、不在待验收或已被修改');
      return { record, events: [this.gateDecided(subtaskId, decision)] };
    });
  }

  gateDecided(subtaskId: string, decision: GateDecision): PersistentEvent {
    const { stage, outcome, runId, reason } = decision;
    const payload = reason === undefined ? { stage, outcome, runId } : { stage, outcome, runId, reason: reason.slice(0, 500) };
    return this.events.append(subtaskId, { type: 'gate.decided', payload });
  }

  setIntegration(taskId: string, branch: string, worktree: string, base: string): TaskRecord | undefined {
    const row = this.db.get<TaskRow>(SQL.setIntegration, taskId, branch, worktree, base);
    return row && toTask(row);
  }

  rebaseSubtask(subtaskId: string, expectedVersion: number, baseCommit: string): SubtaskRecord {
    const record = this.db.get<SubtaskRecord>(SQL.rebaseSubtask, subtaskId, expectedVersion, baseCommit);
    if (!record) throw new CodedError(this.getSubtask(subtaskId) ? 'conflict' : 'not_found', '子任务不存在或已被修改');
    return record;
  }

  createSession(role: string): SessionRecord {
    return this.db.get<SessionRecord>(SQL.insertLooseSession, newId('sess'), role, this.clock.iso())!;
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
