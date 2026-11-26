/**
 * P3-04 验收（离线）：协调助手经 MCP 网关提出 4 节点菱形计划（A → B、A → C、B + C → D），用户确认后由调度器按依赖派单。
 * 执行器是测试里可控的模拟：每次 Run 何时成功、失败由测试决定，便于检查依赖释放、失败阻塞、取消级联和并发上限。
 * 组件按本地服务的接法手工装配（协调助手的 Run 在桌面还没有入口，P3-07 才有）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpGateway, PlanService, RunSupervisor, TaskGraphScheduler, TaskService } from '@paldock/application';
import type { PersistentEvent, RunStartRequest, RuntimeAdapter, RuntimeApprovalRequest, RuntimeEvent, SubtaskRecord, TaskDetail } from '@paldock/contracts';
import { openStore, type Store } from '@paldock/storage-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** 一次模拟 Run：测试调用 succeed / fail 结束它；取消时报告 interrupted。 */
interface FakeRun {
  request: RunStartRequest;
  title: string;
  ended: boolean;
  succeed(message?: string): void;
  fail(message: string): void;
  /** 像 Claude 的 Edit 一样请求改文件，返回宿主的决定。 */
  askFileChange(path: string): Promise<string>;
  /** 像 Claude 的 Bash 一样请求运行命令（不带工作目录），返回宿主的决定。 */
  askCommand(command: string): Promise<string>;
}

class FakeRuntime implements RuntimeAdapter {
  readonly name = 'claude';
  readonly runs: FakeRun[] = [];

  async discover() {
    const capabilities = { resume: true, streaming: true, approvals: true, cancel: true, workingDirectoryRestriction: false, attachments: false };
    return { runtime: this.name, available: true, capabilities };
  }

  async start(request: RunStartRequest, onEvent: (event: RuntimeEvent) => void) {
    const decisions = new Map<string, (decision: string) => void>();
    const ask = (request: Omit<RuntimeApprovalRequest, 'nativeRequestId'>) =>
      new Promise<string>((resolve) => {
        const id = `perm_${Math.random()}`;
        decisions.set(id, resolve);
        onEvent({ type: 'approval_request', request: { nativeRequestId: id, ...request } as RuntimeApprovalRequest });
      });
    const title = /你负责的子任务：(.+)/.exec(request.prompt)?.[1] ?? '?';
    const run: FakeRun = {
      request,
      title,
      ended: false,
      askFileChange: (path) => ask({ kind: 'file_change', summary: `Edit：${path}`, paths: [path] }),
      askCommand: (command) => ask({ kind: 'command', summary: command, command }),
      succeed: (message = `${title} 完成`) => {
        if (run.ended) return;
        run.ended = true;
        // 留一个改动，结束任务时有东西可提交
        writeFileSync(join(request.cwd, `${title}.txt`), message);
        onEvent({ type: 'completed', finalMessage: message });
      },
      fail: (message) => {
        if (run.ended) return;
        run.ended = true;
        onEvent({ type: 'failed', message });
      },
    };
    this.runs.push(run);
    setImmediate(() => {
      onEvent({ type: 'thread', threadId: `thr_${request.runId}` });
      onEvent({ type: 'turn', turnId: `turn_${request.runId}` });
    });
    return {
      respondApproval: (id: string, decision: string) => decisions.get(id)?.(decision),
      cancel: async () => {
        if (run.ended) return;
        run.ended = true;
        onEvent({ type: 'interrupted' });
      },
      dispose: async () => {},
    };
  }

  async checkTurn() {
    return { status: 'not_found' as const };
  }

  /** 正在执行（还没结束）的 Run 的节点标题，按启动顺序（建 worktree 是异步的，同时派出的先后不固定）。 */
  active(): string[] {
    return this.runs.filter((r) => !r.ended).map((r) => r.title);
  }

  latest(title: string): FakeRun {
    const run = this.runs.findLast((r) => r.title === title);
    if (!run) throw new Error(`节点 ${title} 没有启动过`);
    return run;
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8' });

let root: string;
let store: Store;
let runtime: FakeRuntime;
let supervisor: RunSupervisor;
let tasks: TaskService;
let plans: PlanService;
let gateway: McpGateway;
let workspaceId: string;
const logs: string[] = [];

async function setup(limits: { maxConcurrentRuns?: number; maxRunsPerTask?: number } = {}) {
  root = mkdtempSync(join(tmpdir(), 'paldock-p3-graph-'));
  const repo = join(root, 'repo');
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
  const publish = (events: PersistentEvent[]) => scheduler.onEvents(events);
  const log = (message: string) => logs.push(message);
  gateway = new McpGateway({ store, publish, plans: () => plans });
  supervisor = new RunSupervisor({ store, runtimes: { claude: runtime }, dataRoot, publish, publishEphemeral: () => {}, log, limits });
  scheduler = new TaskGraphScheduler({ store, supervisor, publish, log });
  plans = new PlanService({ store, scheduler, publish });
  tasks = new TaskService({ store, supervisor, scheduler, dataRoot, publish });
  workspaceId = store.tasks.ensureWorkspace('repo', repo).id;
}

afterEach(async () => {
  // 调度推进和执行器事件都不应该出错（版本冲突、非法迁移会记在日志里）
  expect(logs.filter((l) => /failed|不存在|没有会话/.test(l) && !/finished: failed/.test(l))).toEqual([]);
  await supervisor?.stop();
  store?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  logs.length = 0;
});

/** 协调助手的一次 Run，经 MCP 网关调用 propose_plan（令牌只认协调助手）。 */
function propose(title = '加记住我'): { taskId: string; planId: string } {
  const coordinator = store.tasks.createTask({
    workspaceId,
    title: '协调',
    goal: '和用户对话',
    role: 'coordinator',
    checkCommand: null,
    checkConfirmed: false,
    idempotencyKey: `coord-${title}-${Math.random()}`,
  }).record;
  const run = store.runs.createRun({ subtaskId: coordinator.subtask.id, sessionId: coordinator.session.id, runtime: 'claude' }).record;
  const caller = gateway.authenticate(gateway.issue(run.id, 'coordinator', 60_000))!;
  const node = (key: string, role: string, dependsOn: string[] = []) => ({ key, role, title: `${title}-${key}`, goal: `完成 ${key}`, dependsOn });
  return gateway.call(caller, 'propose_plan', {
    title,
    goal: '给登录页加「记住我」',
    nodes: [node('a', 'developer'), node('b', 'tester', ['a']), node('c', 'docs', ['a']), node('d', 'reviewer', ['b', 'c'])],
  }) as { taskId: string; planId: string };
}

function confirm(planId: string) {
  return plans.confirm(planId, store.plans.getPlan(planId)!.version);
}

async function until<T>(read: () => T, ok: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}（当前 ${JSON.stringify(value)}；日志 ${logs.join(' / ')}）`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 节点键 → 子任务状态。 */
const statuses = (taskId: string) => Object.fromEntries(store.tasks.listSubtasks(taskId).map((s) => [s.nodeKey, s.status]));
const subtask = (taskId: string, key: string): SubtaskRecord => store.tasks.listSubtasks(taskId).find((s) => s.nodeKey === key)!;
const taskStatus = (taskId: string) => store.tasks.getTask(taskId)!.status;

/** 让节点的当前 Run 成功，等它进入待命中，再由用户「通过」。 */
async function finishNode(taskId: string, key: string, title: string) {
  runtime.latest(title).succeed();
  await until(() => subtask(taskId, key).status, (s) => s === 'review', `${key} 待命中`);
  await tasks.decideReview(subtask(taskId, key).id, subtask(taskId, key).version, 'accept');
}

describe('P3 任务图调度', () => {
  it('写自己 worktree 里的文件、Claude 在 worktree 内跑普通命令由宿主直接批准并记审计；越界、装依赖、push 照旧要审批', async () => {
    await setup();
    const { planId } = propose();
    await confirm(planId);
    await until(() => runtime.active(), (x) => x.length === 1, 'A 开始');
    const a = runtime.latest('加记住我-a');
    expect(await a.askFileChange(join(a.request.cwd, 'src', 'a.ts'))).toBe('allow_once');
    expect(await a.askCommand('node --test')).toBe('allow_once');
    expect(store.db.all<{ action: string; result: string }>(`SELECT action, result FROM audit_log WHERE action = 'approval.auto' ORDER BY id`)).toEqual([
      { action: 'approval.auto', result: 'allow:write_in_worktree' },
      { action: 'approval.auto', result: 'allow:run_command_in_worktree' },
    ]);
    void a.askFileChange(join(root, 'outside.txt'));
    void a.askCommand('pnpm install');
    void a.askCommand('git push origin main');
    const pending = await until(
      () => store.db.all<{ risk_level: string }>(`SELECT risk_level FROM approvals WHERE status = 'pending'`),
      (rows) => rows.length === 3,
      '越界写入、装依赖、push 要审批',
    );
    expect(pending.map((r) => r.risk_level).sort()).toEqual(['high', 'high', 'medium']);
    // 计划任务的详情里，节点的执行记录带着待处理的审批（任务页在那一行直接显示批准 / 拒绝）
    const detail = tasks.getTask(store.plans.getPlan(planId)!.taskId);
    const nodeA = detail.plan!.nodes.find((n) => n.node.key === 'a')!;
    expect(nodeA.runs.flatMap((r) => r.approvals).filter((x) => x.status === 'pending')).toHaveLength(3);
  });

  beforeEach(() => {
    logs.length = 0;
  });

  it('只有协调助手能提计划；确认后按依赖放行，汇合点等全部上游，全部通过后任务成功', async () => {
    await setup();
    const { taskId, planId } = propose();
    expect(taskStatus(taskId)).toBe('draft');
    const detail: TaskDetail = tasks.getTask(taskId);
    expect(detail.subtask).toBeNull();
    expect(detail.plan).toMatchObject({ plan: { revision: 1, status: 'proposed' }, actions: { confirm: true, reject: true } });
    expect(detail.plan!.nodes.map((n) => [n.node.key, n.node.dependsOn, n.subtask])).toEqual([
      ['a', [], null],
      ['b', ['a'], null],
      ['c', ['a'], null],
      ['d', ['b', 'c'], null],
    ]);
    expect(runtime.runs).toHaveLength(0);

    // 版本不对时先到者为准
    await expect(plans.confirm(planId, 9)).rejects.toThrow(/已被修改/);
    await confirm(planId);
    // 没有依赖的 A 确认后立即交给监管器（同步进入执行中），其余等依赖
    expect(statuses(taskId)).toEqual({ a: 'running', b: 'waiting_dependency', c: 'waiting_dependency', d: 'waiting_dependency' });
    await until(() => runtime.active(), (a) => a.length === 1, 'A 开始');
    expect(runtime.active()).toEqual(['加记住我-a']);
    expect(taskStatus(taskId)).toBe('running');

    await finishNode(taskId, 'a', '加记住我-a');
    await until(() => runtime.active().sort(), (a) => a.length === 2, 'B、C 同时开始');
    expect(runtime.active().sort()).toEqual(['加记住我-b', '加记住我-c']);
    expect(statuses(taskId).d).toBe('waiting_dependency');

    await finishNode(taskId, 'b', '加记住我-b');
    // C 还没完成，D 不放行
    await new Promise((r) => setTimeout(r, 50));
    expect(statuses(taskId).d).toBe('waiting_dependency');
    await finishNode(taskId, 'c', '加记住我-c');
    await until(() => runtime.active(), (a) => a.includes('加记住我-d'), 'D 开始');
    // 汇合点的提示词带上两个上游的交接（最终回复）
    const prompt = runtime.latest('加记住我-d').request.prompt;
    expect(prompt).toContain('加记住我-b：加记住我-b 完成');
    expect(prompt).toContain('加记住我-c：加记住我-c 完成');
    // 每个节点有自己的 worktree
    expect(new Set(runtime.runs.map((r) => r.request.cwd)).size).toBe(4);

    await finishNode(taskId, 'd', '加记住我-d');
    await until(() => taskStatus(taskId), (s) => s === 'succeeded', '任务成功');
    expect(statuses(taskId)).toEqual({ a: 'succeeded', b: 'succeeded', c: 'succeeded', d: 'succeeded' });
  });

  it('上游失败时下游链式阻塞并写明原因；上游重新开始后自动解除', async () => {
    await setup();
    const { taskId, planId } = propose();
    await confirm(planId);
    await until(() => runtime.active(), (a) => a.length === 1, 'A 开始');
    runtime.latest('加记住我-a').fail('编译不过');
    await until(() => statuses(taskId), (s) => s.d === 'blocked', '下游阻塞');
    expect(statuses(taskId)).toEqual({ a: 'blocked', b: 'blocked', c: 'blocked', d: 'blocked' });
    expect(subtask(taskId, 'a').statusReason).toBe('执行失败：编译不过');
    expect(subtask(taskId, 'b').statusReason).toBe('上游「加记住我-a」阻塞');
    expect(subtask(taskId, 'd').statusReason).toBe('上游「加记住我-b」阻塞');
    expect(taskStatus(taskId)).toBe('blocked');
    expect(runtime.active()).toEqual([]);

    const a = subtask(taskId, 'a');
    tasks.recover(a.id, a.version, 'restart');
    await until(() => statuses(taskId), (s) => s.b === 'waiting_dependency' && s.d === 'waiting_dependency', '下游解除阻塞');
    await until(() => runtime.active(), (x) => x.length === 1, 'A 重新开始');
    expect(taskStatus(taskId)).toBe('running');
    await finishNode(taskId, 'a', '加记住我-a');
    await until(() => runtime.active(), (x) => x.length === 2, 'B、C 开始');
  });

  it('取消任务：运行中的中断，没开始的直接取消，任务最终取消；草稿任务取消时计划一并退回', async () => {
    await setup();
    const { taskId, planId } = propose();
    await confirm(planId);
    await until(() => runtime.active(), (a) => a.length === 1, 'A 开始');
    await finishNode(taskId, 'a', '加记住我-a');
    await until(() => runtime.active(), (a) => a.length === 2, 'B、C 开始');

    tasks.cancelTask(taskId);
    expect(statuses(taskId).d).toBe('cancelled');
    await until(() => taskStatus(taskId), (s) => s === 'cancelled', '任务取消');
    expect(statuses(taskId)).toEqual({ a: 'succeeded', b: 'cancelled', c: 'cancelled', d: 'cancelled' });
    expect(runtime.active()).toEqual([]);
    expect(() => tasks.cancelTask(taskId)).toThrow(/已经结束/);

    const draft = propose('草稿');
    tasks.cancelTask(draft.taskId);
    expect(taskStatus(draft.taskId)).toBe('cancelled');
    expect(store.plans.getPlan(draft.planId)).toMatchObject({ status: 'rejected', decisionNote: '任务已取消' });
    await expect(confirm(draft.planId)).rejects.toThrow();
    expect(runtime.runs.filter((r) => r.title.startsWith('草稿'))).toEqual([]);
  });

  it('并发上限：全局和每个任务都满时排队，名额空出后按顺序启动', async () => {
    await setup({ maxConcurrentRuns: 2, maxRunsPerTask: 1 });
    const one = propose('一');
    const two = propose('二');
    const three = propose('三');
    for (const p of [one, two, three]) await confirm(p.planId);
    await until(() => runtime.active(), (a) => a.length === 2, '两个 A 开始');
    await new Promise((r) => setTimeout(r, 50));
    expect(runtime.active().sort()).toEqual(['一-a', '二-a']);
    expect(statuses(three.taskId).a).toBe('queued');

    // 一的 A 结束（进入待命中）后让出全局名额，三的 A 开始
    runtime.latest('一-a').succeed();
    await until(() => runtime.active(), (a) => a.includes('三-a'), '三的 A 开始');
    await until(() => subtask(one.taskId, 'a').status, (s) => s === 'review', '一的 A 待命中');
    await tasks.decideReview(subtask(one.taskId, 'a').id, subtask(one.taskId, 'a').version, 'accept');

    // 一的 B、C 都已排队，但每个任务同时只能跑 1 个；全局也满（二-a、三-a）
    await until(() => statuses(one.taskId), (s) => s.b === 'queued' && s.c === 'queued', '一的 B、C 排队');
    expect(runtime.active().sort()).toEqual(['三-a', '二-a'].sort());
    runtime.latest('二-a').succeed();
    await until(() => runtime.active(), (a) => a.length === 2 && a.includes('一-b'), '一的 B 开始');
    await new Promise((r) => setTimeout(r, 50));
    expect(runtime.active().sort()).toEqual(['一-b', '三-a'].sort());
    expect(statuses(one.taskId).c).toBe('queued');
    runtime.latest('一-b').succeed();
    await until(() => runtime.active(), (a) => a.includes('一-c'), '一的 C 在 B 结束后开始');
  });
});
