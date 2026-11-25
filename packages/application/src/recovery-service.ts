import type { PersistentEvent, RecoveryItem, RecoveryKind, RecoveryReport, RuntimeAdapter, StorePort, SubtaskRecord, TurnCheck } from '@paldock/contracts';
import type { CoordinatorService } from './coordinator.js';
import type { IntegrationService } from './integration.js';
import { resumePrompt } from './prompts.js';
import type { ReviewGate } from './review-gate.js';
import type { RunPlan } from './run-supervisor.js';
import type { TaskGraphScheduler } from './task-graph-scheduler.js';
import { settleTask } from './transitions.js';
import { errorText } from './util.js';

export interface RecoveryDeps {
  store: StorePort;
  supervisor: {
    enqueue(subtaskId: string, plan: RunPlan): void;
    adoptCompleted(runId: string, finalMessage: string | null): void;
    /** 跑这次 Run 的执行器（与监管器选执行器的规则一致）。 */
    adapter(name: string): RuntimeAdapter | undefined;
  };
  scheduler: TaskGraphScheduler;
  gate: ReviewGate;
  integration?: IntegrationService;
  coordinator?: CoordinatorService;
  publish(events: PersistentEvent[]): void;
  log(message: string): void;
  now?: () => Date;
}


/**
 * 服务启动时收拾 P3 的中间状态（存储层的 interruptActiveWork 已先跑过）：计划节点被中断的 Run 按原生会话查实后
 * 补记、续做或重做；排队中被打断的节点重新排队；审阅中的节点用新会话重新审；没结束的合并补记、重做或交给人；
 * 唤醒放回队列；通知照常升级；最后调度器重新推进每个没结束的任务图。每一项写一条 recovery.performed 事件。
 * P1 / P2 的单子任务不在这里自动恢复，仍由用户在「待我处理」里选。
 */
export class RecoveryService {
  private readonly items: RecoveryItem[] = [];
  private readonly now: () => Date;

  constructor(private readonly deps: RecoveryDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** 这次启动恢复了什么（桌面「待我处理」顶部列出）。 */
  report(): RecoveryItem[] {
    return [...this.items];
  }

  private record(kind: RecoveryKind, targetId: string, outcome: string, detail: string | null = null): void {
    this.deps.publish([this.deps.store.recordRecovery({ kind, targetId, outcome, detail })]);
    this.items.push({ kind, targetId, outcome, detail, at: this.now().toISOString() });
  }

  async recover(report: RecoveryReport): Promise<RecoveryItem[]> {
    const { store } = this.deps;
    // 合并先收拾：节点的成功与否决定后面的调度
    for (const item of (await this.deps.integration?.recover().catch((error) => (this.deps.log(`recover merges failed: ${errorText(error)}`), []))) ?? []) {
      this.record('merge', item.targetId, item.outcome, item.detail);
    }
    // 唤醒先放回队列：后面哪一项出错都不影响主会话继续处理
    const wakes = this.attempt('wakes', () => this.deps.coordinator?.start() ?? []) ?? [];
    for (const wake of wakes) this.record('wake', wake.sessionId, '唤醒放回队列', wake.summary.slice(0, 200));
    const handled = new Set<string>();
    for (const interrupted of report.interruptedRuns) {
      const run = store.runs.getRun(interrupted.id);
      const subtask = run && store.tasks.getSubtask(run.subtaskId);
      if (!run || !subtask?.planId || run.purpose !== 'work') continue;
      handled.add(subtask.id);
      await this.recoverRun(run.id, subtask).catch((error) => this.deps.log(`recover run ${run.id} failed: ${errorText(error)}`));
    }
    for (const { id, from } of report.blockedSubtasks) {
      const subtask = store.tasks.getSubtask(id);
      if (from !== 'queued' || handled.has(id) || !subtask?.planId || subtask.status !== 'blocked') continue;
      this.attempt(`requeue ${id}`, () => this.requeue(subtask, '排队中被重启打断，重新排队'));
    }
    this.attempt('reviews', () => this.restartReviews());
    const notices = store.coordinator.unescalatedNotices().length;
    if (notices > 0) this.record('notice', 'notices', '通知继续按升级规则外发', `${notices} 条还没在桌面看过`);
    this.attempt('reschedule', () => this.reschedule());
    return this.report();
  }

  /** 每一项单独兜底：一项出错只记日志，不打断其余的恢复。 */
  private attempt<T>(what: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (error) {
      this.deps.log(`recover ${what} failed: ${errorText(error)}`);
      return undefined;
    }
  }

  /** 计划节点被中断的工作 Run：按原生 thread + turn 查实。 */
  private async recoverRun(runId: string, subtask: SubtaskRecord): Promise<void> {
    const { store } = this.deps;
    const run = store.runs.getRun(runId)!;
    const adapter = this.deps.supervisor.adapter(run.runtime);
    const check: TurnCheck =
      adapter && run.nativeThreadId && run.nativeTurnId
        ? await adapter.checkTurn(run.nativeThreadId, run.nativeTurnId).catch((): TurnCheck => ({ status: 'not_found' }))
        : { status: 'not_found' };
    switch (check.status) {
      case 'completed':
        this.deps.supervisor.adoptCompleted(run.id, check.finalMessage);
        return this.record('run', subtask.id, '补记结果', '重启后核对到这一轮已经完成，照常收集证据并验收');
      case 'failed': {
        const reason = `执行失败：${check.message}`;
        this.deps.publish(store.runs.transitionRun(run.id, run.version, 'failed', reason).events);
        return this.record('run', subtask.id, '记为失败', reason);
      }
      default: {
        const resume = run.nativeThreadId ? { threadId: run.nativeThreadId, resumesRunId: run.id } : undefined;
        this.requeue(subtask, resume ? '重启前没做完，按原会话续做' : '重启前没做完，重新开始', resume);
      }
    }
  }

  /** 阻塞 → 排队，交给监管器：有原生会话就续做，否则按节点的提示词重新开始。 */
  private requeue(subtask: SubtaskRecord, outcome: string, resume?: { threadId: string; resumesRunId: string }): void {
    const { store } = this.deps;
    this.deps.publish(
      store.transaction(() => [...store.tasks.transitionSubtask(subtask.id, subtask.version, 'queued').events, ...settleTask(store, subtask.taskId)]),
    );
    const prompt = resume ? resumePrompt(subtask.goal) : this.deps.scheduler.promptFor(store.tasks.getSubtask(subtask.id)!);
    this.deps.supervisor.enqueue(subtask.id, { prompt, ...(resume ?? {}) });
    this.record('queued', subtask.id, outcome);
  }

  /** 审阅中的节点（审阅 Run 已被中断）：新的独立会话重新审。 */
  private restartReviews(): void {
    for (const subtask of this.deps.store.tasks.subtasksInReview()) {
      if (this.attempt(`review ${subtask.id}`, () => this.deps.gate.restartReview(subtask.id))) this.record('review', subtask.id, '用新会话重新审阅');
    }
  }

  /** 每个没结束的计划任务重新推进一次，把就绪的节点交给监管器。 */
  private reschedule(): void {
    for (const taskId of this.deps.store.plans.openPlanTasks()) {
      const released = this.deps.scheduler.advance(taskId);
      if (released.length > 0) this.record('schedule', taskId, '重新推进任务图', `放行 ${released.length} 个节点`);
    }
  }
}
