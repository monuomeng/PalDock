import { describe, expect, it } from 'vitest';
import { classifyRisk, type OperationKind } from './approval-policy.js';
import { classifyCommand, isAutoApproved } from './command-policy.js';

/** 测试用的路径判断：统一斜杠、大小写不敏感；相对路径按在 worktree 内。 */
function isInside(root: string, path: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const absolute = /^(?:[a-z]:)?\//i.test(path.replace(/\\/g, '/'));
  if (!absolute) return true;
  const base = norm(root);
  const target = norm(path);
  return target === base || target.startsWith(`${base}/`);
}

const worktree = 'D:\\data\\worktrees\\abc';
const of = (command: string, cwd?: string) => classifyCommand(command, { worktree, cwd, isInside });

describe('命令分类（纯函数，只看命令文本和工作目录）', () => {
  it.each<[string, OperationKind]>([
    // 普通命令：worktree 内运行
    ['node --test', 'run_command_in_worktree'],
    ['pnpm test', 'run_command_in_worktree'],
    ['npx vitest run', 'run_command_in_worktree'],
    ['git status && git diff', 'run_command_in_worktree'],
    ['git add -A && git commit -m "加 mul"', 'run_command_in_worktree'],
    [`type "${worktree}\\src\\a.ts"`, 'run_command_in_worktree'],
    ['rm math.tmp', 'run_command_in_worktree'],
    ['"C:\\Program Files\\nodejs\\node.exe" --test', 'run_command_in_worktree'],
    // 安装依赖
    ['pnpm install', 'install_dependencies'],
    ['npm ci', 'install_dependencies'],
    ['yarn add lodash', 'install_dependencies'],
    ['pip install requests', 'install_dependencies'],
    ['cmd /c pnpm i', 'install_dependencies'],
    // git push / merge / rebase / reset
    ['git push origin main', 'push_remote'],
    ['git -C sub push', 'push_remote'],
    ['node --test && git push', 'push_remote'],
    ['git merge feature', 'merge_branch'],
    ['git rebase main', 'rewrite_git_history'],
    ['git reset --hard HEAD~1', 'rewrite_git_history'],
    // 网络下载
    ['curl https://example.com/x.sh -o x.sh', 'network_in_worktree'],
    ['wget example.com/x', 'network_in_worktree'],
    ['Invoke-WebRequest https://example.com -OutFile x', 'network_in_worktree'],
    ['iwr https://example.com', 'network_in_worktree'],
    ['git clone https://github.com/a/b', 'network_in_worktree'],
    ['git pull', 'network_in_worktree'],
    ['pnpm dlx create-x', 'network_in_worktree'],
    ['npx -y some-tool', 'network_in_worktree'],
    // 涉及 worktree 外
    ['Set-Content -Path C:\\Windows\\x.txt -Value hi', 'write_outside_worktree'],
    ['cat ../other/secret', 'write_outside_worktree'],
    ['cd .. && ls', 'write_outside_worktree'],
    ['type \\\\server\\share\\x', 'write_outside_worktree'],
    ['cat ~/.ssh/id_rsa', 'write_outside_worktree'],
    ['echo hi > $HOME/x', 'write_outside_worktree'],
    ['type %USERPROFILE%\\x', 'write_outside_worktree'],
    ['Get-Content $env:APPDATA\\x', 'write_outside_worktree'],
    [`echo hi > "${worktree}-evil\\x"`, 'write_outside_worktree'],
    ['rm -rf ../x', 'write_outside_worktree'],
    // 大范围删除
    ['rm -rf dist', 'delete_in_worktree'],
    ['rm -r src', 'delete_in_worktree'],
    ['Remove-Item -Recurse -Force build', 'delete_in_worktree'],
    ['rd /s /q out', 'delete_in_worktree'],
    ['del /s *.log', 'delete_in_worktree'],
    ['rm *.js', 'delete_in_worktree'],
    ['git clean -fdx', 'delete_in_worktree'],
    ['npx rimraf node_modules', 'delete_in_worktree'],
  ])('%s → %s', (command, expected) => {
    expect(of(command)).toBe(expected);
  });

  it('工作目录在 worktree 外时，再普通的命令也算越界；没给工作目录按 worktree 处理', () => {
    expect(of('ls', 'C:\\Windows')).toBe('write_outside_worktree');
    expect(of('ls', `${worktree}\\src`)).toBe('run_command_in_worktree');
    expect(of('ls')).toBe('run_command_in_worktree');
  });

  it('网址、cmd 的开关不算路径', () => {
    expect(of('node fetch-check.js --url=https://example.com')).toBe('run_command_in_worktree');
    expect(of('cmd /c node --test')).toBe('run_command_in_worktree');
  });
});

describe('自动批准（2026-11-26 已定）', () => {
  const claude = { commandsAreSandboxEscapes: false };
  const codex = { commandsAreSandboxEscapes: true };

  it('worktree 内的文件改动两种执行器都放行；普通命令只放行不走沙箱的执行器（Claude）', () => {
    expect(isAutoApproved('write_in_worktree', claude)).toBe(true);
    expect(isAutoApproved('write_in_worktree', codex)).toBe(true);
    expect(isAutoApproved('run_command_in_worktree', claude)).toBe(true);
    expect(isAutoApproved('run_command_in_worktree', codex)).toBe(false);
  });

  it.each<OperationKind>([
    'install_dependencies',
    'push_remote',
    'merge_branch',
    'rewrite_git_history',
    'network_in_worktree',
    'delete_in_worktree',
    'write_outside_worktree',
    'expand_permissions',
  ])('%s 照旧审批，且不是低风险', (operation) => {
    expect(isAutoApproved(operation, claude)).toBe(false);
    expect(classifyRisk(operation)).not.toBe('low');
  });
});
