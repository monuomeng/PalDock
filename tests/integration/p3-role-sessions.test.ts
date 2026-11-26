/**
 * 角色会话复用（2026-11-26 已定）：计划节点按（项目，角色，执行器）复用原生会话，并行用会话池，
 * 用久了先写摘要再换新会话（换下的归档），续用失败时换新会话重试。离线，模拟执行器。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { McpGateway, PlanService, RunSupervisor, TaskGraphScheduler } from '@paldock/application';
import type { PersistentEvent, RunStartRequest, RuntimeAdapter, RuntimeEvent } from '@paldock/contracts';
import { openStore, type Store } from '@paldock/storage-sqlite';
import { afterEach, describe, expect, it } from 'vitest';

interface FakeRun {
  request: RunStartRequest;
  title: string;
  threadId: string;
  ended: boolean;
  /** 交付：缺省写一个 `<标题>.txt`；给了 files 就写这些文件（相对工作目录）。 */
  succeed(files?: Record<string, string>): void;
  /** 像 Claude 一样请求改文件 / 跑命令，返回宿主的决定（待审批时一直不返回）。 */
  ask(request: { kind: 'file_change'; path: string } | { kind: 'command'; command: string }): Promise<string>;
}

class FakeRuntime implements RuntimeAdapter {
  readonly name = 'claude';
  readonly runs: FakeRun[] = [];
  readonly archived: string[] = [];
  /** 续用这些原生会话时启动失败（会话被删了）。 */
  readonly broken = new Set<string>();

  async discover() {
    const capabilities = { resume: true, streaming: true, approvals: true, cancel: true, workingDirectoryRestriction: false, attachments: false };
    return { runtime: this.name, available: true, capabilities };
  }

  async start(request: RunStartRequest, onEvent: (event: RuntimeEvent) => void) {
    if (request.resumeThreadId && this.broken.has(request.resumeThreadId)) throw new Error(`No conversation found with session ID: ${request.resumeThreadId}`);
    const threadId = request.resumeThreadId ?? `thr_${this.runs.length + 1}`;
    const title = /你负责的子任务：(.+)/.exec(request.prompt)?.[1] ?? '?';
    const decisions = new Map<string, (decision: string) => void>();
    const run: FakeRun = {
      request,
      title,
      threadId,
      ended: false,
      ask: (what) =>
        new Promise<string>((resolve) => {
          const id = `perm_${Math.random()}`;
          decisions.set(id, resolve);
          const req =
            what.kind === 'file_change'
              ? { nativeRequestId: id, kind: 'file_change' as const, summary: `Edit：${what.path}`, paths: [what.path] }
              : { nativeRequestId: id, kind: 'command' as const, summary: what.command, command: what.command };
          onEvent({ type: 'approval_request', request: req });
        }),
      succeed: (files) => {
        if (run.ended) return;
        run.ended = true;
        for (const [path, content] of Object.entries(files ?? { [`${title}.txt`]: title })) {
          mkdirSync(dirname(join(request.cwd, path)), { recursive: true });
          writeFileSync(join(request.cwd, path), content);
        }
        onEvent({ type: 'completed', finalMessage: `${title} 完成`, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } });
      },
    };
    this.runs.push(run);
    setImmediate(() => {
      onEvent({ type: 'thread', threadId });
      onEvent({ type: 'turn', turnId: `turn_${request.runId}` });
    });
    return {
      respondApproval: (id: string, decision: string) => decisions.get(id)?.(decision),
      cancel: async () => {
        run.ended = true;
        onEvent({ type: 'interrupted' });
      },
      dispose: async () => {},
    };
  }

  async checkTurn() {
    return { status: 'not_found' as const };
  }

  async archiveThread(threadId: string) {
    this.archived.push(threadId);
  }

  started(title: string): FakeRun | undefined {
    return this.runs.findLast((r) => r.title === title);
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8' });

let root: string;
let store: Store;
let runtime: FakeRuntime;
let supervisor: RunSupervisor;
let plans: PlanService;
let gateway: McpGateway;
let workspaceId: string;
const logs: string[] = [];

async function setup(options: { maxRunsPerTask?: number; maxTurns?: number } = {}) {
  root = mkdtempSync(join(tmpdir(), 'paldock-p3-roles-'));
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
  supervisor = new RunSupervisor({
    store,
    runtimes: { claude: runtime },
    dataRoot,
    publish,
    publishEphemeral: () => {},
    log,
    limits: options.maxRunsPerTask ? { maxRunsPerTask: options.maxRunsPerTask } : {},
    ...(options.maxTurns ? { roleSessionLimits: { roleSessionMaxTurns: options.maxTurns, roleSessionMaxTokens: 1e12 } } : {}),
  });
  scheduler = new TaskGraphScheduler({ store, supervisor, publish, log });
  plans = new PlanService({ store, scheduler, publish });
  workspaceId = store.tasks.ensureWorkspace('repo', repo).id;
}

afterEach(async () => {
  await supervisor?.stop();
  plans?.stop();
  store?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  logs.length = 0;
});

/** 协调助手经 MCP 提一份全是独立节点的计划并确认（多节点，不会自动确认）。 */
async function runPlan(nodes: { key: string; role: string; dependsOn?: string[] }[]): Promise<void> {
  await plans.confirm(...proposeOnly(nodes));
}

/** 只提出不确认：返回计划 ID 和版本。 */
function proposeOnly(nodes: { key: string; role: string; dependsOn?: string[] }[]): [string, number] {
  const coordinator = store.tasks.createTask({ workspaceId, title: '协调', goal: 'g', role: 'coordinator', checkCommand: null, checkConfirmed: false, idempotencyKey: `c-${Math.random()}` }).record;
  const run = store.runs.createRun({ subtaskId: coordinator.subtask.id, sessionId: coordinator.session.id, runtime: 'claude' }).record;
  const caller = gateway.authenticate(gateway.issue(run.id, 'coordinator', 60_000))!;
  const { planId } = gateway.call(caller, 'propose_plan', {
    title: '计划',
    goal: '目标',
    nodes: nodes.map((n) => ({ key: n.key, role: n.role, title: n.key, goal: `做 ${n.key}`, dependsOn: n.dependsOn ?? [] })),
  }) as { planId: string };
  return [planId, store.plans.getPlan(planId)!.version];
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
const started = (title: string) => until(() => runtime.started(title), (r) => r !== undefined, `${title} 开始`).then((r) => r!);
const sessions = () => store.db.all<{ role: string; status: string; turns: number; native_thread_id: string | null; summary: string | null }>(
  'SELECT role, status, turns, native_thread_id, summary FROM role_sessions ORDER BY created_at',
);
const idle = () => until(() => store.db.all(`SELECT id FROM role_sessions WHERE status = 'busy'`).length, (n) => n === 0, '会话都放回');

describe('角色会话复用', () => {
  it('同一角色的多个子任务在同一个原生会话里开新 turn：角色说明只发一次，每轮带这一轮的工作目录', async () => {
    await setup({ maxRunsPerTask: 1 });
    await runPlan([
      { key: 'x1', role: 'developer' },
      { key: 'x2', role: 'developer' },
    ]);
    const x1 = await started('x1');
    expect(x1.request.resumeThreadId).toBeUndefined();
    expect(x1.request.instructions).toContain('你是 PalDock 的开发助手');
    expect(x1.request.prompt).toContain(`这一轮的工作目录（只在这里操作）：${x1.request.cwd}`);
    x1.succeed();

    const x2 = await started('x2');
    expect(x2.request.resumeThreadId).toBe(x1.threadId);
    expect(x2.request.instructions).toBeUndefined();
    expect(x2.request.cwd).not.toBe(x1.request.cwd);
    expect(x2.request.prompt).toContain(`这一轮的工作目录（只在这里操作）：${x2.request.cwd}`);
    x2.succeed();
    await idle();
    expect(sessions()).toEqual([{ role: 'developer', status: 'idle', turns: 2, native_thread_id: x1.threadId, summary: null }]);
    // 两次 Run 都记着用的是这个角色会话
    const roleSessionIds = store.db.all<{ role_session_id: string }>(`SELECT DISTINCT role_session_id FROM runs WHERE role_session_id IS NOT NULL`);
    expect(roleSessionIds).toHaveLength(1);
  });

  it('不同角色用不同的会话；并行时按角色的并发上限建会话池，满了就排队，空出来再复用', async () => {
    await setup();
    // 测试助手的并发上限是 2：三个独立的测试节点只开两个会话，第三个等前面的放回
    await runPlan([
      { key: 't1', role: 'tester' },
      { key: 't2', role: 'tester' },
      { key: 't3', role: 'tester' },
      { key: 'd1', role: 'developer' },
    ]);
    const [t1, t2, d1] = await Promise.all([started('t1'), started('t2'), started('d1')]);
    expect(new Set([t1.threadId, t2.threadId, d1.threadId]).size).toBe(3);
    await new Promise((r) => setTimeout(r, 100));
    expect(runtime.started('t3')).toBeUndefined();
    t2.succeed();
    const t3 = await started('t3');
    expect(t3.request.resumeThreadId).toBe(t2.threadId);
    t1.succeed();
    t3.succeed();
    d1.succeed();
    await idle();
    expect(sessions().map((s) => `${s.role}:${s.turns}`).sort()).toEqual(['developer:1', 'tester:1', 'tester:2']);
  });

  it('跑满阈值：下一轮要求写角色摘要，结束后换下并归档；新会话首轮注入摘要和角色说明', async () => {
    await setup({ maxRunsPerTask: 1, maxTurns: 1 });
    await runPlan([
      { key: 'r1', role: 'developer' },
      { key: 'r2', role: 'developer' },
      { key: 'r3', role: 'developer' },
    ]);
    const r1 = await started('r1');
    r1.succeed();
    const r2 = await started('r2');
    expect(r2.request.resumeThreadId).toBe(r1.threadId);
    expect(r2.request.prompt).toContain('调用 write_summary');
    // 开发助手在这一轮里写摘要（经 MCP，写在它占用的角色会话上）
    const caller = gateway.authenticate(gateway.issue(r2.request.runId, 'developer', 60_000))!;
    expect(gateway.call(caller, 'write_summary', { summary: '测试用 node --test；入口在 main.py' })).toMatchObject({ saved: true });
    r2.succeed();
    const r3 = await started('r3');
    expect(r3.request.resumeThreadId).toBeUndefined();
    expect(r3.request.instructions).toContain('你是 PalDock 的开发助手');
    expect(r3.request.prompt).toContain('测试用 node --test；入口在 main.py');
    r3.succeed();
    await idle();
    expect(sessions().map((s) => [s.status, s.turns])).toEqual([
      ['retired', 2],
      ['idle', 1],
    ]);
    await until(() => runtime.archived, (a) => a.length === 1, '换下的会话归档');
    expect(runtime.archived).toEqual([r1.threadId]);
  });

  it('续用失败（原生会话没了）：换下这个会话，开新会话重试，带角色说明', async () => {
    await setup({ maxRunsPerTask: 1 });
    await runPlan([
      { key: 'f1', role: 'developer' },
      { key: 'f2', role: 'developer' },
    ]);
    const f1 = await started('f1');
    runtime.broken.add(f1.threadId);
    f1.succeed();
    const f2 = await started('f2');
    expect(f2.request.resumeThreadId).toBeUndefined();
    expect(f2.request.instructions).toContain('你是 PalDock 的开发助手');
    f2.succeed();
    await idle();
    expect(sessions().map((s) => s.status)).toEqual(['retired', 'idle']);
    expect(store.db.all(`SELECT seq FROM events WHERE type = 'run.notice' AND json_extract(payload, '$.code') = 'resume_failed'`)).toHaveLength(1);
    logs.length = 0; // 「续不上」的日志是预期的
  });
});

describe('项目级助手设置（2026-11-26 已定）', () => {
  const repo = () => store.tasks.getWorkspace(workspaceId)!.rootPath;
  const setRole = (role: string, patch: Parameters<Store['projectSettings']['setRole']>[3]) =>
    store.projectSettings.setRole(workspaceId, role, store.projectSettings.role(workspaceId, role).version, patch);
  const pending = () => store.db.all<{ kind: string; risk_level: string }>(`SELECT kind, risk_level FROM approvals WHERE status = 'pending'`);
  const auto = () => store.db.all<{ result: string }>(`SELECT result FROM audit_log WHERE action = 'approval.auto' ORDER BY id`).map((r) => r.result);

  it('项目里没启用的角色不能派单', async () => {
    await setup();
    setRole('tester', { enabled: false });
    await expect(runPlan([{ key: 't', role: 'tester' }, { key: 'd', role: 'developer' }])).rejects.toThrow(/没有启用这些角色：测试助手/);
  });

  it('直接在项目目录里改：工作目录是项目根目录，不建 worktree、不动你的暂存区；同一时刻只有一个写入者；交付按新改动核对，不提交', async () => {
    await setup();
    setRole('developer', { isolation: 'direct' });
    // 你自己还没提交的改动：不算交付
    writeFileSync(join(repo(), 'README.md'), '# demo\n我自己的改动\n');
    await runPlan([
      { key: 'd1', role: 'developer' },
      { key: 'd2', role: 'developer' },
    ]);
    const first = await until(() => runtime.runs[0], (r) => r !== undefined, '第一个写入者开始');
    expect(first.request.cwd).toBe(repo());
    await new Promise((r) => setTimeout(r, 100));
    expect(runtime.runs).toHaveLength(1); // 另一个直接写入者在排队
    // 改项目目录里的文件：工作目录内自动批准
    expect(await first.ask({ kind: 'file_change', path: join(repo(), `${first.title}.txt`) })).toBe('allow_once');
    first.succeed();
    const second = await until(() => runtime.runs[1], (r) => r !== undefined, '第二个写入者开始');
    expect(second.request.cwd).toBe(repo());
    const subtask = store.tasks.listSubtasks(store.tasks.getSubtask(store.runs.getRun(first.request.runId)!.subtaskId)!.taskId).find((s) => s.nodeKey === first.title)!;
    expect(subtask.worktreePath).toBeNull();
    const result = store.runs.getResult(first.request.runId)!;
    expect(result).toMatchObject({ commitSha: null, outOfScope: [] });
    expect(git(repo(), 'diff', '--cached', '--name-only').trim()).toBe('');
    expect(git(repo(), 'status', '--porcelain')).toContain('README.md');
    second.succeed();
    await idle();
  });

  it('只读：Codex 用只读沙箱，写文件的请求一律拒绝并记审计', async () => {
    await setup();
    await runPlan([
      { key: 'r', role: 'researcher' },
      { key: 'x', role: 'developer' },
    ]);
    const r = await started('r');
    expect(r.request.readOnly).toBe(true);
    expect(await r.ask({ kind: 'file_change', path: join(r.request.cwd, 'notes.md') })).toBe('deny');
    expect(auto()).toContain('deny:readonly');
    const x = await started('x');
    expect(x.request.readOnly).toBeUndefined();
  });

  it('审批严格度：工作目录内自动批准（默认）、每条都审批、只审批高风险', async () => {
    await setup({ maxRunsPerTask: 1 });
    await runPlan([
      { key: 'a', role: 'developer' },
      { key: 'b', role: 'developer' },
      { key: 'c', role: 'developer' },
    ]);
    // 默认：工作目录内的改动和普通命令自动批准，装依赖要审批
    const a = await started('a');
    expect(await a.ask({ kind: 'file_change', path: join(a.request.cwd, 'a.ts') })).toBe('allow_once');
    expect(await a.ask({ kind: 'command', command: 'node --test' })).toBe('allow_once');
    void a.ask({ kind: 'command', command: 'pnpm install' });
    await until(pending, (p) => p.length === 1, '装依赖要审批');
    setRole('developer', { approval: 'all' });
    a.succeed();

    // 每条都审批：工作目录里改文件也要问
    const b = await started('b');
    void b.ask({ kind: 'file_change', path: join(b.request.cwd, 'b.ts') });
    await until(pending, (p) => p.some((x) => x.kind === 'file_change'), '每条都审批');
    setRole('developer', { approval: 'high_only' });
    b.succeed();

    // 只审批高风险：装依赖（中风险）自动批准，写到工作目录外（高风险）要问
    const c = await started('c');
    expect(await c.ask({ kind: 'command', command: 'pnpm install' })).toBe('allow_once');
    void c.ask({ kind: 'file_change', path: join(root, 'outside.txt') });
    await until(pending, (p) => p.some((x) => x.risk_level === 'high'), '高风险要问');
    expect(auto()).toEqual(['allow:write_in_worktree', 'allow:run_command_in_worktree', 'allow:install_dependencies:high_only']);
    c.succeed();
  });
});

describe('Codex 复审的修复（0.3.5）', () => {
  const repo = () => store.tasks.getWorkspace(workspaceId)!.rootPath;
  const setRole = (role: string, patch: Parameters<Store['projectSettings']['setRole']>[3]) =>
    store.projectSettings.setRole(workspaceId, role, store.projectSettings.role(workspaceId, role).version, patch);

  it('依赖两端一个直接改项目目录、一个用 worktree：提出时拒绝；提出后才改设置的，确认时拒绝', async () => {
    await setup();
    setRole('developer', { isolation: 'direct' });
    expect(() => proposeOnly([{ key: 'd', role: 'developer' }, { key: 't', role: 'tester', dependsOn: ['d'] }])).toThrow(/拿不到上游的改动：d → t/);
    // 没有依赖的可以混用
    expect(() => proposeOnly([{ key: 'd', role: 'developer' }, { key: 't', role: 'tester' }])).not.toThrow();

    setRole('developer', { isolation: 'worktree' });
    const [planId, version] = proposeOnly([{ key: 'd', role: 'developer' }, { key: 't', role: 'tester', dependsOn: ['d'] }]);
    setRole('developer', { isolation: 'direct' });
    await expect(plans.confirm(planId, version)).rejects.toThrow(/拿不到上游的改动/);
    setRole('tester', { isolation: 'direct' });
    await expect(plans.confirm(planId, version)).resolves.toBeUndefined();
  });

  it('你改过的文件助手又改了：按内容比对，算进这次的交付并核对范围', async () => {
    await setup({ maxRunsPerTask: 1 });
    writeFileSync(join(repo(), 'config.ts'), 'export const a = 1;\n');
    git(repo(), 'add', 'config.ts');
    git(repo(), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'config');
    writeFileSync(join(repo(), 'config.ts'), 'export const a = 2; // 我自己的改动\n');
    setRole('docs', { isolation: 'direct' });
    await runPlan([
      { key: 'g1', role: 'docs' },
      { key: 'g2', role: 'docs' },
    ]);
    // 只改了文档：你原有的 config.ts 改动不算越界
    const g1 = await started('g1');
    g1.succeed({ 'docs/guide.md': '# 用法\n' });
    await until(() => store.runs.getResult(g1.request.runId), (r) => r !== undefined, 'g1 交付');
    expect(store.runs.getResult(g1.request.runId)).toMatchObject({ commitSha: null, outOfScope: [] });
    // 又改了你改过的 config.ts：内容变了，算这次的改动，越出文档助手的交付范围
    const g2 = await started('g2');
    g2.succeed({ 'config.ts': 'export const a = 3;\n' });
    await until(() => store.runs.getResult(g2.request.runId), (r) => r !== undefined, 'g2 交付');
    expect(store.runs.getResult(g2.request.runId)!.outOfScope).toEqual(['config.ts']);
  });

  it('角色会话续用失败：强制新建会话，不借池里另一个空闲会话，首轮带角色说明', async () => {
    await setup();
    // 两个开发会话都空闲下来
    await runPlan([
      { key: 'p1', role: 'developer' },
      { key: 'p2', role: 'developer' },
    ]);
    const [p1, p2] = await Promise.all([started('p1'), started('p2')]);
    p1.succeed();
    await new Promise((r) => setTimeout(r, 20));
    p2.succeed();
    await idle();
    // 最近用过的（p2 的会话）会被优先续用：让它续不上
    runtime.broken.add(p2.threadId);
    await runPlan([{ key: 'q1', role: 'developer' }, { key: 'q2', role: 'tester' }]);
    const q1 = await started('q1');
    expect(q1.request.resumeThreadId).toBeUndefined();
    expect(q1.request.instructions).toContain('你是 PalDock 的开发助手');
    expect(q1.threadId).not.toBe(p1.threadId);
    q1.succeed();
    (await started('q2')).succeed();
    await idle();
    const developer = sessions().filter((x) => x.role === 'developer');
    expect(developer.map((x) => [x.native_thread_id, x.status])).toEqual([
      [p1.threadId, 'idle'],
      [p2.threadId, 'retired'],
      [q1.threadId, 'idle'],
    ]);
    logs.length = 0;
  });
});
