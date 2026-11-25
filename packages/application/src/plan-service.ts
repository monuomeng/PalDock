import { CodedError, type McpToolArgs, type PersistentEvent, type PlanRecord, type StorePort } from '@paldock/contracts';
import { validatePlan } from '@paldock/domain';
import type { IntegrationService } from './integration.js';
import type { TaskGraphScheduler } from './task-graph-scheduler.js';

export interface PlanServiceDeps {
  store: StorePort;
  scheduler: TaskGraphScheduler;
  /** 确认时建任务集成分支；缺省时（测试）不建，节点从项目 HEAD 出发、通过即成功。 */
  integration?: IntegrationService;
  publish(events: PersistentEvent[]): void;
}

/**
 * 计划的用例：协调助手经 MCP 桥提出（只产生待确认的计划），用户在桌面确认或退回（带版本，先到者为准）。
 * 提出和确认时各校验一次：确认前角色设置可能已经变了。
 */
export class PlanService {
  constructor(private readonly deps: PlanServiceDeps) {}

  /** 可以派单的角色：设置里有的，不含协调助手。 */
  private specialistRoles(): Set<string> {
    return new Set(this.deps.store.agents.listProfiles().map((p) => p.role).filter((role) => role !== 'coordinator'));
  }

  /** 协调助手这次 Run 所在的项目里提出计划；带 taskId 时给那个草稿任务提新一版。 */
  propose(proposedByRunId: string, args: McpToolArgs<'propose_plan'>): PlanRecord {
    const { store } = this.deps;
    const run = store.runs.getRun(proposedByRunId);
    const subtask = run && store.tasks.getSubtask(run.subtaskId);
    const task = subtask && store.tasks.getTask(subtask.taskId);
    if (!task) throw new CodedError('not_found', '找不到这次 Run 所在的任务');
    validatePlan(args.nodes, this.specialistRoles());
    const { record, events } = store.plans.propose({
      workspaceId: task.workspaceId,
      title: args.title,
      goal: args.goal,
      nodes: args.nodes,
      proposedByRunId,
      ...(args.taskId ? { taskId: args.taskId } : {}),
    });
    this.deps.publish(events);
    return record;
  }

  /**
   * 确认后建任务集成分支（从项目当前 HEAD），按节点建子任务，没有依赖的立即交给监管器。
   * 集成分支先建：确认因版本冲突失败时分支留着，下次确认复用。
   */
  async confirm(planId: string, expectedVersion: number): Promise<void> {
    const { store } = this.deps;
    const plan = store.plans.getPlan(planId);
    if (!plan) throw new CodedError('not_found', '计划不存在');
    if (plan.version !== expectedVersion || plan.status !== 'proposed') throw new CodedError('conflict', '计划已被修改或已处理，请刷新');
    validatePlan(store.plans.nodes(planId), this.specialistRoles());
    if (this.deps.integration) await this.deps.integration.ensureBranch(store.tasks.getTask(plan.taskId)!);
    const { record: subtasks, events } = store.plans.confirm(planId, expectedVersion);
    this.deps.publish(events);
    for (const subtask of subtasks) if (subtask.status === 'queued') this.deps.scheduler.dispatch(subtask.id);
  }

  reject(planId: string, expectedVersion: number, note?: string): void {
    if (!this.deps.store.plans.getPlan(planId)) throw new CodedError('not_found', '计划不存在');
    this.deps.publish(this.deps.store.plans.reject(planId, expectedVersion, note?.trim() || null).events);
  }
}
