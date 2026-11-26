/**
 * 选择性提交用的纯函数（默认在当前仓库协作，2026-11-26 已定；0.3.7 改为按块归属）：把 `git diff` 的统一补丁拆成改动块、
 * 重放助手的写入、按每一行的归属判断哪些块列出和默认勾选，再把选中的块拼回补丁。不碰文件系统和 git。
 */

export interface DiffHunk {
  id: string;
  path: string;
  /** 这个文件的补丁头（diff --git / index / --- / +++ 等）。 */
  header: string;
  /** 这个块的文本（@@ 行和内容；二进制或没有 @@ 的整段改动为整段）。 */
  body: string;
  added: string[];
  removed: string[];
}

const strip = (line: string) => line.replace(/\r$/, '');
const stripName = (name: string) => name.replace(/\r$/, '').replace(/\t$/, '');

/** 统一补丁 → 改动块（按文件、按 @@ 分）。 */
export function splitDiff(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const files = patch.split(/^(?=diff --git )/m).filter((f) => f.startsWith('diff --git '));
  files.forEach((file, fileIndex) => {
    const path = pathOf(file);
    const at = file.search(/^@@ /m);
    if (at < 0) {
      // 二进制、纯改权限、空文件新增 / 删除：整个文件一块
      hunks.push({ id: `${fileIndex}:0`, path, header: file, body: '', added: [], removed: [] });
      return;
    }
    const header = file.slice(0, at);
    const bodies = file.slice(at).split(/^(?=@@ )/m);
    bodies.forEach((body, i) => {
      const lines = body.split('\n').slice(1);
      hunks.push({
        id: `${fileIndex}:${i}`,
        path,
        header,
        body,
        added: lines.filter((l) => l.startsWith('+')).map((l) => strip(l.slice(1))),
        removed: lines.filter((l) => l.startsWith('-')).map((l) => strip(l.slice(1))),
      });
    });
  });
  return hunks;
}

/**
 * 存下来的一个块（补丁头 + 块）还原成 DiffHunk，路径用调用方给的原始路径（0.3.9：不从补丁头的文本里解析路径，
 * 中文路径会被转义、带空格的路径行尾多一个 TAB）。
 */
export function hunkFromPatch(id: string, path: string, patch: string): DiffHunk {
  const at = patch.search(/^@@ /m);
  const header = at < 0 ? patch : patch.slice(0, at);
  const body = at < 0 ? '' : patch.slice(at);
  const lines = body.split('\n').slice(1);
  return {
    id,
    path,
    header,
    body,
    added: lines.filter((l) => l.startsWith('+')).map((l) => strip(l.slice(1))),
    removed: lines.filter((l) => l.startsWith('-')).map((l) => strip(l.slice(1))),
  };
}

/** 补丁头里的路径（新路径；删除时用旧路径）。只用于没有原始路径可用的场合；带空格的路径 git 会在行尾加一个 TAB。 */
function pathOf(file: string): string {
  const plus = /^\+\+\+ b\/(.+)$/m.exec(file)?.[1];
  if (plus) return stripName(plus);
  const minus = /^--- a\/(.+)$/m.exec(file)?.[1];
  if (minus) return stripName(minus);
  return stripName(/^diff --git a\/(.+?) b\//.exec(file)?.[1] ?? '');
}

/** 选中的块拼回补丁：同一文件的补丁头只写一次，块按原顺序。 */
export function joinHunks(hunks: readonly DiffHunk[]): string {
  let out = '';
  let lastHeader: string | undefined;
  for (const hunk of hunks) {
    if (hunk.header !== lastHeader) out += hunk.header;
    lastHeader = hunk.header;
    out += hunk.body;
  }
  return out.endsWith('\n') || out === '' ? out : `${out}\n`;
}

/** 补丁里一个块改了哪些行：加的行在新文件里的行号、删的行在旧文件里的行号（都从 1 起）。 */
export function hunkLines(hunk: Pick<DiffHunk, 'body'>): { added: number[]; removed: number[] } {
  const added: number[] = [];
  const removed: number[] = [];
  const lines = hunk.body.split('\n');
  const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[0] ?? '');
  if (!head) return { added, removed };
  let oldLine = Number(head[1]);
  let newLine = Number(head[2]);
  // 空的一边（新建 / 删光）行号写 0，从下一行起算
  if (oldLine === 0) oldLine = 1;
  if (newLine === 0) newLine = 1;
  for (const line of lines.slice(1)) {
    if (line.startsWith('+')) added.push(newLine++);
    else if (line.startsWith('-')) removed.push(oldLine++);
    else if (line.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
  }
  return { added, removed };
}

/** 助手的一次写入（重放用）。beforeHash：写之前文件内容的摘要（只有整文件写入记；文件不存在时为 'absent'）。 */
export interface ReplayWrite {
  kind: 'patch' | 'replace' | 'content';
  detail: string;
  beforeHash: string | null;
}

/** 写入证据统一按 LF 比较。 */
export const toLf = (text: string) => text.replace(/\r\n/g, '\n');

/**
 * 从一次 Run 开始时的文件内容出发，按顺序重放助手对这个文件的写入，得到「只有助手的改动」的版本（LF；null 表示文件不存在）。
 * 任何一步对不上就返回 undefined（这个文件在这次 Run 里没有可用的写入证据）：
 * 替换的原文找不到或不唯一、补丁打不上、整文件写入时文件已经不是助手看到的样子（beforeHash 不符，说明期间有人改过）。
 */
export function replayWrites(base: string | null, writes: readonly ReplayWrite[], digest: (text: string) => string): string | null | undefined {
  let state = base === null ? null : toLf(base);
  for (const write of writes) {
    if (write.beforeHash !== null && (state === null ? 'absent' : digest(state)) !== write.beforeHash) return undefined;
    if (write.kind === 'content') {
      state = toLf(write.detail);
    } else if (write.kind === 'replace') {
      const { old, new: next } = JSON.parse(write.detail) as { old: string; new: string };
      const from = toLf(old);
      if (state === null || from === '') return undefined;
      const at = state.indexOf(from);
      if (at < 0 || state.indexOf(from, at + 1) >= 0) return undefined;
      state = state.slice(0, at) + toLf(next) + state.slice(at + from.length);
    } else {
      // 不存在的文件上打补丁：只有新建文件的补丁（原文为空）能打上
      const patched = applyPatch(state ?? '', toLf(write.detail));
      if (patched === undefined) return undefined;
      state = patched;
    }
  }
  return state;
}

/** 严格地打一个统一补丁（不模糊匹配）：每个块的原文必须在头里写的位置，或者在全文里只出现一次。打不上返回 undefined。 */
export function applyPatch(text: string, patch: string): string | undefined {
  const lines = text === '' ? [] : text.split('\n');
  let finalNewline = true;
  if (lines.length > 0) {
    if (lines[lines.length - 1] === '') lines.pop();
    else finalNewline = false;
  }
  const hunks: { start: number; old: string[]; next: string[]; noNewline: boolean }[] = [];
  let current: (typeof hunks)[number] | undefined;
  let last = '';
  for (const line of patch.split('\n')) {
    const head = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (head) {
      hunks.push((current = { start: Number(head[1]), old: [], next: [], noNewline: false }));
    } else if (current) {
      if (line.startsWith(' ')) (current.old.push(line.slice(1)), current.next.push(line.slice(1)));
      else if (line.startsWith('-')) current.old.push(line.slice(1));
      else if (line.startsWith('+')) current.next.push(line.slice(1));
      else if (line.startsWith('\\') && last !== '-') current.noNewline = true;
    }
    last = line.slice(0, 1);
  }
  if (hunks.length === 0) return undefined;
  let offset = 0;
  for (const hunk of hunks) {
    const expected = Math.max(0, (hunk.old.length === 0 ? hunk.start : hunk.start - 1) + offset);
    const matches = (at: number) => hunk.old.every((l, i) => lines[at + i] === l) && at + hunk.old.length <= lines.length;
    let at = matches(expected) ? expected : -1;
    if (at < 0 && hunk.old.length > 0) {
      const found: number[] = [];
      for (let i = 0; i + hunk.old.length <= lines.length && found.length < 2; i++) if (matches(i)) found.push(i);
      if (found.length === 1) at = found[0]!;
    }
    if (at < 0) return undefined;
    lines.splice(at, hunk.old.length, ...hunk.next);
    offset += hunk.next.length - hunk.old.length;
    if (hunk.noNewline && at + hunk.next.length === lines.length) finalNewline = false;
  }
  return lines.length === 0 ? '' : lines.join('\n') + (finalNewline ? '\n' : '');
}

/**
 * 一行改动是谁做的（按这段时间的快照链推出来）：
 * - assistant：这次 Run 里、能用助手自己的写入重放出来的改动（有对应到这一行的写入证据）；
 * - during：这次 Run 期间发生、但重放不出来的改动（你同时改的、命令写的、证据对不上的）；
 * - other：不在任何 Run 期间（两次 Run 之间、最后一次 Run 之后你改的，或者更早的）。
 */
export type LineOwner = { kind: 'assistant' | 'during'; runId: string } | { kind: 'other' };

/**
 * 提交卡片上的一个块：只要有一行是范围内（这个任务 / 这个对话）的 Run 期间改的，就列出来；
 * 每一行都是范围内助手自己的改动（重放核对上的）才默认勾选。没有行号可核对的块（二进制等）由调用方按文件决定、默认不勾。
 */
export function classifyHunk(owners: readonly LineOwner[], inScope: (runId: string) => boolean): { show: boolean; evidenced: boolean } {
  const scoped = (o: LineOwner) => o.kind !== 'other' && inScope(o.runId);
  return {
    show: owners.some(scoped),
    evidenced: owners.length > 0 && owners.every((o) => o.kind === 'assistant' && inScope(o.runId)),
  };
}

const GIT_WRITE = /\bgit\b[^;|&\n]*?\s(commit|push|merge|rebase|reset|checkout|switch|restore|stash|cherry-pick|revert|tag|branch\s+-[dDmM]|am|apply|clean|update-ref|pull|add|rm|mv|update-index|read-tree|worktree)\b/i;

/** 改仓库状态或暂存区的 git 命令（当前工作区方式下由宿主拒绝：提交、推送、合并都要用户在对话里指挥，经卡片确认；暂存区是你的）。 */
export function isGitWrite(command: string): boolean {
  return GIT_WRITE.test(command);
}
