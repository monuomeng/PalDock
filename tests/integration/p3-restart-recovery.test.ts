/**
 * P3-09 验收（离线）：在关键点「杀掉」本地服务（停掉组件、关库，不跑正常退出的收尾），再按启动顺序重开：
 * 存储层先中断没结束的工作，恢复程序再收拾 P3 的中间状态。数据库落盘，git 仓库是真的临时仓库。
 * 覆盖：工作 Run 中（这一轮其实已完成 / 已失败 / 查不到）、排队中、审阅中、合并的每一步、协调助手唤醒中。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CoordinatorService,
  IntegrationService,
  McpGateway,
  PlanService,
  RecoveryService,
  ReviewGate,
  RunSupervisor,
  TaskGraphScheduler,
  TaskService,
} from '@paldock/application';
import type { PersistentEvent, RecoveryItem, RunStartRequest, RuntimeAdapter, RuntimeEvent, SubtaskRecord, TurnCheck } from '@paldock/contracts';
import { openStore, type Store } from '@paldock/storage-sqlite';
import { afterEach, describe, expect, it } from 'vitest';

interface FakeRun {
  request: RunStartRequest;
  title: string;
  ended: boolean;
  succeed(files?: Record<string, string>): void;
}

/** 跨两次启动共用的模拟执行器：记下所有 Run；checkTurn 的结果由测试按 turn 设定。 */
class FakeRuntime implements RuntimeAdapter {
  readonly name = 'claude';
  readonly runs: FakeRun[] = [];
  readonly turns = new Map<string, TurnCheck>();
  /** 审阅 Run 自动交「通过」。 */
  autoReview = true;
  gateway!: McpGateway;

  async discover() {
    const capabilities = { resume: true, streaming: true, approvals: true, cancel: true, workingDirectoryRestriction: false, attachments: false };
    return { runtime: this.name, available: true, capabilities };
  }

  async start(request: RunStartRequest, onEvent: (event: RuntimeEvent) => void) {
    const review = /请审阅子任务「(.+?)」/.exec(request.prompt)?.[1];
    const title = review
      ? `审阅:${review}`
      : (/你负责的子任务：(.+)/.exec(request.prompt)?.[1] ?? ((request.instructions?.includes('协调助手') || /^(用户说：|任务事件)/.test(request.prompt)) ? '协调' : /继续完成目标：\n(.+)/.exec(request.prompt)?.[1] ?? '?'));
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const run: FakeRun = {
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
    this.runs.push(run);
    setImmediate(() => {
      onEvent({ type: 'thread', threadId: request.resumeThreadId ?? `thr_${request.runId}` });
      onEvent({ type: 'turn', turnId: `turn_${request.runId}` });
      started();
      if (review && this.autoReview) {
        this.gateway.call(this.gateway.authenticate(request.mcpServer!.env.PALDOCK_MCP_TOKEN!)!, 'submit_review', { decision: 'accept' });
        run.succeed();
      }
    });
    return { cancel: async () => {}, respondApproval: () => {}, dispose: async () => {} };
  }

  async checkTurn(_threadId: string, turnId: string): Promise<TurnCheck> {
    return this.turns.get(turnId) ?? { status: 'not_found' };
  }

  of(title: string): FakeRun[] {
    return this.runs.filter((r) => r.title === title);
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8' }).trim();

interface Service {
  store: Store;
  supervisor: RunSupervisor;
  plans: PlanService;
  tasks: TaskService;
  coordinator: CoordinatorService;
  integration: IntegrationService;
  gateway: McpGateway;
  recovered: RecoveryItem[];
}

let root: string;
let repo: string;
let dataRoot: string;
let runtime: FakeRuntime;
let live: Service | undefined;
const logs: string[] = [];
/** 只在第一次启动时生效：合并停在这一步，模拟服务在这里被杀。 */
let pauseAt: 'started' | 'candidate' | 'fast_forward' | undefined;

function prepareRepo() {
  root = mkdtempSync(join(tmpdir(), 'paldock-p3-restart-'));
  repo = join(root, 'repo');
  dataRoot = join(root, 'data');
  mkdirSync(repo);
  mkdirSync(dataRoot);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  runtime = new FakeRuntime();
}

/** 按本地服务的启动顺序装配；restart 为真时先跑存储层的中断，再跑恢复程序。 */
async function boot(options: { restart: boolean; limits?: { maxRunsPerTask?: number } }): Promise<Service> {
  const store = await openStore(dataRoot);
  const report = options.restart ? store.interruptActiveWork('服务重启') : undefined;
  let scheduler!: TaskGraphScheduler;
  let gate!: ReviewGate;
  let coordinator!: CoordinatorService;
  let plans!: PlanService;
  const publish = (batch: PersistentEvent[]) => {
    scheduler.onEvents(batch);
    gate.onEvents(batch);
    coordinator.onEvents(batch);
  };
  const log = (message: string) => logs.push(message);
  const gateway = new McpGateway({ store, publish, plans: () => plans, coordinator: () => coordinator });
  runtime.gateway = gateway;
  const supervisor = new RunSupervisor({
    store,
    runtimes: { claude: runtime },
    mcp: { gateway, server: (token) => ({ name: 'paldock', command: 'node', args: [], env: { PALDOCK_MCP_TOKEN: token } }) },
    dataRoot,
    publish,
    publishEphemeral: () => {},
    log,
    ...(options.limits ? { limits: options.limits } : {}),
  });
  scheduler = new TaskGraphScheduler({ store, supervisor, publish, log });
  const pause = options.restart ? undefined : pauseAt;
  const integration = new IntegrationService({
    store,
    supervisor,
    dataRoot,
    publish,
    log,
    ...(pause ? { checkpoint: (point) => (point === pause ? new Promise<void>(() => {}) : Promise.resolve()) } : {}),
  });
  gate = new ReviewGate({ store, supervisor, publish, log, integration });
  coordinator = new CoordinatorService({ store, supervisor, publish, log });
  plans = new PlanService({ store, scheduler, integration, supervisor, publish });
  const tasks = new TaskService({ store, supervisor, scheduler, integration, dataRoot, publish });
  const recovery = new RecoveryService({ store, supervisor, scheduler, gate, integration, coordinator, publish, log });
  const recovered = report ? await recovery.recover(report) : (coordinator.start(), []);
  live = { store, supervisor, plans, tasks, coordinator, integration, gateway, recovered };
  return live;
}

/** 模拟进程被杀：停掉执行器与定时器、关库，不跑正常退出时的「全部中断」。 */
async function kill(service: Service): Promise<void> {
  service.coordinator.stop();
  await service.supervisor.stop();
  await new Promise((r) => setTimeout(r, 30));
  service.store.close();
  live = undefined;
}

afterEach(async () => {
  if (live) {
    // 恢复程序重做的合并可能还在收尾（删临时 worktree）：等它做完再关库、删目录
    await live.supervisor.stop();
    await live.integration.idle();
    live.store.close();
    live = undefined;
  }
  pauseAt = undefined;
  const failures = logs.filter((l) => / failed/.test(l) && !/finished: failed/.test(l));
  logs.length = 0;
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  expect(failures.join(' / ')).toBe('');
});

async function until<T>(read: () => T, ok: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}（当前 ${JSON.stringify(value)}；日志 ${logs.join(' / ')}）`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 提出并确认一份计划（协调助手的 Run 只是提出者，不需要在跑）。 */
async function confirmPlan(service: Service, nodes: { key: string; dependsOn?: string[] }[]): Promise<string> {
  const ws = service.store.tasks.ensureWorkspace('repo', repo);
  const coord = service.store.tasks.createTask({ workspaceId: ws.id, title: 'c', goal: 'g', role: 'coordinator', checkCommand: null, checkConfirmed: false, idempotencyKey: `c-${Math.random()}` }).record;
  const proposer = service.store.runs.createRun({ subtaskId: coord.subtask.id, sessionId: coord.session.id, runtime: 'claude' }).record;
  const plan = service.plans.propose(proposer.id, {
    title: '记住我',
    goal: '加记住我',
    nodes: nodes.map((n) => ({ key: n.key, role: 'developer', title: n.key, goal: `做 ${n.key}`, paths: [], dependsOn: n.dependsOn ?? [] })),
  });
  await service.plans.confirm(plan.id, service.store.plans.getPlan(plan.id)!.version);
  return plan.taskId;
}

const node = (s: Service, taskId: string, key: string): SubtaskRecord => s.store.tasks.listSubtasks(taskId).find((x) => x.nodeKey === key)!;
const started = (title: string, count = 1) => until(() => runtime.of(title)[count - 1], (r) => r !== undefined, `${title} 第 ${count} 次`).then((r) => r!);
const outcomes = (s: Service) => s.recovered.map((i) => `${i.kind}:${i.outcome}`);

describe('P3 重启恢复', () => {
  it('工作 Run 中被杀，这一轮其实已经完成：补记结果、照常验收合并，不重新执行', async () => {
    prepareRepo();
    let s = await boot({ restart: false });
    const taskId = await confirmPlan(s, [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }]);
    const a = await started('a');
    await until(() => s.store.runs.latestRun(node(s, taskId, 'a').id)?.nativeTurnId, (t) => !!t, 'turn 记下');
    writeFileSync(join(a.request.cwd, 'a.txt'), 'a\n');
    await kill(s);

    runtime.turns.set(`turn_${a.request.runId}`, { status: 'completed', finalMessage: 'a 做完了' });
    s = await boot({ restart: true });
    expect(outcomes(s)).toContain('run:补记结果');
    await until(() => node(s, taskId, 'a').status, (st) => st === 'succeeded', 'a 通过');
    expect(runtime.of('a')).toHaveLength(1); // 没重新执行
    expect(s.store.runs.getRun(a.request.runId)).toMatchObject({ status: 'succeeded' });
    expect(s.store.runs.getResult(a.request.runId)).toMatchObject({ finalMessage: 'a 做完了' });
    await started('b');
    // 事件里能看到恢复了什么
    expect(s.store.events.since(0, 5000).filter((e) => e.type === 'recovery.performed').map((e) => e.aggregateId)).toContain(node(s, taskId, 'a').id);
  });

  it('工作 Run 中被杀，这一轮已失败：记为失败，下游阻塞', async () => {
    prepareRepo();
    let s = await boot({ restart: false });
    const taskId = await confirmPlan(s, [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }]);
    const a = await started('a');
    await until(() => s.store.runs.latestRun(node(s, taskId, 'a').id)?.nativeTurnId, (t) => !!t, 'turn 记下');
    await kill(s);

    runtime.turns.set(`turn_${a.request.runId}`, { status: 'failed', message: '编译不过' });
    s = await boot({ restart: true });
    expect(outcomes(s)).toContain('run:记为失败');
    expect(s.store.runs.getRun(a.request.runId)).toMatchObject({ status: 'failed', failureReason: '执行失败：编译不过' });
    expect(node(s, taskId, 'a').status).toBe('blocked');
    await until(() => node(s, taskId, 'b').status, (st) => st === 'blocked', 'b 阻塞');
    expect(runtime.of('a')).toHaveLength(1);
  });

  it('工作 Run 中查不到结果：按原会话续做；排队中的节点重新排队', async () => {
    prepareRepo();
    let s = await boot({ restart: false, limits: { maxRunsPerTask: 1 } });
    const taskId = await confirmPlan(s, [{ key: 'a' }, { key: 'c' }]);
    const a = await started('a');
    await until(() => s.store.runs.latestRun(node(s, taskId, 'a').id)?.nativeTurnId, (t) => !!t, 'turn 记下');
    expect(node(s, taskId, 'c').status).toBe('queued'); // 每任务 1 个，c 在监管器的队列里
    await kill(s);

    s = await boot({ restart: true, limits: { maxRunsPerTask: 1 } });
    expect(outcomes(s)).toEqual(expect.arrayContaining(['queued:重启前没做完，按原会话续做', 'queued:排队中被重启打断，重新排队']));
    const resumed = await until(() => runtime.runs.find((r) => r.request.resumeThreadId === `thr_${a.request.runId}`), (r) => r !== undefined, 'a 续做');
    expect(s.store.runs.getRun(resumed!.request.runId)).toMatchObject({ resumesRunId: a.request.runId, nativeThreadId: `thr_${a.request.runId}` });
    resumed!.succeed({ 'a.txt': 'a\n' });
    // c 不会被重复派：只开始一次
    const c = await started('c');
    expect(runtime.of('c')).toHaveLength(1);
    c.succeed({ 'c.txt': 'c\n' });
    await until(() => s.store.tasks.getTask(taskId)!.status, (st) => st === 'succeeded', '任务成功');
  });

  it('审阅中被杀：用新的独立会话重新审阅', async () => {
    prepareRepo();
    runtime.autoReview = false;
    let s = await boot({ restart: false });
    const taskId = await confirmPlan(s, [{ key: 'a' }]);
    (await started('a')).succeed({ 'a.txt': 'a\n' });
    const review1 = await started('审阅:a');
    const firstSession = s.store.runs.getRun(review1.request.runId)!.sessionId;
    await kill(s);

    runtime.autoReview = true;
    s = await boot({ restart: true });
    expect(outcomes(s)).toContain('review:用新会话重新审阅');
    const review2 = await started('审阅:a', 2);
    expect(s.store.runs.getRun(review2.request.runId)!.sessionId).not.toBe(firstSession);
    await until(() => node(s, taskId, 'a').status, (st) => st === 'succeeded', 'a 通过');
  });

  for (const [point, outcome] of [
    ['started', '重做合并'],
    ['candidate', '重做合并'],
    ['fast_forward', '补记完成'],
  ] as const) {
    it(`合并停在「${point}」时被杀：${outcome}，节点成功，集成分支只前进一次`, async () => {
      prepareRepo();
      pauseAt = point;
      let s = await boot({ restart: false });
      const taskId = await confirmPlan(s, [{ key: 'a' }]);
      (await started('a')).succeed({ 'a.txt': 'a\n' });
      await until(() => s.store.merges.latestOf(node(s, taskId, 'a').id)?.phase, (p) => (point === 'started' ? p === 'started' : p === 'candidate'), '合并停住');
      if (point === 'fast_forward') await until(() => git(repo, 'rev-parse', s.store.tasks.getTask(taskId)!.integrationBranch!), (h) => h === s.store.merges.latestOf(node(s, taskId, 'a').id)!.candidateSha, '已快进');
      const base = s.store.tasks.getTask(taskId)!.integrationBase!;
      await kill(s);

      s = await boot({ restart: true });
      expect(outcomes(s)).toContain(`merge:${outcome}`);
      await until(() => node(s, taskId, 'a').status, (st) => st === 'succeeded', 'a 成功');
      const task = s.store.tasks.getTask(taskId)!;
      const head = git(repo, 'rev-parse', task.integrationBranch!);
      // 集成分支只多一个合并提交，第一父提交是起点
      expect(git(repo, 'rev-parse', `${head}^1`)).toBe(base);
      expect(git(task.integrationWorktree!, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(task.integrationWorktree!, 'status', '--porcelain')).toBe('');
      // 残留的临时合并 worktree 已清掉
      const merges = join(dataRoot, 'merges');
      expect(existsSync(merges) ? readdirSync(merges) : []).toEqual([]);
      expect(git(repo, 'worktree', 'list')).not.toContain('merges');
    });
  }

  it('协调助手唤醒中被杀：唤醒放回队列，沿用原生会话重新处理', async () => {
    prepareRepo();
    let s = await boot({ restart: false });
    const ws = s.store.tasks.ensureWorkspace('repo', repo);
    const [session] = s.coordinator.sessions(ws.id);
    s.coordinator.send(session!.sessionId, '给登录页加记住我', 'say-1');
    const first = await started('协调');
    await until(() => s.store.runs.getRun(first.request.runId)?.nativeThreadId, (t) => !!t, 'thread 记下');
    await kill(s);

    s = await boot({ restart: true });
    expect(outcomes(s)).toContain('wake:唤醒放回队列');
    const again = await started('协调', 2);
    expect(again.request.resumeThreadId).toBe(`thr_${first.request.runId}`);
    expect(again.request.prompt).toContain('给登录页加记住我');
    again.succeed();
    await until(() => s.store.coordinator.listWakes(session!.sessionId, 5)[0]?.status, (st) => st === 'done', '唤醒完成');
    expect(s.store.coordinator.listWakes(session!.sessionId, 5)).toHaveLength(1); // 同一条唤醒，不重复
  });
});
