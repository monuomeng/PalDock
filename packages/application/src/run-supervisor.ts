import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRole } from '@paldock/contracts';
import type {
  CheckCommand,
  McpServerSpec,
  Executor,
  WorkspaceAccess,
  ApprovalDecision,
  ApprovalRecord,
  EphemeralEvent,
  NewRunResult,
  PersistentEvent,
  RunRecord,
  RunStatus,
  RuntimeAdapter,
  RuntimeApprovalDecision,
  RuntimeApprovalRequest,
  RuntimeEvent,
  RuntimeRun,
  StorePort,
  SubtaskRecord,
  SubtaskStatus,
  TaskRecord,
  TurnCheck,
} from '@paldock/contracts';
import { checkCapability, outOfScope, P1_DEFAULTS, taskKey } from '@paldock/domain';
import { runCheck } from './check-runner.js';
import { addWorktree, branchCommit, changedFiles, commitStaged, headCommit, stageAndDiffStat } from './git.js';
import { redact } from './redact.js';
import { riskOf } from './risk.js';
import type { McpGateway } from './mcp-gateway.js';
import { nodeOf } from './task-graph-scheduler.js';
import { moveSubtask, settleTask } from './transitions.js';

export type Limits = typeof P1_DEFAULTS;

export interface SupervisorDeps {
  store: StorePort;
  /**
   * 各执行器的适配器，按名字（codex、claude）索引。子任务按角色在项目里的执行器选用（项目覆盖优先），
   * 启动前做能力检查；只有一个适配器时（测试、离线模拟）所有角色都用它，不做检查。
   */
  runtimes: Readonly<Record<string, RuntimeAdapter>>;
  /** MCP 桥：每次 Run 签发一次性令牌并把桥作为这次会话的 MCP 服务器注入；缺省时不注入（测试）。 */
  mcp?: { gateway: McpGateway; server(token: string): McpServerSpec };
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
  /**
   * 审阅 Run：在给定的审阅会话里以审阅角色运行，不改子任务状态（子任务停在 review），不收集证据；
   * 结论由审阅助手经 MCP 交，闸门在 Run 结束后处理。
   */
  review?: { sessionId: string; role: AgentRole };
}

/** 正在执行的 Run：内存里只放控制所需的东西，事实都在库里。 */
interface LiveRun {
  run: RunRecord;
  subtask: SubtaskRecord;
  /** 启动时读一次；检查命令等在 Run 期间不变。 */
  task: TaskRecord;
  /** 这次 Run 的角色：工作 Run 是子任务的角色，审阅 Run 是审阅助手。 */
  role: string;
  /**
   * work：子任务的工作 Run；review：审阅 Run（子任务停在 review）；conversation：协调助手主会话的 Run
   * （对话任务的子任务一直是草稿，工作目录是项目根目录，不收集证据）。后两种都不改子任务和任务的状态。
   */
  mode: 'work' | 'review' | 'conversation';
  /** 这次 Run 有过流式输出（没有时把最终回复记成一条消息）。 */
  spoke: boolean;
  worktree: string | undefined;
  handle: RuntimeRun | undefined;
  /** 拿到 handle 之前就要回复的审批（事件可能先于 start() 的返回值送达），拿到后补发。 */
  pendingReplies: [string, RuntimeApprovalDecision][];
  /** approvalId → 执行器请求 ID；回复时原样带回。 */
  approvals: Map<string, string>;
  output: string;
  flushTimer: NodeJS.Timeout | undefined;
  cancelRequested: boolean;
  check: AbortController;
}

const TERMINAL_EVENTS = new Set<RuntimeEvent['type']>(['completed', 'failed', 'interrupted', 'disconnected']);
const CANCELLED = '用户取消';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

/**
 * 执行器监管：启动 Run、把执行器事件写成状态与事件、处理审批与取消、断线后按 turn 核对、
 * Run 结束后收集证据。确定性规则都在这里，模型说「完成」只会让子任务进入待命中（等用户继续或结束）。
 */
export class RunSupervisor {
  /** 按 subtaskId 索引：同一子任务同时最多一次 Run。 */
  private readonly live = new Map<string, LiveRun>();
  private readonly queue: { subtaskId: string; taskId: string; plan: RunPlan }[] = [];
  private readonly limits: Limits;
  private expiryTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  /** 进行中的异步收尾（启动、证据收集、断线核对）；退出时等它们结束，避免在数据库关闭后写入。 */
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly deps: SupervisorDeps) {
    this.limits = { ...P1_DEFAULTS, ...deps.limits };
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

  /**
   * 调用方已把子任务置为 queued；全局或所在任务的并发已满时排队。
   * 同一子任务（也就是同一助手会话）同时只有一次 Run：已在执行或排队的再次入队会被忽略。
   */
  enqueue(subtaskId: string, plan: RunPlan): void {
    const subtask = this.deps.store.tasks.getSubtask(subtaskId);
    if (!subtask) return this.deps.log(`subtask ${subtaskId} 不存在`);
    if (this.live.has(subtaskId) || this.queue.some((q) => q.subtaskId === subtaskId)) return;
    if (this.hasRoom(subtask.taskId)) this.background(this.launch(subtaskId, plan));
    else this.queue.push({ subtaskId, taskId: subtask.taskId, plan });
  }

  private hasRoom(taskId: string): boolean {
    if (this.live.size >= this.limits.maxConcurrentRuns) return false;
    let ofTask = 0;
    for (const live of this.live.values()) if (live.subtask.taskId === taskId) ofTask++;
    return ofTask < this.limits.maxRunsPerTask;
  }

  /** 子任务有 Run 在执行或排队。 */
  isActive(subtaskId: string): boolean {
    return this.live.has(subtaskId) || this.queue.some((q) => q.subtaskId === subtaskId);
  }

  /** 取消正在执行或排队的 Run；不在这里的返回 false，由调用方直接改状态。 */
  cancel(subtaskId: string): boolean {
    const queued = this.queue.findIndex((q) => q.subtaskId === subtaskId);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      return false;
    }
    const live = this.live.get(subtaskId);
    if (!live) return false;
    live.cancelRequested = true;
    live.check.abort();
    void live.handle?.cancel().catch((error) => this.deps.log(`cancel failed: ${errorText(error)}`));
    return true;
  }

  /** 用户（或过期）已在库里决定审批，这里转告执行器。 */
  forwardDecision(approval: ApprovalRecord, decision: ApprovalDecision): void {
    const live = this.liveRun(approval.runId);
    const nativeId = live?.approvals.get(approval.id);
    if (!live || nativeId === undefined) return;
    this.releaseApproval(live, approval.id);
    this.reply(live, nativeId, decision);
  }

  private reply(live: LiveRun, nativeId: string, decision: RuntimeApprovalDecision): void {
    if (live.handle) live.handle.respondApproval(nativeId, decision);
    else live.pendingReplies.push([nativeId, decision]);
  }

  private liveRun(runId: string): LiveRun | undefined {
    for (const live of this.live.values()) if (live.run.id === runId) return live;
    return undefined;
  }

  /** 释放本地记录；没有挂起的审批后 Run 回到 running。 */
  private releaseApproval(live: LiveRun, approvalId: string): void {
    live.approvals.delete(approvalId);
    if (live.approvals.size === 0 && live.run.status === 'waiting_approval') this.publish(this.runTo(live, 'running'));
  }

  private background(work: Promise<void>): void {
    this.inflight.add(work);
    void work
      .catch((error) => this.deps.log(`background work failed: ${errorText(error)}`))
      .finally(() => this.inflight.delete(work));
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

  /** 按名字取适配器；记录里的执行器已不在（例如改了配置）时返回 undefined。 */
  private adapter(name: string): RuntimeAdapter | undefined {
    const adapters = Object.values(this.deps.runtimes);
    return adapters.length === 1 ? adapters[0] : this.deps.runtimes[name];
  }

  /**
   * 子任务用哪个执行器：角色在项目里的执行器（项目覆盖优先）。只有一个适配器时直接用它。
   * 角色不在设置里（旧数据）时退回开发助手的设置。
   */
  private executorOf(roleName: string, task: TaskRecord): { name: string; access?: WorkspaceAccess; label: string } {
    const adapters = Object.values(this.deps.runtimes);
    if (adapters.length === 1) return { name: adapters[0]!.name, label: roleName };
    const parsed = AgentRole.safeParse(roleName);
    const role = parsed.success ? parsed.data : 'developer';
    const profile = this.deps.store.agents.getProfile(role)!;
    const name = this.deps.store.agents.resolveExecutor(task.workspaceId, role) ?? profile.executor;
    return { name, access: profile.workspaceAccess, label: profile.displayName };
  }

  /** 给这次 Run 签发 MCP 令牌（有效期为角色的单次时长上限再加 10 分钟），返回要注入的服务器。 */
  private mcpServerFor(run: RunRecord, roleName: string): McpServerSpec | undefined {
    const parsed = AgentRole.safeParse(roleName);
    if (!this.deps.mcp || !parsed.success) return undefined;
    const minutes = (this.deps.store.agents.getProfile(parsed.data)?.maxRunMinutes ?? 60) + 10;
    return this.deps.mcp.server(this.deps.mcp.gateway.issue(run.id, parsed.data, minutes * 60_000));
  }

  /** 启动前的能力检查（只在多执行器时做）；不满足时抛出原因，按启动失败处理。 */
  private async readyRuntime(executor: { name: string; access?: WorkspaceAccess; label: string }): Promise<RuntimeAdapter> {
    const runtime = this.adapter(executor.name);
    if (!runtime) throw new Error(`没有名为 ${executor.name} 的执行器`);
    if (!executor.access) return runtime;
    const check = checkCapability(executor.access, executor.name as Executor, await runtime.discover());
    if (!check.ok) throw new Error(`${executor.label}不能用 ${executor.name}：${check.problems.join('；')}`);
    return runtime;
  }

  private async launch(subtaskId: string, plan: RunPlan): Promise<void> {
    const { store } = this.deps;
    const sessionId = plan.review?.sessionId ?? store.tasks.getSessionOfSubtask(subtaskId)?.id;
    if (!sessionId) return this.deps.log(`subtask ${subtaskId} 没有会话`);
    let executor!: ReturnType<RunSupervisor['executorOf']>;
    const live = store.transaction(() => {
      // 审阅 Run 和主会话 Run 不改子任务和任务的状态（子任务停在 review / 对话任务的子任务一直是草稿）
      const current = store.tasks.getSubtask(subtaskId)!;
      const detached = plan.review !== undefined || store.tasks.getTask(current.taskId)?.kind === 'conversation';
      const moved = detached ? { record: current, events: [] } : moveSubtask(store, subtaskId, 'running');
      const taskEvents = detached ? [] : settleTask(store, moved.record.taskId);
      const task = store.tasks.getTask(moved.record.taskId)!;
      const role = plan.review?.role ?? moved.record.role;
      executor = this.executorOf(role, task);
      const run = store.runs.createRun({
        subtaskId,
        sessionId,
        runtime: executor.name,
        ...(plan.threadId ? { nativeThreadId: plan.threadId } : {}),
        ...(plan.resumesRunId ? { resumesRunId: plan.resumesRunId } : {}),
        ...(plan.review ? { purpose: 'review' as const } : {}),
      });
      this.publish([...moved.events, ...taskEvents, ...run.events]);
      return this.track(run.record, moved.record, task, role);
    });

    try {
      const runtime = await this.readyRuntime(executor);
      live.worktree = await this.ensureWorktree(live);
      const mcpServer = this.mcpServerFor(live.run, live.role);
      live.handle = await runtime.start(
        {
          runId: live.run.id,
          cwd: live.worktree,
          prompt: plan.prompt,
          ...(plan.threadId ? { resumeThreadId: plan.threadId } : {}),
          ...(mcpServer ? { mcpServer } : {}),
        },
        (event) => this.onEvent(live, event),
      );
    } catch (error) {
      if (this.stopping) return;
      const reason = plan.threadId ? `续做失败：${errorText(error)}` : `启动失败：${errorText(error)}`;
      if (plan.threadId) this.publish([store.runs.addNotice(live.run.id, 'resume_failed', reason)]);
      return this.finishFailed(live, reason);
    }
    for (const [nativeId, decision] of live.pendingReplies.splice(0)) live.handle.respondApproval(nativeId, decision);
    if (this.stopping) return live.handle.dispose();
    if (live.cancelRequested) await live.handle.cancel();
  }

  private track(run: RunRecord, subtask: SubtaskRecord, task: TaskRecord, role: string): LiveRun {
    const live: LiveRun = {
      run,
      subtask,
      task,
      role,
      mode: run.purpose === 'review' ? 'review' : task.kind === 'conversation' ? 'conversation' : 'work',
      spoke: false,
      worktree: subtask.worktreePath ?? undefined,
      handle: undefined,
      pendingReplies: [],
      approvals: new Map(),
      output: '',
      flushTimer: undefined,
      cancelRequested: false,
      check: new AbortController(),
    };
    this.live.set(subtask.id, live);
    return live;
  }

  /**
   * 写入型子任务的 worktree 只建一次（数据根下，分支名小写），之后各次 Run 共用。
   * 任务编号取 12 位十六进制（48 位）；计划节点再加上节点键，同一任务的各节点互不干扰。
   */
  private async ensureWorktree(live: LiveRun): Promise<string> {
    if (live.subtask.worktreePath) return live.subtask.worktreePath;
    const workspace = this.deps.store.tasks.getWorkspace(live.task.workspaceId)!;
    // 协调助手只读：在项目根目录里看代码和文档，不建 worktree
    if (live.mode === 'conversation') return workspace.rootPath;
    const key = taskKey(live.task.id).slice(0, 12);
    const slug = live.subtask.nodeKey ? `${key}-${live.subtask.nodeKey}` : key;
    const path = join(this.deps.dataRoot, 'worktrees', slug);
    const branch = `${this.limits.branchPrefix}${slug}`;
    const base = await this.worktreeBase(live.task, workspace.rootPath);
    mkdirSync(join(this.deps.dataRoot, 'worktrees'), { recursive: true });
    const start = await addWorktree(workspace.rootPath, path, branch, base);
    const updated = this.deps.store.tasks.setWorktree(live.subtask.id, path, branch, start);
    if (updated) live.subtask = updated;
    return path;
  }

  /**
   * 新任务从项目 HEAD 出发；接续的任务从来源任务的分支出发（包含它提交的改动）；
   * 按计划拆分的任务从集成分支当时的最新提交出发（上游合进去的改动下游都看得到）。
   */
  private async worktreeBase(task: TaskRecord, repo: string): Promise<string> {
    const integration = task.integrationBranch;
    if (integration) {
      return branchCommit(repo, integration).catch(() => {
        throw new Error(`任务集成分支 ${integration} 已不存在（可能已被删除），无法创建 worktree`);
      });
    }
    const source = task.continuedFromTaskId ? this.deps.store.tasks.getSubtaskOfTask(task.continuedFromTaskId) : undefined;
    if (!source?.branch) {
      return headCommit(repo).catch(() => {
        throw new Error('项目还没有任何提交，无法创建 worktree');
      });
    }
    const branch = source.branch;
    return branchCommit(repo, branch).catch(() => {
      throw new Error(`接续的任务分支 ${branch} 已不存在（可能已被删除），无法创建 worktree`);
    });
  }

  private onEvent(live: LiveRun, event: RuntimeEvent): void {
    if (this.stopping) return;
    try {
      this.handle(live, event);
    } catch (error) {
      // 状态写入失败（例如版本冲突）不能让执行器事件循环崩溃；记录后按失败收尾
      this.deps.log(`run ${live.run.id} event ${event.type} failed: ${errorText(error)}`);
      if (TERMINAL_EVENTS.has(event.type) && this.live.get(live.subtask.id) === live) this.finish(live, 'failed', 'blocked', '内部错误');
    }
  }

  private handle(live: LiveRun, event: RuntimeEvent): void {
    const { store } = this.deps;
    switch (event.type) {
      case 'thread':
        if (store.runs.recordThread(live.run, event.threadId)) live.run = { ...live.run, nativeThreadId: event.threadId };
        else this.deps.log(`run ${live.run.id} 的 thread 与记录不符`);
        return;
      case 'turn':
        if (store.runs.recordTurn(live.run.id, event.turnId)) live.run = { ...live.run, nativeTurnId: event.turnId };
        // 早到的审批可能已让 Run 进入 waiting_approval，此时不回退
        return this.publish(live.run.status === 'starting' ? this.runTo(live, 'running') : []);
      case 'output_delta':
        live.spoke = true;
        live.output += event.text;
        this.deps.publishEphemeral({ type: 'run.output_delta', runId: live.run.id, text: event.text });
        live.flushTimer ??= setTimeout(() => this.flushOutput(live), this.limits.outputCheckpointMs);
        return;
      case 'approval_request':
        return this.onApprovalRequest(live, event.request);
      case 'approval_withdrawn':
        return this.onApprovalWithdrawn(live, event.nativeRequestId);
      case 'notice':
        return this.publish([store.runs.addNotice(live.run.id, event.code, event.detail)]);
      case 'completed':
        if (event.usage) store.runs.recordUsage(live.run.id, { ...event.usage, costUsd: event.usage.costUsd ?? null });
        return this.background(this.finishSucceeded(live, event.finalMessage));
      case 'failed':
        if (event.usage) store.runs.recordUsage(live.run.id, { ...event.usage, costUsd: event.usage.costUsd ?? null });
        return this.finishFailed(live, `执行失败：${event.message}`);
      case 'interrupted':
        return this.finishInterrupted(live, '执行被中断');
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
    // 审批请求可能先于 turn 事件到达（Run 仍是 starting），先进入 running
    const started = live.run.status === 'starting' ? this.runTo(live, 'running') : [];
    this.publish([...change.events, ...started, ...this.runTo(live, 'waiting_approval')]);
  }

  /** 执行器自己收回了请求：审批置为 cancelled，不再回复执行器。 */
  private onApprovalWithdrawn(live: LiveRun, nativeRequestId: string): void {
    for (const [approvalId, nativeId] of live.approvals) {
      if (nativeId !== nativeRequestId) continue;
      const approval = this.deps.store.runs.getApproval(approvalId);
      if (approval?.status === 'pending') {
        this.publish(this.deps.store.runs.decideApproval(approval.id, approval.version, 'cancelled', 'policy').events);
      }
      return this.releaseApproval(live, approvalId);
    }
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

  /**
   * 取消这次 Run 仍挂起的审批（一条 UPDATE）并让 Run 回到 running；respond 为真时同时回复执行器 cancel。
   * Run 不会在审批挂起时直接进入终态。
   */
  private closeApprovals(live: LiveRun, respond: boolean): PersistentEvent[] {
    if (live.approvals.size === 0 && live.run.status !== 'waiting_approval') return [];
    if (respond) for (const nativeId of live.approvals.values()) this.reply(live, nativeId, 'cancel');
    live.approvals.clear();
    return [...this.deps.store.runs.cancelPendingApprovals(live.run.id).events, ...this.runTo(live, 'running')];
  }

  /** 让出并发名额（Run 与证据收集都结束后调用一次）。 */
  private release(live: LiveRun): void {
    this.deps.mcp?.gateway.revoke(live.run.id);
    if (this.live.get(live.subtask.id) === live) this.live.delete(live.subtask.id);
    queueMicrotask(() => this.dequeue());
  }

  /** 按入队顺序启动还有名额的；所在任务已满的留在队里，不挡后面其他任务的。 */
  private dequeue(): void {
    for (let i = 0; !this.stopping && i < this.queue.length && this.live.size < this.limits.maxConcurrentRuns; ) {
      const next = this.queue[i]!;
      if (!this.hasRoom(next.taskId)) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.background(this.launch(next.subtaskId, next.plan));
    }
  }

  /** Run 结束的公共收尾：合并输出、取消挂起审批，Run、子任务、任务同一事务进入各自的状态。 */
  private finish(live: LiveRun, runStatus: RunStatus, subtaskStatus: SubtaskStatus, reason: string): void {
    // 每次 Run 只收尾一次（启动失败与断线核对可能先后到达）
    if (this.live.get(live.subtask.id) !== live) return;
    const { store } = this.deps;
    this.flushOutput(live);
    // 审阅 Run 失败或被中断时子任务仍停在 review，由闸门交给人，只有取消任务才连带取消子任务；主会话的 Run 从不改子任务
    const touchSubtask = live.mode === 'work' || (live.mode === 'review' && subtaskStatus === 'cancelled');
    this.publish(
      store.transaction(() => [
        ...this.closeApprovals(live, true),
        ...this.runTo(live, runStatus, reason),
        ...(touchSubtask ? [...moveSubtask(store, live.subtask.id, subtaskStatus, reason).events, ...settleTask(store, live.subtask.taskId, reason)] : []),
      ]),
    );
    this.deps.log(`run ${live.run.id} finished: ${runStatus}（${reason}）`);
    this.release(live);
  }

  /** 中断：用户要求的算取消，否则阻塞等用户选择恢复、重新开始或放弃。 */
  private finishInterrupted(live: LiveRun, reason: string): void {
    if (live.cancelRequested) this.finish(live, 'cancelled', 'cancelled', CANCELLED);
    else this.finish(live, 'interrupted', 'blocked', reason);
  }

  /** 失败：用户已要求取消的仍记为取消，否则阻塞。 */
  private finishFailed(live: LiveRun, reason: string): void {
    if (live.cancelRequested) this.finish(live, 'cancelled', 'cancelled', CANCELLED);
    else this.finish(live, 'failed', 'blocked', reason);
  }

  /** turn 完成：Run 成功，收集证据后子任务进入待命中（不直接成功）。证据收集期间仍占用名额、仍可取消。 */
  private async finishSucceeded(live: LiveRun, finalMessage: string | null): Promise<void> {
    if (this.live.get(live.subtask.id) !== live || live.run.status === 'succeeded') return;
    const { store } = this.deps;
    this.flushOutput(live);
    // 执行器在 turn 事件之前就报了完成（没收到 turn 时 Run 还在 starting）：先补进 running 再成功
    this.publish(
      store.transaction(() => [...this.closeApprovals(live, false), ...(live.run.status === 'starting' ? this.runTo(live, 'running') : []), ...this.runTo(live, 'succeeded')]),
    );
    // 审阅 Run 没有自己的证据：结论已经由审阅助手经 MCP 交了，闸门按 Run 结束的事件处理
    if (live.mode === 'review') return this.release(live);
    // 主会话：回复就是消息（流式输出已在上面合并；执行器只给了最终回复时补记一条），唤醒循环按 Run 结束的事件收尾
    if (live.mode === 'conversation') {
      if (!live.spoke && finalMessage && live.run.sessionId) this.publish(store.messages.append(live.run.sessionId, 'assistant', finalMessage, live.run.id).events);
      return this.release(live);
    }
    const result = await this.collectEvidence(live, finalMessage).catch((error) => ({
      ...this.resultBase(live, finalMessage, `收集证据失败：${errorText(error)}`),
      checkStatus: 'error' as const,
    }));
    // 退出时检查命令已被中止（记为 cancelled），仍照常保存证据并进入待命中，不让子任务停在「执行中」
    const cancelled = live.cancelRequested && !this.stopping;
    this.publish(
      store.transaction(() => [
        ...store.runs.saveResult(result).events,
        ...moveSubtask(store, live.subtask.id, cancelled ? 'cancelled' : 'review', cancelled ? CANCELLED : undefined).events,
        ...settleTask(store, live.subtask.taskId, cancelled ? CANCELLED : undefined),
      ]),
    );
    this.release(live);
  }

  private resultBase(live: LiveRun, finalMessage: string | null, diffStat: string | null) {
    return { runId: live.run.id, finalMessage, diffStat, checkExitCode: null, checkDurationMs: null, checkOutputRef: null };
  }

  /**
   * 证据：改动统计和检查命令的结果。计划节点还要把改动提交到节点分支（检查与审阅都针对这个 SHA），
   * 并对照交付范围（角色的交付范围 ∪ 节点路径）列出越界的文件；检查命令用节点的（随计划确认）。
   */
  private async collectEvidence(live: LiveRun, finalMessage: string | null): Promise<NewRunResult> {
    const worktree = live.worktree!;
    const baseCommit = live.subtask.baseCommit ?? 'HEAD';
    const base: Omit<NewRunResult, 'checkStatus'> = this.resultBase(live, finalMessage, await stageAndDiffStat(worktree, baseCommit));
    const node = nodeOf(this.deps.store, live.subtask);
    let check: { command: TaskRecord['checkCommand']; confirmed: boolean } = { command: live.task.checkCommand, confirmed: live.task.checkConfirmedAt !== null };
    if (node) {
      await commitStaged(worktree, `paldock: ${node.title}`);
      const sha = await headCommit(worktree);
      const parsed = AgentRole.safeParse(live.subtask.role);
      const roleScope = parsed.success ? (this.deps.store.agents.getProfile(parsed.data)?.deliveryScope ?? []) : [];
      base.commitSha = sha;
      base.outOfScope = outOfScope(await changedFiles(worktree, baseCommit, sha), [...roleScope, ...node.paths]);
      check = { command: node.checkCommand, confirmed: true };
    }
    const checkCommand = check.command;
    if (!checkCommand) return { ...base, checkStatus: 'not_configured' };
    // 用户在建任务时没有确认的命令不会运行
    if (!check.confirmed) return { ...base, checkStatus: 'not_confirmed' };

    // 计划节点的 worktree 第一次跑检查前先跑项目的准备命令（例如安装依赖），之后各次 Run 共用
    const prepare = node && !live.subtask.preparedAt ? this.deps.store.tasks.getWorkspace(live.task.workspaceId)?.prepareCommand : null;
    if (prepare) {
      const prepared = await this.runLogged(live, prepare, worktree, `checks/${live.run.id}.prepare.log`);
      if (prepared.status !== 'passed') {
        return { ...base, prepareStatus: prepared.status, checkStatus: 'error', checkExitCode: prepared.exitCode, checkDurationMs: prepared.durationMs, checkOutputRef: prepared.ref };
      }
      this.deps.store.tasks.markPrepared(live.subtask.id);
      base.prepareStatus = 'passed';
    }
    const outcome = await this.runLogged(live, checkCommand, worktree, `checks/${live.run.id}.log`);
    return { ...base, checkStatus: outcome.status, checkExitCode: outcome.exitCode, checkDurationMs: outcome.durationMs, checkOutputRef: outcome.ref };
  }

  /** 跑一条命令（检查或准备），脱敏后的输出写到 artifacts/ 下。 */
  private async runLogged(live: LiveRun, command: CheckCommand, cwd: string, ref: string) {
    const outcome = await runCheck(command, { cwd, timeoutMs: this.limits.checkTimeoutMs, maxOutputBytes: this.limits.checkOutputMaxBytes, signal: live.check.signal });
    mkdirSync(join(this.deps.dataRoot, 'artifacts', 'checks'), { recursive: true });
    const note = outcome.truncated ? `\n\n[输出超过 ${this.limits.checkOutputMaxBytes} 字节，已截断]` : '';
    writeFileSync(join(this.deps.dataRoot, 'artifacts', ref), redact(outcome.output) + note, 'utf8');
    if (outcome.truncated) this.publish([this.deps.store.runs.addNotice(live.run.id, 'output_truncated', '命令输出已截断')]);
    return { ...outcome, ref };
  }

  /**
   * 执行器断线：Run 进入「执行状态待确认」，挂起审批取消；然后只按这次 Run 记录的 turn 核对，
   * 有明确终态才更新；多次仍无法确认则转为 interrupted 交给用户，不猜测结果。
   */
  private async reconcile(live: LiveRun, message: string): Promise<void> {
    this.publish(this.deps.store.transaction(() => [...this.closeApprovals(live, false), ...this.runTo(live, 'unconfirmed', message)]));
    const check = await this.pollTurn(live.run);
    if (this.stopping) return;
    switch (check.status) {
      case 'completed':
        return this.finishSucceeded(live, check.finalMessage);
      case 'failed':
        return this.finishFailed(live, `执行失败：${check.message}`);
      case 'interrupted':
        return this.finishInterrupted(live, '执行被中断');
      default:
        return this.finishInterrupted(live, live.run.nativeTurnId ? '执行器断线，无法确认这一轮的结果' : '执行器在开始前断线');
    }
  }

  /** 按 thread + turn 核对，in_progress / not_found 时按间隔重试；没有 turn ID 直接视为无法确认。 */
  private async pollTurn(run: RunRecord): Promise<TurnCheck> {
    const { nativeThreadId: threadId, nativeTurnId: turnId } = run;
    let check: TurnCheck = { status: 'not_found' };
    for (let attempt = 0; threadId && turnId && attempt < this.limits.confirmAttempts && !this.stopping; attempt++) {
      if (attempt > 0) await sleep(this.limits.confirmIntervalMs);
      const adapter = this.adapter(run.runtime);
      check = adapter ? await adapter.checkTurn(threadId, turnId).catch((): TurnCheck => ({ status: 'not_found' })) : check;
      if (check.status !== 'in_progress' && check.status !== 'not_found') break;
    }
    return check;
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
