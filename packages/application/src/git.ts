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

export async function headCommit(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
}

/** 在 base 提交上新建分支并检出到 worktreePath。 */
export async function addWorktree(repo: string, worktreePath: string, branch: string, base: string): Promise<void> {
  await git(repo, ['worktree', 'add', '-b', branch, worktreePath, base]);
}

/** 暂存 worktree 内全部改动（含新文件），返回相对 base 的改动统计；没有改动时为空串。 */
export async function stageAndDiffStat(worktree: string, base: string): Promise<string> {
  await git(worktree, ['add', '-A']);
  return (await git(worktree, ['diff', '--cached', '--stat', base])).trimEnd();
}

/** 把已暂存的改动提交到 worktree 的分支；没有改动时返回 false。 */
export async function commitStaged(worktree: string, message: string): Promise<boolean> {
  await git(worktree, ['add', '-A']);
  const staged = await git(worktree, ['diff', '--cached', '--name-only']);
  if (staged.trim() === '') return false;
  await git(worktree, ['-c', 'user.name=PalDock', '-c', 'user.email=paldock@localhost', 'commit', '--no-verify', '-m', message]);
  return true;
}
