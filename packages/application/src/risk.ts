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
const TESTS = /\b(?:test|tests|vitest|jest|pytest|mocha)\b/i;

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
    case 'command': {
      const command = request.command ?? '';
      if (request.cwd && !isInside(worktree, request.cwd)) return 'write_outside_worktree';
      if (/\bgit\s+push\b/i.test(command)) return 'push_remote';
      if (/\bgit\s+merge\b/i.test(command)) return 'merge_branch';
      if (INSTALL.test(command)) return 'install_dependencies';
      if (TESTS.test(command)) return 'run_tests';
      return 'run_command_in_worktree';
    }
  }
}

export function riskOf(request: RuntimeApprovalRequest, worktree: string): RiskLevel {
  return classifyRisk(operationOf(request, worktree));
}
