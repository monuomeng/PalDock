import { describe, expect, it } from 'vitest';
import { evidenceOf, isEvidenced, isGitWrite, joinHunks, splitDiff } from './git-hunks.js';

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

  it('默认勾选要有写入证据：助手的替换核对得上才算；你同时改的块、你改的别的文件都不算', () => {
    const evidence = evidenceOf([{ path: 'src/a.ts', kind: 'replace', detail: JSON.stringify({ old: 'line 80', new: 'line 80 (助手)' }) }]);
    expect(splitDiff(PATCH).map((h) => isEvidenced(h, evidence))).toEqual([false, true, false]);
  });

  it('Codex 的补丁和 Claude 的整文件写入也能当证据', () => {
    const fromPatch = evidenceOf([{ path: 'src/a.ts', kind: 'patch', detail: '@@ -80 +80 @@\n-line 80\n+line 80 (助手)\n' }]);
    expect(isEvidenced(splitDiff(PATCH)[1]!, fromPatch)).toBe(true);
    const whole = evidenceOf([{ path: 'b.txt', kind: 'content', detail: '你新建的文件\n' }]);
    expect(isEvidenced(splitDiff(PATCH)[2]!, whole)).toBe(true);
  });

  it('改仓库状态的 git 命令', () => {
    for (const c of ['git commit -m x', 'git push', 'git -C . merge main', 'git reset --hard', 'git checkout other', 'git stash', 'git branch -D x'])
      expect(isGitWrite(c)).toBe(true);
    for (const c of ['git status', 'git diff HEAD', 'git log --oneline', 'node --test', 'git branch']) expect(isGitWrite(c)).toBe(false);
  });
});
