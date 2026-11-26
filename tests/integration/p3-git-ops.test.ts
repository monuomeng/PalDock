/**
 * 默认在当前仓库协作（2026-11-26 已定，0.3.6）：提交 / 推送 / 合并卡片。离线，真实 git，临时仓库和临时远端。
 * 快照只能看出「变了什么」，默认勾选要有写入证据；只提交勾选的块，你暂存的内容提交后仍是暂存状态。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitOpsService, snapshotTree } from '@paldock/application';
import type { PersistentEvent } from '@paldock/contracts';
import { openStore, type Store } from '@paldock/storage-sqlite';
import { afterEach, describe, expect, it } from 'vitest';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let store: Store;
let ops: GitOpsService;
let workspaceId: string;
let coordinatorRun: string;
let workSubtask: { subtaskId: string; sessionId: string };
const logs: string[] = [];

async function setup(files: Record<string, string> = { 'a.txt': 'a\n', 'b.txt': 'b\n' }) {
  root = mkdtempSync(join(tmpdir(), 'paldock-gitops-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'feature');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'user.name', 'tester');
  git(repo, 'config', 'user.email', 't@t');
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  store = await openStore(':memory:');
  const ws = store.tasks.ensureWorkspace('repo', repo);
  workspaceId = store.tasks.setWorkspaceMode(ws.id, ws.version, 'current').record.id;
  const coord = store.tasks.createTask({ workspaceId, title: 'c', goal: 'g', role: 'coordinator', checkCommand: null, checkConfirmed: false, idempotencyKey: 'c' }).record;
  coordinatorRun = store.runs.createRun({ subtaskId: coord.subtask.id, sessionId: coord.session.id, runtime: 'claude' }).record.id;
  const work = store.tasks.createTask({ workspaceId, title: 'w', goal: 'g', role: 'developer', checkCommand: null, checkConfirmed: false, idempotencyKey: 'w' }).record;
  workSubtask = { subtaskId: work.subtask.id, sessionId: work.session.id };
  ops = new GitOpsService({ store, dataRoot: join(root, 'data'), publish: (_: PersistentEvent[]) => {}, log: (m) => logs.push(m) });
}

afterEach(() => {
  store?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  logs.length = 0;
});

/** 模拟一次助手的 Run：开始快照 → change()（助手写文件并留下写入记录，你也可能同时改别的）→ 结束快照。 */
async function assistantRun(change: (runId: string) => void): Promise<string> {
  const run = store.runs.createRun({ subtaskId: workSubtask.subtaskId, sessionId: workSubtask.sessionId, runtime: 'claude' }).record;
  const scratch = join(root, 'data', 'tmp');
  store.git.startSnapshot({ runId: run.id, workspaceId, branch: 'feature', head: git(repo, 'rev-parse', 'HEAD'), startTree: await snapshotTree(repo, scratch) });
  change(run.id);
  store.git.endSnapshot(run.id, await snapshotTree(repo, scratch));
  return run.id;
}

const write = (path: string, content: string) => writeFileSync(join(repo, path), content);
const lines = (n: number, overrides: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => overrides[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

describe('提交卡片', () => {
  it('助手改 A、你同时改 B：卡片列出两处改动，只有 A 有写入证据、默认勾选；按默认确认只提交 A，B 留在你的工作区', async () => {
    await setup();
    await assistantRun((runId) => {
      write('a.txt', 'a\n助手加的\n');
      store.git.addWrite({ runId, path: 'a.txt', kind: 'replace', detail: JSON.stringify({ old: 'a', new: 'a\n助手加的' }) });
      write('b.txt', 'b\n你加的\n'); // 你在 IDE 里同时改的
    });
    const card = await ops.proposeCommit(coordinatorRun, '加一行');
    if (card.request.kind !== 'commit') throw new Error('不是提交卡片');
    expect(card.request.hunks.map((h) => [h.path, h.evidenced])).toEqual([
      ['a.txt', true],
      ['b.txt', false],
    ]);
    const done = await ops.decide(card.id, card.version, 'confirm', card.request.hunks.filter((h) => h.evidenced).map((h) => h.id));
    expect(done.status).toBe('done');
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt');
    expect(git(repo, 'status', '--porcelain')).toBe('M b.txt');
    expect(git(repo, 'diff', '--cached')).toBe('');
  });

  it('你暂存了第 10 行，助手改了第 80 行，只提交第 80 行：提交只含第 80 行，git diff --cached 仍只有你的第 10 行，工作区两边的改动都在', async () => {
    await setup({ 'big.txt': lines(100) });
    write('big.txt', lines(100, { 10: 'line 10 (你)' }));
    git(repo, 'add', 'big.txt');
    await assistantRun((runId) => {
      write('big.txt', lines(100, { 10: 'line 10 (你)', 80: 'line 80 (助手)' }));
      store.git.addWrite({ runId, path: 'big.txt', kind: 'replace', detail: JSON.stringify({ old: 'line 80', new: 'line 80 (助手)' }) });
    });
    const card = await ops.proposeCommit(coordinatorRun, '改第 80 行');
    if (card.request.kind !== 'commit') throw new Error('不是提交卡片');
    // 两个块：你的第 10 行（没有证据、标着你暂存过这个文件）和助手的第 80 行
    expect(card.request.hunks.map((h) => [h.evidenced, h.stagedByUser])).toEqual([
      [false, true],
      [true, true],
    ]);
    const eighty = card.request.hunks.find((h) => h.evidenced)!;
    expect((await ops.decide(card.id, card.version, 'confirm', [eighty.id])).status).toBe('done');
    const committed = git(repo, 'diff', 'HEAD~1', 'HEAD');
    expect(committed).toContain('+line 80 (助手)');
    expect(committed).not.toContain('line 10 (你)');
    const cached = git(repo, 'diff', '--cached');
    expect(cached).toContain('+line 10 (你)');
    expect(cached).not.toContain('line 80');
    expect(readFileSync(join(repo, 'big.txt'), 'utf8')).toBe(lines(100, { 10: 'line 10 (你)', 80: 'line 80 (助手)' }));
  });

  it('你暂存的块和要提交的块重叠：推进分支之前停下，分支和暂存区都不动', async () => {
    await setup({ 'c.txt': lines(20) });
    write('c.txt', lines(20, { 5: 'line 5 (你暂存的)' }));
    git(repo, 'add', 'c.txt');
    const head = git(repo, 'rev-parse', 'HEAD');
    const cachedBefore = git(repo, 'diff', '--cached');
    await assistantRun((runId) => {
      write('c.txt', lines(20, { 5: 'line 5 (助手又改了)' }));
      store.git.addWrite({ runId, path: 'c.txt', kind: 'replace', detail: JSON.stringify({ old: 'line 5 (你暂存的)', new: 'line 5 (助手又改了)' }) });
    });
    const card = await ops.proposeCommit(coordinatorRun, '改第 5 行');
    if (card.request.kind !== 'commit') throw new Error('不是提交卡片');
    const done = await ops.decide(card.id, card.version, 'confirm', card.request.hunks.map((h) => h.id));
    expect(done.status).toBe('failed');
    expect(done.result).toMatch(/重叠/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'diff', '--cached')).toBe(cachedBefore);
  });

  it('提出之后你切了分支或别人提交了：卡片作废，不提交', async () => {
    await setup();
    await assistantRun((runId) => {
      write('a.txt', 'a\nx\n');
      store.git.addWrite({ runId, path: 'a.txt', kind: 'content', detail: 'a\nx\n' });
    });
    const card = await ops.proposeCommit(coordinatorRun, 'x');
    git(repo, 'checkout', '-q', '-b', 'other');
    const done = await ops.decide(card.id, card.version, 'confirm', card.request.kind === 'commit' ? card.request.hunks.map((h) => h.id) : []);
    expect(done.status).toBe('stale');
    expect(git(repo, 'log', '--oneline').split('\n')).toHaveLength(1);
  });
});

describe('推送与合并卡片', () => {
  it('推送：卡片写明远端、远端分支和要推的提交；确认后推到临时远端，不强推；分支变了就作废', async () => {
    await setup();
    const remote = join(root, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'feature');
    write('a.txt', 'a\n新提交\n');
    git(repo, 'commit', '-q', '-am', '新提交');
    const card = await ops.proposePush(coordinatorRun);
    expect(card.request).toMatchObject({ kind: 'push', remote: 'origin', remoteUrl: remote, branch: 'feature', remoteBranch: 'feature' });
    expect(card.request.kind === 'push' && card.request.commits).toHaveLength(1);
    expect((await ops.decide(card.id, card.version, 'confirm')).status).toBe('done');
    expect(execFileSync('git', ['-C', remote, 'rev-parse', 'feature'], { encoding: 'utf8' }).trim()).toBe(git(repo, 'rev-parse', 'HEAD'));

    const again = await ops.proposePush(coordinatorRun);
    git(repo, 'checkout', '-q', '-b', 'elsewhere');
    expect((await ops.decide(again.id, again.version, 'confirm')).status).toBe('stale');
  });

  it('本地合并：目标不是当前分支时在临时 worktree 里合并，成功后推进目标分支；你的工作区不动', async () => {
    await setup();
    git(repo, 'branch', 'main');
    write('a.txt', 'a\nfeature 的改动\n');
    git(repo, 'commit', '-q', '-am', 'feature');
    write('b.txt', 'b\n我还没提交的\n');
    const card = await ops.proposeMerge(coordinatorRun, 'feature', 'main');
    expect(card.request).toMatchObject({ kind: 'merge', source: 'feature', target: 'main', fastForward: true });
    expect((await ops.decide(card.id, card.version, 'confirm')).status).toBe('done');
    expect(git(repo, 'show', 'main:a.txt')).toContain('feature 的改动');
    expect(git(repo, 'status', '--porcelain')).toBe('M b.txt');
  });

  it('独立 worktree 方式的项目不提供这些卡片', async () => {
    await setup();
    const ws = store.tasks.getWorkspace(workspaceId)!;
    store.tasks.setWorkspaceMode(ws.id, ws.version, 'worktree');
    await expect(ops.proposeCommit(coordinatorRun, 'x')).rejects.toThrow(/独立 worktree/);
  });
});
