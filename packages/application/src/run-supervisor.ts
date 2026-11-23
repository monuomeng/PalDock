import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ApprovalDecision,
  ApprovalRecord,
  EphemeralEvent,
  NewRunResult,
  PersistentEvent,
  RunRecord,
  RunStatus,
  RuntimeAdapter,
  RuntimeApprovalRequest,
  RuntimeEvent,
  RuntimeRun,
  StorePort,
  SubtaskRecord,
  TurnCheck,
} from '@paldock/contracts';
import { P1_DEFAULTS } from '@paldock/domain';
import { runCheck } from './check-runner.js';
import { addWorktree, headCommit, stageAndDiffStat } from './git.js';
import { redact } from './redact.js';
import { riskOf } from './risk.js';
import { moveSubtask, moveTask } from './transitions.js';

export type Limits = typeof P1_DEFAULTS & { maxConcurrentRuns: number; expiryScanMs: number };

export interface SupervisorDeps {
  store: StorePort;
  runtime: RuntimeAdapter;
  dataRoot: string;
  publish(events: PersistentEvent[]): void;
  publishEphemeral(event: EphemeralEvent): void;
  log(message: string): void;
  limits?: Partial<Limits>;
}

/** 一次 Run 的提示词与原生会话：续做或退回重做时沿用 thread，重新开始时不带。 */
export interface RunPlan {
  prompt: string;
  threadId?: string;
  resumesRunId?: string;
}

/** 正在执行的 Run：内存里只放控制所需的东西，事实都在库里。 */
interface LiveRun {
  run: RunRecord;
  subtask: SubtaskRecord;
  worktree: string | undefined;
  handle: RuntimeRun | undefined;
  /** approvalId → 执行器请求 ID；回复时原样带回。 */
  approvals: Map<string, string>;
  output: string;
  flushTimer: NodeJS.Timeout | undefined;
  cancelRequested: boolean;
  check: AbortController;
}

const TERMINAL_EVENTS = new Set<RuntimeEvent['type']>(['completed', 'failed', 'interrupted', 'disconnected']);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/**
 * 执行器监管：启动 Run、把执行器事件写成状态与事件、处理审批与取消、断线后按 turn 核对、
 * Run 结束后收集证据。确定性规则都在这里，模型说「完成」只会让子任务进入待验收。
 */
export class RunSupervisor {
  private readonly live = new Map<string, LiveRun>();
  private readonly queue: { subtaskId: string; plan: RunPlan }[] = [];
  private readonly limits: Limits;
  private expiryTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  /** 进行中的异步收尾（启动、证据收集、断线核对）；退出时等它们结束，避免在数据库关闭后写入。 */
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly deps: SupervisorDeps) {
    this.limits = { ...P1_DEFAULTS, maxConcurrentRuns: 10, expiryScanMs: 15_000, ...deps.limits };
  }

  start(): void {
    this.expiryTimer = setInterval(() => this.expireApprovals(), this.limits.expiryScanMs);
    this.expiryTimer.unref();
  }

  /** 正常退出：结束所有执行器进程树和检查命令；状态由存储层的恢复程序统一置为 interrupted。 */
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.expiryTimer);
    this.queue.length = 0;
    await Promise.all(
      [...this.live.values()].map(async (live) => {
        this.flushOutput(live);
        live.check.abort();
        await live.handle?.dispose();
      }),
    );
    await Promise.allSettled([...this.inflight]);
    this.live.clear();
  }

  private background(work: Promise<void>): void {
    this.inflight.add(work);
    void work
      .catch((error) => this.deps.log(`background work failed: ${errorText(error)}`))
      .finally(() => this.inflight.delete(work));
  }

  isLive(subtaskId: string): boolean {
    return [...this.live.values()].some((l) => l.subtask.id === subtaskId) || this.queue.some((q) => q.subtaskId === subtaskId);
  }

  /** 调用方已把子任务置为 queued；并发已满时排队。 */
  enqueue(subtaskId: string, plan: RunPlan): void {
    if (this.live.size >= this.limits.maxConcurrentRuns) this.queue.push({ subtaskId, plan });
    else this.background(this.launch(subtaskId, plan));
  }

  /** 取消正在执行或排队的 Run；不在这里的返回 false，由调用方直接改状态。 */
  cancel(subtaskId: string): boolean {
    const queued = this.queue.findIndex((q) => q.subtaskId === subtaskId);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      return false;
    }
    const live = [...this.live.values()].find((l) => l.subtask.id === subtaskId);
    if (!live) return false;
    live.cancelRequested = true;
    live.check.abort();
    void live.handle?.cancel().catch((error) => this.deps.log(`cancel failed: ${errorText(error)}`));
    return true;
  }

  /** 用户（或过期）已在库里决定审批，这里转告执行器；没有挂起的审批后 Run 回到 running。 */
  forwardDecision(approval: ApprovalRecord, decision: ApprovalDecision): void {
    const live = this.live.get(approval.runId);
    const nativeId = live?.approvals.get(approval.id);
    if (!live || nativeId === undefined) return;
    live.approvals.delete(approval.id);
    live.handle?.respondApproval(nativeId, decision);
    if (live.approvals.size === 0 && live.run.status === 'waiting_approval') this.publish(this.runTo(live, 'running'));
  }

  private publish(events: PersistentEvent[]): void {
    if (events.length > 0) this.deps.publish(events);
  }

  private runTo(live: LiveRun, to: RunStatus, reason?: string): PersistentEvent[] {
    if (live.run.status === to) return [];
    const change = this.deps.store.runs.transitionRun(live.run.id, live.run.version, to, reason);
    live.run = change.record;
    return change.events;
  }

  private async launch(subtaskId: string, plan: RunPlan): Promise<void> {
    const { store } = this.deps;
    const session = store.tasks.getSessionOfSubtask(subtaskId);
    if (!session) return this.deps.log(`subtask ${subtaskId} 没有会话`);
    const live = store.transaction(() => {
      const moved = moveSubtask(store, subtaskId, 'running');
      const taskEvents = moveTask(store, moved.record.taskId, 'running');
      const run = store.runs.createRun({
        subtaskId,
        sessionId: session.id,
        runtime: this.deps.runtime.name,
        ...(plan.threadId ? { nativeThreadId: plan.threadId } : {}),
        ...(plan.resumesRunId ? { resumesRunId: plan.resumesRunId } : {}),
      });
      this.publish([...moved.events, ...taskEvents, ...run.events]);
      return this.track(run.record, moved.record);
    });

    try {
      live.worktree = await this.ensureWorktree(live);
      live.handle = await this.deps.runtime.start(
        { runId: live.run.id, cwd: live.worktree, prompt: plan.prompt, ...(plan.threadId ? { resumeThreadId: plan.threadId } : {}) },
        (event) => this.onEvent(live, event),
      );
    } catch (error) {
      if (this.stopping) return;
      const reason = plan.threadId ? `续做失败：${errorText(error)}` : `启动失败：${errorText(error)}`;
      if (plan.threadId) this.publish([store.runs.addNotice(live.run.id, 'resume_failed', reason)]);
      return this.finishBlocked(live, 'failed', reason);
    }
    if (this.stopping) return live.handle.dispose();
    if (live.cancelRequested) await live.handle.cancel();
  }

  private track(run: RunRecord, subtask: SubtaskRecord): LiveRun {
    const live: LiveRun = {
      run,
      subtask,
      worktree: subtask.worktreePath ?? undefined,
      handle: undefined,
      approvals: new Map(),
      output: '',
      flushTimer: undefined,
      cancelRequested: false,
      check: new AbortController(),
    };
    this.live.set(run.id, live);
    return live;
  }

  /** 写入型子任务的 worktree 只建一次（数据根下，分支名小写），之后各次 Run 共用。 */
  private async ensureWorktree(live: LiveRun): Promise<string> {
    if (live.subtask.worktreePath) return live.subtask.worktreePath;
    const task = this.deps.store.tasks.getTask(live.subtask.taskId)!;
    const workspace = this.deps.store.tasks.getWorkspace(task.workspaceId)!;
    const slug = task.id.replace(/^task_/, '').slice(0, 8).toLowerCase();
    const path = join(this.deps.dataRoot, 'worktrees', slug);
    const branch = `${this.limits.branchPrefix}${slug}`;
    const base = await headCommit(workspace.rootPath).catch(() => {
      throw new Error('项目还没有任何提交，无法创建 worktree');
    });
    mkdirSync(join(this.deps.dataRoot, 'worktrees'), { recursive: true });
    await addWorktree(workspace.rootPath, path, branch, base);
    const updated = this.deps.store.tasks.setWorktree(live.subtask.id, path, branch, base);
    if (updated) live.subtask = updated;
    return path;
  }

  private onEvent(live: LiveRun, event: RuntimeEvent): void {
    if (this.stopping) return;
    try {
      this.handle(live, event);
    } catch (error) {
      // 状态写入失败（例如版本冲突）不能让执行器事件循环崩溃；记录后按失败收尾
      this.deps.log(`run ${live.run.id} event ${event.type} failed: ${errorText(error)}`);
      if (TERMINAL_EVENTS.has(event.type) && this.live.has(live.run.id)) this.finishBlocked(live, 'failed', '内部错误');
    }
  }

  private handle(live: LiveRun, event: RuntimeEvent): void {
    const { store } = this.deps;
    switch (event.type) {
      case 'thread':
        if (!store.runs.recordThread(live.run, event.threadId)) this.deps.log(`run ${live.run.id} 的 thread 与记录不符`);
        else live.run = { ...live.run, nativeThreadId: event.threadId };
        return;
      case 'turn': {
        const updated = store.runs.recordTurn(live.run.id, event.turnId);
        if (updated) live.run = { ...live.run, nativeTurnId: event.turnId };
        return this.publish(this.runTo(live, 'running'));
      }
      case 'output_delta':
        live.output += event.text;
        this.deps.publishEphemeral({ type: 'run.output_delta', runId: live.run.id, text: event.text });
        live.flushTimer ??= setTimeout(() => this.flushOutput(live), this.limits.outputCheckpointMs);
        return;
      case 'approval_request':
        return this.onApprovalRequest(live, event.request);
      case 'approval_withdrawn': {
        const approvalId = [...live.approvals].find(([, nativeId]) => nativeId === event.nativeRequestId)?.[0];
        const approval = approvalId && store.runs.getApproval(approvalId);
        if (!approval || approval.status !== 'pending') return;
        this.publish(store.runs.decideApproval(approval.id, approval.version, 'cancelled', 'policy').events);
        return this.forwardDecision(approval, 'deny');
      }
      case 'notice':
        return this.publish([store.runs.addNotice(live.run.id, event.code, event.detail)]);
      case 'completed':
        return this.background(this.finishSucceeded(live, event.finalMessage));
      case 'failed':
        return this.finishBlocked(live, 'failed', `执行失败：${event.message}`);
      case 'interrupted':
        return live.cancelRequested ? this.finishCancelled(live) : this.finishBlocked(live, 'interrupted', '执行被中断');
      case 'disconnected':
        return this.background(this.reconcile(live, event.message));
    }
  }

  private onApprovalRequest(live: LiveRun, request: RuntimeApprovalRequest): void {
    const change = this.deps.store.runs.requestApproval({
      runId: live.run.id,
      kind: request.kind,
      riskLevel: riskOf(request, live.worktree ?? ''),
      summary: request.summary,
      detail: request.reason ? `${request.detail ?? ''}\n理由（执行器自述）：${request.reason}`.trim() : (request.detail ?? null),
      cwd: request.cwd ?? null,
      nativeRequestId: request.nativeRequestId,
      ttlMs: this.limits.approvalTtlMs,
    });
    live.approvals.set(change.record.id, request.nativeRequestId);
    this.publish([...change.events, ...this.runTo(live, 'waiting_approval')]);
  }

  /** 流式输出只走临时事件；到检查点或 Run 结束时合并成一条持久消息。 */
  private flushOutput(live: LiveRun): void {
    clearTimeout(live.flushTimer);
    live.flushTimer = undefined;
    if (live.output === '' || !live.run.sessionId) return;
    const text = live.output;
    live.output = '';
    this.publish(this.deps.store.messages.append(live.run.sessionId, 'assistant', text, live.run.id).events);
  }

  /** Run 结束时的公共收尾：合并输出、取消仍挂起的审批（转告执行器）、让出并发名额。 */
  private settle(live: LiveRun, reason: string): PersistentEvent[] {
    this.flushOutput(live);
    const events: PersistentEvent[] = [];
    for (const approval of this.deps.store.runs.pendingApprovals(live.run.id)) {
      events.push(...this.deps.store.runs.decideApproval(approval.id, approval.version, 'cancelled', 'policy').events);
      const nativeId = live.approvals.get(approval.id);
      if (nativeId !== undefined) live.handle?.respondApproval(nativeId, 'cancel');
    }
    live.approvals.clear();
    this.deps.log(`run ${live.run.id} settled: ${reason}`);
    this.live.delete(live.run.id);
    queueMicrotask(() => this.dequeue());
    return events;
  }

  private dequeue(): void {
    while (!this.stopping && this.queue.length > 0 && this.live.size < this.limits.maxConcurrentRuns) {
      const next = this.queue.shift()!;
      this.background(this.launch(next.subtaskId, next.plan));
    }
  }

  private finishBlocked(live: LiveRun, runStatus: 'failed' | 'interrupted', reason: string): void {
    const { store } = this.deps;
    this.publish(
      store.transaction(() => [
        ...this.settle(live, reason),
        ...this.runTo(live, runStatus, reason),
        ...moveSubtask(store, live.subtask.id, 'blocked', reason).events,
        ...moveTask(store, live.subtask.taskId, 'blocked', reason),
      ]),
    );
  }

  private finishCancelled(live: LiveRun): void {
    const { store } = this.deps;
    this.publish(
      store.transaction(() => [
        ...this.settle(live, '用户取消'),
        ...this.runTo(live, 'cancelled', '用户取消'),
        ...moveSubtask(store, live.subtask.id, 'cancelled', '用户取消').events,
        ...moveTask(store, live.subtask.taskId, 'cancelled', '用户取消'),
      ]),
    );
  }

  /** turn 完成：Run 成功，收集证据后子任务进入待验收（不直接成功）。 */
  private async finishSucceeded(live: LiveRun, finalMessage: string | null): Promise<void> {
    const { store } = this.deps;
    this.publish(store.transaction(() => [...this.settle(live, 'completed'), ...this.runTo(live, 'succeeded')]));
    // 证据收集期间仍可取消（中止检查命令）；为此暂时留在 live 表中
    this.live.set(live.run.id, live);
    let result: NewRunResult;
    try {
      result = await this.collectEvidence(live, finalMessage);
    } catch (error) {
      result = this.emptyResult(live, finalMessage, `收集证据失败：${errorText(error)}`);
    }
    this.live.delete(live.run.id);
    if (this.stopping) return;
    const cancelled = live.cancelRequested;
    this.publish(
      store.transaction(() => [
        ...store.runs.saveResult(result).events,
        ...moveSubtask(store, live.subtask.id, cancelled ? 'cancelled' : 'review', cancelled ? '用户取消' : undefined).events,
        ...(cancelled ? moveTask(store, live.subtask.taskId, 'cancelled', '用户取消') : []),
      ]),
    );
    this.dequeue();
  }

  private emptyResult(live: LiveRun, finalMessage: string | null, diffStat: string | null): NewRunResult {
    return {
      runId: live.run.id,
      finalMessage,
      diffStat,
      checkStatus: 'error',
      checkExitCode: null,
      checkDurationMs: null,
      checkOutputRef: null,
    };
  }

  private async collectEvidence(live: LiveRun, finalMessage: string | null): Promise<NewRunResult> {
    const worktree = live.worktree!;
    const diffStat = await stageAndDiffStat(worktree, live.subtask.baseCommit ?? 'HEAD');
    const task = this.deps.store.tasks.getTask(live.subtask.taskId)!;
    const base = { runId: live.run.id, finalMessage, diffStat, checkExitCode: null, checkDurationMs: null, checkOutputRef: null };
    if (!task.checkCommand) return { ...base, checkStatus: 'not_configured' };
    // 用户在建任务时没有确认的命令不会运行
    if (!task.checkConfirmedAt) return { ...base, checkStatus: 'not_confirmed' };

    const outcome = await runCheck(task.checkCommand, {
      cwd: worktree,
      timeoutMs: this.limits.checkTimeoutMs,
      maxOutputBytes: this.limits.checkOutputMaxBytes,
      signal: live.check.signal,
    });
    const ref = `checks/${live.run.id}.log`;
    const dir = join(this.deps.dataRoot, 'artifacts', 'checks');
    mkdirSync(dir, { recursive: true });
    const note = outcome.truncated ? `\n\n[输出超过 ${this.limits.checkOutputMaxBytes} 字节，已截断]` : '';
    writeFileSync(join(this.deps.dataRoot, 'artifacts', ref), redact(outcome.output) + note, 'utf8');
    if (outcome.truncated) this.publish([this.deps.store.runs.addNotice(live.run.id, 'output_truncated', '检查命令输出已截断')]);
    return { ...base, checkStatus: outcome.status, checkExitCode: outcome.exitCode, checkDurationMs: outcome.durationMs, checkOutputRef: ref };
  }

  /**
   * 执行器断线：Run 进入「执行状态待确认」，挂起审批取消；然后只按这次 Run 记录的 turn 核对，
   * 有明确终态才更新；多次仍无法确认则转为 interrupted 交给用户，不猜测结果。
   */
  private async reconcile(live: LiveRun, message: string): Promise<void> {
    const { store } = this.deps;
    this.publish(
      store.transaction(() => {
        const events = this.runTo(live, 'unconfirmed', message);
        for (const approval of store.runs.pendingApprovals(live.run.id)) {
          events.push(...store.runs.decideApproval(approval.id, approval.version, 'cancelled', 'policy').events);
        }
        live.approvals.clear();
        return events;
      }),
    );
    const { nativeThreadId: threadId, nativeTurnId: turnId } = live.run;
    let check: TurnCheck = { status: 'not_found' };
    for (let attempt = 0; threadId && turnId && attempt < this.limits.confirmAttempts && !this.stopping; attempt++) {
      if (attempt > 0) await sleep(this.limits.confirmIntervalMs);
      check = await this.deps.runtime.checkTurn(threadId, turnId).catch((): TurnCheck => ({ status: 'not_found' }));
      if (check.status !== 'in_progress' && check.status !== 'not_found') break;
    }
    if (this.stopping) return;
    switch (check.status) {
      case 'completed':
        return this.finishSucceeded(live, check.finalMessage);
      case 'failed':
        return this.finishBlocked(live, 'failed', `执行失败：${check.message}`);
      case 'interrupted':
        return live.cancelRequested ? this.finishCancelled(live) : this.finishBlocked(live, 'interrupted', '执行被中断');
      default:
        return live.cancelRequested
          ? this.finishCancelled(live)
          : this.finishBlocked(live, 'interrupted', turnId ? '执行器断线，无法确认这一轮的结果' : '执行器在开始前断线');
    }
  }

  private expireApprovals(): void {
    for (const approval of this.deps.store.runs.expiredApprovals()) {
      try {
        this.publish(this.deps.store.runs.decideApproval(approval.id, approval.version, 'expired', 'policy').events);
        this.forwardDecision(approval, 'deny');
      } catch (error) {
        this.deps.log(`expire ${approval.id} failed: ${errorText(error)}`);
      }
    }
  }
}
