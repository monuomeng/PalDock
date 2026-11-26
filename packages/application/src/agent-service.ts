import {
  AgentRole,
  CodedError,
  EXECUTORS,
  type AgentOverrideRecord,
  type AgentSettings,
  type Executor,
  type PersistentEvent,
  type ProjectAssistantsView,
  type ProjectRolePatch,
  type ProjectSettingsPatch,
  type RuntimeAdapter,
  type StorePort,
} from '@paldock/contracts';
import { accessOf, assertDirectConfirmed } from './project-policy.js';
import { checkCapability } from '@paldock/domain';

export interface AgentServiceDeps {
  store: StorePort;
  runtimes: Readonly<Record<string, RuntimeAdapter>>;
  publish(events: PersistentEvent[]): void;
}

/** 设置页「助手」：角色的执行器、按项目的覆盖，以及每个角色当前执行器的能力检查。 */
export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  /** 每次打开设置页重新发现执行器（用户可能刚装好或登录），两个执行器并行检查。 */
  async settings(): Promise<AgentSettings> {
    const adapters = EXECUTORS.flatMap((name) => (this.deps.runtimes[name] ? [this.deps.runtimes[name]] : []));
    const runtimes = await Promise.all(adapters.map((adapter) => adapter.discover()));
    const discovered = new Map(runtimes.map((d) => [d.runtime, d]));
    const agents = this.deps.store.agents
      .listProfiles()
      .map((profile) => ({ profile, check: checkCapability(profile.workspaceAccess, profile.executor, discovered.get(profile.executor)) }));
    return { agents, runtimes };
  }

  setExecutor(role: AgentRole, expectedVersion: number, executor: Executor): void {
    this.deps.publish(this.deps.store.agents.setExecutor(role, expectedVersion, executor).events);
  }

  overrides(workspaceId: string): AgentOverrideRecord[] {
    return this.deps.store.agents.listOverrides(workspaceId);
  }

  setOverride(workspaceId: string, role: AgentRole, executor: Executor | null): void {
    this.deps.publish(this.deps.store.agents.setOverride(workspaceId, role, executor).events);
  }

  /**
   * 「项目 → 助手」页（2026-11-26 已定）：工作模式与单人设置，每个角色的启用、执行器、隔离方式、审批严格度、
   * 是否跳过审阅，以及按项目实际隔离方式算的能力检查。
   */
  async projectAssistants(workspaceId: string): Promise<ProjectAssistantsView> {
    const { store } = this.deps;
    const workspace = store.tasks.getWorkspace(workspaceId);
    if (!workspace) throw new CodedError('not_found', '项目不存在');
    const discovered = new Map(
      (await Promise.all(EXECUTORS.flatMap((name) => (this.deps.runtimes[name] ? [this.deps.runtimes[name].discover()] : [])))).map((d) => [d.runtime, d]),
    );
    const overrides = new Map(store.agents.listOverrides(workspaceId).map((o) => [o.role, o.executor]));
    const settings = store.projectSettings.get(workspaceId);
    const roles = store.agents
      .listProfiles()
      .filter((profile) => profile.role !== 'coordinator')
      .map((profile) => {
        const setting = store.projectSettings.role(workspaceId, profile.role);
        const executor = (overrides.get(profile.role) ?? profile.executor) as Executor;
        return {
          profile,
          setting,
          executor,
          override: (overrides.get(profile.role) ?? null) as Executor | null,
          skipReview: workspace.autoPolicy.skipReviewRoles.includes(profile.role),
          check: checkCapability(accessOf(setting.isolation), executor, discovered.get(executor)),
        };
      });
    const soloExecutor = (settings.soloExecutor ?? executorOfRole(store, workspaceId, 'coordinator')) as Executor;
    return { workspace, settings, soloExecutor, roles };
  }

  /** 工作模式与单人设置；单人模式改成「直接在项目目录里改」要带确认。 */
  setProjectMode(workspaceId: string, expectedVersion: number, patch: ProjectSettingsPatch, confirmDirect?: boolean): void {
    const { store } = this.deps;
    if (!store.tasks.getWorkspace(workspaceId)) throw new CodedError('not_found', '项目不存在');
    const current = store.projectSettings.get(workspaceId);
    // 切到单人模式时，如果它默认就是直接在项目目录里改，同样要确认
    const nextIsolation = patch.soloIsolation ?? (patch.mode === 'solo' && current.mode !== 'solo' ? current.soloIsolation : undefined);
    assertDirectConfirmed(nextIsolation, patch.mode === 'solo' && current.mode !== 'solo' ? 'worktree' : current.soloIsolation, confirmDirect);
    this.deps.publish(store.projectSettings.set(workspaceId, expectedVersion, patch).events);
  }

  /** 角色在项目里的启用、隔离方式、审批严格度；改成「直接在项目目录里改」要带确认。 */
  setProjectRole(workspaceId: string, role: AgentRole, expectedVersion: number, patch: ProjectRolePatch, confirmDirect?: boolean): void {
    const { store } = this.deps;
    if (!store.tasks.getWorkspace(workspaceId)) throw new CodedError('not_found', '项目不存在');
    if (role === 'coordinator') throw new CodedError('bad_request', '协调助手在团队模式下总是启用；单人设置在工作模式里改');
    assertDirectConfirmed(patch.isolation, store.projectSettings.role(workspaceId, role).isolation, confirmDirect);
    this.deps.publish(store.projectSettings.setRole(workspaceId, role, expectedVersion, patch).events);
  }
}

/** 角色在项目里实际会用的执行器（项目覆盖优先，否则角色默认；不认识的角色原样返回）。 */
export function executorOfRole(store: StorePort, workspaceId: string, role: string): string {
  const parsed = AgentRole.safeParse(role);
  return (parsed.success && store.agents.resolveExecutor(workspaceId, parsed.data)) || role;
}
