import { z } from 'zod';
import type { AgentProfileRecord, CapabilityCheck, WorkspaceRecord } from './records.js';
import type { Executor } from './states.js';
import type { Change } from './storage.js';

/**
 * 项目级助手设置（2026-11-26 已定，0.3.4）：全局「设置 → 助手」只当默认值，每个项目可以覆盖工作模式、
 * 启用的角色、隔离方式和审批严格度（执行器仍用 agent_overrides）。没有设置行时按默认，旧数据行为不变。
 */
export const WORK_MODES = ['team', 'solo'] as const;
export const WorkMode = z.enum(WORK_MODES);
export type WorkMode = z.infer<typeof WorkMode>;

/** worktree：独立 worktree（可写角色默认）；direct：直接在项目目录里改（要确认，同一时刻一个写入者）；readonly：只读。 */
export const ROLE_ISOLATIONS = ['worktree', 'direct', 'readonly'] as const;
export const RoleIsolation = z.enum(ROLE_ISOLATIONS);
export type RoleIsolation = z.infer<typeof RoleIsolation>;

/** worktree_auto：工作目录内的文件改动和普通命令由宿主批准（现行规则）；all：每条都审批；high_only：只审批高风险。 */
export const APPROVAL_STRICTNESS = ['worktree_auto', 'all', 'high_only'] as const;
export const ApprovalStrictness = z.enum(APPROVAL_STRICTNESS);
export type ApprovalStrictness = z.infer<typeof ApprovalStrictness>;

export interface ProjectAgentSettings {
  workspaceId: string;
  mode: WorkMode;
  /** 单人模式的执行器；为空时用协调助手在这个项目里的执行器。 */
  soloExecutor: Executor | null;
  soloIsolation: RoleIsolation;
  soloApproval: ApprovalStrictness;
  /** 单人模式每轮改完让审阅助手看一遍。 */
  soloReview: boolean;
  /** 还没保存过为 0。 */
  version: number;
}

export interface ProjectRoleSetting {
  workspaceId: string;
  role: string;
  enabled: boolean;
  isolation: RoleIsolation;
  approval: ApprovalStrictness;
  version: number;
}

export type ProjectSettingsPatch = Partial<Pick<ProjectAgentSettings, 'mode' | 'soloExecutor' | 'soloIsolation' | 'soloApproval' | 'soloReview'>>;
export type ProjectRolePatch = Partial<Pick<ProjectRoleSetting, 'enabled' | 'isolation' | 'approval'>>;

export interface ProjectSettingsStorePort {
  get(workspaceId: string): ProjectAgentSettings;
  set(workspaceId: string, expectedVersion: number, patch: ProjectSettingsPatch): Change<ProjectAgentSettings>;
  /** 角色在项目里的设置；没有行时按角色默认（只读角色为只读，其余独立 worktree）。 */
  role(workspaceId: string, role: string): ProjectRoleSetting;
  roles(workspaceId: string): ProjectRoleSetting[];
  setRole(workspaceId: string, role: string, expectedVersion: number, patch: ProjectRolePatch): Change<ProjectRoleSetting>;
}

/** 「项目 → 助手」页的数据。 */
export interface ProjectAssistantsView {
  workspace: WorkspaceRecord;
  settings: ProjectAgentSettings;
  /** 单人模式实际会用的执行器。 */
  soloExecutor: Executor;
  roles: {
    profile: AgentProfileRecord;
    setting: ProjectRoleSetting;
    /** 实际会用的执行器和项目覆盖（没有覆盖为 null）。 */
    executor: Executor;
    override: Executor | null;
    skipReview: boolean;
    /** 按项目实际的隔离方式算的能力检查。 */
    check: CapabilityCheck;
  }[];
}
