import type { PersistentEvent, RunRecord, StorePort, SubtaskRecord } from '@paldock/contracts';
import { AgentRole } from '@paldock/contracts';
import { gateAfterReview, gateAfterWork, P1_DEFAULTS, runMachine } from '@paldock/domain';
import { reviewPrompt, reviewReworkPrompt } from './prompts.js';
import type { RunPlan } from './run-supervisor.js';
import { nodeOf } from './task-graph-scheduler.js';
import { settleTask } from './transitions.js';

export interface ReviewGateDeps {
  store: StorePort;
  supervisor: { enqueue(subtaskId: string, plan: RunPlan): void };
  publish(events: PersistentEvent[]): void;
  log(message: string): void;
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
  private readonly pending: { kind: 'work' | 'review'; runId: string }[] = [];
  private flushing = false;
  private readonly maxAutoReworks: number;

  constructor(private readonly deps: ReviewGateDeps) {
    this.maxAutoReworks = deps.limits?.maxAutoReworks ?? P1_DEFAULTS.maxAutoReworks;
  }

  onEvents(events: readonly PersistentEvent[]): void {
    for (const event of events) {
      if (event.type === 'run.result_collected') this.pending.push({ kind: 'work', runId: event.aggregateId });
      else if (event.type === 'run.status_changed' && runMachine.isTerminal(event.payload.to)) {
        const run = this.deps.store.runs.getRun(event.aggregateId);
        if (run?.purpose === 'review') this.pending.push({ kind: 'review', runId: run.id });
      }
    }
    if (this.pending.length > 0 && !this.flushing) {
      this.flushing = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.flushing = false;
    for (const { kind, runId } of this.pending.splice(0)) {
      try {
        if (kind === 'work') this.afterWork(runId);
        else this.afterReview(runId);
      } catch (error) {
        this.deps.log(`gate ${kind} ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
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
    const writable = role.success && store.agents.getProfile(role.data)?.workspaceAccess === 'worktree_write';
    const decision = gateAfterWork({ outOfScope: result.outOfScope ?? [], checkStatus: result.checkStatus, writable });
    switch (decision.outcome) {
      case 'human':
        return this.deps.publish(store.tasks.setGateStage(subtask.id, subtask.version, 'human', { stage: 'check', outcome: 'human', runId, reason: decision.reason }).events);
      case 'passed':
        return this.accept(subtask, { stage: 'check', runId, reason: '只读角色，没有改动要审' });
      case 'review': {
        const { record, events } = store.tasks.setGateStage(subtask.id, subtask.version, 'review', { stage: 'check', outcome: 'passed', runId });
        this.deps.publish(events);
        return this.startReview(record, run!, result.commitSha, result.diffStat);
      }
    }
  }

  /** 每轮审阅一个新的审阅助手会话（不沿用开发助手的会话和上下文），执行器按审阅角色的设置。 */
  private startReview(subtask: SubtaskRecord, work: RunRecord, commitSha: string | null, diffStat: string | null): void {
    const { store } = this.deps;
    const node = nodeOf(store, subtask)!;
    const session = store.tasks.createSession(REVIEWER);
    const handoff = store.runs.getHandoff(work.id)?.summary ?? store.runs.getResult(work.id)?.finalMessage ?? null;
    const prompt = reviewPrompt(node, { commitSha: commitSha ?? 'HEAD', baseCommit: subtask.baseCommit ?? 'HEAD', diffStat, handoff });
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
    switch (decision.outcome) {
      case 'passed':
        return this.accept(subtask, { stage: 'review', runId: review.id });
      case 'human':
        return this.deps.publish(
          store.tasks.setGateStage(subtask.id, subtask.version, 'human', { stage: 'review', outcome: 'human', runId: review.id, reason: decision.reason }).events,
        );
      case 'rework':
        return this.rework(subtask, review.id, decision.reason);
    }
  }

  /** 通过：子任务成功（放行下游由调度器按事件做），任务状态重新推导。 */
  private accept(subtask: SubtaskRecord, decision: { stage: 'check' | 'review'; runId: string; reason?: string }): void {
    const { store } = this.deps;
    this.deps.publish(
      store.transaction(() => [
        store.tasks.gateDecided(subtask.id, { ...decision, outcome: 'passed' }),
        ...store.tasks.transitionSubtask(subtask.id, subtask.version, 'succeeded').events,
        ...settleTask(store, subtask.taskId),
      ]),
    );
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
