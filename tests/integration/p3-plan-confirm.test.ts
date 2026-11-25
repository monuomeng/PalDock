/**
 * P3-08 验收（离线）：确认前改执行器、检查命令、删节点；运行中确认新一版（没变的沿用、改了的重新执行、删掉的取消）；
 * 按角色跳过审阅与自动处理记录单。执行器是两个模拟（codex、claude），由测试决定每次 Run 何时结束；审阅 Run 自动交「通过」。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpGateway, PlanService, ReviewGate, RunSupervisor, TaskGraphScheduler, TaskService } from '@paldock/application';
import type { PersistentEvent, RunStartRequest, RuntimeAdapter, RuntimeEvent, SubtaskRecord } from '@paldock/contracts';
import { openStore, type Store } from '@paldock/storage-sqlite';
import { afterEach, describe, expect, it } from 'vitest';

interface FakeRun {
  runtime: string;
  request: RunStartRequest;
  title: string;
  ended: boolean;
  succeed(files?: Record<string, string>): void;
}

const runs: FakeRun[] = [];

class FakeRuntime implements RuntimeAdapter {
  constructor(
    readonly name: string,
    private readonly approve: (token: string) => void,
  ) {}

  async discover() {
    const capabilities = { resume: true, streaming: true, approvals: true, cancel: true, workingDirectoryRestriction: false, attachments: false };
    return { runtime: this.name, available: true, capabilities };
  }

  async start(request: RunStartRequest, onEvent: (event: RuntimeEvent) => void) {
    const review = /请审阅子任务「(.+?)」/.exec(request.prompt)?.[1];
    const title = review ? `审阅:${review}` : (/你负责的子任务：(.+)/.exec(request.prompt)?.[1] ?? '?');
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const run: FakeRun = {
      runtime: this.name,
      request,
      title,
      ended: false,
      succeed: (files = {}) => {
        if (run.ended) return;
        run.ended = true;
        for (const [path, content] of Object.entries(files)) writeFileSync(join(request.cwd, path), content);
        void ready.then(() => onEvent({ type: 'completed', finalMessage: `${title} 完成` }));
      },
    };
    runs.push(run);
    setImmediate(() => {
      onEvent({ type: 'thread', threadId: `thr_${request.runId}` });
      onEvent({ type: 'turn', turnId: `turn_${request.runId}` });
      started();
      if (review) {
        this.approve(request.mcpServer!.env.PALDOCK_MCP_TOKEN!);
        run.succeed();
      }
    });
    return {
      cancel: async () => {
        if (run.ended) return;
        run.ended = true;
        void ready.then(() => onEvent({ type: 'interrupted' }));
      },
      respondApproval: () => {},
      dispose: async () => {},
    };
  }

  async checkTurn() {
    return { status: 'not_found' as const };
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8' }).trim();

let root: string;
let store: Store;
let supervisor: RunSupervisor;
let plans: PlanService;
let tasks: TaskService;
let gateway: McpGateway;
let workspaceId: string;
let proposerRunId: string;
const logs: string[] = [];

async function setup() {
  root = mkdtempSync(join(tmpdir(), 'paldock-p3-plan-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  mkdirSync(join(root, 'data'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

  store = await openStore(':memory:');
  let scheduler!: TaskGraphScheduler;
  let gate!: ReviewGate;
  const publish = (batch: PersistentEvent[]) => {
    scheduler.onEvents(batch);
    gate.onEvents(batch);
  };
  const log = (message: string) => logs.push(message);
  gateway = new McpGateway({ store, publish, plans: () => plans });
  const approve = (token: string) => void gateway.call(gateway.authenticate(token)!, 'submit_review', { decision: 'accept', reason: '看过了' });
  supervisor = new RunSupervisor({
    store,
    runtimes: { codex: new FakeRuntime('codex', approve), claude: new FakeRuntime('claude', approve) },
    mcp: { gateway, server: (token) => ({ name: 'paldock', command: 'node', args: [], env: { PALDOCK_MCP_TOKEN: token } }) },
    dataRoot: join(root, 'data'),
    publish,
    publishEphemeral: () => {},
    log,
  });
  scheduler = new TaskGraphScheduler({ store, supervisor, publish, log });
  gate = new ReviewGate({ store, supervisor, publish, log });
  plans = new PlanService({ store, scheduler, supervisor, publish });
  tasks = new TaskService({ store, supervisor, scheduler, dataRoot: join(root, 'data'), publish });
  workspaceId = store.tasks.ensureWorkspace('repo', repo).id;
  const coord = store.tasks.createTask({ workspaceId, title: 'c', goal: 'g', role: 'coordinator', checkCommand: null, checkConfirmed: false, idempotencyKey: 'c' }).record;
  proposerRunId = store.runs.createRun({ subtaskId: coord.subtask.id, sessionId: coord.session.id, runtime: 'claude' }).record.id;
}

afterEach(async () => {
  await supervisor?.stop();
  expect(logs.filter((l) => / failed/.test(l) && !/finished: failed/.test(l))).toEqual([]);
  store?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  logs.length = 0;
  runs.length = 0;
});

type NodeArg = { key: string; role?: string; goal?: string; dependsOn?: string[]; paths?: string[]; check?: { executable: string; args: string[] } };
const nodesOf = (list: NodeArg[]) => list.map((n) => ({ role: 'developer', title: n.key, goal: n.goal ?? `做 ${n.key}`, paths: n.paths ?? [], dependsOn: n.dependsOn ?? [], ...n }));
const propose = (list: NodeArg[], taskId?: string) =>
  plans.propose(proposerRunId, { title: '记住我', goal: '加记住我', nodes: nodesOf(list), ...(taskId ? { taskId } : {}) });
const version = (planId: string) => store.plans.getPlan(planId)!.version;

async function until<T>(read: () => T, ok: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}（当前 ${JSON.stringify(value)}；日志 ${logs.join(' / ')}）`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const node = (taskId: string, key: string): SubtaskRecord => store.tasks.listSubtasks(taskId).find((s) => s.nodeKey === key)!;
const started = (title: string, count = 1) => until(() => runs.filter((r) => r.title === title)[count - 1], (r) => r !== undefined, `${title} 第 ${count} 次`).then((r) => r!);
const PASS = { executable: process.execPath, args: ['-e', 'process.exit(0)'] };

describe('P3 计划确认与自动处理记录', () => {
  it('确认前改执行器、检查命令、删节点；详情里显示实际执行器；确认后按改过的执行', async () => {
    await setup();
    const plan = propose([{ key: 'a' }, { key: 'b' }, { key: 'c', dependsOn: ['a'] }]);
    let detail = tasks.getTask(plan.taskId).plan!;
    expect(detail.actions).toEqual({ confirm: true, reject: true, edit: true });
    // 开发助手默认用 claude（出厂设置）
    expect(detail.nodes.map((n) => [n.node.key, n.executor])).toEqual([
      ['a', 'claude'],
      ['b', 'claude'],
      ['c', 'claude'],
    ]);
    plans.editNode(plan.id, version(plan.id), { kind: 'executor', nodeKey: 'a', executor: 'codex' });
    plans.editNode(plan.id, version(plan.id), { kind: 'check', nodeKey: 'a', check: PASS });
    expect(() => plans.editNode(plan.id, version(plan.id), { kind: 'remove', nodeKey: 'a' })).toThrow(/c 依赖它/);
    plans.editNode(plan.id, version(plan.id), { kind: 'remove', nodeKey: 'b' });
    expect(() => plans.editNode(plan.id, 0, { kind: 'executor', nodeKey: 'a', executor: null })).toThrow(/已被修改/);
    detail = tasks.getTask(plan.taskId).plan!;
    expect(detail.nodes.map((n) => [n.node.key, n.executor, n.node.checkCommand])).toEqual([
      ['a', 'codex', PASS],
      ['c', 'claude', null],
    ]);

    await plans.confirm(plan.id, version(plan.id), '先做 a');
    expect(store.plans.getPlan(plan.id)).toMatchObject({ status: 'confirmed', decisionNote: '先做 a' });
    const a = await started('a');
    expect(a.runtime).toBe('codex');
    expect(() => plans.editNode(plan.id, version(plan.id), { kind: 'executor', nodeKey: 'a', executor: null })).toThrow(/已确认/);
    a.succeed({ 'a.txt': 'a' });
    await until(() => node(plan.taskId, 'a').status, (s) => s === 'succeeded', 'a 通过');
    // 改过的检查命令随计划确认，真的跑了
    expect(store.runs.getResult(store.runs.latestRun(node(plan.taskId, 'a').id)!.id)!.checkStatus).toBe('passed');
    expect((await started('c')).runtime).toBe('claude');
    // 详情里每个节点能看到它的各次 Run（工作 + 审阅）
    const view = tasks.getTask(plan.taskId).plan!.nodes.find((n) => n.node.key === 'a')!;
    expect(view.runs.map((r) => [r.run.purpose, r.run.status])).toEqual([
      ['work', 'succeeded'],
      ['review', 'succeeded'],
    ]);
  });

  it('运行中确认新一版：没变的沿用结论，改了的中断并重新执行，删掉的取消，新增的按依赖开始', async () => {
    await setup();
    const first = propose([{ key: 'a' }, { key: 'b', dependsOn: ['a'] }, { key: 'x' }]);
    await plans.confirm(first.id, version(first.id));
    const taskId = first.taskId;
    (await started('a')).succeed({ 'a.txt': 'a' });
    await until(() => node(taskId, 'a').status, (s) => s === 'succeeded', 'a 通过');
    const oldB = await started('b');
    await started('x');
    const before = { b: node(taskId, 'b').id, x: node(taskId, 'x').id, a: node(taskId, 'a').id };

    // 第 2 版：b 换了目标，x 删掉，新增 c 依赖 b
    const second = propose([{ key: 'a' }, { key: 'b', dependsOn: ['a'], goal: '换个做法' }, { key: 'c', dependsOn: ['b'] }], taskId);
    const detail = tasks.getTask(taskId).plan!;
    expect(detail).toMatchObject({ plan: { revision: 2, status: 'proposed' }, confirmedRevision: 1, actions: { confirm: true } });
    await plans.confirm(second.id, version(second.id), '按新的来');

    // 旧 b 和 x 的 Run 被中断、子任务取消
    await until(() => [store.tasks.getSubtask(before.b)!.status, store.tasks.getSubtask(before.x)!.status], (s) => s.every((x) => x === 'cancelled'), '旧节点取消');
    expect(oldB.ended).toBe(true);
    // a 沿用：同一个子任务、结论还在
    expect(node(taskId, 'a')).toMatchObject({ id: before.a, status: 'succeeded', planId: second.id });
    // 新 b 按新目标开始，c 等它
    const newB = await started('b', 2);
    expect(newB.request.prompt).toContain('换个做法');
    expect(node(taskId, 'b').id).not.toBe(before.b);
    expect(node(taskId, 'c').status).toBe('waiting_dependency');
    expect(store.tasks.listSubtasks(taskId).map((s) => s.nodeKey).sort()).toEqual(['a', 'b', 'c']);
    newB.succeed({ 'b.txt': 'b' });
    (await started('c')).succeed({ 'c.txt': 'c' });
    await until(() => store.tasks.getTask(taskId)!.status, (s) => s === 'succeeded', '任务成功');
  });

  it('按角色跳过审阅：交付在范围内、检查通过就直接通过并记一条；审阅助手放行也记一条', async () => {
    await setup();
    const ws = store.tasks.getWorkspace(workspaceId)!;
    tasks.setAutoPolicy(ws.id, ws.version, { skipReviewRoles: ['docs'] });
    const plan = propose([
      { key: 'doc', role: 'docs', paths: ['docs'] },
      { key: 'dev', role: 'developer' },
    ]);
    await plans.confirm(plan.id, version(plan.id));
    const doc = await started('doc');
    mkdirSync(join(doc.request.cwd, 'docs'), { recursive: true });
    doc.succeed({ 'docs/guide.md': '# 用法\n' });
    await until(() => node(plan.taskId, 'doc').status, (s) => s === 'succeeded', '文档通过');
    expect(runs.filter((r) => r.title === '审阅:doc')).toEqual([]);

    (await started('dev')).succeed({ 'dev.txt': 'x' });
    await until(() => node(plan.taskId, 'dev').status, (s) => s === 'succeeded', '开发通过');
    expect(runs.filter((r) => r.title === '审阅:dev')).toHaveLength(1);

    const decisions = store.autoDecisions.list(workspaceId, 10);
    expect(decisions.map((d) => [d.kind, d.subtaskId])).toEqual([
      ['review_passed', node(plan.taskId, 'dev').id],
      ['skip_review', node(plan.taskId, 'doc').id],
    ]);
    expect(decisions[1]!.reason).toContain('跳过「文档助手」的审阅');
    expect(decisions[0]!.reason).toBe('审阅助手通过：看过了');

    // 越界时不跳过：交给人
    const second = propose([{ key: 'doc2', role: 'docs', paths: ['docs'] }]);
    await plans.confirm(second.id, version(second.id));
    (await started('doc2')).succeed({ 'outside.txt': 'x' });
    await until(() => node(second.taskId, 'doc2').gateStage, (s) => s === 'human', '交给人');
    expect(store.autoDecisions.list(workspaceId, 10)).toHaveLength(2);
  });
});
