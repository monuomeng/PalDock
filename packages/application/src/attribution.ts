import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunWriteRecord } from '@paldock/contracts';
import { hunkLines, replayWrites, splitDiff, type DiffHunk, type LineOwner } from '@paldock/domain';
import { git, gitInput, treeChangedFiles } from './git.js';

/** 写入证据的摘要：LF 后的 sha1。 */
export const contentDigest = (text: string) => createHash('sha1').update(text, 'utf8').digest('hex');

/** 快照链上的一次 Run：开始、结束时项目目录的 tree（没结束的为 null）和助手报告的写入。 */
export interface ChainRun {
  runId: string;
  startTree: string;
  endTree: string | null;
  writes: readonly RunWriteRecord[];
}

/** 一个改动块和它每一行的归属；files 是 Run 期间改过这个文件的 Run（二进制等没有行可核对的块据此判断）。 */
export interface AttributedHunk {
  hunk: DiffHunk;
  owners: LineOwner[];
  lineless: boolean;
  fileRuns: string[];
}

/** 路径参数按字面匹配（文件名里有 * ? [ 之类时不当通配符）。 */
export const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };

// 合成提交用固定的身份和时间（不进任何分支，只给 blame 用，之后由 gc 回收）
const CHAIN_ENV = {
  GIT_AUTHOR_NAME: 'PalDock',
  GIT_AUTHOR_EMAIL: 'paldock@localhost',
  GIT_COMMITTER_NAME: 'PalDock',
  GIT_COMMITTER_EMAIL: 'paldock@localhost',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

/**
 * 逐行归属（0.3.7）：HEAD 到现在工作区的每个改动块，每一行是谁改的。
 * 做法：把这段时间的快照串成一条合成提交链 HEAD → 开始₁ → 助手重放₁ → 结束₁ → 开始₂ → … → 现在，
 * 其中「助手重放」是从这次 Run 开始时的内容出发、只重放助手自己报告的写入得到的版本。
 * 再用 git blame（加的行）和 git blame --reverse（删的行）沿这条链找出每一行是在哪一步变的：
 * 在「助手重放」那一步 = 助手自己的改动（有对应到这一行的写入证据）；在「结束」那一步 = 这次 Run 期间别的改动；
 * 在「开始」或「现在」那一步 = 两次 Run 之间或之后你改的。
 */
export async function attributeHunks(repo: string, scratchDir: string, head: string, nowTree: string, runs: readonly ChainRun[], files: readonly string[]): Promise<AttributedHunk[]> {
  if (files.length === 0) return [];
  // 逐个文件取补丁，块的路径用原始路径（0.3.9：不从补丁头的文本里解析，中文会被转义、带空格的行尾多一个 TAB）
  const hunks: DiffHunk[] = [];
  for (const [fileIndex, file] of files.entries()) {
    const patch = await git(repo, ['diff', '--no-color', '--no-renames', '--binary', '-U1', head, nowTree, '--', file], 60_000, LITERAL);
    hunks.push(...splitDiff(patch).map((h, i) => ({ ...h, id: `${fileIndex}:${i}`, path: file })));
  }
  if (hunks.length === 0) return [];

  // 合成提交链
  const labels = new Map<string, LineOwner>();
  const child = new Map<string, string>();
  let parent = head;
  const link = async (tree: string, label: LineOwner) => {
    const sha = (await gitInput(repo, ['commit-tree', tree, '-p', parent], 'paldock attribution', CHAIN_ENV)).trim();
    labels.set(sha, label);
    child.set(parent, sha);
    parent = sha;
  };
  const fileRuns = new Map<string, Set<string>>();
  for (const [i, run] of runs.entries()) {
    const end = run.endTree ?? runs[i + 1]?.startTree ?? nowTree;
    await link(run.startTree, { kind: 'other' });
    await link(await replayTree(repo, scratchDir, run.startTree, run.writes), { kind: 'assistant', runId: run.runId });
    await link(end, { kind: 'during', runId: run.runId });
    for (const f of await treeChangedFiles(repo, run.startTree, end)) {
      let set = fileRuns.get(f);
      if (!set) fileRuns.set(f, (set = new Set()));
      set.add(run.runId);
    }
  }
  await link(nowTree, { kind: 'other' });
  const now = parent;

  const blames = new Map<string, { added: Map<number, string>; removed: Map<number, string> }>();
  const blameOf = async (path: string) => {
    let b = blames.get(path);
    if (!b) {
      const [added, removed] = await Promise.all([
        blame(repo, ['blame', '--porcelain', `${head}..${now}`, '--', path]),
        blame(repo, ['blame', '--reverse', '--porcelain', `${head}..${now}`, '--', path]),
      ]);
      blames.set(path, (b = { added, removed }));
    }
    return b;
  };
  const OTHER: LineOwner = { kind: 'other' };
  const result: AttributedHunk[] = [];
  for (const hunk of hunks) {
    const lines = hunkLines(hunk);
    const runsOfFile = [...(fileRuns.get(hunk.path) ?? [])];
    if (lines.added.length === 0 && lines.removed.length === 0) {
      result.push({ hunk, owners: [], lineless: true, fileRuns: runsOfFile });
      continue;
    }
    const b = await blameOf(hunk.path);
    const owners: LineOwner[] = [
      ...lines.added.map((n) => labels.get(b.added.get(n) ?? '') ?? OTHER),
      // 删掉的行：reverse blame 给出它最后还在的那一步，删掉它的是链上的下一步
      ...lines.removed.map((n) => labels.get(child.get(b.removed.get(n) ?? '') ?? '') ?? OTHER),
    ];
    result.push({ hunk, owners, lineless: false, fileRuns: runsOfFile });
  }
  return result;
}

/** git blame --porcelain 的输出 → 行号（最终文件里的）→ 提交。文件不存在等出错时为空（这些行归为 other，不默认勾选）。 */
async function blame(repo: string, args: string[]): Promise<Map<number, string>> {
  const out = await git(repo, args, 120_000, LITERAL).catch(() => '');
  const lines = new Map<number, string>();
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(line);
    if (m) lines.set(Number(m[2]), m[1]!);
  }
  return lines;
}

/**
 * 「只有助手改动」的 tree：从这次 Run 开始时的 tree 出发，逐个文件重放助手的写入（对不上的文件保持开始时的内容，即没有证据）。
 * 换行：按原文件的换行写回（原来是 CRLF 的写回 CRLF），再用 hash-object --path 走和 git add 相同的转换。
 */
async function replayTree(repo: string, scratchDir: string, startTree: string, writes: readonly RunWriteRecord[]): Promise<string> {
  if (writes.length === 0) return startTree;
  const byPath = new Map<string, RunWriteRecord[]>();
  for (const w of writes) {
    const list = byPath.get(w.path);
    if (list) list.push(w);
    else byPath.set(w.path, [w]);
  }
  const index = join(scratchDir, `index-replay-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(repo, ['read-tree', startTree], 60_000, env);
    for (const [path, list] of byPath) {
      const entry = (await git(repo, ['ls-tree', '-z', startTree, '--', path], 60_000, LITERAL).catch(() => '')).replace(/\0$/, '');
      const mode = /^(\d+) blob /.exec(entry)?.[1] ?? '100644';
      const base = entry ? await git(repo, ['cat-file', 'blob', `${startTree}:${path}`]).catch(() => null) : null;
      const replayed = replayWrites(base, list, contentDigest);
      if (replayed === undefined) continue;
      if (replayed === null) {
        await git(repo, ['update-index', '--force-remove', '--', path], 60_000, { ...env, ...LITERAL });
        continue;
      }
      const lastContent = [...list].reverse().find((w) => w.kind === 'content')?.detail;
      const crlf = base !== null ? base.includes('\r\n') : (lastContent ?? '').includes('\r\n');
      const content = crlf ? replayed.replace(/\n/g, '\r\n') : replayed;
      const blob = (await gitInput(repo, ['hash-object', '-w', '--stdin', `--path=${path}`], content)).trim();
      await git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], 60_000, env);
    }
    return (await git(repo, ['write-tree'], 60_000, env)).trim();
  } finally {
    rmSync(index, { force: true });
  }
}
