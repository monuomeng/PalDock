import { PLAN_STATUSES, type PlanNodeInput } from '@paldock/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './index.js';

const now = () => new Date('2026-11-25T08:00:00.000Z');
let store: Store;
beforeEach(async () => {
  store = await openStore(':memory:', now);
});
afterEach(() => store.close());

const queryPlan = (sql: string, ...params: string[]) =>
  store.db.raw
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((r) => String(r.detail))
    .join(' | ');

const node = (key: string, dependsOn: string[] = [], paths: string[] = []): PlanNodeInput => ({ key, role: 'developer', title: `标题 ${key}`, goal: `做 ${key}`, paths, dependsOn });
const DIAMOND = [node('a', [], ['src/a.ts']), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c'])];

function seed() {
  const ws = store.tasks.ensureWorkspace('demo', 'D:/demo');
  const coordinator = store.tasks.createTask({
    workspaceId: ws.id,
    title: '协调',
    goal: '拆任务',
    role: 'coordinator',
    checkCommand: null,
    checkConfirmed: false,
    idempotencyKey: 'coord',
  }).record;
  const run = store.runs.createRun({ subtaskId: coordinator.subtask.id, sessionId: coordinator.session.id, runtime: 'claude' }).record;
  const propose = (nodes = DIAMOND, taskId?: string) =>
    store.plans.propose({ workspaceId: ws.id, title: '加记住我', goal: '实现记住我', nodes, proposedByRunId: run.id, ...(taskId ? { taskId } : {}) });
  return { ws, run, propose };
}

describe('计划', () => {
  it('提出计划时建草稿任务；节点按顺序存，路径和依赖原样读回', () => {
    const { propose, run } = seed();
    const { record: plan, events } = propose();
    expect(plan).toMatchObject({ revision: 1, status: 'proposed', proposedByRunId: run.id, version: 0, decidedAt: null });
    expect(store.tasks.getTask(plan.taskId)).toMatchObject({ status: 'draft', title: '加记住我', goal: '实现记住我' });
    expect(events.map((e) => e.type)).toEqual(['task.created', 'plan.proposed']);
    expect(events[1]).toMatchObject({ aggregateId: plan.id, payload: { taskId: plan.taskId, revision: 1, nodes: 4 } });
    const nodes = store.plans.nodes(plan.id);
    expect(nodes.map((n) => [n.position, n.key, n.dependsOn])).toEqual([
      [0, 'a', []],
      [1, 'b', ['a']],
      [2, 'c', ['a']],
      [3, 'd', ['b', 'c']],
    ]);
    expect(nodes[0]!.paths).toEqual(['src/a.ts']);
    // 草稿任务没有单子任务，也只在任务列表里出现一次
    expect(store.tasks.getSubtaskOfTask(plan.taskId)).toBeUndefined();
    expect(store.tasks.listTasks(10).filter((t) => t.task.id === plan.taskId)).toEqual([expect.objectContaining({ subtaskStatus: 'draft', latestRunStatus: null })]);
  });

  it('给草稿任务提新一版：旧版本被取代；任务结束后不能再提', () => {
    const { propose } = seed();
    const first = propose().record;
    const second = propose([node('only')], first.taskId);
    expect(second.record).toMatchObject({ taskId: first.taskId, revision: 2, status: 'proposed' });
    expect(second.events.map((e) => e.type)).toEqual(['plan.status_changed', 'plan.proposed']);
    expect(store.plans.getPlan(first.id)).toMatchObject({ status: 'superseded', version: 1 });
    expect(store.plans.latestPlan(first.taskId)?.id).toBe(second.record.id);
    // 被取代的旧版本不能再确认
    expect(() => store.plans.confirm(first.id, 1)).toThrow();
    store.plans.confirm(second.record.id, 0);
    // 运行中的任务可以提新一版
    expect(propose([node('only')], first.taskId).record).toMatchObject({ revision: 3, status: 'proposed' });
    const task = store.tasks.getTask(first.taskId)!;
    store.tasks.transitionTask(task.id, task.version, 'cancelled');
    expect(() => propose([node('x')], first.taskId)).toThrow(/任务已结束/);
    expect(() => propose([node('x')], 'task_missing')).toThrow(/任务不存在/);
  });

  it('确认：按节点建子任务、会话和依赖，没有依赖的排队，任务进入排队；先到者为准', () => {
    const { propose } = seed();
    const plan = propose().record;
    expect(() => store.plans.confirm(plan.id, 5)).toThrow(/已被修改/);
    const {
      record: { created: subtasks },
      events,
    } = store.plans.confirm(plan.id, 0);
    expect(subtasks.map((s) => [s.nodeKey, s.status, s.planId])).toEqual([
      ['a', 'queued', plan.id],
      ['b', 'waiting_dependency', plan.id],
      ['c', 'waiting_dependency', plan.id],
      ['d', 'waiting_dependency', plan.id],
    ]);
    expect(events.map((e) => e.type)).toEqual(['plan.status_changed', 'subtask.created', 'subtask.created', 'subtask.created', 'subtask.created', 'task.status_changed']);
    expect(store.tasks.getTask(plan.taskId)?.status).toBe('queued');
    expect(store.plans.getPlan(plan.id)).toMatchObject({ status: 'confirmed', version: 1 });
    for (const s of subtasks) expect(store.tasks.getSessionOfSubtask(s.id)).toMatchObject({ kind: 'agent', role: 'developer' });
    expect(() => store.plans.confirm(plan.id, 1)).toThrow(/不允许/);

    const ids = Object.fromEntries(subtasks.map((s) => [s.nodeKey, s.id]));
    expect(store.plans.graph(plan.taskId)).toEqual([
      { id: ids.a, title: '标题 a', status: 'queued', statusReason: null, version: 0, dependsOn: [] },
      { id: ids.b, title: '标题 b', status: 'waiting_dependency', statusReason: null, version: 0, dependsOn: [ids.a] },
      { id: ids.c, title: '标题 c', status: 'waiting_dependency', statusReason: null, version: 0, dependsOn: [ids.a] },
      { id: ids.d, title: '标题 d', status: 'waiting_dependency', statusReason: null, version: 0, dependsOn: [ids.b, ids.c] },
    ]);
    expect(store.tasks.listSubtasks(plan.taskId).map((s) => s.nodeKey)).toEqual(['a', 'b', 'c', 'd']);
    // 任务图的子任务不算「单子任务」；任务列表仍只有一行
    expect(store.tasks.getSubtaskOfTask(plan.taskId)).toBeUndefined();
    expect(store.tasks.listTasks(10).filter((t) => t.task.id === plan.taskId)).toHaveLength(1);
  });

  it('退回写原因，任务留在草稿；已取消的任务不能确认', () => {
    const { propose } = seed();
    const plan = propose().record;
    const { record, events } = store.plans.reject(plan.id, 0, '先别做文档');
    expect(record).toMatchObject({ status: 'rejected', decisionNote: '先别做文档', decidedAt: now().toISOString() });
    expect(events[0]).toMatchObject({ type: 'plan.status_changed', payload: { from: 'proposed', to: 'rejected', reason: '先别做文档' } });
    expect(store.tasks.getTask(plan.taskId)?.status).toBe('draft');

    const next = propose([node('a')], plan.taskId).record;
    const task = store.tasks.getTask(plan.taskId)!;
    store.tasks.transitionTask(task.id, task.version, 'cancelled');
    expect(() => store.plans.confirm(next.id, 0)).toThrow(/任务已结束/);
    expect(store.plans.getPlan(next.id)?.status).toBe('proposed');
  });

  it('status 的 CHECK 列表与契约一致', () => {
    const sql = store.db.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'plans'`)!.sql;
    const list = /status\s+TEXT NOT NULL CHECK \(status IN \(([^)]*)\)\)/.exec(sql)![1]!;
    expect(list.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...PLAN_STATUSES]);
  });

  it('查询走索引', () => {
    expect(queryPlan(`SELECT id FROM plans WHERE task_id = ? ORDER BY revision DESC LIMIT 1`, 't')).toMatch(/USING (COVERING )?INDEX sqlite_autoindex_plans_2/);
    expect(queryPlan(`SELECT id FROM plans WHERE task_id = ? AND status = 'proposed'`, 't')).toMatch(/INDEX sqlite_autoindex_plans_2/);
    const nodes = queryPlan(`SELECT node_key FROM plan_nodes WHERE plan_id = ? ORDER BY position`, 'p');
    expect(nodes).toMatch(/PRIMARY KEY/);
    expect(nodes).not.toMatch(/TEMP B-TREE/);
    const graph = queryPlan(
      `SELECT s.id, n.title, (SELECT json_group_array(d.depends_on_id) FROM subtask_deps d WHERE d.subtask_id = s.id)
         FROM subtasks s JOIN plan_nodes n ON n.plan_id = s.plan_id AND n.node_key = s.node_key
        WHERE s.task_id = ? ORDER BY n.position`,
      't',
    );
    expect(graph).toContain('subtasks_by_task');
    expect(graph).toContain('SEARCH n USING INDEX sqlite_autoindex_plan_nodes_2 (plan_id=? AND node_key=?)');
    expect(graph).toContain('SEARCH d USING PRIMARY KEY (subtask_id=?)');
    expect(queryPlan(`SELECT id FROM subtasks WHERE task_id = ? AND plan_id IS NULL ORDER BY created_at LIMIT 1`, 't')).toContain('subtasks_by_task');
    expect(
      queryPlan(`SELECT t.id FROM tasks t LEFT JOIN subtasks s ON s.task_id = t.id AND s.plan_id IS NULL ORDER BY t.created_at DESC LIMIT 10`),
    ).toMatch(/tasks_by_created.*subtasks_by_task/s);
  });
});
