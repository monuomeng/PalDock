import { resolve, sep } from 'node:path';
import type { RiskLevel, RuntimeApprovalRequest } from '@paldock/contracts';
import { classifyRisk, type OperationKind } from '@paldock/domain';

/** Windows 与 macOS 默认文件系统都不区分大小写，路径比较统一转小写。 */
const normalize = (path: string) => {
  const full = resolve(path);
  return process.platform === 'linux' ? full : full.toLowerCase();
};

export function isInside(root: string, path: string): boolean {
  const base = normalize(root);
  const target = normalize(resolve(root, path));
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

const INSTALL = /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|\bpip3?\s+install\b|\bcargo\s+(?:add|install)\b|\bgo\s+get\b/i;
/** 命令文本里的绝对路径：Windows 盘符路径、UNC 路径与 posix 路径。 */
const ABSOLUTE_PATHS = /[A-Za-z]:[\\/][^\s'"`;|&<>]*|\\\\[^\s'"`;|&<>]+|(?<=^|[\s'"`=])\/[^\s'"`;|&<>]+/g;

/** 命令里出现 worktree 以外的绝对路径时，按 worktree 外的操作处理（真实 Codex 实测：越界写文件的 PowerShell 命令）。 */
function touchesOutside(command: string, worktree: string): boolean {
  return (command.match(ABSOLUTE_PATHS) ?? []).some((path) => !isInside(worktree, path));
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
