import type { OperationKind } from './approval-policy.js';

/**
 * 执行器要运行的命令 → 操作类型（纯函数，只看命令文本和工作目录，不采信执行器给的理由）。
 * 整段文本一起匹配，`a && git push` 这类串起来的命令按最危险的那段归类；判断不了的往高处归。
 * 路径是否在 worktree 内由调用方注入（平台相关：Windows 大小写不敏感），这里不碰文件系统。
 */
export interface CommandContext {
  worktree: string;
  /** 执行器报的工作目录；没有时按 worktree 处理。 */
  cwd?: string | undefined;
  isInside(root: string, path: string): boolean;
}

/** git 子命令：`git` 和子命令之间允许带 `-C 目录` 之类的全局参数；可能误伤 commit 信息里的字样，误伤只会多一次审批。 */
const git = (verbs: string) => new RegExp(`\\bgit\\b[^;|&\\n]*?\\s(?:${verbs})\\b`, 'i');
const PUSH = git('push');
const MERGE = git('merge');
const REWRITE_HISTORY = git('rebase|reset');
const INSTALL = /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|\bpip3?\s+install\b|\bcargo\s+(?:add|install)\b|\bgo\s+(?:get|install)\b|\bwinget\s+install\b|\bchoco\s+install\b/i;
/** 网络下载：下载工具、PowerShell 的 Web cmdlet、拉代码、临时下载执行包。 */
const NETWORK = new RegExp(
  [
    String.raw`\b(?:curl|wget|aria2c|bitsadmin)\b`,
    String.raw`\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer)\b`,
    String.raw`\bcertutil\b[^;|&\n]*-urlcache`,
    git('clone|fetch|pull').source,
    String.raw`\b(?:pnpm|yarn)\s+dlx\b|\bbunx\b|\bnpx\s+(?:-y|--yes)\b|\bpip3?\s+download\b`,
  ].join('|'),
  'i',
);
/** 大范围删除：递归删除、通配符删除、git clean。 */
const WIDE_DELETE = new RegExp(
  [
    String.raw`\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b`,
    String.raw`\b(?:Remove-Item|ri|del|erase|rm|rmdir|rd)\b[^;|&\n]*(?:\s-Recurse\b|\s/[sS]\b|\*)`,
    String.raw`\bgit\b[^;|&\n]*?\sclean\b`,
    String.raw`\brimraf\b`,
  ].join('|'),
  'i',
);

const STOP = `\\s'"\`;|&<>`;
/**
 * 命令文本里的绝对路径：Windows 盘符路径（前面不能是字母数字，排除 https:// 之类）、UNC 路径、
 * 至少两段的 posix 路径（排除 cmd 的 /c、/s 等开关）。
 */
const ABSOLUTE_PATHS = new RegExp(
  `(?<![A-Za-z0-9])[A-Za-z]:[\\\\/][^${STOP}]*|(?<=^|[\\s'"\`=])\\\\\\\\[^${STOP}]+|(?<=^|[\\s'"\`=])/[^${STOP}/]+/[^${STOP}]*`,
  'g',
);
/** 用 .. 跳出当前目录。 */
const PARENT_ESCAPE = /(?:^|[\s'"`=\\/])\.\.(?:[\\/]|$|[\s'"`])/;
/** 由环境决定的位置（家目录、环境变量），一律当成 worktree 外。 */
const ENV_LOCATION = /(?:^|[\s'"`=])~(?:[\/]|$|[\s'"`])|\$HOME\b|\$\{HOME\}|\$env:|%[A-Za-z_][A-Za-z0-9_]*%/i;
/** 开头的可执行文件路径（执行器常把命令包成 `C:\…\powershell.exe -Command …`），不算操作对象。 */
const LEADING_PROGRAM = /^\s*(?:"[^"]+\.exe"|'[^']+\.exe'|\S+\.exe)(?=\s|$)/i;

/** 命令是否涉及 worktree 以外的位置：出现 worktree 外的绝对路径、家目录或环境变量路径，或用 .. 跳出（真实 Codex 实测：越界写文件的路径以参数形式出现）。 */
function touchesOutside(command: string, ctx: CommandContext): boolean {
  const args = command.replace(LEADING_PROGRAM, '');
  return PARENT_ESCAPE.test(args) || ENV_LOCATION.test(args) || (args.match(ABSOLUTE_PATHS) ?? []).some((path) => !ctx.isInside(ctx.worktree, path));
}

export function classifyCommand(command: string, ctx: CommandContext): OperationKind {
  if (ctx.cwd && !ctx.isInside(ctx.worktree, ctx.cwd)) return 'write_outside_worktree';
  if (PUSH.test(command)) return 'push_remote';
  if (MERGE.test(command)) return 'merge_branch';
  if (REWRITE_HISTORY.test(command)) return 'rewrite_git_history';
  if (touchesOutside(command, ctx)) return 'write_outside_worktree';
  if (INSTALL.test(command)) return 'install_dependencies';
  if (NETWORK.test(command)) return 'network_in_worktree';
  if (WIDE_DELETE.test(command)) return 'delete_in_worktree';
  return 'run_command_in_worktree';
}

/**
 * 宿主不经审批直接放行的操作（2026-11-25 / 11-26 已定：Windows 上可写角色「不隔离」，不逐条审批）：
 * 改自己 worktree 里的文件；`commandsAreSandboxEscapes` 为假的执行器（Claude）在 worktree 内跑的普通命令。
 * Codex 用 on-request 时来审批的命令都是要越过沙箱的（例如联网），不在此列，照旧审批。
 */
export function isAutoApproved(operation: OperationKind, executor: { commandsAreSandboxEscapes: boolean }): boolean {
  if (operation === 'write_in_worktree') return true;
  return operation === 'run_command_in_worktree' && !executor.commandsAreSandboxEscapes;
}
