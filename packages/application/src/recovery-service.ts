import type { PersistentEvent, RecoveryItem, RecoveryKind, RecoveryReport, RuntimeAdapter, StorePort, SubtaskRecord, TurnCheck } from '@paldock/contracts';
import type { CoordinatorService } from './coordinator.js';
import type { IntegrationService } from './integration.js';
import { resumePrompt } from './prompts.js';
import type { ReviewGate } from './review-gate.js';
import type { RunPlan } from './run-supervisor.js';
import type { TaskGraphScheduler } from './task-graph-scheduler.js';
import { settleTask } from './transitions.js';

export interface RecoveryDeps {
  store: StorePort;
  runtimes: Readonly<Record<string, RuntimeAdapter>>;
  supervisor: { enqueue(subtaskId: string, plan: RunPlan): void; adoptCompleted(runId: string, finalMessage: string | null): void };
  scheduler: TaskGraphScheduler;
  gate: ReviewGate;
  integration?: IntegrationService;
  coordinator?: CoordinatorService;
  publish(events: PersistentEvent[]): void;
  log(message: string): void;
  now?: () => Date;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

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
      this.requeue(subtask, '排队中被重启打断，重新排队');
    }
    this.restartReviews();
    const wakes = this.deps.coordinator?.start() ?? [];
    for (const wake of wakes) this.record('wake', wake.sessionId, '唤醒放回队列', wake.summary.slice(0, 200));
    const notices = store.coordinator.unescalatedNotices().length;
    if (notices > 0) this.record('notice', 'notices', '通知继续按升级规则外发', `${notices} 条还没在桌面看过`);
    this.reschedule();
    return this.report();
  }

  /** 计划节点被中断的工作 Run：按原生 thread + turn 查实。 */
  private async recoverRun(runId: string, subtask: SubtaskRecord): Promise<void> {
    const { store } = this.deps;
    const run = store.runs.getRun(runId)!;
    const adapters = Object.values(this.deps.runtimes);
    const adapter = adapters.length === 1 ? adapters[0] : this.deps.runtimes[run.runtime];
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
    const { store } = this.deps;
    for (const summary of store.tasks.listTasks(500)) {
      for (const subtask of store.tasks.listSubtasks(summary.task.id)) {
        if (subtask.status === 'review' && subtask.gateStage === 'review' && this.deps.gate.restartReview(subtask.id)) {
          this.record('review', subtask.id, '用新会话重新审阅');
        }
      }
    }
  }

  /** 每个没结束的计划任务重新推进一次，把就绪的节点交给监管器。 */
  private reschedule(): void {
    const { store } = this.deps;
    for (const { task } of store.tasks.listTasks(500)) {
      if (!store.plans.confirmedPlan(task.id) || ['succeeded', 'failed', 'cancelled'].includes(task.status)) continue;
      const released = this.deps.scheduler.advance(task.id);
      if (released.length > 0) this.record('schedule', task.id, '重新推进任务图', `放行 ${released.length} 个节点`);
    }
  }
}
