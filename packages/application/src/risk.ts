import type { RiskLevel, RuntimeApprovalRequest } from '@paldock/contracts';
import { classifyRisk, type OperationKind } from '@paldock/domain';
import { isInside } from '@paldock/platform';

const INSTALL = /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|\bpip3?\s+install\b|\bcargo\s+(?:add|install)\b|\bgo\s+get\b/i;
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
/** 开头的可执行文件路径（执行器常把命令包成 `C:\…\powershell.exe -Command …`），不算操作对象。 */
const LEADING_PROGRAM = /^\s*(?:"[^"]+\.exe"|'[^']+\.exe'|\S+\.exe)(?=\s|$)/i;

/**
 * 命令是否涉及 worktree 以外的位置：出现 worktree 外的绝对路径，或用 .. 跳出。
 * 真实 Codex 实测：越界写文件的命令是 PowerShell，路径以参数形式出现。
 */
function touchesOutside(command: string, worktree: string): boolean {
  const args = command.replace(LEADING_PROGRAM, '');
  return PARENT_ESCAPE.test(args) || (args.match(ABSOLUTE_PATHS) ?? []).some((path) => !isInside(worktree, path));
}

/**
 * 执行器审批请求 → 操作类型。只看请求的客观内容（命令、目录、路径），不采信执行器给的理由。
 * 判断不了的一律往高处归：路径未知按 worktree 外处理。
 */
export function operationOf(request: RuntimeApprovalRequest, worktree: string): OperationKind {
  switch (request.kind) {
    case 'permissions':
      return 'expand_permissions';
    case 'file_change': {
      const paths = request.paths ?? [];
      return paths.length > 0 && paths.every((p) => isInside(worktree, p)) ? 'write_in_worktree' : 'write_outside_worktree';
    }
    // on-request 下来审批的命令都是要越过沙箱的，不按命令名降成低风险（「test」等字样可能只是路径的一部分）
    case 'command': {
      const command = request.command ?? '';
      if (request.cwd && !isInside(worktree, request.cwd)) return 'write_outside_worktree';
      if (/\bgit\s+push\b/i.test(command)) return 'push_remote';
      if (/\bgit\s+merge\b/i.test(command)) return 'merge_branch';
      if (touchesOutside(command, worktree)) return 'write_outside_worktree';
      if (INSTALL.test(command)) return 'install_dependencies';
      return 'run_command_in_worktree';
    }
  }
}

export function riskOf(request: RuntimeApprovalRequest, worktree: string): RiskLevel {
  return classifyRisk(operationOf(request, worktree));
}
