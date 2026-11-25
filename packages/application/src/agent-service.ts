import { EXECUTORS, type AgentOverrideRecord, type AgentRole, type AgentSettings, type Executor, type PersistentEvent, type RuntimeAdapter, type StorePort } from '@paldock/contracts';
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
}
