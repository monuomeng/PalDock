import type { AutoDecisionKind, PersistentEvent, RunRecord, RunResultRecord, StorePort, SubtaskRecord, TaskRecord } from '@paldock/contracts';
import { AgentRole } from '@paldock/contracts';
import { gateAfterReview, gateAfterWork, P1_DEFAULTS, runMachine } from '@paldock/domain';
import { reviewPrompt, reviewReworkPrompt } from './prompts.js';
import type { RunPlan } from './run-supervisor.js';
import { handoffOf, nodeOf } from './task-graph-scheduler.js';
import { settleTask } from './transitions.js';
import { MicroBatch } from './util.js';

export interface ReviewGateDeps {
  store: StorePort;
  supervisor: { enqueue(subtaskId: string, plan: RunPlan): void };
  publish(events: PersistentEvent[]): void;
  log(message: string): void;
  /** 通过后合进任务集成分支，合并成功才算子任务成功（没有集成分支的任务由它直接记成功）。 */
  integration: { merge(subtaskId: string): Promise<void> };
  limits?: { maxAutoReworks?: number };
}

const REVIEWER: AgentRole = 'reviewer';

/**
 * 计划节点的验收闸门，事件驱动（与调度器一样在下一个微任务里处理，不在别人的事务里写库）：
 * - 工作 Run 的证据收好（run.result_collected）→ 越界或检查没通过交给人；否则可写角色交给审阅助手，只读角色直接通过；
 * - 审阅 Run 结束（run.status_changed 到终态）→ 按审阅助手经 MCP 交的结论通过、退回重做或交给人。
 * 规则在 domain 的 gateAfterWork / gateAfterReview；这里只读状态、写结论、派审阅和返工的 Run。
 * 所有写入带读到的版本，子任务已被别处改动（取消、人工覆盖）时不处理。
 */
export class ReviewGate {
  private readonly batch: MicroBatch<{ kind: 'work' | 'review'; runId: string }>;
  private readonly maxAutoReworks: number;

  constructor(private readonly deps: ReviewGateDeps) {
    this.maxAutoReworks = deps.limits?.maxAutoReworks ?? P1_DEFAULTS.maxAutoReworks;
    this.batch = new MicroBatch(
      ({ kind, runId }) => (kind === 'work' ? this.afterWork(runId) : this.afterReview(runId)),
      deps.log,
      'gate',
      ({ kind, runId }) => `${kind} ${runId}`,
    );
  }

  onEvents(events: readonly PersistentEvent[]): void {
    for (const event of events) {
      if (event.type === 'run.result_collected') this.batch.add({ kind: 'work', runId: event.aggregateId });
      else if (event.type === 'run.status_changed' && runMachine.isTerminal(event.payload.to)) {
        const run = this.deps.store.runs.getRun(event.aggregateId);
        if (run?.purpose === 'review') this.batch.add({ kind: 'review', runId: run.id });
      }
    }
  }

  /** 节点子任务刚交付（review、还没过闸门），且这次 Run 是它最新的工作 Run。 */
  private freshDelivery(run: RunRecord): SubtaskRecord | undefined {
    const subtask = this.deps.store.tasks.getSubtask(run.subtaskId);
    if (!subtask?.planId || subtask.status !== 'review' || subtask.gateStage !== null) return undefined;
    return this.deps.store.runs.latestRun(subtask.id)?.id === run.id ? subtask : undefined;
  }

  afterWork(runId: string): void {
    const { store } = this.deps;
    const run = store.runs.getRun(runId);
    const subtask = run && this.freshDelivery(run);
    const result = subtask && store.runs.getResult(runId);
    if (!subtask || !result) return;
    const role = AgentRole.safeParse(subtask.role);
    const task = store.tasks.getTask(subtask.taskId)!;
    // 按项目设置的隔离方式（只读角色没有改动要审）
    const writable = store.projectSettings.role(task.workspaceId, subtask.role).isolation !== 'readonly';
    const decision = gateAfterWork({ outOfScope: result.outOfScope ?? [], checkStatus: result.checkStatus, prepareStatus: result.prepareStatus, writable });
    switch (decision.outcome) {
      case 'human':
        return this.deps.publish(store.tasks.setGateStage(subtask.id, subtask.version, 'human', { stage: 'check', outcome: 'human', runId, reason: decision.reason }).events);
      case 'passed':
        this.recordDecision(task, subtask, 'skip_review', '只读角色，没有改动要审，直接通过');
        return this.accept(subtask, { stage: 'check', runId, reason: '只读角色，没有改动要审' });
      case 'review': {
        // 项目设置里勾了这个角色跳过审阅：范围和检查都过了，直接合并，记一条
        if (role.success && store.tasks.getWorkspace(task.workspaceId)?.autoPolicy.skipReviewRoles.includes(role.data)) {
          this.recordDecision(task, subtask, 'skip_review', `项目设置跳过「${store.agents.getProfile(role.data)?.displayName ?? role.data}」的审阅；交付在范围内、检查通过`);
          return this.accept(subtask, { stage: 'check', runId, reason: '按项目设置跳过审阅' });
        }
        const { record, events } = store.tasks.setGateStage(subtask.id, subtask.version, 'review', { stage: 'check', outcome: 'passed', runId });
        this.deps.publish(events);
        return this.startReview(record, run!, result);
      }
    }
  }

  /** 重启恢复：审阅中的节点（审阅 Run 已被中断）用新的独立会话重新审阅同一次交付。 */
  restartReview(subtaskId: string): boolean {
    const { store } = this.deps;
    const subtask = store.tasks.getSubtask(subtaskId);
    if (subtask?.status !== 'review' || subtask.gateStage !== 'review') return false;
    const work = store.runs.latestRun(subtask.id);
    const result = work && store.runs.getResult(work.id);
    if (!work || !result) return false;
    this.startReview(subtask, work, result);
    return true;
  }

  /** 每轮审阅一个新的审阅助手会话（不沿用开发助手的会话和上下文），执行器按审阅角色的设置。 */
  private startReview(subtask: SubtaskRecord, work: RunRecord, result: RunResultRecord): void {
    const { store } = this.deps;
    const node = nodeOf(store, subtask) ?? { title: subtask.goal.slice(0, 40), goal: subtask.goal, paths: [] };
    const session = store.tasks.createSession(REVIEWER);
    const prompt = reviewPrompt(node, {
      commitSha: result.commitSha,
      baseCommit: subtask.baseCommit ?? 'HEAD',
      diffStat: result.diffStat,
      handoff: handoffOf(store, work.id),
    });
    this.deps.supervisor.enqueue(subtask.id, { prompt, review: { sessionId: session.id, role: REVIEWER } });
  }

  afterReview(reviewRunId: string): void {
    const { store } = this.deps;
    const review = store.runs.getRun(reviewRunId);
    const subtask = review && store.tasks.getSubtask(review.subtaskId);
    if (!review || !subtask || subtask.status !== 'review' || subtask.gateStage !== 'review') return;
    const verdict = store.runs.reviewOf(review.id);
    const decision = gateAfterReview({
      verdict,
      failure: review.status === 'succeeded' ? undefined : (review.failureReason ?? review.status),
      // 这次的退回已经记进去了，之前的轮数要减掉它
      previousReworks: store.runs.autoReworkCount(subtask.id) - (verdict?.decision === 'rework' ? 1 : 0),
      maxAutoReworks: this.maxAutoReworks,
    });
    const task = store.tasks.getTask(subtask.taskId)!;
    switch (decision.outcome) {
      case 'passed':
        this.recordDecision(task, subtask, 'review_passed', `审阅助手通过${verdict?.note ? `：${verdict.note}` : ''}`);
        return this.accept(subtask, { stage: 'review', runId: review.id });
      case 'human':
        return this.deps.publish(
          store.tasks.setGateStage(subtask.id, subtask.version, 'human', { stage: 'review', outcome: 'human', runId: review.id, reason: decision.reason }).events,
        );
      case 'rework':
        this.recordDecision(task, subtask, 'review_rework', `审阅助手自动退回：${decision.reason}`);
        return this.rework(subtask, review.id, decision.reason);
    }
  }

  /** 没经过用户的决定记进自动处理记录单。 */
  private recordDecision(task: TaskRecord, subtask: SubtaskRecord, kind: AutoDecisionKind, reason: string): void {
    this.deps.publish(
      this.deps.store.autoDecisions.record({ workspaceId: task.workspaceId, taskId: task.id, planId: subtask.planId, subtaskId: subtask.id, kind, reason }).events,
    );
  }

  /** 通过：合进任务集成分支，合并成功子任务才成功（放行下游由调度器按事件做）。 */
  private accept(subtask: SubtaskRecord, decision: { stage: 'check' | 'review'; runId: string; reason?: string }): void {
    this.deps.publish([this.deps.store.tasks.gateDecided(subtask.id, { ...decision, outcome: 'passed' })]);
    void this.deps.integration.merge(subtask.id);
  }

  /** 退回：回到开发助手同一个会话（最近一次工作 Run 的 thread）按审阅意见接着改。 */
  private rework(subtask: SubtaskRecord, reviewRunId: string, reason: string): void {
    const { store } = this.deps;
    const work = store.runs.latestRun(subtask.id);
    this.deps.publish(
      store.transaction(() => [
        store.tasks.gateDecided(subtask.id, { stage: 'review', outcome: 'rework', runId: reviewRunId, reason }),
        ...store.tasks.transitionSubtask(subtask.id, subtask.version, 'queued', `审阅退回：${reason}`.slice(0, 500)).events,
        ...settleTask(store, subtask.taskId),
      ]),
    );
    this.deps.supervisor.enqueue(subtask.id, {
      prompt: reviewReworkPrompt(subtask.goal, reason),
      ...(work?.nativeThreadId ? { threadId: work.nativeThreadId } : {}),
    });
  }
}
