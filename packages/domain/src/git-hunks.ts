/**
 * 选择性提交用的纯函数（默认在当前仓库协作，2026-11-26 已定）：把 `git diff` 的统一补丁拆成改动块、按写入证据判断
 * 哪些块默认勾选、再把选中的块拼回补丁。不碰文件系统和 git。
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

/** 补丁头里的路径（新路径；删除时用旧路径）。 */
function pathOf(file: string): string {
  const plus = /^\+\+\+ b\/(.+)$/m.exec(file)?.[1];
  if (plus) return strip(plus);
  const minus = /^--- a\/(.+)$/m.exec(file)?.[1];
  if (minus) return strip(minus);
  return strip(/^diff --git a\/(.+?) b\//.exec(file)?.[1] ?? '');
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

/** 一个文件上助手的写入证据：加进来的行、删掉的行；wholeFile 表示整文件写入（Write），删掉的行不限。 */
export interface WriteEvidence {
  added: Set<string>;
  removed: Set<string>;
  wholeFile: boolean;
}

/** 执行器报告的写入 → 按文件汇总的证据。 */
export function evidenceOf(writes: readonly { path: string; kind: 'patch' | 'replace' | 'content'; detail: string }[]): Map<string, WriteEvidence> {
  const byPath = new Map<string, WriteEvidence>();
  const of = (path: string) => {
    let e = byPath.get(path);
    if (!e) byPath.set(path, (e = { added: new Set(), removed: new Set(), wholeFile: false }));
    return e;
  };
  for (const write of writes) {
    const e = of(write.path);
    if (write.kind === 'patch') {
      for (const line of write.detail.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) e.added.add(strip(line.slice(1)));
        else if (line.startsWith('-') && !line.startsWith('---')) e.removed.add(strip(line.slice(1)));
      }
    } else if (write.kind === 'replace') {
      const { old, new: next } = JSON.parse(write.detail) as { old: string; new: string };
      for (const line of next.split('\n')) e.added.add(strip(line));
      for (const line of old.split('\n')) e.removed.add(strip(line));
    } else {
      e.wholeFile = true;
      for (const line of write.detail.split('\n')) e.added.add(strip(line));
    }
  }
  return byPath;
}

/**
 * 这个块能不能用写入证据核对上：加的每一行都在助手写过的内容里，删的每一行都是助手删过的（整文件写入时删的不限）。
 * 一个块里只要有一行对不上（比如你在同一处也改了），就不算，默认不勾。没有任何行（二进制等）的块不算。
 */
export function isEvidenced(hunk: DiffHunk, evidence: ReadonlyMap<string, WriteEvidence>): boolean {
  const e = evidence.get(hunk.path);
  if (!e || (hunk.added.length === 0 && hunk.removed.length === 0)) return false;
  return hunk.added.every((l) => e.added.has(l)) && (e.wholeFile || hunk.removed.every((l) => e.removed.has(l)));
}

const GIT_WRITE = /\bgit\b[^;|&\n]*?\s(commit|push|merge|rebase|reset|checkout|switch|restore|stash|cherry-pick|revert|tag|branch\s+-[dDmM]|am|apply|clean|update-ref|pull)\b/i;

/** 改仓库状态的 git 命令（当前工作区方式下由宿主拒绝：提交、推送、合并都要用户在对话里指挥，经卡片确认）。 */
export function isGitWrite(command: string): boolean {
  return GIT_WRITE.test(command);
}
