import { AUTO_DECISION_KINDS, type PlanNodeInput } from '@paldock/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './index.js';

let clock = Date.parse('2026-11-25T08:00:00.000Z');
let store: Store;
beforeEach(async () => {
  store = await openStore(':memory:', () => new Date((clock += 1000)));
});
afterEach(() => store.close());

const queryPlan = (sql: string, ...params: string[]) =>
  store.db.raw
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((r) => String(r.detail))
    .join(' | ');

const node = (key: string, dependsOn: string[] = [], extra: Partial<PlanNodeInput> = {}): PlanNodeInput => ({
  key,
  role: 'developer',
  title: key,
  goal: `做 ${key}`,
  paths: [],
  dependsOn,
  ...extra,
});

function seed() {
  const ws = store.tasks.ensureWorkspace('demo', 'D:/demo');
  const coord = store.tasks.createTask({ workspaceId: ws.id, title: 'c', goal: 'g', role: 'coordinator', checkCommand: null, checkConfirmed: false, idempotencyKey: 'k' }).record;
  const run = store.runs.createRun({ subtaskId: coord.subtask.id, sessionId: coord.session.id, runtime: 'claude' }).record;
  const propose = (nodes: PlanNodeInput[], taskId?: string) =>
    store.plans.propose({ workspaceId: ws.id, title: 't', goal: 'g', nodes, proposedByRunId: run.id, ...(taskId ? { taskId } : {}) }).record;
  return { ws, propose };
}

const byKey = (taskId: string) => Object.fromEntries(store.tasks.listSubtasks(taskId).map((s) => [s.nodeKey, s]));

describe('确认前修改计划', () => {
  it('改执行器、检查命令，删节点（被依赖时拒绝）；每次带版本、记事件；确认后不能再改', () => {
    const { propose } = seed();
    const plan = propose([node('a'), node('b', ['a']), node('c')]);
    const check = { executable: 'pnpm', args: ['test'] };
    const e1 = store.plans.editNode(plan.id, 0, { kind: 'executor', nodeKey: 'a', executor: 'codex' });
    expect(e1.record.version).toBe(1);
    expect(e1.events[0]).toMatchObject({ type: 'plan.edited', payload: { nodeKey: 'a', kind: 'executor' } });
    store.plans.editNode(plan.id, 1, { kind: 'check', nodeKey: 'b', check });
    expect(() => store.plans.editNode(plan.id, 1, { kind: 'check', nodeKey: 'b', check: null })).toThrow(/已被修改/);
    expect(() => store.plans.editNode(plan.id, 2, { kind: 'remove', nodeKey: 'a' })).toThrow(/b 依赖它/);
    store.plans.editNode(plan.id, 2, { kind: 'remove', nodeKey: 'b' });
    const nodes = store.plans.nodes(plan.id);
    expect(nodes.map((n) => [n.position, n.key, n.executor])).toEqual([
      [0, 'a', 'codex'],
      [1, 'c', null],
    ]);
    expect(() => store.plans.editNode(plan.id, 3, { kind: 'remove', nodeKey: 'zz' })).toThrow(/没有节点 zz/);
    store.plans.confirm(plan.id, 3);
    expect(() => store.plans.editNode(plan.id, 4, { kind: 'executor', nodeKey: 'a', executor: null })).toThrow(/已确认/);
  });
});

describe('运行中改计划', () => {
  it('没变的沿用原子任务和结论；改了的和它的下游重新执行；删掉的取消；新增的等依赖；旧子任务不再算进任务', () => {
    const { propose } = seed();
    const first = propose([node('a'), node('b', ['a']), node('c'), node('d')]);
    store.plans.confirm(first.id, 0, '先这样');
    expect(store.plans.getPlan(first.id)?.decisionNote).toBe('先这样');
    const taskId = first.taskId;
    // a、c 已经成功，d 还在等
    for (const key of ['a', 'c']) {
      let s = byKey(taskId)[key]!;
      s = store.tasks.transitionSubtask(s.id, s.version, 'running').record;
      s = store.tasks.transitionSubtask(s.id, s.version, 'review').record;
      store.tasks.transitionSubtask(s.id, s.version, 'succeeded');
    }
    const before = byKey(taskId);

    // 第 2 版：a 改了目标（a 和下游 b 重新执行），c 没变，d 删掉，新增 e 依赖 c
    const second = propose([node('a', [], { goal: '换个做法' }), node('b', ['a']), node('c'), node('e', ['c'])], taskId);
    const { record, events } = store.plans.confirm(second.id, 0);
    expect(store.plans.getPlan(first.id)?.status).toBe('superseded');
    expect(store.plans.confirmedPlan(taskId)?.id).toBe(second.id);
    expect(record.cancelled.sort()).toEqual([before.b!.id, before.d!.id].sort()); // a 已成功，不用取消
    expect(record.created.map((s) => [s.nodeKey, s.status])).toEqual([
      ['a', 'waiting_dependency'],
      ['b', 'waiting_dependency'],
      ['e', 'waiting_dependency'],
    ]);
    expect(events.map((e) => e.type)).toContain('plan.status_changed');
    const after = byKey(taskId);
    expect(Object.keys(after).sort()).toEqual(['a', 'b', 'c', 'e']);
    expect(after.c).toMatchObject({ id: before.c!.id, status: 'succeeded', planId: second.id });
    expect(after.a!.id).not.toBe(before.a!.id);
    // 图按新版本：依赖重建，旧子任务不在里面
    const graph = store.plans.graph(taskId);
    expect(graph.map((g) => g.id)).toEqual([after.a!.id, after.b!.id, after.c!.id, after.e!.id]);
    expect(graph.find((g) => g.id === after.b!.id)!.dependsOn).toEqual([after.a!.id]);
    expect(graph.find((g) => g.id === after.e!.id)!.dependsOn).toEqual([after.c!.id]);
    expect(store.tasks.getSubtask(before.d!.id)?.status).toBe('cancelled');
  });

  it('查询走索引', () => {
    expect(queryPlan(`SELECT id FROM plans WHERE task_id = ? AND status = 'confirmed'`, 't')).toContain('sqlite_autoindex_plans_2');
    expect(
      queryPlan(`SELECT id FROM subtasks WHERE task_id = ?1 AND (plan_id IS NULL OR plan_id = (SELECT id FROM plans WHERE task_id = ?1 AND status = 'confirmed'))`, 't'),
    ).toContain('subtasks_by_task');
  });
});

describe('自动处理设置与记录单', () => {
  it('默认全关；按版本修改并记事件', () => {
    const { ws } = seed();
    expect(ws.autoPolicy).toEqual({ skipReviewRoles: [] });
    const { record, events } = store.tasks.setAutoPolicy(ws.id, ws.version, { skipReviewRoles: ['docs'] });
    expect(record.autoPolicy).toEqual({ skipReviewRoles: ['docs'] });
    expect(events[0]).toMatchObject({ type: 'workspace.auto_policy_changed', payload: { skipReviewRoles: ['docs'] } });
    expect(() => store.tasks.setAutoPolicy(ws.id, ws.version, { skipReviewRoles: [] })).toThrow(/已被修改/);
  });

  it('只追加；按项目筛选，新的在前；类别 CHECK 与契约一致；查询走索引', () => {
    const { ws, propose } = seed();
    const other = store.tasks.ensureWorkspace('other', 'D:/other');
    const plan = propose([node('a')]);
    const taskId = plan.taskId;
    const first = store.autoDecisions.record({ workspaceId: ws.id, taskId, planId: plan.id, subtaskId: null, kind: 'skip_review', reason: '文档节点' });
    expect(first.events[0]).toMatchObject({ type: 'auto.decided', aggregateId: taskId, payload: { decisionId: first.record.id, kind: 'skip_review' } });
    store.autoDecisions.record({ workspaceId: ws.id, taskId, planId: null, subtaskId: null, kind: 'review_passed', reason: '审阅助手通过' });
    expect(store.autoDecisions.list(ws.id, 10).map((d) => d.kind)).toEqual(['review_passed', 'skip_review']);
    expect(store.autoDecisions.list(other.id, 10)).toEqual([]);
    expect(store.autoDecisions.list(null, 1)).toHaveLength(1);
    const sql = store.db.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'auto_decisions'`)!.sql;
    const list = /kind\s+TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)\)/.exec(sql)![1]!;
    expect(list.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...AUTO_DECISION_KINDS]);
    const q = queryPlan(`SELECT id FROM auto_decisions WHERE workspace_id = ? ORDER BY id DESC LIMIT 10`, 'w');
    expect(q).toContain('auto_decisions_by_workspace');
    expect(q).not.toContain('TEMP B-TREE');
  });
});
