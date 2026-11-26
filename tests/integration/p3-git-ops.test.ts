/**
 * 默认在当前仓库协作（2026-11-26 已定，0.3.6；0.3.7 收紧）：提交 / 推送 / 合并 / 暂存区卡片。离线，真实 git，临时仓库和临时裸远端。
 * - 只提交这次：按任务 / 对话、按块（不是按文件名）筛选；默认勾选要求每一行都能用助手自己的写入重放核对上。
 * - 只推送看过的：推预览时的提交，目标状态取实际推送地址（ls-remote），确认时再核对；合并锁定两边的提交。
 * - 暂存区：变了就暂停，你选保留或恢复；恢复前核对暂存区没被你再动过，只改索引不改工作区。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentDigest, GitOpsService, indexTree, snapshotTree } from '@paldock/application';
import type { GitOpRecord, PersistentEvent } from '@paldock/contracts';
import { toLf } from '@paldock/domain';
import { openStore, type Store } from '@paldock/storage-sqlite';
import { afterEach, describe, expect, it } from 'vitest';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let store: Store;
let ops: GitOpsService;
let workspaceId: string;
/** 两个对话（主会话）：各自的协调助手 Run。 */
let chat1: { runId: string; sessionId: string };
let chat2: { runId: string; sessionId: string };
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
  chat1 = coordinator('c1');
  chat2 = coordinator('c2');
  ops = new GitOpsService({ store, dataRoot: join(root, 'data'), publish: (_: PersistentEvent[]) => {}, log: (m) => logs.push(m) });
}

function coordinator(key: string) {
  const c = store.tasks.createTask({ workspaceId, title: key, goal: 'g', role: 'coordinator', checkCommand: null, checkConfirmed: false, idempotencyKey: key }).record;
  return { runId: store.runs.createRun({ subtaskId: c.subtask.id, sessionId: c.session.id, runtime: 'claude' }).record.id, sessionId: c.session.id };
}

/** 对话 chat 里的协调助手提出并确认一个计划任务，返回它的任务和第一个子任务。 */
function planTask(chat: { runId: string; sessionId: string }, title: string) {
  const plan = store.plans.propose({ workspaceId, title, goal: title, nodes: [{ key: 'n', role: 'developer', title, goal: title, paths: [], dependsOn: [] }], proposedByRunId: chat.runId }).record;
  const { created } = store.plans.confirm(plan.id, plan.version).record;
  return { taskId: plan.taskId, subtaskId: created[0]!.id, sessionId: chat.sessionId };
}

afterEach(() => {
  store?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  logs.length = 0;
});

/**
 * 模拟一次助手的 Run：开始快照 → change()（助手写文件并留下写入记录，你也可能同时改别的）→ 结束快照。
 * 整文件写入的写入记录按监管器的做法带上写之前内容的摘要。
 */
async function assistantRun(task: { subtaskId: string; sessionId: string }, change: (w: Writer) => void): Promise<string> {
  const run = store.runs.createRun({ subtaskId: task.subtaskId, sessionId: task.sessionId, runtime: 'claude' }).record;
  const scratch = join(root, 'data', 'tmp');
  store.git.startSnapshot({ runId: run.id, workspaceId, branch: 'feature', head: git(repo, 'rev-parse', 'HEAD'), startTree: await snapshotTree(repo, scratch) });
  change({
    replace: (path, old, next) => {
      write(path, read(path).replace(old, next));
      store.git.addWrite({ runId: run.id, path, kind: 'replace', detail: JSON.stringify({ old, new: next }) });
    },
    content: (path, content) => {
      let before = 'absent';
      try {
        before = contentDigest(toLf(read(path)));
      } catch {
        // 新文件
      }
      store.git.addWrite({ runId: run.id, path, kind: 'content', detail: content, beforeHash: before });
      write(path, content);
    },
  });
  store.git.endSnapshot(run.id, await snapshotTree(repo, scratch));
  return run.id;
}
interface Writer {
  replace(path: string, old: string, next: string): void;
  content(path: string, content: string): void;
}

const write = (path: string, content: string) => writeFileSync(join(repo, path), content);
const read = (path: string) => readFileSync(join(repo, path), 'utf8');
const lines = (n: number, overrides: Record<number, string | null> = {}) =>
  Array.from({ length: n }, (_, i) => (i + 1 in overrides ? overrides[i + 1] : `line ${i + 1}`))
    .filter((l) => l !== null)
    .join('\n') + '\n';
const commitHunks = (card: GitOpRecord) => {
  if (card.request.kind !== 'commit') throw new Error('不是提交卡片');
  return card.request.hunks;
};
const summary = (card: GitOpRecord) => commitHunks(card).map((h) => [h.path, firstChange(h.patch), h.evidenced]);
const firstChange = (patch: string) => patch.split('\n').find((l) => /^[+-](?![+-]{2} )/.test(l)) ?? '';

describe('只提交这次：按任务 / 对话、按块', () => {
  it('助手改 A、你同时改 B：两处都列出，只有 A 默认勾选；按默认确认只提交 A，B 留在你的工作区', async () => {
    await setup();
    const task = planTask(chat1, '改 a');
    await assistantRun(task, (w) => {
      w.replace('a.txt', 'a\n', 'a\n助手加的\n');
      write('b.txt', 'b\n你加的\n'); // 你在 IDE 里同时改的
    });
    const card = await ops.proposeCommit(chat1.runId, '加一行');
    expect(summary(card)).toEqual([
      ['a.txt', '+助手加的', true],
      ['b.txt', '+你加的', false],
    ]);
    const done = await ops.decide(card.id, card.version, 'confirm', commitHunks(card).filter((h) => h.evidenced).map((h) => h.id));
    expect(done.status).toBe('done');
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt');
    expect(git(repo, 'status', '--porcelain')).toBe('M b.txt');
  });

  it('任务 A、B 改同一个文件的不同块，都没提交：在 B 的对话里提交只列 B 的块；提交 B 之后，在 A 的对话里提交 A 的块还在', async () => {
    await setup({ 'shared.txt': lines(40) });
    const a = planTask(chat1, '任务 A');
    const b = planTask(chat2, '任务 B');
    await assistantRun(a, (w) => w.replace('shared.txt', 'line 3\n', 'line 3 (A)\n'));
    await assistantRun(b, (w) => w.replace('shared.txt', 'line 30\n', 'line 30 (B)\n'));
    const cardB = await ops.proposeCommit(chat2.runId, 'B');
    expect(cardB.request.kind === 'commit' && cardB.request.scope).toMatchObject({ kind: 'session', taskIds: expect.arrayContaining([b.taskId]) });
    expect(summary(cardB)).toEqual([['shared.txt', '-line 30', true]]);
    expect((await ops.decide(cardB.id, cardB.version, 'confirm', commitHunks(cardB).map((h) => h.id))).status).toBe('done');
    expect(git(repo, 'show', 'HEAD:shared.txt')).toBe(lines(40, { 30: 'line 30 (B)' }).trimEnd());

    const cardA = await ops.proposeCommit(chat1.runId, 'A');
    expect(summary(cardA)).toEqual([['shared.txt', '-line 3', true]]);
    expect((await ops.decide(cardA.id, cardA.version, 'confirm', commitHunks(cardA).map((h) => h.id))).status).toBe('done');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('同一个对话里两个任务：指定 taskId 只列这个任务的块；不是这个对话的任务不能指定；整个项目要明确要求', async () => {
    await setup({ 'shared.txt': lines(40) });
    const a = planTask(chat1, '任务 A');
    const b = planTask(chat1, '任务 B');
    await assistantRun(a, (w) => w.replace('shared.txt', 'line 3\n', 'line 3 (A)\n'));
    await assistantRun(b, (w) => w.replace('shared.txt', 'line 30\n', 'line 30 (B)\n'));
    const onlyB = await ops.proposeCommit(chat1.runId, 'B', { taskId: b.taskId });
    expect(onlyB.request.kind === 'commit' && onlyB.request.scope.label).toBe('任务「任务 B」');
    expect(summary(onlyB)).toEqual([['shared.txt', '-line 30', true]]);
    // 默认（这个对话）两个都在
    expect(summary(await ops.proposeCommit(chat1.runId, '都提'))).toHaveLength(2);
    // 别的对话的任务不能指定；在别的对话里默认看不到这两个任务的改动
    await expect(ops.proposeCommit(chat2.runId, 'x', { taskId: b.taskId })).rejects.toThrow(/不是这个对话发起的/);
    await expect(ops.proposeCommit(chat2.runId, 'x')).rejects.toThrow(/没有找到这个对话发起的任务还没提交的改动/);
    // 明确扩大到整个项目
    const whole = await ops.proposeCommit(chat2.runId, 'x', { wholeProject: true });
    expect(whole.request.kind === 'commit' && whole.request.scope.kind).toBe('project');
    expect(summary(whole)).toHaveLength(2);
  });

  it('你暂存了第 10 行（Run 之前），助手改了第 80 行：卡片只列第 80 行；提交后 git diff --cached 仍只有你的第 10 行，工作区两边的改动都在', async () => {
    await setup({ 'big.txt': lines(100) });
    write('big.txt', lines(100, { 10: 'line 10 (你)' }));
    git(repo, 'add', 'big.txt');
    const task = planTask(chat1, '改第 80 行');
    await assistantRun(task, (w) => w.replace('big.txt', 'line 80\n', 'line 80 (助手)\n'));
    const card = await ops.proposeCommit(chat1.runId, '改第 80 行');
    expect(commitHunks(card).map((h) => [firstChange(h.patch), h.evidenced, h.stagedByUser])).toEqual([['-line 80', true, true]]);
    expect((await ops.decide(card.id, card.version, 'confirm', commitHunks(card).map((h) => h.id))).status).toBe('done');
    const committed = git(repo, 'diff', 'HEAD~1', 'HEAD');
    expect(committed).toContain('+line 80 (助手)');
    expect(committed).not.toContain('line 10 (你)');
    const cached = git(repo, 'diff', '--cached');
    expect(cached).toContain('+line 10 (你)');
    expect(cached).not.toContain('line 80');
    expect(read('big.txt')).toBe(lines(100, { 10: 'line 10 (你)', 80: 'line 80 (助手)' }));
  });

  it('你暂存的块和要提交的块重叠：推进分支之前停下，分支和暂存区都不动', async () => {
    await setup({ 'c.txt': lines(20) });
    write('c.txt', lines(20, { 5: 'line 5 (你暂存的)' }));
    git(repo, 'add', 'c.txt');
    const head = git(repo, 'rev-parse', 'HEAD');
    const cachedBefore = git(repo, 'diff', '--cached');
    const task = planTask(chat1, '改第 5 行');
    await assistantRun(task, (w) => w.replace('c.txt', 'line 5 (你暂存的)', 'line 5 (助手又改了)'));
    const card = await ops.proposeCommit(chat1.runId, '改第 5 行');
    const done = await ops.decide(card.id, card.version, 'confirm', commitHunks(card).map((h) => h.id));
    expect(done.status).toBe('failed');
    expect(done.result).toMatch(/重叠/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'diff', '--cached')).toBe(cachedBefore);
  });

  it('提出之后你切了分支或别人提交了：卡片作废，不提交', async () => {
    await setup();
    const task = planTask(chat1, 'x');
    await assistantRun(task, (w) => w.content('a.txt', 'a\nx\n'));
    const card = await ops.proposeCommit(chat1.runId, 'x');
    git(repo, 'checkout', '-q', '-b', 'other');
    const done = await ops.decide(card.id, card.version, 'confirm', commitHunks(card).map((h) => h.id));
    expect(done.status).toBe('stale');
    expect(git(repo, 'log', '--oneline').split('\n')).toHaveLength(1);
  });
});

describe('默认勾选要有对应到块的写入证据', () => {
  const FILE = lines(40);

  it('助手整文件写入后，你在同一轮结束前删了另一段：删除块列出但不勾，助手的块照常勾选', async () => {
    await setup({ 'f.txt': FILE });
    const task = planTask(chat1, '整文件写');
    await assistantRun(task, (w) => {
      w.content('f.txt', lines(40, { 5: 'line 5 (助手)' }));
      write('f.txt', lines(40, { 5: 'line 5 (助手)', 25: null, 26: null })); // 你在 Run 期间删了第 25、26 行
    });
    expect(summary(await ops.proposeCommit(chat1.runId, 'x'))).toEqual([
      ['f.txt', '-line 5', true],
      ['f.txt', '-line 25', false],
    ]);
  });

  it('助手整文件写入后，你在 Run 结束后删了另一段：这个删除块不属于这次，不列；助手的块照常勾选', async () => {
    await setup({ 'f.txt': FILE });
    const task = planTask(chat1, '整文件写');
    await assistantRun(task, (w) => w.content('f.txt', lines(40, { 5: 'line 5 (助手)' })));
    write('f.txt', lines(40, { 5: 'line 5 (助手)', 25: null, 26: null }));
    expect(summary(await ops.proposeCommit(chat1.runId, 'x'))).toEqual([['f.txt', '-line 5', true]]);
  });

  it('你在别处加了和助手相同的一行：Run 期间加的列出不勾，Run 之后加的不列', async () => {
    await setup({ 'f.txt': FILE });
    const task = planTask(chat1, '加括号');
    await assistantRun(task, (w) => {
      w.replace('f.txt', 'line 5\n', 'line 5\n}\n');
      write('f.txt', read('f.txt').replace('line 20\n', 'line 20\n}\n')); // Run 期间你也加了一个 }
    });
    write('f.txt', read('f.txt').replace('line 35\n', 'line 35\n}\n')); // Run 之后又加一个
    expect(summary(await ops.proposeCommit(chat1.runId, 'x'))).toEqual([
      ['f.txt', '+}', true],
      ['f.txt', '+}', false],
    ]);
  });

  it('助手整文件写入之前你已经改过这个文件（它写的内容里带着你的改动）：证据对不上，这个文件的块都不勾', async () => {
    await setup({ 'f.txt': FILE });
    const task = planTask(chat1, '整文件写');
    await assistantRun(task, (w) => {
      write('f.txt', lines(40, { 30: 'line 30 (你)' })); // 你先改了
      w.content('f.txt', lines(40, { 5: 'line 5 (助手)', 30: 'line 30 (你)' })); // 助手读到你的改动后整文件写回
    });
    const hunks = commitHunks(await ops.proposeCommit(chat1.runId, 'x'));
    expect(hunks).toHaveLength(2);
    expect(hunks.every((h) => !h.evidenced)).toBe(true);
  });
});

describe('推送与合并：只执行你预览过的', () => {
  /** 临时裸远端和另一份克隆（模拟别人）。 */
  function remotes() {
    const remote = join(root, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'feature');
    const other = join(root, 'other');
    execFileSync('git', ['clone', '-q', '-b', 'feature', remote, other]);
    git(other, 'config', 'user.name', 'other');
    git(other, 'config', 'user.email', 'o@o');
    return { remote, other };
  }
  const commitIn = (cwd: string, file: string, text: string) => {
    writeFileSync(join(cwd, file), text);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-q', '-m', text.trim());
  };
  const remoteSha = (remote: string, branch: string) => (execFileSync('git', ['-C', remote, 'rev-parse', '--verify', '-q', branch], { encoding: 'utf8' }).trim());

  it('推送：卡片写明实际推送地址和远端分支现在的提交、提交总数；确认后推的是预览时的提交', async () => {
    await setup();
    const { remote } = remotes();
    commitIn(repo, 'a.txt', 'a\n1\n');
    commitIn(repo, 'a.txt', 'a\n1\n2\n');
    const card = await ops.proposePush(chat1.runId);
    expect(card.request).toMatchObject({ kind: 'push', remote: 'origin', targets: [{ url: remote, remoteSha: remoteSha(remote, 'feature') }], remoteBranch: 'feature', totalCommits: 2 });
    expect((await ops.decide(card.id, card.version, 'confirm')).status).toBe('done');
    expect(remoteSha(remote, 'feature')).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it('卡片生成后另一份克隆更新了远端（本地 origin/feature 还是旧的）：旧卡片作废，远端不动', async () => {
    await setup();
    const { remote, other } = remotes();
    commitIn(repo, 'a.txt', 'a\n我的\n');
    const card = await ops.proposePush(chat1.runId);
    commitIn(other, 'b.txt', 'b\n别人的\n');
    git(other, 'push', '-q', 'origin', 'feature');
    const theirs = remoteSha(remote, 'feature');
    const done = await ops.decide(card.id, card.version, 'confirm');
    expect(done.status).toBe('stale');
    expect(done.result).toMatch(/变了/);
    expect(remoteSha(remote, 'feature')).toBe(theirs);
  });

  it('新建远端分支：预览时不存在、确认前被别人抢先创建了，旧卡片作废', async () => {
    await setup();
    const { remote, other } = remotes();
    git(repo, 'checkout', '-q', '-b', 'topic');
    commitIn(repo, 'a.txt', 'a\ntopic\n');
    const card = await ops.proposePush(chat1.runId, 'origin', 'topic');
    expect(card.request.kind === 'push' && card.request.targets[0]!.remoteSha).toBeNull();
    git(other, 'push', '-q', 'origin', 'feature:topic');
    expect((await ops.decide(card.id, card.version, 'confirm')).status).toBe('stale');
    expect(remoteSha(remote, 'topic')).toBe(git(other, 'rev-parse', 'feature'));
  });

  it('看完卡片后你又提交了一次：旧卡片作废，不会把新提交推出去', async () => {
    await setup();
    const { remote } = remotes();
    commitIn(repo, 'a.txt', 'a\nA\n');
    const before = remoteSha(remote, 'feature');
    const card = await ops.proposePush(chat1.runId);
    commitIn(repo, 'a.txt', 'a\nA\nB\n');
    expect((await ops.decide(card.id, card.version, 'confirm')).status).toBe('stale');
    expect(remoteSha(remote, 'feature')).toBe(before);
  });

  it('配了独立 pushurl（和 url 不同）、多个推送地址：卡片列出实际写入的全部地址，确认后两个都推到', async () => {
    await setup();
    const { remote } = remotes();
    const pushA = join(root, 'push-a.git');
    const pushB = join(root, 'push-b.git');
    for (const r of [pushA, pushB]) execFileSync('git', ['clone', '-q', '--bare', remote, r]);
    git(repo, 'remote', 'set-url', '--push', 'origin', pushA);
    git(repo, 'remote', 'set-url', '--add', '--push', 'origin', pushB);
    commitIn(repo, 'a.txt', 'a\n推\n');
    const card = await ops.proposePush(chat1.runId);
    expect(card.request.kind === 'push' && card.request.targets.map((t) => t.url)).toEqual([pushA, pushB]);
    expect((await ops.decide(card.id, card.version, 'confirm')).status).toBe('done');
    const head = git(repo, 'rev-parse', 'HEAD');
    expect([remoteSha(pushA, 'feature'), remoteSha(pushB, 'feature')]).toEqual([head, head]);
    // 只配了 url 的那个地址没被写
    expect(remoteSha(remote, 'feature')).not.toBe(head);
  });

  it('本地合并：锁定源和目标两边的提交；看完卡片后源分支又有新提交，旧卡片作废', async () => {
    await setup();
    git(repo, 'branch', 'main');
    commitIn(repo, 'a.txt', 'a\nfeature 的改动\n');
    write('b.txt', 'b\n我还没提交的\n');
    const card = await ops.proposeMerge(chat1.runId, 'feature', 'main');
    expect(card.request).toMatchObject({ kind: 'merge', fastForward: true, totalCommits: 1, sourceSha: git(repo, 'rev-parse', 'feature'), targetSha: git(repo, 'rev-parse', 'main') });
    const main = git(repo, 'rev-parse', 'main');
    commitIn(repo, 'a.txt', 'a\nfeature 的改动\n又一个\n');
    expect((await ops.decide(card.id, card.version, 'confirm')).status).toBe('stale');
    expect(git(repo, 'rev-parse', 'main')).toBe(main);
    // 重新提出后合并成功，你的工作区不动
    const again = await ops.proposeMerge(chat1.runId, 'feature', 'main');
    expect((await ops.decide(again.id, again.version, 'confirm')).status).toBe('done');
    expect(git(repo, 'show', 'main:a.txt')).toContain('又一个');
    expect(git(repo, 'status', '--porcelain')).toBe('M b.txt');
  });

  it('独立 worktree 方式的项目不提供这些卡片', async () => {
    await setup();
    const ws = store.tasks.getWorkspace(workspaceId)!;
    store.tasks.setWorkspaceMode(ws.id, ws.version, 'worktree');
    await expect(ops.proposeCommit(chat1.runId, 'x')).rejects.toThrow(/独立 worktree/);
  });
});

describe('暂存区卡片：保留或恢复', () => {
  const scratch = () => join(root, 'data', 'tmp');

  async function changedIndex() {
    write('mine.txt', '我暂存的\n');
    git(repo, 'add', 'mine.txt');
    const before = await indexTree(repo, scratch());
    write('a.txt', 'a\n助手暂存的\n');
    git(repo, 'add', 'a.txt'); // 绕过拦截的 git add
    const after = await indexTree(repo, scratch());
    const card = ops.proposeIndexChange(workspaceId, chat1.runId, before, after, ['a.txt']);
    return { before, after, card };
  }

  it('恢复：暂存区回到这一轮开始前（你自己暂存的还在），工作区文件内容不动，项目恢复写入', async () => {
    await setup();
    const { before, card } = await changedIndex();
    expect(store.tasks.getWorkspace(workspaceId)!.pausedReason).toMatch(/暂存区变了/);
    expect((await ops.decide(card.id, card.version, 'confirm')).status).toBe('done');
    expect(await indexTree(repo, scratch())).toBe(before);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('mine.txt');
    expect(read('a.txt')).toBe('a\n助手暂存的\n');
    expect(store.tasks.getWorkspace(workspaceId)!.pausedReason).toBeNull();
  });

  it('弹卡之后你又暂存了文件：点恢复时卡片作废，不覆盖你刚做的', async () => {
    await setup();
    const { card } = await changedIndex();
    write('b.txt', 'b\n我刚暂存的\n');
    git(repo, 'add', 'b.txt');
    const done = await ops.decide(card.id, card.version, 'confirm');
    expect(done.status).toBe('stale');
    expect(git(repo, 'diff', '--cached', '--name-only').split('\n')).toEqual(['a.txt', 'b.txt', 'mine.txt']);
  });

  it('保留：暂存区原样，项目恢复写入', async () => {
    await setup();
    const { after, card } = await changedIndex();
    expect((await ops.decide(card.id, card.version, 'cancel')).status).toBe('cancelled');
    expect(await indexTree(repo, scratch())).toBe(after);
    expect(store.tasks.getWorkspace(workspaceId)!.pausedReason).toBeNull();
  });

  it('已有未解决的合并冲突：git write-tree 失败时明确报错，不当成「暂存区没变」', async () => {
    await setup();
    git(repo, 'checkout', '-q', '-b', 'side');
    write('a.txt', 'side\n');
    git(repo, 'commit', '-q', '-am', 'side');
    git(repo, 'checkout', '-q', 'feature');
    write('a.txt', 'feature\n');
    git(repo, 'commit', '-q', '-am', 'feature');
    expect(() => git(repo, 'merge', 'side')).toThrow();
    await expect(indexTree(repo, scratch())).rejects.toThrow(/读不出暂存区（git write-tree 失败/);
  });
});
