/**
 * P3 真实执行器端到端实测（opt-in，消耗额度）：`PALDOCK_LIVE_P3=1 pnpm exec vitest run tests/live/p3.live.test.ts`。
 * 本地服务跑在子进程里（和桌面一样 fork 它），「强杀」就是真的结束这个进程；执行器用本机的真实 Codex 和 Claude
 * （Codex 按 PALDOCK_CODEX_PATH，缺省 D:\software\codex-cli\codex.cmd；Claude 按自动发现，含桌面版自带的那份）。
 * 每个场景独立的临时数据根和临时小仓库，只跑一次；结果（用时、状态、用量）写到 PALDOCK_LIVE_REPORT 指定的 JSON 文件。
 * 副作用：Codex、Claude 自己的历史里会留下这些会话。
 */
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandArgsOf, CommandName, CommandResultOf, PersistentEvent, TaskDetail } from '@paldock/contracts';
import { IpcClient, createIpcPath, createToken } from '@paldock/platform';
import { openStore } from '@paldock/storage-sqlite';
import { afterEach, describe, expect, it } from 'vitest';

const MAIN = fileURLToPath(new URL('../../apps/local-service/dist/main.js', import.meta.url));
const CODEX = process.env.PALDOCK_CODEX_PATH ?? 'D:\\software\\codex-cli\\codex.cmd';
const REPORT = process.env.PALDOCK_LIVE_REPORT ?? join(tmpdir(), 'paldock-p3-live-report.jsonl');
const MINUTE = 60_000;

interface Running {
  child: ChildProcess;
  client: IpcClient;
  events: PersistentEvent[];
  dataRoot: string;
}

let root: string;
let repo: string;
let current: Running | undefined;
/** 本场景里代你批准过的执行器请求（类别）。 */
const approvals: string[] = [];
const started = Date.now();

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** 一个只有 add 函数和一条测试的小仓库。 */
function prepare(name: string): void {
  root = mkdtempSync(join(tmpdir(), `paldock-p3-live-${name}-`));
  repo = join(root, 'repo');
  mkdirSync(join(repo, 'test'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'math.js'), '// 加法\nexport function add(a, b) {\n  return a + b;\n}\n');
  writeFileSync(join(repo, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(join(repo, 'test', 'add.test.js'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../math.js';\n\ntest('add', () => assert.equal(add(1, 2), 3));\n");
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  mkdirSync(join(root, 'data'));
}

/** 和桌面一样 fork 本地服务子进程并连上 IPC。 */
async function boot(): Promise<Running> {
  const dataRoot = join(root, 'data');
  const ipcPath = createIpcPath(dataRoot);
  const token = createToken();
  const child = fork(MAIN, [], { env: { ...process.env, PALDOCK_CODEX_PATH: CODEX }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const log = join(root, 'service.log');
  child.stdout!.on('data', (d) => appendFileSync(log, d));
  child.stderr!.on('data', (d) => appendFileSync(log, d));
  await new Promise<void>((resolve, reject) => {
    child.once('message', (m: { type: string; message?: string }) => (m.type === 'ready' ? resolve() : reject(new Error(m.message))));
    child.once('exit', (code) => reject(new Error(`服务退出 ${code}`)));
    child.send({ type: 'init', dataRoot, ipcPath, token });
  });
  const events: PersistentEvent[] = [];
  // 测试里由脚本代你批准执行器的请求（都在临时 worktree 里，例如写文件），批准次数记进报告
  const client: IpcClient = new IpcClient((e) => {
    events.push(e);
    if (e.type === 'approval.requested') {
      approvals.push(e.payload.kind);
      void client.request('approval.decide', { approvalId: e.aggregateId, expectedVersion: 0, decision: 'allow_once' }).catch(() => {});
    }
  });
  await client.connect(ipcPath, token);
  current = { child, client, events, dataRoot };
  return current;
}

/** 正常退出（和桌面关闭一样）。 */
async function shutdown(s: Running): Promise<void> {
  await s.client.close().catch(() => {});
  await new Promise<void>((resolve) => {
    s.child.once('exit', () => resolve());
    s.child.send({ type: 'shutdown' });
    setTimeout(() => resolve(), 30_000);
  });
  current = undefined;
}

/** 强杀：只结束服务进程本身（不带进程树），然后看执行器子进程有没有残留。 */
async function hardKill(s: Running): Promise<string[]> {
  await s.client.close().catch(() => {});
  execFileSync('taskkill', ['/F', '/PID', String(s.child.pid)]);
  await new Promise((r) => setTimeout(r, 3_000));
  current = undefined;
  return leftovers();
}

/** 命令行里带着这个场景临时目录的进程（执行器、MCP 桥、检查命令）。 */
function leftovers(): string[] {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${root.replaceAll("'", "''")}*' -and $_.ProcessId -ne $PID } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
  return out ? out.split(/\r?\n/) : [];
}

afterEach(async () => {
  if (current) await shutdown(current).catch(() => {});
  for (const line of leftovers()) {
    const pid = line.split(' ')[0]!;
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', pid]);
    } catch {
      // 已经退出
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

const call = <N extends CommandName>(s: Running, name: N, args: CommandArgsOf<N>) => s.client.request(name, args) as Promise<CommandResultOf<N>>;

async function until<T>(probe: () => Promise<T | undefined | false>, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`超时：${what}`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

/** 让协调助手经 propose_plan 提出给定的计划，返回任务 ID 和计划详情。 */
async function proposeViaCoordinator(s: Running, plan: object): Promise<TaskDetail> {
  const workspace = await call(s, 'workspace.add', { rootPath: repo });
  const [session] = await call(s, 'chat.sessions', { workspaceId: workspace.id });
  const text = `请直接调用 PalDock 的 propose_plan 工具提出下面这份计划，参数原样照抄，不要读代码、不要做别的，提完用一句话告诉我：\n${JSON.stringify(plan)}`;
  await call(s, 'chat.send', { sessionId: session!.sessionId, text, idempotencyKey: `live-${Date.now()}` });
  const task = await until(
    async () => (await call(s, 'task.list', { limit: 20 })).find((t) => t.task.status === 'draft'),
    '协调助手提出计划',
    10 * MINUTE,
  );
  return call(s, 'task.get', { taskId: task.task.id });
}

async function confirm(s: Running, detail: TaskDetail): Promise<void> {
  const plan = detail.plan!.plan;
  await call(s, 'plan.confirm', { planId: plan.id, expectedVersion: plan.version });
}

/** 收尾时从数据库读出每次 Run 的执行器、用途、状态、用时和用量，写进报告。 */
async function report(name: string, extra: Record<string, unknown>): Promise<void> {
  const store = await openStore(join(root, 'data'));
  const runs = store.db.all<Record<string, unknown>>(
    `SELECT r.runtime, r.purpose, r.status, r.started_at AS startedAt, r.ended_at AS endedAt, r.failure_reason AS failureReason,
            r.input_tokens AS inputTokens, r.output_tokens AS outputTokens, r.cost_usd AS costUsd, s.role, s.node_key AS nodeKey
       FROM runs r JOIN subtasks s ON s.id = r.subtask_id ORDER BY r.started_at`,
  );
  const recovery = store.events.since(0, 100_000).filter((e) => e.type === 'recovery.performed').map((e) => e.payload);
  store.close();
  appendFileSync(REPORT, `${JSON.stringify({ name, at: new Date().toISOString(), elapsedMs: Date.now() - started, runs, recovery, approvals: approvals.splice(0), ...extra })}\n`);
}

describe.skipIf(process.env.PALDOCK_LIVE_P3 !== '1')('P3 真实执行器', () => {
  it('完整链路：协调助手提计划 → 确认 → Claude 开发 → Codex 测试 → Codex 审阅 → 合入集成分支 → 待合并', { timeout: 60 * MINUTE }, async () => {
    prepare('chain');
    const s = await boot();
    const t0 = Date.now();
    const detail = await proposeViaCoordinator(s, {
      title: '加 sub 函数',
      goal: '在 math.js 加一个 sub 函数并补测试',
      nodes: [
        { key: 'dev', role: 'developer', title: '实现 sub', goal: '在 math.js 里加 export function sub(a, b) { return a - b; }。只改 math.js，不要动别的文件。', paths: ['math.js'] },
        {
          key: 'test',
          role: 'tester',
          title: '测试 sub',
          goal: '新建 test/sub.test.js，用 node:test 和 node:assert 为 math.js 的 sub 写一个测试（例如 sub(5, 3) 等于 2）。只新建这个文件。',
          paths: ['test'],
          dependsOn: ['dev'],
          check: { executable: 'node', args: ['--test'] },
        },
      ],
    });
    const proposedMs = Date.now() - t0;
    expect(detail.plan!.nodes.map((n) => [n.node.key, n.executor])).toEqual([
      ['dev', 'claude'],
      ['test', 'codex'],
    ]);
    await confirm(s, detail);
    const done = await until(async () => {
      const d = await call(s, 'task.get', { taskId: detail.task.id });
      const stuck = d.plan!.nodes.find((n) => n.subtask?.gateStage === 'human' || n.subtask?.status === 'blocked');
      if (stuck) throw new Error(`节点 ${stuck.node.key} 停住：${stuck.subtask!.statusReason}`);
      return d.task.status === 'succeeded' && d;
    }, '任务全部通过', 45 * MINUTE);
    const branch = done.task.integrationBranch!;
    const files = git(repo, 'ls-tree', '-r', '--name-only', branch);
    expect(files).toContain('test/sub.test.js');
    expect(git(repo, 'show', `${branch}:math.js`)).toContain('sub');
    // 你的 main 不动
    expect(git(repo, 'rev-parse', 'main')).toBe(done.task.integrationBase);
    await shutdown(s);
    await report('chain', { proposedMs, totalMs: Date.now() - t0, branch, files: files.split('\n') });
  });

  it('角色会话复用：两个开发节点、两轮审阅，Codex / Claude 里只多出协调、开发、审阅三个会话', { timeout: 60 * MINUTE }, async () => {
    prepare('reuse');
    const s = await boot();
    const t0 = Date.now();
    const detail = await proposeViaCoordinator(s, {
      title: '加 sub 和 mul',
      goal: '在 math.js 加 sub 和 mul 两个函数',
      nodes: [
        { key: 'sub', role: 'developer', title: '实现 sub', goal: '在 math.js 里加 export function sub(a, b) { return a - b; }。只改 math.js。', paths: ['math.js'] },
        { key: 'mul', role: 'developer', title: '实现 mul', goal: '在 math.js 里加 export function mul(a, b) { return a * b; }。只改 math.js。', paths: ['math.js'], dependsOn: ['sub'] },
      ],
    });
    await confirm(s, detail);
    await until(async () => {
      const d = await call(s, 'task.get', { taskId: detail.task.id });
      const stuck = d.plan!.nodes.find((n) => n.subtask?.gateStage === 'human' || n.subtask?.status === 'blocked');
      if (stuck) throw new Error(`节点 ${stuck.node.key} 停住：${stuck.subtask!.statusReason}`);
      return d.task.status === 'succeeded' && d;
    }, '任务全部通过', 45 * MINUTE);
    await shutdown(s);
    const store = await openStore(s.dataRoot);
    try {
      const threads = store.db.all<{ runtime: string; purpose: string; role: string | null; threads: number; runs: number }>(
        `SELECT r.runtime, r.purpose, coalesce(rs.role, 'coordinator') AS role, count(DISTINCT r.native_thread_id) AS threads, count(*) AS runs
           FROM runs r LEFT JOIN role_sessions rs ON rs.id = r.role_session_id GROUP BY r.runtime, r.purpose, role ORDER BY role`,
      );
      await report('reuse', { totalMs: Date.now() - t0, threads });
      // 开发两轮在同一个 Claude 会话里，两轮审阅在同一个 Codex 会话里，协调助手一个会话
      expect(threads.find((t) => t.role === 'developer')).toMatchObject({ runtime: 'claude', threads: 1, runs: 2 });
      expect(threads.find((t) => t.role === 'reviewer')).toMatchObject({ runtime: 'codex', threads: 1, runs: 2 });
      expect(threads.find((t) => t.role === 'coordinator')?.threads).toBe(1);
    } finally {
      store.close();
    }
  });

  it('单人模式：一个助手直接在项目目录里改代码、跑测试，不拆计划', { timeout: 30 * MINUTE }, async () => {
    prepare('solo');
    const s = await boot();
    const t0 = Date.now();
    const workspace = await call(s, 'workspace.add', { rootPath: repo });
    await call(s, 'project.setMode', { workspaceId: workspace.id, expectedVersion: 0, mode: 'solo', confirmDirect: true });
    const [session] = await call(s, 'chat.sessions', { workspaceId: workspace.id });
    await call(s, 'chat.send', {
      sessionId: session!.sessionId,
      text: '在 math.js 里加 export function mul(a, b) { return a * b; }，再运行 node --test 确认测试通过。只改 math.js，不要提交。',
      idempotencyKey: `solo-${Date.now()}`,
    });
    const reply = await until(
      async () => {
        const detail = await call(s, 'chat.get', { sessionId: session!.sessionId, limit: 20 });
        return detail.wakes[0]?.status === 'done' && detail.messages.findLast((m) => m.role === 'assistant');
      },
      '单人助手做完',
      20 * MINUTE,
    );
    const math = readFileSync(join(repo, 'math.js'), 'utf8');
    const status = git(repo, 'status', '--porcelain');
    const tasks = await call(s, 'task.list', { limit: 20 });
    await shutdown(s);
    await report('solo', { totalMs: Date.now() - t0, reply: reply.body.slice(0, 500), status, tasks: tasks.length });
    expect(math).toContain('mul');
    // 直接改在你的工作区里，没有提交、没有拆计划
    expect(status).toContain('math.js');
    expect(tasks).toHaveLength(0);
  });

  it('开发节点运行中强杀本地服务后重启：检查残留进程，按 checkTurn 恢复', { timeout: 40 * MINUTE }, async () => {
    prepare('restart');
    let s = await boot();
    const detail = await proposeViaCoordinator(s, {
      title: '加 mul 函数',
      goal: '在 math.js 加 mul',
      nodes: [
        {
          key: 'dev',
          role: 'developer',
          title: '实现 mul',
          goal: '先读一遍 math.js，再在里面加 export function mul(a, b) { return a * b; }，然后运行 node --test 确认通过。只改 math.js。',
          paths: ['math.js'],
        },
      ],
    });
    await confirm(s, detail);
    // 等开发 Run 拿到 turn（已经在执行）后立刻强杀
    await until(async () => {
      const d = await call(s, 'task.get', { taskId: detail.task.id });
      return d.plan!.nodes[0]!.runs.some((r) => r.run.purpose === 'work' && r.run.nativeTurnId) || undefined;
    }, '开发 Run 开始', 10 * MINUTE);
    const afterKill = await hardKill(s);
    await new Promise((r) => setTimeout(r, 10_000));
    const later = leftovers();

    s = await boot();
    const rebootedAt = Date.now();
    // 恢复在服务就绪后异步进行（先收拾合并、再按 checkTurn 核对），等它处理到这个节点
    const nodeId = (await call(s, 'task.get', { taskId: detail.task.id })).plan!.nodes[0]!.subtask!.id;
    const recovered = await until(async () => {
      const items = await call(s, 'recovery.report', {});
      return items.some((i) => i.targetId === nodeId) && items;
    }, '恢复处理到开发节点', 5 * MINUTE);
    const recoveredMs = Date.now() - rebootedAt;
    const finalDetail = await until(async () => {
      const d = await call(s, 'task.get', { taskId: detail.task.id });
      const node = d.plan!.nodes[0]!.subtask!;
      return (d.task.status === 'succeeded' || node.gateStage === 'human' || node.status === 'failed' || node.status === 'blocked') && d;
    }, '重启后结束', 25 * MINUTE);
    await shutdown(s);
    await report('restart', {
      leftoversRightAfterKill: afterKill,
      leftoversAfter10s: later,
      recovered,
      recoveredMs,
      afterRebootMs: Date.now() - rebootedAt,
      taskStatus: finalDetail.task.status,
      node: finalDetail.plan!.nodes[0]!.subtask,
    });
    expect(recovered.length).toBeGreaterThan(0);
    expect(finalDetail.task.status).toBe('succeeded');
  });

  it('冲突：两个并行节点改同一行，后合入的交给人并写明冲突文件', { timeout: 40 * MINUTE }, async () => {
    prepare('conflict');
    const s = await boot();
    const detail = await proposeViaCoordinator(s, {
      title: '改注释',
      goal: '两个节点都改 math.js 第一行注释',
      nodes: [
        { key: 'one', role: 'developer', title: '注释一', goal: '把 math.js 第一行注释改成 // 加法（版本一）。只改这一行。', paths: ['math.js'] },
        { key: 'two', role: 'developer', title: '注释二', goal: '把 math.js 第一行注释改成 // 加法（版本二）。只改这一行。', paths: ['math.js'] },
      ],
    });
    await confirm(s, detail);
    const result = await until(async () => {
      const d = await call(s, 'task.get', { taskId: detail.task.id });
      const conflicted = d.plan!.nodes.find((n) => n.merge?.phase === 'conflict');
      const done = d.plan!.nodes.find((n) => n.subtask?.status === 'succeeded');
      return conflicted && done && { d, conflicted };
    }, '一个合入、一个冲突', 30 * MINUTE);
    expect(result.conflicted.subtask!.statusReason).toContain('math.js');
    await shutdown(s);
    await report('conflict', { conflicted: result.conflicted.node.key, reason: result.conflicted.subtask!.statusReason, merge: result.conflicted.merge });
    expect(readFileSync(REPORT, 'utf8')).toContain('conflict');
  });
});
