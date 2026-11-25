import {
  CodedError,
  type Change,
  type GraphNode,
  type NewPlan,
  type PersistentEvent,
  type PlanNodeRecord,
  type PlanRecord,
  type PlanStatus,
  type PlanStorePort,
  type SubtaskRecord,
} from '@paldock/contracts';
import { planMachine } from '@paldock/domain';
import type { Clock } from './clock.js';
import { COLUMNS, toTask, type TaskRow } from './columns.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import type { TaskRepository } from './task-repository.js';
import { applyTransition, newId, statusChanged, type TransitionSpec } from './writes.js';

type NodeRow = Omit<PlanNodeRecord, 'paths' | 'dependsOn'> & { paths: string; dependsOn: string };
const toNode = (row: NodeRow): PlanNodeRecord => ({ ...row, paths: JSON.parse(row.paths) as string[], dependsOn: JSON.parse(row.dependsOn) as string[] });

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
    INSERT INTO plan_nodes (plan_id, position, node_key, role, title, goal, paths, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
     WHERE s.task_id = ?
     ORDER BY n.position`,
} as const;

const TRANSITION = {
  machine: planMachine,
  select: `SELECT status, version FROM plans WHERE id = ?`,
  update: `
    UPDATE plans SET status = $to, decision_note = $note, decided_at = $at, version = version + 1
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
        if (task.status !== 'draft') throw new CodedError('conflict', '这个任务的计划已经确认或任务已结束，不能再提新一版');
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
        this.db.run(SQL.insertNode, plan.id, position, n.key, n.role, n.title, n.goal, JSON.stringify(n.paths), JSON.stringify(n.dependsOn)),
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

  /** 没有依赖的节点进 queued，有依赖的进 waiting_dependency；每个子任务一个助手会话。 */
  confirm(id: string, expectedVersion: number): Change<SubtaskRecord[]> {
    return this.db.transaction(() => {
      const planChange = this.transition(id, expectedVersion, 'confirmed');
      const plan = planChange.record;
      const task = this.tasks.getTask(plan.taskId)!;
      if (task.status !== 'draft') throw new CodedError('conflict', '任务已不在等待确认（可能已取消）');
      const at = this.clock.iso();
      const nodes = this.nodes(plan.id);
      const ids = new Map(nodes.map((n) => [n.key, newId('sub')]));
      const events = [...planChange.events];
      const subtasks = nodes.map((n) => {
        const status = n.dependsOn.length === 0 ? 'queued' : 'waiting_dependency';
        const subtask = this.db.get<SubtaskRecord>(SQL.insertSubtask, ids.get(n.key)!, task.id, n.role, n.goal, status, plan.id, n.key, at)!;
        this.db.run(SQL.insertSession, newId('sess'), subtask.id, n.role, at);
        for (const dep of n.dependsOn) this.db.run(SQL.insertDep, subtask.id, ids.get(dep)!);
        events.push(this.events.append(subtask.id, { type: 'subtask.created', payload: { taskId: task.id, role: n.role } }));
        return subtask;
      });
      events.push(...this.tasks.transitionTask(task.id, task.version, 'queued', `计划第 ${plan.revision} 版已确认`).events);
      return { record: subtasks, events };
    });
  }

  reject(id: string, expectedVersion: number, note: string | null): Change<PlanRecord> {
    return this.transition(id, expectedVersion, 'rejected', note ?? undefined);
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

  private transition(id: string, expectedVersion: number, to: PlanStatus, note?: string): Change<PlanRecord> {
    return applyTransition(this.db, this.events, TRANSITION, id, expectedVersion, to, (from) => ({
      params: { at: this.clock.iso(), note: note ?? null },
      event: { type: 'plan.status_changed', payload: statusChanged(from, to, note) },
    }));
  }
}
