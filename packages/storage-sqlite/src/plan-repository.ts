import {
  CodedError,
  type Change,
  type CheckCommand,
  type GraphNode,
  type NewPlan,
  type PersistentEvent,
  type PlanNodeRecord,
  type PlanRecord,
  type PlanStatus,
  type PlanNodeEdit,
  type PlanStorePort,
  type SubtaskRecord,
} from '@paldock/contracts';
import { planDiff, planMachine } from '@paldock/domain';
import type { Clock } from './clock.js';
import { COLUMNS, toTask, type TaskRow } from './columns.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import type { TaskRepository } from './task-repository.js';
import { applyTransition, newId, statusChanged, type TransitionSpec } from './writes.js';

type NodeRow = Omit<PlanNodeRecord, 'paths' | 'dependsOn' | 'checkCommand'> & { paths: string; dependsOn: string; checkCommand: string | null };
const TERMINAL_TASK = new Set(['succeeded', 'failed', 'cancelled']);
const FINISHED_SUBTASK = new Set(['succeeded', 'failed', 'cancelled']);
const toNode = (row: NodeRow): PlanNodeRecord => ({
  ...row,
  paths: JSON.parse(row.paths) as string[],
  dependsOn: JSON.parse(row.dependsOn) as string[],
  checkCommand: row.checkCommand === null ? null : (JSON.parse(row.checkCommand) as CheckCommand),
});

const SQL = {
  insertDraftTask: `
    INSERT INTO tasks (id, workspace_id, title, goal, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?5)
    RETURNING ${COLUMNS.task()}`,
  selectTask: `SELECT ${COLUMNS.task()} FROM tasks WHERE id = ?`,
  // 新一版的版本号与「还在等确认的旧版本」都走 UNIQUE (task_id, revision) 的自动索引
  insertPlan: `
    INSERT INTO plans (id, task_id, revision, status, proposed_by_run_id, created_at)
    VALUES (?1, ?2, (SELECT coalesce(max(revision), 0) + 1 FROM plans WHERE task_id = ?2), 'proposed', ?3, ?4)
    RETURNING ${COLUMNS.plan()}`,
  proposedOfTask: `SELECT id, version FROM plans WHERE task_id = ? AND status = 'proposed'`,
  insertNode: `
    INSERT INTO plan_nodes (plan_id, position, node_key, role, title, goal, paths, depends_on, check_command) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  setNodeExecutor: `UPDATE plan_nodes SET executor = ? WHERE plan_id = ? AND node_key = ?`,
  setNodeCheck: `UPDATE plan_nodes SET check_command = ? WHERE plan_id = ? AND node_key = ?`,
  deleteNode: `DELETE FROM plan_nodes WHERE plan_id = ? AND node_key = ?`,
  // 删节点后位置重新连续（主键 (plan_id, position)：先挪到负数再挪回，避免中途撞主键）
  shiftNodes: `UPDATE plan_nodes SET position = -position - 1 WHERE plan_id = ? AND position > ?`,
  unshiftNodes: `UPDATE plan_nodes SET position = -position - 2 WHERE plan_id = ? AND position < 0`,
  bumpPlan: `UPDATE plans SET version = version + 1 WHERE id = ? AND version = ? AND status = 'proposed' RETURNING ${COLUMNS.plan()}`,
  // 当前确认版本：UNIQUE (task_id, revision) 的自动索引按 task_id 找，再按状态过滤（每个任务只有几版）
  confirmedOfTask: `SELECT ${COLUMNS.plan()} FROM plans WHERE task_id = ? AND status = 'confirmed'`,
  subtasksOfPlan: `SELECT ${COLUMNS.subtask()} FROM subtasks WHERE task_id = ? AND plan_id = ?`,
  movePlan: `UPDATE subtasks SET plan_id = ?, version = version + 1 WHERE id = ?`,
  clearDeps: `DELETE FROM subtask_deps WHERE subtask_id = ?`,
  selectPlan: `SELECT ${COLUMNS.plan()} FROM plans WHERE id = ?`,
  latestPlan: `SELECT ${COLUMNS.plan()} FROM plans WHERE task_id = ? ORDER BY revision DESC LIMIT 1`,
  // 主键 (plan_id, position)：按节点顺序读，不排序
  nodes: `SELECT ${COLUMNS.planNode()} FROM plan_nodes WHERE plan_id = ? ORDER BY position`,
  insertSubtask: `
    INSERT INTO subtasks (id, task_id, role, goal, status, plan_id, node_key, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
    RETURNING ${COLUMNS.subtask()}`,
  insertSession: `INSERT INTO sessions (id, kind, subtask_id, role, created_at) VALUES (?, 'agent', ?, ?, ?)`,
  insertDep: `INSERT INTO subtask_deps (subtask_id, depends_on_id) VALUES (?, ?)`,
  // 子任务走 subtasks_by_task，标题走 plan_nodes 的 UNIQUE (plan_id, node_key)，依赖走 subtask_deps 主键
  graph: `
    SELECT s.id, n.title, s.status, s.status_reason AS statusReason, s.version,
           (SELECT json_group_array(d.depends_on_id) FROM subtask_deps d WHERE d.subtask_id = s.id) AS dependsOn
      FROM subtasks s
      JOIN plan_nodes n ON n.plan_id = s.plan_id AND n.node_key = s.node_key
     WHERE s.task_id = ?1 AND s.plan_id = (SELECT id FROM plans WHERE task_id = ?1 AND status = 'confirmed')
     ORDER BY n.position`,
} as const;

const TRANSITION = {
  machine: planMachine,
  select: `SELECT status, version FROM plans WHERE id = ?`,
  update: `
    UPDATE plans SET status = $to, decision_note = $note, decided_at = $at, decided_via = $via, version = version + 1
     WHERE id = $id AND version = $version
    RETURNING ${COLUMNS.plan()}`,
} satisfies TransitionSpec<PlanStatus>;

/**
 * 计划的写入口：提出新一版、确认（物化为子任务）、退回。每个写方法一个事务，计划、子任务、任务与事件同时提交。
 * 校验（角色、无环、路径）在 domain 的 validatePlan，由应用层在调用前做；这里只守住状态与版本。
 */
export class PlanRepository implements PlanStorePort {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly clock: Clock,
    private readonly tasks: TaskRepository,
  ) {}

  propose(input: NewPlan): Change<PlanRecord> {
    return this.db.transaction(() => {
      const at = this.clock.iso();
      const events: PersistentEvent[] = [];
      let taskId = input.taskId;
      if (taskId) {
        const task = this.db.get<TaskRow>(SQL.selectTask, taskId);
        if (!task || task.workspaceId !== input.workspaceId) throw new CodedError('not_found', '任务不存在');
        // 草稿任务提新一版替换待确认的；运行中的任务也能提新一版（确认后替换正在执行的那一版）
        if (TERMINAL_TASK.has(task.status)) throw new CodedError('conflict', '任务已结束，不能再提新一版');
        for (const old of this.db.all<{ id: string; version: number }>(SQL.proposedOfTask, taskId)) {
          events.push(...this.transition(old.id, old.version, 'superseded', '有了新一版').events);
        }
      } else {
        const task = toTask(this.db.get<TaskRow>(SQL.insertDraftTask, newId('task'), input.workspaceId, input.title, input.goal, at)!);
        taskId = task.id;
        events.push(this.events.append(task.id, { type: 'task.created', payload: { workspaceId: task.workspaceId, title: task.title } }));
      }
      const plan = this.db.get<PlanRecord>(SQL.insertPlan, newId('plan'), taskId, input.proposedByRunId, at)!;
      input.nodes.forEach((n, position) =>
        this.db.run(
          SQL.insertNode,
          plan.id,
          position,
          n.key,
          n.role,
          n.title,
          n.goal,
          JSON.stringify(n.paths),
          JSON.stringify(n.dependsOn),
          n.check ? JSON.stringify(n.check) : null,
        ),
      );
      events.push(this.events.append(plan.id, { type: 'plan.proposed', payload: { taskId, revision: plan.revision, nodes: input.nodes.length } }));
      return { record: plan, events };
    });
  }

  getPlan(id: string): PlanRecord | undefined {
    return this.db.get<PlanRecord>(SQL.selectPlan, id);
  }

  latestPlan(taskId: string): PlanRecord | undefined {
    return this.db.get<PlanRecord>(SQL.latestPlan, taskId);
  }

  nodes(planId: string): PlanNodeRecord[] {
    return this.db.all<NodeRow>(SQL.nodes, planId).map(toNode);
  }

  /**
   * 确认。草稿任务：按节点建子任务（没有依赖的 queued，有依赖的 waiting_dependency），任务 draft → queued。
   * 运行中的任务：上一版 superseded；没变的节点沿用原子任务（换挂到新版本），改了的、新增的建新子任务
   * （新建的一律先 waiting_dependency，由调度器按依赖放行），被替换的和没了的取消。依赖按新版本重建。
   */
  confirm(id: string, expectedVersion: number, note: string | null = null, via: 'desktop' | 'feishu' | 'telegram' = 'desktop'): Change<{ created: SubtaskRecord[]; cancelled: string[] }> {
    return this.db.transaction(() => {
      const plan0 = this.getPlan(id);
      const task = plan0 && this.tasks.getTask(plan0.taskId);
      if (!plan0 || !task) throw new CodedError('not_found', '计划不存在');
      if (TERMINAL_TASK.has(task.status)) throw new CodedError('conflict', '任务已结束（可能已取消）');
      // 只有待确认的才能确认（先于取代上一版检查，免得把正在执行的那一版当成「上一版」）
      planMachine.assertTransition(plan0.status, 'confirmed');
      const previous = task.status === 'draft' ? undefined : this.confirmedPlan(task.id);
      const events: PersistentEvent[] = [];
      if (previous) events.push(...this.transition(previous.id, previous.version, 'superseded', `第 ${plan0.revision} 版已确认`).events);
      const planChange = this.transition(id, expectedVersion, 'confirmed', note ?? undefined, via);
      const plan = planChange.record;
      events.push(...planChange.events);

      const at = this.clock.iso();
      const nodes = this.nodes(plan.id);
      const diff = previous ? planDiff(this.nodes(previous.id), nodes) : { keep: [], replace: [], add: nodes.map((n) => n.key), drop: [] };
      const old = new Map((previous ? this.db.all<SubtaskRecord>(SQL.subtasksOfPlan, task.id, previous.id) : []).map((s) => [s.nodeKey!, s]));
      const ids = new Map<string, string>();
      const cancelled: string[] = [];
      const cancel = (subtask: SubtaskRecord | undefined, reason: string) => {
        if (!subtask || FINISHED_SUBTASK.has(subtask.status)) return;
        events.push(...this.tasks.transitionSubtask(subtask.id, subtask.version, 'cancelled', reason).events);
        cancelled.push(subtask.id);
      };
      for (const key of diff.keep) {
        const kept = old.get(key)!;
        this.db.run(SQL.movePlan, plan.id, kept.id);
        this.db.run(SQL.clearDeps, kept.id);
        ids.set(key, kept.id);
      }
      for (const key of diff.replace) cancel(old.get(key), `计划第 ${plan.revision} 版改了这个节点，按新版本重新执行`);
      for (const key of diff.drop) cancel(old.get(key), `计划第 ${plan.revision} 版删掉了这个节点`);

      const created: SubtaskRecord[] = [];
      for (const n of nodes) {
        if (ids.has(n.key)) continue;
        const status = !previous && n.dependsOn.length === 0 ? 'queued' : 'waiting_dependency';
        const subtask = this.db.get<SubtaskRecord>(SQL.insertSubtask, newId('sub'), task.id, n.role, n.goal, status, plan.id, n.key, at)!;
        this.db.run(SQL.insertSession, newId('sess'), subtask.id, n.role, at);
        events.push(this.events.append(subtask.id, { type: 'subtask.created', payload: { taskId: task.id, role: n.role } }));
        ids.set(n.key, subtask.id);
        created.push(subtask);
      }
      for (const n of nodes) for (const dep of n.dependsOn) this.db.run(SQL.insertDep, ids.get(n.key)!, ids.get(dep)!);
      if (!previous) events.push(...this.tasks.transitionTask(task.id, task.version, 'queued', `计划第 ${plan.revision} 版已确认`).events);
      return { record: { created, cancelled }, events };
    });
  }

  confirmedPlan(taskId: string): PlanRecord | undefined {
    return this.db.get<PlanRecord>(SQL.confirmedOfTask, taskId);
  }

  /** 确认前改一个节点：执行器、检查命令，或删掉（有别的节点依赖它时拒绝）。计划版本 + 1。 */
  editNode(id: string, expectedVersion: number, edit: PlanNodeEdit): Change<PlanRecord> {
    return this.db.transaction(() => {
      const plan = this.db.get<PlanRecord>(SQL.bumpPlan, id, expectedVersion);
      if (!plan) throw new CodedError(this.getPlan(id) ? 'conflict' : 'not_found', '计划不存在、已确认或已被修改');
      const nodes = this.nodes(id);
      const node = nodes.find((n) => n.key === edit.nodeKey);
      if (!node) throw new CodedError('not_found', `计划里没有节点 ${edit.nodeKey}`);
      switch (edit.kind) {
        case 'executor':
          this.db.run(SQL.setNodeExecutor, edit.executor, id, edit.nodeKey);
          break;
        case 'check':
          this.db.run(SQL.setNodeCheck, edit.check && JSON.stringify(edit.check), id, edit.nodeKey);
          break;
        case 'remove': {
          const dependents = nodes.filter((n) => n.dependsOn.includes(edit.nodeKey)).map((n) => n.key);
          if (dependents.length > 0) throw new CodedError('bad_request', `${dependents.join('、')} 依赖它，先删掉或让它们不依赖它`);
          if (nodes.length === 1) throw new CodedError('bad_request', '计划至少要有一个节点；不需要的话请退回');
          this.db.run(SQL.deleteNode, id, edit.nodeKey);
          this.db.run(SQL.shiftNodes, id, node.position);
          this.db.run(SQL.unshiftNodes, id);
          break;
        }
      }
      return { record: plan, events: [this.events.append(id, { type: 'plan.edited', payload: { nodeKey: edit.nodeKey, kind: edit.kind } })] };
    });
  }

  reject(id: string, expectedVersion: number, note: string | null, via: 'desktop' | 'feishu' | 'telegram' = 'desktop'): Change<PlanRecord> {
    return this.transition(id, expectedVersion, 'rejected', note ?? undefined, via);
  }

  /** 依赖按节点顺序排（子查询按依赖 ID 扫描，顺序随机），阻塞原因因此稳定指向最靠前的上游。 */
  graph(taskId: string): GraphNode[] {
    const rows = this.db.all<Omit<GraphNode, 'dependsOn'> & { dependsOn: string }>(SQL.graph, taskId);
    const position = new Map(rows.map((row, i) => [row.id, i]));
    return rows.map((row) => ({
      ...row,
      dependsOn: (JSON.parse(row.dependsOn) as string[]).sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0)),
    }));
  }

  private transition(id: string, expectedVersion: number, to: PlanStatus, note?: string, via: string | null = null): Change<PlanRecord> {
    return applyTransition(this.db, this.events, TRANSITION, id, expectedVersion, to, (from) => ({
      params: { at: this.clock.iso(), note: note ?? null, via },
      event: { type: 'plan.status_changed', payload: statusChanged(from, to, note) },
    }));
  }
}
