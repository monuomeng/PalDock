import { CodedError, type McpToolArgs, type PersistentEvent, type PlanNodeEdit, type PlanRecord, type StorePort } from '@paldock/contracts';
import { isSimplePlan, P3_DEFAULTS, validatePlan } from '@paldock/domain';
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
  log?: (message: string) => void;
  now?: () => number;
  /** 简单计划提出后等多久自动确认（测试里调小）。 */
  autoConfirmDelayMs?: number;
}

type Via = 'desktop' | 'feishu' | 'telegram';

/**
 * 计划的用例：协调助手经 MCP 桥提出（只产生待确认的计划），用户在桌面确认或退回（带版本，先到者为准）。
 * 提出和确认时各校验一次：确认前角色设置可能已经变了。
 */
export class PlanService {
  /** 排定了自动确认的计划 → 计时器。 */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;

  constructor(private readonly deps: PlanServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** 服务启动：重启前排定、还没到点（或已过点）的自动确认重新排上。 */
  start(): void {
    for (const plan of this.deps.store.plans.pendingAutoConfirms()) this.arm(plan.id, Date.parse(plan.autoConfirmAt!));
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** 可以派单的角色：设置里有的，不含协调助手。 */
  private specialistRoles(): Set<string> {
    return new Set(this.deps.store.agents.listProfiles().map((p) => p.role).filter((role) => role !== 'coordinator'));
  }

  /** 项目里没启用的角色不能派单（2026-11-26 已定，项目级助手设置）；提出和确认时都查。 */
  private assertEnabled(workspaceId: string, nodes: readonly { key: string; role: string }[]): void {
    const disabled = nodes.filter((n) => !this.deps.store.projectSettings.role(workspaceId, n.role).enabled);
    if (disabled.length === 0) return;
    const names = [...new Set(disabled.map((n) => this.deps.store.agents.listProfiles().find((p) => p.role === n.role)?.displayName ?? n.role))];
    throw new CodedError('bad_request', `这个项目没有启用这些角色：${names.join('、')}（节点 ${disabled.map((n) => n.key).join('、')}）。请换成已启用的角色，或请用户在「项目 → 助手」里启用`);
  }

  /** 协调助手这次 Run 所在的项目里提出计划；带 taskId 时给那个草稿任务提新一版。 */
  propose(proposedByRunId: string, args: McpToolArgs<'propose_plan'>): PlanRecord {
    const { store } = this.deps;
    const run = store.runs.getRun(proposedByRunId);
    const subtask = run && store.tasks.getSubtask(run.subtaskId);
    const task = subtask && store.tasks.getTask(subtask.taskId);
    if (!task) throw new CodedError('not_found', '找不到这次 Run 所在的任务');
    if (store.projectSettings.get(task.workspaceId).mode === 'solo') {
      throw new CodedError('bad_request', '这个项目是单人模式：不拆计划，直接在工作目录里动手做');
    }
    validatePlan(args.nodes, this.specialistRoles());
    this.assertEnabled(task.workspaceId, args.nodes);
    const { record, events } = store.plans.propose({
      workspaceId: task.workspaceId,
      title: args.title,
      goal: args.goal,
      nodes: args.nodes,
      proposedByRunId,
      ...(args.taskId ? { taskId: args.taskId } : {}),
    });
    this.deps.publish(events);
    return this.maybeScheduleAutoConfirm(record);
  }

  /**
   * 简单计划（2026-11-26 已定）：项目开着「简单计划自动确认」时，排定在一小段时间后自动确认；这段时间里可以撤回，
   * 撤回后计划留在待确认。不马上确认是为了让撤回来得及：确认后节点立刻派单，就撤不回了。
   */
  private maybeScheduleAutoConfirm(plan: PlanRecord): PlanRecord {
    if (!this.eligible(plan)) return plan;
    const at = this.now() + (this.deps.autoConfirmDelayMs ?? P3_DEFAULTS.autoConfirmDelayMs);
    const { record, events } = this.deps.store.plans.setAutoConfirm(plan.id, plan.version, new Date(at).toISOString());
    this.deps.publish(events);
    this.arm(plan.id, at);
    return record;
  }

  private eligible(plan: PlanRecord): boolean {
    const { store } = this.deps;
    const task = store.tasks.getTask(plan.taskId);
    const workspace = task && store.tasks.getWorkspace(task.workspaceId);
    return !!workspace && workspace.autoPolicy.autoConfirmSimplePlans && plan.status === 'proposed' && isSimplePlan(store.plans.nodes(plan.id), task!.status === 'draft');
  }

  private arm(planId: string, at: number): void {
    clearTimeout(this.timers.get(planId));
    const timer = setTimeout(() => {
      this.timers.delete(planId);
      this.fireAutoConfirm(planId).catch((error) => this.deps.log?.(`auto confirm ${planId} failed: ${(error as Error).message}`));
    }, Math.max(0, at - this.now()));
    // 不拖住进程退出：重启后由 start() 重新排定
    timer.unref?.();
    this.timers.set(planId, timer);
  }

  /** 到点：再核对一次（期间可能被改成带检查命令、关掉了开关、已手动处理），仍然满足才确认，并记一条自动处理决定。 */
  private async fireAutoConfirm(planId: string): Promise<void> {
    const { store } = this.deps;
    const plan = store.plans.getPlan(planId);
    if (!plan || plan.status !== 'proposed' || !plan.autoConfirmAt) return;
    if (!this.eligible(plan)) {
      // 不再满足：取消排定，留给你确认
      this.deps.publish(store.plans.setAutoConfirm(plan.id, plan.version, null).events);
      return;
    }
    await this.confirm(plan.id, plan.version, undefined, null);
    const task = store.tasks.getTask(plan.taskId)!;
    const reason = '简单计划（只有 1 个节点、不带检查命令），按项目设置自动确认';
    this.deps.publish(store.autoDecisions.record({ workspaceId: task.workspaceId, taskId: task.id, planId: plan.id, subtaskId: null, kind: 'plan_auto_confirmed', reason }).events);
  }

  /** 撤回自动确认：只在还没确认时可以；计划留在待确认，记一条自动处理决定。 */
  withdrawAutoConfirm(planId: string, expectedVersion: number): void {
    const { store } = this.deps;
    const plan = store.plans.getPlan(planId);
    if (!plan) throw new CodedError('not_found', '计划不存在');
    if (plan.status !== 'proposed' || !plan.autoConfirmAt) throw new CodedError('conflict', '计划已经确认或没有排定自动确认，不能撤回');
    clearTimeout(this.timers.get(planId));
    this.timers.delete(planId);
    const task = store.tasks.getTask(plan.taskId)!;
    this.deps.publish(
      store.transaction(() => [
        ...store.plans.setAutoConfirm(planId, expectedVersion, null).events,
        ...store.autoDecisions.record({ workspaceId: task.workspaceId, taskId: task.id, planId, subtaskId: null, kind: 'plan_auto_withdrawn', reason: '你撤回了自动确认，计划留在待确认' }).events,
      ]),
    );
  }

  /**
   * 确认（可带意见，交给协调助手）。草稿任务：先建任务集成分支（从项目当前 HEAD；确认因版本冲突失败时分支留着，下次复用），
   * 按节点建子任务，没有依赖的立即交给监管器。运行中的任务：按新旧两版对照替换节点，被作废的节点中断 Run，
   * 再让调度器按新的依赖推进一次。
   */
  async confirm(planId: string, expectedVersion: number, note?: string, via: Via | null = 'desktop'): Promise<void> {
    const { store } = this.deps;
    const plan = store.plans.getPlan(planId);
    if (!plan) throw new CodedError('not_found', '计划不存在');
    if (plan.version !== expectedVersion || plan.status !== 'proposed') throw new CodedError('conflict', '计划已被修改或已处理，请刷新');
    validatePlan(store.plans.nodes(planId), this.specialistRoles());
    const task = store.tasks.getTask(plan.taskId)!;
    this.assertEnabled(task.workspaceId, store.plans.nodes(planId));
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

  reject(planId: string, expectedVersion: number, note?: string, via: Via = 'desktop'): void {
    if (!this.deps.store.plans.getPlan(planId)) throw new CodedError('not_found', '计划不存在');
    clearTimeout(this.timers.get(planId));
    this.timers.delete(planId);
    this.deps.publish(this.deps.store.plans.reject(planId, expectedVersion, note?.trim() || null, via).events);
  }
}
