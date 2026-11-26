import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { applyPatch, classifyHunk, hunkLines, isGitWrite, joinHunks, replayWrites, splitDiff } from './git-hunks.js';

const sha1 = (t: string) => createHash('sha1').update(t, 'utf8').digest('hex');

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10 +10 @@',
  '-line 10',
  '+line 10 (你)',
  '@@ -80 +80 @@',
  '-line 80',
  '+line 80 (助手)',
  'diff --git a/b.txt b/b.txt',
  'new file mode 100644',
  'index 000..333',
  '--- /dev/null',
  '+++ b/b.txt',
  '@@ -0,0 +1 @@',
  '+你新建的文件',
  '',
].join('\n');

describe('改动块', () => {
  it('按文件、按 @@ 拆开，记下加和删的行', () => {
    const hunks = splitDiff(PATCH);
    expect(hunks.map((h) => [h.id, h.path, h.added, h.removed])).toEqual([
      ['0:0', 'src/a.ts', ['line 10 (你)'], ['line 10']],
      ['0:1', 'src/a.ts', ['line 80 (助手)'], ['line 80']],
      ['1:0', 'b.txt', ['你新建的文件'], []],
    ]);
  });

  it('只拼选中的块：同一文件的补丁头只写一次', () => {
    const [, eighty] = splitDiff(PATCH);
    expect(joinHunks([eighty!])).toBe(
      ['diff --git a/src/a.ts b/src/a.ts', 'index 111..222 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -80 +80 @@', '-line 80', '+line 80 (助手)', ''].join('\n'),
    );
  });

  it('块里每一行的行号：加的行按新文件、删的行按旧文件', () => {
    const [ten, eighty, created] = splitDiff(PATCH);
    expect(hunkLines(ten!)).toEqual({ added: [10], removed: [10] });
    expect(hunkLines(eighty!)).toEqual({ added: [80], removed: [80] });
    expect(hunkLines(created!)).toEqual({ added: [1], removed: [] });
    expect(hunkLines(splitDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,3 +3,2 @@\n a\n-b\n c\n')[0]!)).toEqual({ added: [], removed: [4] });
  });

  it('重放助手的写入：替换要唯一、补丁严格打、整文件写入要和写之前的内容对得上', () => {
    const base = 'a\nb\nc\n';
    const replace = (old: string, next: string) => ({ kind: 'replace' as const, detail: JSON.stringify({ old, new: next }), beforeHash: null });
    expect(replayWrites(base, [replace('b', 'B')], sha1)).toBe('a\nB\nc\n');
    // 原文不唯一 / 找不到：对不上
    expect(replayWrites('x\nx\n', [replace('x', 'y')], sha1)).toBeUndefined();
    expect(replayWrites(base, [replace('zzz', 'y')], sha1)).toBeUndefined();
    // Codex 的补丁
    expect(replayWrites(base, [{ kind: 'patch', detail: '@@ -2 +2 @@\n-b\n+B\n', beforeHash: null }], sha1)).toBe('a\nB\nc\n');
    expect(replayWrites(base, [{ kind: 'patch', detail: '@@ -2 +2 @@\n-q\n+B\n', beforeHash: null }], sha1)).toBeUndefined();
    // 新建文件的补丁（原文为空）
    expect(replayWrites(null, [{ kind: 'patch', detail: '@@ -0,0 +1,2 @@\n+x\n+y\n', beforeHash: null }], sha1)).toBe('x\ny\n');
    // 整文件写入：写之前的内容就是开始时的样子才算
    expect(replayWrites(base, [{ kind: 'content', detail: 'new\n', beforeHash: sha1(base) }], sha1)).toBe('new\n');
    // 期间有人改过（助手写的时候文件已经不是开始时的样子）：不算证据
    expect(replayWrites(base, [{ kind: 'content', detail: 'new\n', beforeHash: sha1('a\nb\nc\n你改的\n') }], sha1)).toBeUndefined();
    expect(replayWrites(null, [{ kind: 'content', detail: 'x\n', beforeHash: 'absent' }], sha1)).toBe('x\n');
    // CRLF 统一按 LF 比
    expect(replayWrites('a\r\nb\r\n', [replace('b', 'B')], sha1)).toBe('a\nB\n');
  });

  it('严格打补丁：位置不对时只在全文里唯一出现才打，否则打不上', () => {
    expect(applyPatch('q\na\nb\n', '@@ -1 +1 @@\n-a\n+A\n')).toBe('q\nA\nb\n');
    expect(applyPatch('a\nq\na\n', '@@ -5 +5 @@\n-a\n+A\n')).toBeUndefined();
    expect(applyPatch('a\n', '没有块')).toBeUndefined();
  });

  it('块的归属：有一行是范围内 Run 期间改的才列出；每一行都是范围内助手自己的改动才默认勾选', () => {
    const scoped = (runId: string) => runId === 'B';
    const mine = { kind: 'assistant' as const, runId: 'B' };
    expect(classifyHunk([mine, mine], scoped)).toEqual({ show: true, evidenced: true });
    // 你在 Run 期间改的（重放不出来）
    expect(classifyHunk([mine, { kind: 'during', runId: 'B' }], scoped)).toEqual({ show: true, evidenced: false });
    // 挨着你在 Run 之外改的
    expect(classifyHunk([mine, { kind: 'other' }], scoped)).toEqual({ show: true, evidenced: false });
    // 别的任务的块、只有你在 Run 之外改的块：不列
    expect(classifyHunk([{ kind: 'assistant', runId: 'A' }], scoped)).toEqual({ show: false, evidenced: false });
    expect(classifyHunk([{ kind: 'other' }], scoped)).toEqual({ show: false, evidenced: false });
  });

  it('改仓库状态的 git 命令', () => {
    for (const c of [
      'git commit -m x',
      'git push',
      'git -C . merge main',
      'git reset --hard',
      'git checkout other',
      'git stash',
      'git branch -D x',
      // 暂存区也是你的（0.3.7）
      'git add -A',
      'git add src/a.ts',
      'git rm --cached a',
      'git mv a b',
      'git restore --staged a',
      'git reset HEAD a',
      'git update-index --add a',
      'git read-tree HEAD',
      'git worktree add ../x',
    ])
      expect(isGitWrite(c)).toBe(true);
    for (const c of ['git status', 'git diff HEAD', 'git log --oneline', 'node --test', 'git branch']) expect(isGitWrite(c)).toBe(false);
  });
});
