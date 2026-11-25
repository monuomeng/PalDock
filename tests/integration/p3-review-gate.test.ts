/**
 * P3-05 验收（离线）：计划节点交付后的验收闸门与审阅助手。
 * 模拟执行器由测试控制：工作 Run 写哪些文件、何时结束；审阅 Run 经 MCP 网关调用 submit_review 交结论。
 * 覆盖：通过放行下游、退回后回到原会话重做再通过、自动退回满轮数交给人、越出交付范围、检查命令失败与人工覆盖。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { McpGateway, PlanService, ReviewGate, RunSupervisor, TaskGraphScheduler, TaskService } from '@paldock/application';
import type { CheckCommand, PersistentEvent, RunStartRequest, RuntimeAdapter, RuntimeEvent, SubtaskRecord } from '@paldock/contracts';
import { openStore, type Store } from '@paldock/storage-sqlite';
import { afterEach, describe, expect, it } from 'vitest';

interface FakeRun {
  request: RunStartRequest;
  /** 工作 Run 是节点标题，审阅 Run 是「审阅:标题」。 */
  title: string;
  ended: boolean;
  succeed(files?: Record<string, string>): void;
}

class FakeRuntime implements RuntimeAdapter {
  readonly name = 'claude';
  readonly runs: FakeRun[] = [];

  async discover() {
    const capabilities = { resume: true, streaming: true, approvals: true, cancel: true, workingDirectoryRestriction: false, attachments: false };
    return { runtime: this.name, available: true, capabilities };
  }

  async start(request: RunStartRequest, onEvent: (event: RuntimeEvent) => void) {
    const reviewed = /请审阅子任务「(.+?)」/.exec(request.prompt)?.[1];
    const title = reviewed ? `审阅:${reviewed}` : (/你负责的子任务：(.+)/.exec(request.prompt)?.[1] ?? /子任务的目标：\n(.+)/.exec(request.prompt)?.[1] ?? '?');
    const run: FakeRun = {
      request,
      title,
      ended: false,
      succeed: (files = {}) => {
        if (run.ended) return;
        run.ended = true;
        for (const [path, content] of Object.entries(files)) {
          mkdirSync(dirname(join(request.cwd, path)), { recursive: true });
          writeFileSync(join(request.cwd, path), content);
        }
        onEvent({ type: 'completed', finalMessage: `${title} 完成` });
      },
    };
    this.runs.push(run);
    setImmediate(() => {
      onEvent({ type: 'thread', threadId: request.resumeThreadId ?? `thr_${request.runId}` });
      onEvent({ type: 'turn', turnId: `turn_${request.runId}` });
    });
    return {
      cancel: async () => {
        if (run.ended) return;
        run.ended = true;
        onEvent({ type: 'interrupted' });
      },
      respondApproval: () => {},
      dispose: async () => {},
    };
  }

  async checkTurn() {
    return { status: 'not_found' as const };
  }

  latest(title: string): FakeRun {
    const run = this.runs.findLast((r) => r.title === title);
    if (!run) throw new Error(`没有 ${title} 的 Run（已有：${this.runs.map((r) => r.title).join('、')}）`);
    return run;
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8' });
const PASS: CheckCommand = { executable: process.execPath, args: ['-e', 'process.exit(0)'] };
const FAIL: CheckCommand = { executable: process.execPath, args: ['-e', 'process.exit(3)'] };

let root: string;
let repo: string;
let store: Store;
let runtime: FakeRuntime;
let supervisor: RunSupervisor;
let tasks: TaskService;
let plans: PlanService;
let gateway: McpGateway;
let workspaceId: string;
const events: PersistentEvent[] = [];
const logs: string[] = [];

async function setup(maxAutoReworks = 2) {
  root = mkdtempSync(join(tmpdir(), 'paldock-p3-gate-'));
  repo = join(root, 'repo');
  const dataRoot = join(root, 'data');
  mkdirSync(repo);
  mkdirSync(dataRoot);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

  store = await openStore(':memory:');
  runtime = new FakeRuntime();
  let scheduler!: TaskGraphScheduler;
  let gate!: ReviewGate;
  const publish = (batch: PersistentEvent[]) => {
    events.push(...batch);
    scheduler.onEvents(batch);
    gate.onEvents(batch);
  };
  const log = (message: string) => logs.push(message);
  gateway = new McpGateway({ store, publish, plans: () => plans });
  supervisor = new RunSupervisor({
    store,
    runtimes: { claude: runtime },
    // 令牌放在注入的 MCP 服务器环境里，测试拿它以审阅助手的身份调用网关
    mcp: { gateway, server: (token) => ({ name: 'paldock', command: 'node', args: [], env: { PALDOCK_MCP_TOKEN: token } }) },
    dataRoot,
    publish,
    publishEphemeral: () => {},
    log,
  });
  scheduler = new TaskGraphScheduler({ store, supervisor, publish, log });
  gate = new ReviewGate({ store, supervisor, publish, log, limits: { maxAutoReworks } });
  plans = new PlanService({ store, scheduler, publish });
  tasks = new TaskService({ store, supervisor, scheduler, dataRoot, publish });
  workspaceId = store.tasks.ensureWorkspace('repo', repo).id;
}

afterEach(async () => {
  expect(logs.filter((l) => /failed/.test(l) && !/finished: failed/.test(l))).toEqual([]);
  await supervisor?.stop();
  store?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  logs.length = 0;
  events.length = 0;
});

/** 协调助手提出并由用户确认：dev（开发，交付范围 src，带检查命令）→ docs（文档，依赖 dev）。 */
function confirmPlan(check: CheckCommand = PASS): string {
  const coord = store.tasks.createTask({ workspaceId, title: '协调', goal: 'g', role: 'coordinator', checkCommand: null, checkConfirmed: false, idempotencyKey: `c-${Math.random()}` }).record;
  const run = store.runs.createRun({ subtaskId: coord.subtask.id, sessionId: coord.session.id, runtime: 'claude' }).record;
  const caller = gateway.authenticate(gateway.issue(run.id, 'coordinator', 60_000))!;
  const { taskId, planId } = gateway.call(caller, 'propose_plan', {
    title: '加记住我',
    goal: '给登录页加「记住我」',
    nodes: [
      { key: 'dev', role: 'developer', title: '实现', goal: '实现记住我', paths: ['src'], check },
      { key: 'docs', role: 'docs', title: '写文档', goal: '写使用说明', dependsOn: ['dev'] },
    ],
  }) as { taskId: string; planId: string };
  // 计划卡片上列出了检查命令，确认计划就是确认它
  expect(store.plans.nodes(planId)[0]!.checkCommand).toEqual(check);
  plans.confirm(planId, store.plans.getPlan(planId)!.version);
  return taskId;
}

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
const runCount = (title: string) => runtime.runs.filter((r) => r.title === title).length;
const waitRun = (title: string, count = 1) => until(() => runCount(title), (n) => n >= count, `${title} 第 ${count} 次开始`);
const gateEvents = (subtaskId: string) =>
  events.filter((e) => e.type === 'gate.decided' && e.aggregateId === subtaskId).map((e) => (e.type === 'gate.decided' ? `${e.payload.stage}:${e.payload.outcome}` : ''));

/** 以审阅助手的身份交结论（令牌来自这次审阅 Run 注入的 MCP 服务器）。 */
function submitReview(run: FakeRun, decision: 'accept' | 'rework', reason?: string) {
  const caller = gateway.authenticate(run.request.mcpServer!.env.PALDOCK_MCP_TOKEN!)!;
  expect(caller.role).toBe('reviewer');
  return gateway.call(caller, 'submit_review', { decision, ...(reason ? { reason } : {}) }) as { commitSha: string };
}

describe('P3 验收闸门与审阅', () => {
  it('交付在范围内、检查通过 → 独立会话里审阅 → 通过后放行下游；结论绑定提交', async () => {
    await setup();
    const taskId = confirmPlan();
    await waitRun('实现');
    const work = runtime.latest('实现');
    work.succeed({ 'src/remember.ts': 'export const remember = true;\n' });

    await waitRun('审阅:实现');
    const review = runtime.latest('审阅:实现');
    const dev = node(taskId, 'dev');
    expect(dev).toMatchObject({ status: 'review', gateStage: 'review' });
    // 审阅用独立会话：不是开发助手的会话，不沿用它的原生 thread；只读的审阅助手，提示里带被审的提交
    const workRun = store.runs.latestRun(dev.id)!;
    const reviewRun = store.runs.getRun(review.request.runId)!;
    expect(reviewRun).toMatchObject({ purpose: 'review', subtaskId: dev.id });
    expect(reviewRun.sessionId).not.toBe(workRun.sessionId);
    expect(review.request.resumeThreadId).toBeUndefined();
    const result = store.runs.getResult(workRun.id)!;
    expect(result).toMatchObject({ checkStatus: 'passed', outOfScope: [] });
    expect(result.commitSha).toBe(git(repo, 'rev-parse', dev.branch!).trim());
    expect(review.request.prompt).toContain(result.commitSha!);
    // 工作 Run 不能交审阅结论，审阅 Run 不能交工作交接
    const devCaller = gateway.authenticate(work.request.mcpServer!.env.PALDOCK_MCP_TOKEN!);
    expect(devCaller).toBeUndefined(); // 工作 Run 结束时令牌已作废
    const reviewer = gateway.authenticate(review.request.mcpServer!.env.PALDOCK_MCP_TOKEN!)!;
    expect(gateway.call(reviewer, 'get_task', {})).toMatchObject({ review: { commitSha: result.commitSha, handoff: '实现 完成' } });
    expect(() => gateway.call(reviewer, 'submit_result', { summary: 'x' })).toThrow(/submit_review/);
    // 人工覆盖在审阅中不可用
    await expect(tasks.decideReview(dev.id, node(taskId, 'dev').version, 'accept')).rejects.toThrow(/正在审/);

    expect(submitReview(review, 'accept').commitSha).toBe(result.commitSha);
    expect(() => submitReview(review, 'accept')).toThrow(/已经交过/);
    review.succeed();
    await until(() => node(taskId, 'dev').status, (s) => s === 'succeeded', 'dev 通过');
    expect(store.runs.reviewsOfRun(workRun.id)).toEqual([expect.objectContaining({ decision: 'accept', reviewerRunId: review.request.runId, commitSha: result.commitSha })]);
    expect(gateEvents(dev.id)).toEqual(['check:passed', 'review:passed']);
    // 下游放行
    await waitRun('写文档');
    expect(node(taskId, 'docs').status).toBe('running');
    // 详情里看得到闸门
    const view = tasks.getTask(taskId).plan!.nodes[0]!;
    expect(view.gate).toMatchObject({ result: { commitSha: result.commitSha }, reviews: [{ decision: 'accept' }] });
  });

  it('审阅退回 → 回到开发助手同一个会话按意见重做 → 再审通过', async () => {
    await setup();
    const taskId = confirmPlan();
    await waitRun('实现');
    const first = runtime.latest('实现');
    first.succeed({ 'src/a.ts': 'a\n' });
    await waitRun('审阅:实现');
    const review1 = runtime.latest('审阅:实现');
    submitReview(review1, 'rework', '缺少过期时间的处理');
    review1.succeed();

    await until(() => runtime.runs.filter((r) => r.title !== '审阅:实现' && r.request.prompt.includes('审阅助手退回')).length, (n) => n === 1, '重做开始');
    const redo = runtime.runs.at(-1)!;
    const dev = node(taskId, 'dev');
    expect(dev).toMatchObject({ status: 'running', reworkCount: 1, gateStage: null });
    expect(redo.request.prompt).toContain('缺少过期时间的处理');
    // 同一个会话：沿用第一次工作 Run 的原生 thread
    expect(redo.request.resumeThreadId).toBe(`thr_${first.request.runId}`);
    expect(store.runs.getRun(redo.request.runId)!.sessionId).toBe(store.tasks.getSessionOfSubtask(dev.id)!.id);

    redo.succeed({ 'src/a.ts': 'a\nexpires\n' });
    await waitRun('审阅:实现', 2);
    const review2 = runtime.latest('审阅:实现');
    // 每轮审阅一个新会话
    expect(store.runs.getRun(review2.request.runId)!.sessionId).not.toBe(store.runs.getRun(review1.request.runId)!.sessionId);
    submitReview(review2, 'accept');
    review2.succeed();
    await until(() => node(taskId, 'dev').status, (s) => s === 'succeeded', 'dev 通过');
    expect(gateEvents(dev.id)).toEqual(['check:passed', 'review:rework', 'check:passed', 'review:passed']);
    expect(store.runs.autoReworkCount(dev.id)).toBe(1);
  });

  it('自动退回满轮数后交给人；人可以继续退回或直接通过', async () => {
    await setup(1);
    const taskId = confirmPlan();
    await waitRun('实现');
    runtime.latest('实现').succeed({ 'src/a.ts': '1\n' });
    for (let round = 1; round <= 2; round++) {
      await waitRun('审阅:实现', round);
      const review = runtime.latest('审阅:实现');
      submitReview(review, 'rework', `第 ${round} 次退回`);
      review.succeed();
      if (round === 1) {
        await until(() => node(taskId, 'dev').status, (s) => s === 'running', '重做');
        runtime.runs.at(-1)!.succeed({ 'src/a.ts': '2\n' });
      }
    }
    await until(() => node(taskId, 'dev').gateStage, (s) => s === 'human', '交给人');
    const dev = node(taskId, 'dev');
    expect(dev).toMatchObject({ status: 'review', statusReason: '审阅助手已自动退回 1 轮，这次仍退回：第 2 次退回' });
    expect(tasks.getTask(taskId).plan!.nodes[0]!.actions).toMatchObject({ review: true });
    expect(store.attention.list()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'review', taskId })]));
    await tasks.decideReview(dev.id, dev.version, 'accept', '我看过了');
    await until(() => node(taskId, 'dev').status, (s) => s === 'succeeded', '人工通过');
    await waitRun('写文档');
  });

  it('越出交付范围：不送审阅，交给人并标出文件；人工通过后放行', async () => {
    await setup();
    const taskId = confirmPlan();
    await waitRun('实现');
    runtime.latest('实现').succeed({ 'src/a.ts': 'a\n', 'package.json': '{}\n' });
    await until(() => node(taskId, 'dev').gateStage, (s) => s === 'human', '交给人');
    const dev = node(taskId, 'dev');
    expect(dev.statusReason).toBe('越出交付范围：package.json');
    expect(store.runs.getResult(store.runs.latestRun(dev.id)!.id)!.outOfScope).toEqual(['package.json']);
    expect(runCount('审阅:实现')).toBe(0);
    expect(gateEvents(dev.id)).toEqual(['check:human']);
    expect(node(taskId, 'docs').status).toBe('waiting_dependency');

    await tasks.decideReview(dev.id, dev.version, 'accept');
    await until(() => node(taskId, 'dev').status, (s) => s === 'succeeded', '人工通过');
    await waitRun('写文档');
  });

  it('检查命令失败：交给人；人写理由退回，回到原会话重做', async () => {
    await setup();
    const taskId = confirmPlan(FAIL);
    await waitRun('实现');
    const first = runtime.latest('实现');
    first.succeed({ 'src/a.ts': 'a\n' });
    await until(() => node(taskId, 'dev').gateStage, (s) => s === 'human', '交给人');
    const dev = node(taskId, 'dev');
    expect(dev.statusReason).toBe('检查命令没通过');
    expect(store.runs.getResult(store.runs.latestRun(dev.id)!.id)).toMatchObject({ checkStatus: 'failed', checkExitCode: 3 });
    expect(runCount('审阅:实现')).toBe(0);

    await tasks.decideReview(dev.id, dev.version, 'rework', '先把测试修好');
    await until(() => runtime.runs.length, (n) => n === 2, '重做开始');
    const redo = runtime.runs.at(-1)!;
    expect(redo.request.prompt).toContain('先把测试修好');
    expect(redo.request.resumeThreadId).toBe(`thr_${first.request.runId}`);
    expect(node(taskId, 'dev')).toMatchObject({ status: 'running', reworkCount: 1 });
  });
});
