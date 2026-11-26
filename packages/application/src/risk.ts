import type { RiskLevel, RuntimeApprovalRequest } from '@paldock/contracts';
import { classifyCommand, classifyRisk, type OperationKind } from '@paldock/domain';
import { isInsideReal } from '@paldock/platform';

/**
 * 执行器审批请求 → 操作类型。只看请求的客观内容（命令、目录、路径），不采信执行器给的理由。
 * 判断不了的一律往高处归：路径未知按 worktree 外处理。命令的分类规则在 domain 的 `classifyCommand`。
 */
export function operationOf(request: RuntimeApprovalRequest, worktree: string): OperationKind {
  switch (request.kind) {
    case 'permissions':
      return 'expand_permissions';
    case 'file_change': {
      const paths = request.paths ?? [];
      return paths.length > 0 && paths.every((p) => isInsideReal(worktree, p)) ? 'write_in_worktree' : 'write_outside_worktree';
    }
    case 'command':
      return classifyCommand(request.command ?? '', { worktree, cwd: request.cwd, isInside: isInsideReal });
  }
}

export function riskOf(request: RuntimeApprovalRequest, worktree: string): RiskLevel {
  return classifyRisk(operationOf(request, worktree));
}
