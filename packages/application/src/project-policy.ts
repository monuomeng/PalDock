import { CodedError, type ApprovalStrictness, type ProjectAgentSettings, type RoleIsolation, type StorePort, type WorkspaceAccess } from '@paldock/contracts';

/** 一次 Run 在项目里的写入方式与审批严格度（2026-11-26 已定，项目级助手设置）。 */
export interface RunPolicy {
  isolation: RoleIsolation;
  approval: ApprovalStrictness;
}

/**
 * 按项目设置算这次 Run 的隔离与审批：
 * - 主会话（对话）：团队模式下协调助手只读、每条都审批（现行规则）；单人模式按单人设置。
 * - 工作 Run、审阅 Run：按角色在这个项目里的设置（没有设置行时按默认）。
 */
export function runPolicy(store: StorePort, workspaceId: string, role: string, mode: 'work' | 'review' | 'conversation'): RunPolicy {
  if (mode === 'conversation') {
    const settings = store.projectSettings.get(workspaceId);
    return settings.mode === 'solo' ? { isolation: settings.soloIsolation, approval: settings.soloApproval } : { isolation: 'readonly', approval: 'all' };
  }
  const setting = store.projectSettings.role(workspaceId, role);
  return { isolation: setting.isolation, approval: setting.approval };
}

export const isSolo = (store: StorePort, workspaceId: string) => store.projectSettings.get(workspaceId).mode === 'solo';

/** 能力检查用的访问级别：只读按只读检查，其余按可写。 */
export const accessOf = (isolation: RoleIsolation): WorkspaceAccess => (isolation === 'readonly' ? 'read' : 'worktree_write');

/** 「直接在项目目录里改」改的是你当前的分支：改成它时要明确确认。 */
export function assertDirectConfirmed(next: RoleIsolation | undefined, current: RoleIsolation, confirmed: boolean | undefined): void {
  if (next === 'direct' && current !== 'direct' && !confirmed) {
    throw new CodedError('bad_request', '「直接在项目目录里改」会改你当前的分支和工作区，请确认后再开启');
  }
}

export type { ProjectAgentSettings };
