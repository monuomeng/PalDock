/**
 * P1 验收（离线）：本地服务 + 模拟 Codex app-server + 临时 git 仓库，从建任务到执行再到回显，
 * 以及拒绝、过期、取消、执行器崩溃、服务重启、重复提交、A/B「待我处理」场景。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalService } from '@paldock/local-service';
import type {
  AttentionItem,
  CommandArgsOf,
  CommandName,
  EphemeralEvent,
  PersistentEvent,
  RunDetail,
  TaskDetail,
} from '@paldock/contracts';
import { IpcClient, createIpcPath, createToken } from '@paldock/platform';
import { CodexAdapter, MOCK_APP_SERVER_PATH } from '@paldock/runtime-codex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root: string;
let dataRoot: string;
let repo: string;
let mockHome: string;
let service: LocalService | undefined;
let client: IpcClient;
let token: string;
let ipcPath: string;
const events: PersistentEvent[] = [];
const deltas: EphemeralEvent[] = [];

const LIMITS = { confirmIntervalMs: 50, expiryScanMs: 50, outputCheckpointMs: 50 };

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8' });
}

async function startService(extraEnv: Record<string, string> = {}, limits: Record<string, number> = {}) {
  token = createToken();
  ipcPath = createIpcPath(dataRoot);
  service = await LocalService.start({
    dataRoot,
    ipcPath,
    token,
    runtime: new CodexAdapter({
      configuredPath: MOCK_APP_SERVER_PATH,
      extraEnv: { MOCK_CODEX_HOME: mockHome, ...extraEnv },
      cancelWaitMs: 3_000,
      interruptWaitMs: 3_000,
    }),
    limits: { ...LIMITS, ...limits },
  });
  client = new IpcClient(
    (e) => events.push(e),
    (e) => deltas.push(e),
  );
  await client.connect(ipcPath, token);
}

async function stopService() {
  await client.close();
  await service?.stop();
  service = undefined;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'paldock-p1-'));
  dataRoot = join(root, 'data');
  repo = join(root, 'my repo');
  mockHome = join(root, 'mock-home');
  mkdirSync(dataRoot);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  events.length = 0;
  deltas.length = 0;
  await startService();
});

afterEach(async () => {
  await stopService();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const call = <N extends CommandName>(name: N, args: CommandArgsOf<N>) => client.request(name, args);
const detail = (taskId: string) => call('task.get', { taskId }) as Promise<TaskDetail>;
const attention = () => call('attention.list', {}) as Promise<AttentionItem[]>;
let keySeq = 0;
const create = (goal: string, extra: Partial<CommandArgsOf<'task.create'>> = {}) =>
  call('task.create', { rootPath: repo, goal, idempotencyKey: `key-${++keySeq}-${Date.now()}`, ...extra }) as Promise<TaskDetail>;

/** 轮询任务详情直到满足条件（服务端推进是异步的）。 */
async function until(taskId: string, predicate: (d: TaskDetail) => boolean, timeoutMs = 15_000): Promise<TaskDetail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await detail(taskId);
    if (predicate(d)) return d;
    if (Date.now() > deadline) throw new Error(`等待超时：${JSON.stringify({ subtask: d.subtask.status, runs: d.runs.map((r) => r.run.status) })}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}
const latest = (d: TaskDetail): RunDetail => d.runs.at(-1)!;
const pendingApproval = (d: TaskDetail) => d.runs.flatMap((r) => r.approvals).find((a) => a.status === 'pending');

describe('P1 主流程', () => {
  it('建任务 → worktree → 流式回显 → 证据（改动、检查结果）→ 验收后提交到 PalDock 分支', async () => {
    const created = await create('加一个文件', {
      check: { executable: process.execPath, args: ['-e', "console.log('token=abc123'); process.exit(0)"] },
      checkConfirmed: true,
    });
    const reviewed = await until(created.task.id, (d) => d.subtask.status === 'review');
    const run = latest(reviewed);
    expect(reviewed.subtask.branch).toMatch(/^paldock\/[0-9a-f]{8}$/);
    expect(existsSync(join(reviewed.subtask.worktreePath!, 'mock-change.txt'))).toBe(true);
    expect(run.run).toMatchObject({ status: 'succeeded', attempt: 1 });
    expect(run.run.nativeThreadId).toMatch(/^thr_/);
    expect(run.run.nativeTurnId).toMatch(/^turn_/);
    expect(run.messages.map((m) => m.body).join('')).toBe('正在处理。完成。');
    expect(deltas.filter((e) => e.type === 'run.output_delta').map((e) => (e as { text: string }).text).join('')).toBe('正在处理。完成。');
    expect(run.result).toMatchObject({ finalMessage: '模拟执行完成：已写入 mock-change.txt。', checkStatus: 'passed', checkExitCode: 0 });
    expect(run.result?.diffStat).toContain('mock-change.txt');

    // 检查输出脱敏后存为产物文件；库与事件里没有输出正文
    const output = (await call('run.checkOutput', { runId: run.run.id })) as string;
    expect(output).toContain('token=[已脱敏]');
    expect(output).not.toContain('abc123');
    expect(JSON.stringify(events)).not.toContain('abc123');

    expect((await attention()).map((i) => i.kind)).toEqual(['review']);
    await call('review.decide', { subtaskId: reviewed.subtask.id, expectedVersion: reviewed.subtask.version, decision: 'accept' });
    const done = await detail(created.task.id);
    expect(done.task.status).toBe('succeeded');
    expect(done.subtask.status).toBe('succeeded');
    expect(git(repo, 'log', '--format=%s', '-1', done.subtask.branch!).trim()).toBe('paldock: 加一个文件');
    expect(await attention()).toEqual([]);
  });

  it('未确认的检查命令不运行', async () => {
    const created = await create('不确认检查', { check: { executable: process.execPath, args: ['-e', 'process.exit(1)'] } });
    const reviewed = await until(created.task.id, (d) => d.subtask.status === 'review');
    expect(latest(reviewed).result?.checkStatus).toBe('not_confirmed');
  });

  it('同一幂等键只建一个任务', async () => {
    const args = { rootPath: repo, goal: '只建一次', idempotencyKey: 'same-key-123' };
    const [a, b] = (await Promise.all([call('task.create', args), call('task.create', args)])) as TaskDetail[];
    expect(a!.task.id).toBe(b!.task.id);
    expect(((await call('task.list', { limit: 10 })) as unknown[]).length).toBe(1);
  });

  it('拒绝非 git 仓库、子目录和数据根', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain);
    await expect(create('x', { rootPath: plain })).rejects.toMatchObject({ code: 'bad_request' });
    mkdirSync(join(repo, 'sub'));
    await expect(create('x', { rootPath: join(repo, 'sub') })).rejects.toThrow(/仓库根目录/);
    await expect(create('x', { rootPath: dataRoot })).rejects.toThrow(/数据目录/);
  });
});

describe('审批', () => {
  it('拒绝：执行器收到 decline，不写入；只移除这条审批', async () => {
    const created = await create('[mock:file-approval] 写文件');
    const waiting = await until(created.task.id, (d) => !!pendingApproval(d));
    const approval = pendingApproval(waiting)!;
    expect(approval).toMatchObject({ kind: 'file_change', riskLevel: 'low' });
    expect(latest(waiting).run.status).toBe('waiting_approval');
    expect((await attention()).map((i) => [i.kind, i.itemId])).toEqual([['approval', approval.id]]);

    await call('approval.decide', { approvalId: approval.id, expectedVersion: approval.version, decision: 'deny' });
    const reviewed = await until(created.task.id, (d) => d.subtask.status === 'review');
    expect(existsSync(join(reviewed.subtask.worktreePath!, 'approved.txt'))).toBe(false);
    expect((await attention()).map((i) => i.kind)).toEqual(['review']);
    // 重放同一个决定被版本号拒绝
    await expect(
      call('approval.decide', { approvalId: approval.id, expectedVersion: approval.version, decision: 'allow_once' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('批准命令：中风险，批准后执行', async () => {
    const created = await create('[mock:command] 装依赖');
    const approval = pendingApproval(await until(created.task.id, (d) => !!pendingApproval(d)))!;
    expect(approval).toMatchObject({ kind: 'command', riskLevel: 'medium', summary: 'pnpm install' });
    expect(approval.detail).toContain('理由（执行器自述）');
    await call('approval.decide', { approvalId: approval.id, expectedVersion: approval.version, decision: 'allow_once' });
    const reviewed = await until(created.task.id, (d) => d.subtask.status === 'review');
    expect(existsSync(join(reviewed.subtask.worktreePath!, 'installed.txt'))).toBe(true);
  });

  it('权限扩展：高风险，P1 不允许批准', async () => {
    const created = await create('[mock:permissions] 联网');
    const approval = pendingApproval(await until(created.task.id, (d) => !!pendingApproval(d)))!;
    expect(approval).toMatchObject({ kind: 'permissions', riskLevel: 'high' });
    await expect(
      call('approval.decide', { approvalId: approval.id, expectedVersion: approval.version, decision: 'allow_once' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await call('approval.decide', { approvalId: approval.id, expectedVersion: approval.version, decision: 'deny' });
    await until(created.task.id, (d) => d.subtask.status === 'review');
  });

  it('审批过期即拒绝并回复执行器', async () => {
    await stopService();
    await startService({}, { approvalTtlMs: 100 });
    const created = await create('[mock:file-approval] 写文件');
    const reviewed = await until(created.task.id, (d) => d.subtask.status === 'review');
    expect(latest(reviewed).approvals[0]).toMatchObject({ status: 'expired', decidedVia: 'policy' });
    expect(existsSync(join(reviewed.subtask.worktreePath!, 'approved.txt'))).toBe(false);
  });

  it('未识别的请求被记录，turn 正常结束', async () => {
    const created = await create('[mock:unknown-request]');
    await until(created.task.id, (d) => d.subtask.status === 'review');
    expect(events.some((e) => e.type === 'run.notice' && e.payload.code === 'unknown_request')).toBe(true);
  });
});

describe('取消', () => {
  it('执行中取消：中断 turn，Run、子任务、任务都为 cancelled', async () => {
    const created = await create('[mock:slow]');
    await until(created.task.id, (d) => latest(d)?.run.status === 'running');
    await call('task.cancel', { taskId: created.task.id });
    const cancelled = await until(created.task.id, (d) => d.task.status === 'cancelled');
    expect(latest(cancelled).run.status).toBe('cancelled');
    expect(cancelled.subtask.status).toBe('cancelled');
  });

  it('等待审批时取消：挂起审批被取消', async () => {
    const created = await create('[mock:file-approval]');
    await until(created.task.id, (d) => !!pendingApproval(d));
    await call('task.cancel', { taskId: created.task.id });
    const cancelled = await until(created.task.id, (d) => d.task.status === 'cancelled');
    expect(latest(cancelled).approvals[0]?.status).toBe('cancelled');
    expect(await attention()).toEqual([]);
  });

  it('turn 开始前取消', async () => {
    await stopService();
    await startService({ MOCK_CODEX_START_DELAY_MS: '500' });
    const created = await create('[mock:slow]');
    await until(created.task.id, (d) => !!latest(d)?.run.nativeTurnId);
    await call('task.cancel', { taskId: created.task.id });
    await until(created.task.id, (d) => d.task.status === 'cancelled');
  });
});

describe('崩溃与恢复', () => {
  it('执行器崩溃：待确认 → 核对当前 turn（上一轮已完成也不误判）→ 阻塞，可续做', async () => {
    const first = await create('第一轮');
    const reviewed = await until(first.task.id, (d) => d.subtask.status === 'review');
    // 退回重做：新 Run 沿用 thread，这一轮让执行器崩溃
    await call('review.decide', {
      subtaskId: reviewed.subtask.id,
      expectedVersion: reviewed.subtask.version,
      decision: 'rework',
      note: '[mock:crash] 再来',
    });
    const blocked = await until(first.task.id, (d) => d.subtask.status === 'blocked');
    const [old, crashed] = blocked.runs;
    expect(crashed!.run).toMatchObject({ status: 'interrupted', nativeThreadId: old!.run.nativeThreadId });
    expect(crashed!.run.failureReason).toMatch(/无法确认/);
    expect(events.some((e) => e.aggregateId === crashed!.run.id && e.type === 'run.status_changed' && e.payload.to === 'unconfirmed')).toBe(true);
    expect(old!.reviews[0]).toMatchObject({ decision: 'rework' });
    expect((await attention()).map((i) => [i.kind, i.itemId])).toEqual([['blocked', crashed!.run.id]]);

    // 续做：新建 Run 指回被中断的那次，原 Run 的 turn 不变
    await call('run.recover', { subtaskId: blocked.subtask.id, expectedVersion: blocked.subtask.version, action: 'resume' });
    const resumed = await until(first.task.id, (d) => d.subtask.status === 'review');
    expect(resumed.runs).toHaveLength(3);
    expect(latest(resumed).run).toMatchObject({ resumesRunId: crashed!.run.id, nativeThreadId: old!.run.nativeThreadId });
    expect(resumed.runs[1]!.run.nativeTurnId).toBe(crashed!.run.nativeTurnId);
  });

  it('完成落盘后崩溃：核对到 completed，照常进入待验收', async () => {
    const created = await create('[mock:crash-after-complete]');
    const reviewed = await until(created.task.id, (d) => d.subtask.status === 'review');
    expect(latest(reviewed).result?.finalMessage).toBe('模拟执行完成：已写入 mock-change.txt。');
  });

  it('服务重启：进行中的 Run 中断、审批取消、任务阻塞；重新开始新建 thread，旧证据保留', async () => {
    const created = await create('[mock:file-approval]');
    const waiting = await until(created.task.id, (d) => !!pendingApproval(d));
    const before = latest(waiting).run;

    await stopService();
    await startService();
    const after = await detail(created.task.id);
    expect(after.task.status).toBe('blocked');
    expect(latest(after).run).toMatchObject({ id: before.id, status: 'interrupted' });
    expect(latest(after).approvals[0]).toMatchObject({ status: 'cancelled' });
    expect(await attention()).toEqual([expect.objectContaining({ kind: 'blocked', taskId: created.task.id, runId: before.id })]);

    await call('run.recover', { subtaskId: after.subtask.id, expectedVersion: after.subtask.version, action: 'restart' });
    const restarted = await until(created.task.id, (d) => !!pendingApproval(d) && d.runs.length === 2);
    expect(latest(restarted).run.nativeThreadId).not.toBe(before.nativeThreadId);
    expect(latest(restarted).run.resumesRunId).toBeNull();
    expect(restarted.runs[0]!.run.status).toBe('interrupted');
  });

  it('续做失败时提示并保持阻塞，只能重新开始或放弃', async () => {
    const created = await create('[mock:slow]');
    await until(created.task.id, (d) => latest(d)?.run.status === 'running');
    await stopService();
    rmSync(join(mockHome, 'mock-threads'), { recursive: true, force: true }); // 原生会话丢失
    await startService();
    const blocked = await detail(created.task.id);
    await call('run.recover', { subtaskId: blocked.subtask.id, expectedVersion: blocked.subtask.version, action: 'resume' });
    const failed = await until(created.task.id, (d) => d.subtask.status === 'blocked' && d.runs.length === 2);
    expect(latest(failed).run).toMatchObject({ status: 'failed' });
    expect(latest(failed).run.failureReason).toMatch(/续做失败/);
    expect(events.some((e) => e.type === 'run.notice' && e.payload.code === 'resume_failed')).toBe(true);
    const again = await detail(created.task.id);
    await expect(
      call('run.recover', { subtaskId: again.subtask.id, expectedVersion: again.subtask.version, action: 'resume' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await call('run.recover', { subtaskId: again.subtask.id, expectedVersion: again.subtask.version, action: 'abandon' });
    expect((await detail(created.task.id)).task.status).toBe('failed');
  });

  it('重复启动：同一数据根第二个服务被拒绝', async () => {
    await expect(LocalService.start({ dataRoot, ipcPath: createIpcPath(dataRoot), token })).rejects.toThrow(/占用/);
  });
});

describe('待我处理 A/B 场景', () => {
  it('A 停在审批、B 待验收；重开窗口不变；拒绝 A 只移除 A；退回 B 重跑后旧证据可查', async () => {
    const a = await create('[mock:file-approval] A');
    const approval = pendingApproval(await until(a.task.id, (d) => !!pendingApproval(d)))!;
    const b = await create('B');
    const bReview = await until(b.task.id, (d) => d.subtask.status === 'review');

    await call('attention.markRead', { itemKind: 'approval', itemId: approval.id });
    // 「关闭并重开窗口」：客户端断开重连，服务一直存活
    await client.close();
    await client.connect(ipcPath, token);
    const items = await attention();
    expect(items.map((i) => [i.kind, i.taskId, i.read])).toEqual([
      ['approval', a.task.id, true],
      ['review', b.task.id, false],
    ]);

    await call('approval.decide', { approvalId: approval.id, expectedVersion: approval.version, decision: 'deny' });
    await until(a.task.id, (d) => d.subtask.status === 'review');
    expect((await attention()).filter((i) => i.taskId === b.task.id)).toHaveLength(1);

    await call('review.decide', { subtaskId: bReview.subtask.id, expectedVersion: bReview.subtask.version, decision: 'rework', note: '补测试' });
    const bAgain = await until(b.task.id, (d) => d.subtask.status === 'review' && d.runs.length === 2);
    expect(bAgain.runs[0]!.result?.diffStat).toContain('mock-change.txt');
    expect(bAgain.runs[0]!.reviews).toEqual([expect.objectContaining({ decision: 'rework', note: '补测试' })]);
    const bItem = (await attention()).find((i) => i.taskId === b.task.id)!;
    expect(bItem).toMatchObject({ kind: 'review', runId: bAgain.runs[1]!.run.id, read: false });
  });
});

describe('备份', () => {
  it('手动备份含数据库与证据文件', async () => {
    const created = await create('备份', { check: { executable: process.execPath, args: ['-e', "console.log('ok')"] }, checkConfirmed: true });
    const reviewed = await until(created.task.id, (d) => d.subtask.status === 'review');
    const { path } = (await call('maintenance.backup', {})) as { path: string };
    expect(existsSync(join(path, 'paldock.db'))).toBe(true);
    expect(readFileSync(join(path, 'artifacts', latest(reviewed).result!.checkOutputRef!), 'utf8')).toContain('ok');
  });
});
