import type { AgentRole, CapabilityCheck, Executor, Isolation, RuntimeDiscovery, WorkspaceAccess } from '@paldock/contracts';

/** 出厂角色设置（迁移 005 按这份写入；测试校验两者一致）。执行器按用户 2026-11-25 的决定。 */
export interface FactoryProfile {
  displayName: string;
  description: string;
  executor: Executor;
  workspaceAccess: WorkspaceAccess;
  deliveryScope: readonly string[];
  maxRunMinutes: number;
  maxConcurrency: number;
}

export const FACTORY_PROFILES: Readonly<Record<AgentRole, FactoryProfile>> = {
  coordinator: {
    displayName: '协调助手',
    description: '和你对话，拆分任务、提出计划、汇总结果；不直接改代码',
    executor: 'claude',
    workspaceAccess: 'read',
    deliveryScope: [],
    maxRunMinutes: 30,
    maxConcurrency: 1,
  },
  developer: {
    displayName: '开发助手',
    description: '在自己的 worktree 里改代码并提交结果',
    executor: 'claude',
    workspaceAccess: 'worktree_write',
    deliveryScope: [],
    maxRunMinutes: 60,
    maxConcurrency: 4,
  },
  tester: {
    displayName: '测试助手',
    description: '补测试、跑测试，只交付测试文件',
    executor: 'codex',
    workspaceAccess: 'worktree_write',
    deliveryScope: ['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**'],
    maxRunMinutes: 60,
    maxConcurrency: 2,
  },
  reviewer: {
    displayName: '审阅助手',
    description: '只读审阅改动，给出通过或退回意见',
    executor: 'codex',
    workspaceAccess: 'read',
    deliveryScope: [],
    maxRunMinutes: 30,
    maxConcurrency: 2,
  },
  docs: {
    displayName: '文档助手',
    description: '写和更新文档，只交付文档',
    executor: 'claude',
    workspaceAccess: 'worktree_write',
    deliveryScope: ['docs/**', '**/*.md'],
    maxRunMinutes: 30,
    maxConcurrency: 2,
  },
  researcher: {
    displayName: '调研助手',
    description: '只读调研代码和资料，产出结论',
    executor: 'codex',
    workspaceAccess: 'read',
    deliveryScope: [],
    maxRunMinutes: 30,
    maxConcurrency: 2,
  },
};

/** 一项限制在某个「执行器 + 平台」上能否强制：实测能挡住、实测挡不住、还没测。 */
export type Enforcement = 'enforced' | 'not_enforced' | 'unverified';

/**
 * P3-00 实测（Windows 11，Codex 0.166.0 / Claude Code 2.1.325，见 p3 findings.md）：
 * - 只读：Codex 的 read-only 沙箱、Claude 禁用写工具 + 宿主拒绝，都挡住了全部写入。
 * - 限定目录（可写角色要用 Shell）：两种执行器都挡不住写到 worktree 外。
 * macOS 还没测，按 unverified 处理。
 */
const ENFORCEMENT: Partial<Record<NodeJS.Platform, Record<Executor, { readOnly: Enforcement; directoryScope: Enforcement }>>> = {
  win32: {
    codex: { readOnly: 'enforced', directoryScope: 'not_enforced' },
    claude: { readOnly: 'enforced', directoryScope: 'not_enforced' },
  },
};

export function enforcementOf(executor: Executor, platform: NodeJS.Platform = process.platform) {
  return ENFORCEMENT[platform]?.[executor] ?? { readOnly: 'unverified' as const, directoryScope: 'unverified' as const };
}

/**
 * 角色能不能用这个执行器：执行器必须可用，并报告宿主审批、取消、恢复；
 * 只读角色要求只读实测可强制（实测挡不住时拒绝，未验证的平台只提醒）；
 * 可写角色的目录限制挡不住时标「不隔离」（用户 2026-11-25 接受），只提醒不拒绝。
 */
export function checkCapability(
  access: WorkspaceAccess,
  executor: Executor,
  discovery: RuntimeDiscovery | undefined,
  platform: NodeJS.Platform = process.platform,
): CapabilityCheck {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!discovery?.available) problems.push(discovery?.reason ?? `${executor} 不可用`);
  else {
    const caps = discovery.capabilities;
    if (!caps.approvals) problems.push(`${executor} 不支持宿主审批`);
    if (!caps.cancel) problems.push(`${executor} 不支持取消`);
    if (!caps.resume) warnings.push(`${executor} 不支持恢复会话，中断后只能重新开始`);
  }
  const enforcement = enforcementOf(executor, platform);
  let isolation: Isolation;
  if (access === 'worktree_write') {
    isolation = enforcement.directoryScope === 'enforced' ? 'isolated' : enforcement.directoryScope === 'not_enforced' ? 'not_isolated' : 'unverified';
    if (isolation === 'not_isolated') warnings.push('不隔离：执行器获批的命令能写到 worktree 以外，交付范围只在验收时核对');
    if (isolation === 'unverified') warnings.push('目录限制在这个平台上还没实测，按不隔离对待');
  } else {
    isolation = enforcement.readOnly === 'enforced' ? 'read_only' : 'unverified';
    if (enforcement.readOnly === 'not_enforced') problems.push(`${executor} 在这个平台上无法强制只读，不能承接只读角色`);
    if (enforcement.readOnly === 'unverified') warnings.push('只读限制在这个平台上还没实测');
  }
  return { ok: problems.length === 0, isolation, problems, warnings };
}
