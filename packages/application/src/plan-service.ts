import { CodedError, type McpToolArgs, type PersistentEvent, type PlanNodeEdit, type PlanRecord, type StorePort } from '@paldock/contracts';
import { validatePlan } from '@paldock/domain';
import type { IntegrationService } from './integration.js';
import type { TaskGraphScheduler } from './task-graph-scheduler.js';
import { settleTask } from './transitions.js';

export interface PlanServiceDeps {
  store: StorePort;
  scheduler: TaskGraphScheduler;
  /** 确认时建任务集成分支；缺省时（测试）不建，节点从项目 HEAD 出发、通过即成功。 */
  integration?: IntegrationService;
  /** 运行中改计划时中断被作废节点的 Run；缺省时（测试）不中断。 */
  supervisor?: { cancel(subtaskId: string): boolean };
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
   * 确认（可带意见，交给协调助手）。草稿任务：先建任务集成分支（从项目当前 HEAD；确认因版本冲突失败时分支留着，下次复用），
   * 按节点建子任务，没有依赖的立即交给监管器。运行中的任务：按新旧两版对照替换节点，被作废的节点中断 Run，
   * 再让调度器按新的依赖推进一次。
   */
  async confirm(planId: string, expectedVersion: number, note?: string, via: 'desktop' | 'feishu' | 'telegram' = 'desktop'): Promise<void> {
    const { store } = this.deps;
    const plan = store.plans.getPlan(planId);
    if (!plan) throw new CodedError('not_found', '计划不存在');
    if (plan.version !== expectedVersion || plan.status !== 'proposed') throw new CodedError('conflict', '计划已被修改或已处理，请刷新');
    validatePlan(store.plans.nodes(planId), this.specialistRoles());
    const task = store.tasks.getTask(plan.taskId)!;
    if (this.deps.integration && task.status === 'draft') await this.deps.integration.ensureBranch(task);
    const { record, events } = store.plans.confirm(planId, expectedVersion, note?.trim() || null, via);
    this.deps.publish(events);
    for (const id of record.cancelled) this.deps.supervisor?.cancel(id);
    for (const subtask of record.created) if (subtask.status === 'queued') this.deps.scheduler.dispatch(subtask.id);
    if (task.status !== 'draft') {
      this.deps.scheduler.advance(task.id);
      this.deps.publish(store.transaction(() => settleTask(store, task.id)));
    }
  }

  /** 确认前改一个节点：先在副本上校验整份计划，通过才写入。 */
  editNode(planId: string, expectedVersion: number, edit: PlanNodeEdit): void {
    const { store } = this.deps;
    const plan = store.plans.getPlan(planId);
    if (!plan) throw new CodedError('not_found', '计划不存在');
    if (plan.status !== 'proposed') throw new CodedError('conflict', '计划已确认或已处理，不能再改');
    const nodes = store.plans.nodes(planId).map((n) => {
      if (n.key !== edit.nodeKey) return n;
      if (edit.kind === 'executor') return { ...n, executor: edit.executor };
      if (edit.kind === 'check') return { ...n, checkCommand: edit.check, check: edit.check ?? undefined };
      return n;
    });
    if (edit.kind !== 'remove') validatePlan(nodes, this.specialistRoles());
    this.deps.publish(store.plans.editNode(planId, expectedVersion, edit).events);
  }

  reject(planId: string, expectedVersion: number, note?: string, via: 'desktop' | 'feishu' | 'telegram' = 'desktop'): void {
    if (!this.deps.store.plans.getPlan(planId)) throw new CodedError('not_found', '计划不存在');
    this.deps.publish(this.deps.store.plans.reject(planId, expectedVersion, note?.trim() || null, via).events);
  }
}
