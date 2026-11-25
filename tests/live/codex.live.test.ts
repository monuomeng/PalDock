/**
 * 真实 Codex 的 opt-in 验收（消耗少量额度）：`PALDOCK_LIVE_CODEX=1 pnpm exec vitest run tests/live`。
 * 用本机 PATH 上的 Codex（或 PALDOCK_CODEX_PATH），在临时 git 仓库里跑：
 * 1. 建任务 → 执行 → 回显 → 证据 → 验收；2. 写 worktree 外的文件触发审批并拒绝；3. 执行中取消。
 * 副作用：Codex 自己的历史里会留下这几条会话。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandArgsOf, CommandName, TaskDetail } from '@paldock/contracts';
import { LocalService } from '@paldock/local-service';
import { IpcClient, createIpcPath, createToken } from '@paldock/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let root: string;
let repo: string;
let service: LocalService;
let client: IpcClient;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'paldock-live-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), '# live\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  mkdirSync(join(root, 'data'));
  const token = createToken();
  const ipcPath = createIpcPath(join(root, 'data'));
  service = await LocalService.start({ dataRoot: join(root, 'data'), ipcPath, token, log: (m) => console.log(m) });
  client = new IpcClient(() => {});
  await client.connect(ipcPath, token);
});

afterAll(async () => {
  await client?.close();
  await service?.stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const call = <N extends CommandName>(name: N, args: CommandArgsOf<N>) => client.request(name, args);
const detail = (taskId: string) => call('task.get', { taskId }) as Promise<TaskDetail>;
async function until(taskId: string, predicate: (d: TaskDetail) => boolean, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await detail(taskId);
    if (predicate(d)) return d;
    if (Date.now() > deadline) throw new Error(`超时：${d.subtask.status} ${d.runs.map((r) => r.run.status)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const create = async (goal: string) =>
  ((await call('task.create', { rootPath: repo, goal, idempotencyKey: `live-${Date.now()}` })) as TaskDetail).task.id;

describe.skipIf(process.env.PALDOCK_LIVE_CODEX !== '1')('真实 Codex', () => {
  it.skipIf(process.env.LIVE_ONLY === 'approval')('建任务 → 执行 → 回显 → 证据 → 验收', async () => {
    const id = await create('在当前目录创建文件 hello.txt，内容只有一行 hi。不要做其他事。');
    const d = await until(id, (x) => ['review', 'blocked'].includes(x.subtask.status));
    const run = d.runs.at(-1)!;
    console.log('run', JSON.stringify({ status: run.run.status, reason: run.run.failureReason, approvals: run.approvals.length }));
    expect(d.subtask.status).toBe('review');
    expect(readFileSync(join(d.subtask.worktreePath!, 'hello.txt'), 'utf8').trim()).toBe('hi');
    expect(run.result?.diffStat).toContain('hello.txt');
    expect(run.messages.length + (run.result?.finalMessage ? 1 : 0)).toBeGreaterThan(0);
    await call('review.decide', { subtaskId: d.subtask.id, expectedVersion: d.subtask.version, decision: 'accept' });
    expect((await detail(id)).task.status).toBe('succeeded');
  }, 300_000);

  it('写 worktree 之外的文件：沙箱拦截或经审批（高风险），拒绝后不写入', async () => {
    // 不能放在临时目录：Codex 的 workspace-write 沙箱默认允许写 TEMP
    const outside = join(process.cwd(), 'tests', 'live', `outside-${Date.now()}.txt`);
    const id = await create(`请创建文件 ${outside}，内容为 hi。必须写入这个绝对路径；如果沙箱拒绝，请申请提升权限后再试一次。`);
    const settled = (x: TaskDetail) => ['review', 'blocked'].includes(x.subtask.status);
    const pending = (x: TaskDetail) => x.runs.flatMap((r) => r.approvals).find((a) => a.status === 'pending');
    const seen: { kind: string; risk: string }[] = [];
    for (let d = await until(id, (x) => !!pending(x) || settled(x)); !settled(d); d = await until(id, (x) => !!pending(x) || settled(x))) {
      const approval = pending(d)!;
      seen.push({ kind: approval.kind, risk: approval.riskLevel });
      await call('approval.decide', { approvalId: approval.id, expectedVersion: approval.version, decision: 'deny' });
    }
    console.log('approvals', JSON.stringify(seen), 'final', (await detail(id)).runs.at(-1)?.result?.finalMessage);
    expect(existsSync(outside)).toBe(false);
    for (const a of seen) expect(a.risk).toBe('high');
    await call('task.cancel', { taskId: id });
  }, 400_000);

  it.skipIf(process.env.LIVE_ONLY === 'approval')('执行中取消：中断 turn，任务为已取消', async () => {
    const id = await create('从 1 数到 2000，每行一个数字，直接输出，不要写文件。');
    await until(id, (x) => x.runs.at(-1)?.run.status === 'running' && !!x.runs.at(-1)?.run.nativeTurnId);
    await call('task.cancel', { taskId: id });
    const d = await until(id, (x) => x.task.status === 'cancelled', 60_000);
    expect(d.runs.at(-1)?.run.status).toBe('cancelled');
  }, 300_000);
});
