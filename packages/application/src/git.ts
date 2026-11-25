import { rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { childEnv } from '@paldock/platform';

/**
 * PalDock 对 git 的全部调用都经这里：参数数组、不经 shell；统一带 `-c core.longpaths=true`
 * （Windows 上删除含超长路径的 worktree 否则会失败并残留文件，P0-04 实测），不修改用户的全局配置。
 */
export function git(cwd: string, args: readonly string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.longpaths=true', '-C', cwd, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: childEnv({ GIT_TERMINAL_PROMPT: '0' }) },
      (error, stdout, stderr) => (error ? reject(new GitError(args[0] ?? 'git', stderr.trim() || error.message)) : resolve(stdout)),
    );
  });
}

export class GitError extends Error {
  constructor(
    readonly command: string,
    readonly stderr: string,
  ) {
    super(`git ${command} 失败：${stderr.split('\n')[0]}`);
    this.name = 'GitError';
  }
}

/** 项目目录必须是 git 仓库的根目录（不接受子目录，避免 worktree 位置混乱）。 */
export async function repositoryRoot(path: string): Promise<string> {
  return (await git(path, ['rev-parse', '--show-toplevel'])).trim();
}

/** 引用当前指向的提交；不存在时抛 GitError。 */
async function resolveCommit(repo: string, ref: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

export const headCommit = (repo: string) => resolveCommit(repo, 'HEAD');
export const branchCommit = (repo: string, branch: string) => resolveCommit(repo, `refs/heads/${branch}`);

/**
 * 在 base 提交上新建分支并检出到 worktreePath，返回分支实际的起点。可重入：上次已建好分支
 * （例如建完 worktree 后、记录入库前进程退出）时复用该分支，起点取它与 base 的分叉点。
 */
export async function addWorktree(repo: string, worktreePath: string, branch: string, base: string): Promise<string> {
  const exists = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
  if (!exists) {
    await git(repo, ['worktree', 'add', '-b', branch, worktreePath, base]);
    return base;
  }
  await git(repo, ['worktree', 'prune']);
  const registered = (await git(repo, ['worktree', 'list', '--porcelain'])).includes(`branch refs/heads/${branch}`);
  if (!registered) await git(repo, ['worktree', 'add', worktreePath, branch]);
  return (await git(repo, ['merge-base', base, branch])).trim();
}

/** 暂存 worktree 内全部改动（含新文件），返回相对 base 的改动统计；没有改动时为空串。 */
export async function stageAndDiffStat(worktree: string, base: string): Promise<string> {
  await git(worktree, ['add', '-A']);
  return (await git(worktree, ['diff', '--cached', '--stat', base])).trimEnd();
}

/**
 * 把收集证据时暂存的改动提交到 worktree 的分支；没有改动时返回 false。
 * 不再 `add -A`：验收的是证据里那份改动，检查命令之后生成的文件（构建产物、覆盖率）不应混进提交。
 */
export async function commitStaged(worktree: string, message: string): Promise<boolean> {
  const staged = await git(worktree, ['diff', '--cached', '--name-only']);
  if (staged.trim() === '') return false;
  await git(worktree, ['-c', 'user.name=PalDock', '-c', 'user.email=paldock@localhost', 'commit', '--no-verify', '-m', message]);
  return true;
}

/** base 到 commit 之间改动的文件（相对仓库根，`/` 分隔），用于核对交付范围。 */
export async function changedFiles(worktree: string, base: string, commit: string): Promise<string[]> {
  const out = await git(worktree, ['diff', '--name-only', '-z', base, commit]);
  return out.split('\0').filter((f) => f !== '');
}

const IDENTITY = ['-c', 'user.name=PalDock', '-c', 'user.email=paldock@localhost'];

/** 未解决冲突的文件。 */
async function unmergedFiles(worktree: string): Promise<string[]> {
  return (await git(worktree, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter((f) => f !== '');
}

/** 在 worktree 里把 source 合进当前 HEAD（总是生成合并提交）；冲突时中止合并、恢复原状，返回冲突文件。 */
export async function mergeInto(worktree: string, source: string, message: string): Promise<{ ok: true } | { ok: false; files: string[] }> {
  try {
    await git(worktree, [...IDENTITY, 'merge', '--no-ff', '--no-edit', '-m', message, source]);
    return { ok: true };
  } catch (error) {
    const files = await unmergedFiles(worktree);
    await git(worktree, ['merge', '--abort']).catch(() => {});
    if (files.length === 0) throw error;
    return { ok: false, files };
  }
}

/** 把 commit 合进 worktree 但不提交：冲突文件留着冲突标记交给助手处理，返回冲突文件（没有冲突时为空）。 */
export async function mergeNoCommit(worktree: string, commit: string): Promise<string[]> {
  try {
    await git(worktree, [...IDENTITY, 'merge', '--no-commit', '--no-ff', commit]);
    return [];
  } catch (error) {
    const files = await unmergedFiles(worktree);
    if (files.length === 0) throw error;
    return files;
  }
}

/**
 * 删掉临时 worktree。Windows 上刚结束的进程（检查命令、杀毒扫描）可能还占着文件，`worktree remove` 偶尔失败：
 * 重试几次，仍不行就直接删目录再 `worktree prune`。
 */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await git(repo, ['worktree', 'remove', '--force', path]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await git(repo, ['worktree', 'prune']);
}
