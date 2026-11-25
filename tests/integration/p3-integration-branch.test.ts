/**
 * P3-06 验收（离线，真实的临时 git 仓库）：计划确认时建任务集成分支；节点通过闸门后先在临时 worktree 出候选合并提交，
 * 再快进集成分支；下游节点从集成分支最新提交建 worktree，看得到上游的改动；冲突时集成分支不动、节点交给人，
 * 可以交回开发助手重做或人工处理后重试。用户自己的分支始终不动。
 * 执行器是测试里的模拟：工作 Run 写哪些文件由测试决定，审阅 Run 自动经 MCP 交「通过」。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { IntegrationService, McpGateway, PlanService, ReviewGate, RunSupervisor, TaskGraphScheduler, TaskService } from '@paldock/application';
import type { PersistentEvent, PlanNodeInput, RunStartRequest, RuntimeAdapter, RuntimeEvent, SubtaskRecord } from '@paldock/contracts';
import { openStore, type Store } from '@paldock/storage-sqlite';
import { afterEach, describe, expect, it } from 'vitest';

interface FakeRun {
  request: RunStartRequest;
  title: string;
  ended: boolean;
  succeed(files?: Record<string, string>): void;
}

/** 工作 Run 由测试结束；审阅 Run 自动交「通过」后结束。 */
class FakeRuntime implements RuntimeAdapter {
  readonly name = 'claude';
  readonly runs: FakeRun[] = [];
  constructor(private readonly approve: (token: string) => void) {}

  async discover() {
    const capabilities = { resume: true, streaming: true, approvals: true, cancel: true, workingDirectoryRestriction: false, attachments: false };
    return { runtime: this.name, available: true, capabilities };
  }

  async start(request: RunStartRequest, onEvent: (event: RuntimeEvent) => void) {
    const review = /请审阅子任务「(.+?)」/.test(request.prompt);
    const title = /你负责的子任务：(.+)/.exec(request.prompt)?.[1] ?? /子任务的目标：\n(.+)/.exec(request.prompt)?.[1] ?? '?';
    const run: FakeRun = {
      request,
      title: review ? `审阅:${title}` : title,
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
      if (review) {
        this.approve(request.mcpServer!.env.PALDOCK_MCP_TOKEN!);
        run.succeed();
      }
    });
    return { cancel: async () => {}, respondApproval: () => {}, dispose: async () => {} };
  }

  async checkTurn() {
    return { status: 'not_found' as const };
  }

  work(goal: string, count = 1): FakeRun | undefined {
    return this.runs.filter((r) => r.title === goal).at(count - 1);
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let dataRoot: string;
let initial: string;
let store: Store;
let runtime: FakeRuntime;
let supervisor: RunSupervisor;
let tasks: TaskService;
let plans: PlanService;
let integration: IntegrationService;
let gateway: McpGateway;
let workspaceId: string;
const logs: string[] = [];

async function setup() {
  root = mkdtempSync(join(tmpdir(), 'paldock-p3-int-'));
  repo = join(root, 'repo');
  dataRoot = join(root, 'data');
  mkdirSync(repo);
  mkdirSync(dataRoot);
  git(repo, 'init', '-q', '-b', 'main');
  // 本机全局 core.autocrlf=true 会把检出的文件换成 CRLF；测试按字节比对内容，这个仓库里关掉
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  initial = git(repo, 'rev-parse', 'main');

  store = await openStore(':memory:');
  let scheduler!: TaskGraphScheduler;
  let gate!: ReviewGate;
  const publish = (batch: PersistentEvent[]) => {
    scheduler.onEvents(batch);
    gate.onEvents(batch);
  };
  const log = (message: string) => logs.push(message);
  gateway = new McpGateway({ store, publish, plans: () => plans });
  runtime = new FakeRuntime((token) => gateway.call(gateway.authenticate(token)!, 'submit_review', { decision: 'accept' }));
  supervisor = new RunSupervisor({
    store,
    runtimes: { claude: runtime },
    mcp: { gateway, server: (token) => ({ name: 'paldock', command: 'node', args: [], env: { PALDOCK_MCP_TOKEN: token } }) },
    dataRoot,
    publish,
    publishEphemeral: () => {},
    log,
  });
  scheduler = new TaskGraphScheduler({ store, supervisor, publish, log });
  integration = new IntegrationService({ store, supervisor, dataRoot, publish, log });
  gate = new ReviewGate({ store, supervisor, publish, log, integration });
  plans = new PlanService({ store, scheduler, integration, publish });
  tasks = new TaskService({ store, supervisor, scheduler, integration, dataRoot, publish });
  workspaceId = store.tasks.ensureWorkspace('repo', repo).id;
}

afterEach(async () => {
  await supervisor?.stop();
  await integration?.idle();
  // 合并、调度、闸门都不应该出错（日志里的失败）
  expect(logs.filter((l) => /failed/.test(l) && !/finished: failed/.test(l)).join(' / ')).toBe('');
  store?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  logs.length = 0;
});

async function confirmPlan(nodes: Partial<PlanNodeInput>[]): Promise<string> {
  const coord = store.tasks.createTask({ workspaceId, title: '协调', goal: 'g', role: 'coordinator', checkCommand: null, checkConfirmed: false, idempotencyKey: `c-${Math.random()}` }).record;
  const run = store.runs.createRun({ subtaskId: coord.subtask.id, sessionId: coord.session.id, runtime: 'claude' }).record;
  const caller = gateway.authenticate(gateway.issue(run.id, 'coordinator', 60_000))!;
  const { taskId, planId } = gateway.call(caller, 'propose_plan', {
    title: '加记住我',
    goal: '给登录页加「记住我」',
    nodes: nodes.map((n) => ({ role: 'developer', title: `做 ${n.key}`, goal: `做 ${n.key}`, ...n })),
  }) as { taskId: string; planId: string };
  await plans.confirm(planId, store.plans.getPlan(planId)!.version);
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
const started = (goal: string, count = 1) => until(() => runtime.work(goal, count), (r) => r !== undefined, `${goal} 第 ${count} 次开始`).then((r) => r!);
const integrationHead = (taskId: string) => git(repo, 'rev-parse', store.tasks.getTask(taskId)!.integrationBranch!);

describe('P3 任务集成分支', () => {
  it('确认时建集成分支；节点依次合入，下游从集成分支出发看得到上游的改动；你的分支不动', async () => {
    await setup();
    const taskId = await confirmPlan([{ key: 'a', paths: ['src'] }, { key: 'b', dependsOn: ['a'], paths: ['src'] }]);
    const task = store.tasks.getTask(taskId)!;
    expect(task.integrationBranch).toMatch(/^paldock\/[0-9a-f]{12}$/);
    expect(task.integrationBase).toBe(initial);
    expect(git(task.integrationWorktree!, 'rev-parse', 'HEAD')).toBe(initial);

    (await started('做 a')).succeed({ 'src/a.ts': 'export const a = 1;\n' });
    await until(() => node(taskId, 'a').status, (s) => s === 'succeeded', 'a 合入');
    const afterA = integrationHead(taskId);
    expect(afterA).not.toBe(initial);
    // 候选合并提交：第一父提交是原集成分支 HEAD，第二父提交是节点交付的提交
    expect(git(repo, 'rev-parse', `${afterA}^1`)).toBe(initial);
    expect(git(repo, 'rev-parse', `${afterA}^2`)).toBe(store.runs.getResult(store.runs.latestRun(node(taskId, 'a').id)!.id)!.commitSha);
    expect(store.merges.latestOf(node(taskId, 'a').id)).toMatchObject({ phase: 'done', targetOld: initial, candidateSha: afterA });

    // 下游 b 的 worktree 从集成分支最新提交建，看得到 a 的改动
    const b = await started('做 b');
    expect(node(taskId, 'b').baseCommit).toBe(afterA);
    expect(readFileSync(join(b.request.cwd, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(b.request.prompt).toContain('已合进任务集成分支');
    b.succeed({ 'src/b.ts': 'export const b = 2;\n' });
    await until(() => store.tasks.getTask(taskId)!.status, (s) => s === 'succeeded', '任务成功');

    const head = integrationHead(taskId);
    expect(git(repo, 'rev-parse', `${head}^1`)).toBe(afterA);
    // 集成 worktree 跟着快进，两份改动都在
    const worktree = store.tasks.getTask(taskId)!.integrationWorktree!;
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(join(worktree, 'src/a.ts')) && existsSync(join(worktree, 'src/b.ts'))).toBe(true);
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    // 你自己的分支和工作区没动；临时 worktree 已清理
    expect(git(repo, 'rev-parse', 'main')).toBe(initial);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'worktree', 'list')).not.toContain(join('data', 'merges'));
  });

  it('冲突：集成分支不动，节点交给人并写明冲突文件；交回开发助手在集成分支最新提交上解决后合入', async () => {
    await setup();
    const taskId = await confirmPlan([{ key: 'a' }, { key: 'b' }]);
    const [a, b] = await Promise.all([started('做 a'), started('做 b')]);
    a.succeed({ 'README.md': '# demo\nA 的说明\n' });
    await until(() => node(taskId, 'a').status, (s) => s === 'succeeded', 'a 合入');
    const afterA = integrationHead(taskId);

    b.succeed({ 'README.md': '# demo\nB 的说明\n' });
    await until(() => node(taskId, 'b').gateStage, (s) => s === 'human', 'b 交给人');
    expect(node(taskId, 'b')).toMatchObject({ status: 'review', statusReason: '合并到集成分支冲突：README.md' });
    expect(store.merges.latestOf(node(taskId, 'b').id)).toMatchObject({ phase: 'conflict', conflictFiles: ['README.md'], targetOld: afterA });
    expect(integrationHead(taskId)).toBe(afterA);
    expect(store.attention.list()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'review', taskId })]));
    const view = tasks.getTask(taskId).plan!.nodes.find((n) => n.node.key === 'b')!;
    expect(view).toMatchObject({ merge: { phase: 'conflict' }, actions: { review: true } });

    await integration.redo(node(taskId, 'b').id, node(taskId, 'b').version);
    const redo = await started('做 b', 2);
    expect(redo.request.prompt).toContain('README.md');
    expect(redo.request.resumeThreadId).toBe(`thr_${b.request.runId}`);
    expect(node(taskId, 'b')).toMatchObject({ status: 'running', baseCommit: afterA, reworkCount: 1 });
    // 节点 worktree 里已经合进集成分支的最新提交，冲突文件带冲突标记
    expect(readFileSync(join(redo.request.cwd, 'README.md'), 'utf8')).toMatch(/<<<<<<<[\s\S]*(A 的说明[\s\S]*B 的说明|B 的说明[\s\S]*A 的说明)[\s\S]*>>>>>>>/);

    redo.succeed({ 'README.md': '# demo\nA 的说明\nB 的说明\n' });
    await until(() => store.tasks.getTask(taskId)!.status, (s) => s === 'succeeded', '任务成功');
    const worktree = store.tasks.getTask(taskId)!.integrationWorktree!;
    expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('# demo\nA 的说明\nB 的说明\n');
    // 交付范围按新基线核对：只算 b 自己的改动
    expect(store.runs.getResult(store.runs.latestRun(node(taskId, 'b').id)!.id)!.diffStat).toContain('README.md');
    expect(git(repo, 'rev-parse', 'main')).toBe(initial);
  });

  it('冲突后人工处理：你在节点 worktree 里改好提交，再点重试合并', async () => {
    await setup();
    const taskId = await confirmPlan([{ key: 'a' }, { key: 'b' }]);
    const [a, b] = await Promise.all([started('做 a'), started('做 b')]);
    a.succeed({ 'README.md': '# A\n' });
    await until(() => node(taskId, 'a').status, (s) => s === 'succeeded', 'a 合入');
    b.succeed({ 'README.md': '# B\n' });
    await until(() => node(taskId, 'b').gateStage, (s) => s === 'human', 'b 交给人');

    // 你自己处理：在节点 worktree 里合进集成分支、取 A 和 B 的并集后提交
    const wt = node(taskId, 'b').worktreePath!;
    try {
      git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', integrationHead(taskId));
    } catch {
      // 预期会冲突
    }
    writeFileSync(join(wt, 'README.md'), '# A + B\n');
    git(wt, 'add', '-A');
    git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', '手动解决冲突');

    await tasks.decideReview(node(taskId, 'b').id, node(taskId, 'b').version, 'accept');
    await until(() => store.tasks.getTask(taskId)!.status, (s) => s === 'succeeded', '任务成功');
    expect(readFileSync(join(store.tasks.getTask(taskId)!.integrationWorktree!, 'README.md'), 'utf8')).toBe('# A + B\n');
    expect(store.merges.latestOf(node(taskId, 'b').id)).toMatchObject({ phase: 'done' });
  });

  it('集成检查在候选提交上跑：失败时集成分支不动、交给人', async () => {
    await setup();
    // 检查要求 src/a.ts 和 src/b.ts 不能同时存在：各自单独都通过，合到一起才失败
    const check = { executable: process.execPath, args: ['-e', "const f=require('fs');process.exit(f.existsSync('src/a.ts')&&f.existsSync('src/b.ts')?1:0)"] };
    const taskId = await confirmPlan([
      { key: 'a', check },
      { key: 'b', check },
    ]);
    const [a, b] = await Promise.all([started('做 a'), started('做 b')]);
    a.succeed({ 'src/a.ts': 'a\n' });
    await until(() => node(taskId, 'a').status, (s) => s === 'succeeded', 'a 合入');
    const afterA = integrationHead(taskId);
    b.succeed({ 'src/b.ts': 'b\n' });
    await until(() => node(taskId, 'b').gateStage, (s) => s === 'human', 'b 交给人');
    expect(node(taskId, 'b').statusReason).toMatch(/^集成检查没通过：.*（退出码 1）$/);
    expect(store.merges.latestOf(node(taskId, 'b').id)).toMatchObject({ phase: 'check_failed' });
    expect(integrationHead(taskId)).toBe(afterA);
    // b 自己的检查（单独在它的 worktree 里）是通过的
    expect(store.runs.getResult(store.runs.latestRun(node(taskId, 'b').id)!.id)!.checkStatus).toBe('passed');
  });
});
