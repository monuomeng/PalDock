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

/** 一个确认过的单节点计划，节点带检查命令；返回节点子任务、它的会话和一次工作 Run。 */
function seed() {
  const ws = store.tasks.ensureWorkspace('demo', 'D:/demo');
  const coord = store.tasks.createTask({ workspaceId: ws.id, title: 'c', goal: 'g', role: 'coordinator', checkCommand: null, checkConfirmed: false, idempotencyKey: 'k' }).record;
  const proposer = store.runs.createRun({ subtaskId: coord.subtask.id, sessionId: coord.session.id, runtime: 'claude' }).record;
  const check = { executable: 'pnpm', args: ['test'] };
  const plan = store.plans.propose({
    workspaceId: ws.id,
    title: 't',
    goal: 'g',
    nodes: [{ key: 'dev', role: 'developer', title: '开发', goal: '做', paths: ['src'], dependsOn: [], check }],
    proposedByRunId: proposer.id,
  }).record;
  const [subtask] = store.plans.confirm(plan.id, 0).record.created;
  const session = store.tasks.getSessionOfSubtask(subtask!.id)!;
  const work = store.runs.createRun({ subtaskId: subtask!.id, sessionId: session.id, runtime: 'claude' }).record;
  return { plan, subtask: subtask!, session, work, check };
}

/** 子任务推到 review（running → review）。 */
function toReview(id: string) {
  let s = store.tasks.getSubtask(id)!;
  if (s.status === 'queued') s = store.tasks.transitionSubtask(id, s.version, 'running').record;
  return store.tasks.transitionSubtask(id, s.version, 'review').record;
}

describe('验收闸门的存储', () => {
  it('节点的检查命令随计划存取；证据记下 SHA 和越界文件', () => {
    const { plan, work, check } = seed();
    expect(store.plans.nodes(plan.id)[0]!.checkCommand).toEqual(check);
    const result = store.runs.saveResult({
      runId: work.id,
      finalMessage: 'ok',
      diffStat: ' 1 file changed',
      checkStatus: 'passed',
      checkExitCode: 0,
      checkDurationMs: 10,
      checkOutputRef: null,
      commitSha: 'abc123',
      outOfScope: ['package.json'],
    }).record;
    expect(result).toMatchObject({ commitSha: 'abc123', outOfScope: ['package.json'] });
    expect(store.runs.getResult(work.id)).toMatchObject({ commitSha: 'abc123', outOfScope: ['package.json'] });
    expect(store.runs.runDetails(work.subtaskId)[0]!.result?.outOfScope).toEqual(['package.json']);
  });

  it('闸门阶段只在 review 内设置、带版本并记事件；子任务换状态时清空', () => {
    const { subtask, work } = seed();
    const decision = { stage: 'check' as const, outcome: 'human' as const, runId: work.id, reason: '越出交付范围：package.json' };
    expect(() => store.tasks.setGateStage(subtask.id, subtask.version, 'human', decision)).toThrow(/不在待验收/);
    const inReview = toReview(subtask.id);
    expect(inReview.gateStage).toBeNull();
    const { record, events } = store.tasks.setGateStage(subtask.id, inReview.version, 'human', decision);
    expect(record).toMatchObject({ status: 'review', gateStage: 'human', statusReason: '越出交付范围：package.json', version: inReview.version + 1 });
    expect(events[0]).toMatchObject({ aggregateId: subtask.id, type: 'gate.decided', payload: decision });
    expect(() => store.tasks.setGateStage(subtask.id, inReview.version, 'review', { ...decision, outcome: 'passed' })).toThrow(/已被修改/);
    const back = store.tasks.transitionSubtask(subtask.id, record.version, 'queued', '退回').record;
    expect(back).toMatchObject({ status: 'queued', gateStage: null, reworkCount: 1 });
  });

  it('审阅 Run 用独立会话，不算「最新一次 Run」；结论每次审阅只收一份，自动退回次数只数审阅助手的', () => {
    const { subtask, work } = seed();
    const reviewerSession = store.tasks.createSession('reviewer');
    expect(reviewerSession).toMatchObject({ kind: 'agent', role: 'reviewer', subtaskId: null });
    const review = store.runs.createRun({ subtaskId: subtask.id, sessionId: reviewerSession.id, runtime: 'codex', purpose: 'review' }).record;
    expect(review).toMatchObject({ purpose: 'review', attempt: 2 });
    expect(store.runs.latestRun(subtask.id)?.id).toBe(work.id);

    const verdict = store.runs.addReview(work.id, 'rework', '缺测试', { runId: review.id, commitSha: 'abc' }).record;
    expect(verdict).toMatchObject({ runId: work.id, reviewerRunId: review.id, commitSha: 'abc', decision: 'rework' });
    expect(store.runs.reviewOf(review.id)?.id).toBe(verdict.id);
    expect(() => store.runs.addReview(work.id, 'accept', null, { runId: review.id, commitSha: 'abc' })).toThrow(/已存在/);
    // 用户自己的退回不算自动轮数
    store.runs.addReview(work.id, 'rework', '我再说一句', undefined);
    expect(store.runs.autoReworkCount(subtask.id)).toBe(1);
    expect(store.runs.reviewOf('run_none')).toBeUndefined();
  });

  it('查询走索引', () => {
    expect(queryPlan(`SELECT id FROM run_reviews WHERE reviewer_run_id = ?`, 'r')).toContain('run_reviews_by_reviewer');
    expect(queryPlan(`SELECT id FROM runs WHERE subtask_id = ? AND purpose = 'work' ORDER BY attempt DESC LIMIT 1`, 's')).toMatch(/sqlite_autoindex_runs_2|subtask_id=\?/);
    const rework = queryPlan(
      `SELECT count(*) FROM runs r JOIN run_reviews x ON x.run_id = r.id WHERE r.subtask_id = ? AND x.reviewer_run_id IS NOT NULL AND x.decision = 'rework'`,
      's',
    );
    expect(rework).toMatch(/SEARCH r USING .*subtask_id=\?/);
    expect(rework).toContain('run_reviews_by_run');
  });
});
