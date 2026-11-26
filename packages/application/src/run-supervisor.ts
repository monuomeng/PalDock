import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  RuntimeWrite,
  RuntimeEvent,
  RuntimeRun,
  StorePort,
  SubtaskRecord,
  SubtaskStatus,
  TaskRecord,
  TurnCheck,
} from '@paldock/contracts';
import { checkCapability, isAutoApproved, isGitWrite, isSensitivePath, outOfScope, P1_DEFAULTS, routeRead, taskKey, toLf, type ReadRoute } from '@paldock/domain';
import { isInside } from '@paldock/platform';
import { contentDigest } from './attribution.js';
import type { GitOpsService } from './git-ops.js';
import { runCheck } from './check-runner.js';
import {
  addWorktree,
  branchAndHead,
  branchCommit,
  changedFiles,
  commitStaged,
  git,
  gitDirOf,
  headCommit,
  indexTree,
  readHeadRef,
  snapshotTree,
  stageAndDiffStat,
  treeChangedFiles,
  workingDiffStat,
} from './git.js';
import { accessOf, runPolicy, worksInProject, type RunPolicy } from './project-policy.js';
import { redact } from './redact.js';
import { operationOf, riskOf } from './risk.js';
import type { McpGateway } from './mcp-gateway.js';
import { roleInstructions, roleTurnPrompt } from './prompts.js';
import { RoleSessionPool, type RoleSessionLease } from './role-sessions.js';
import { nodeOf } from './task-graph-scheduler.js';
import { moveSubtask, settleTask } from './transitions.js';
import { errorText as sharedErrorText } from './util.js';

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
  /** 角色会话轮换阈值（测试里调小）；缺省按 P3_DEFAULTS。 */
  roleSessionLimits?: { roleSessionMaxTurns: number; roleSessionMaxTokens: number };
  dataRoot: string;
  publish(events: PersistentEvent[]): void;
  publishEphemeral(event: EphemeralEvent): void;
  log(message: string): void;
  limits?: Partial<Limits>;
  /** 提交 / 推送 / 合并卡片（暂存区保护在 Run 结束时提出「保留 / 恢复」卡片）；缺省时只暂停、不出卡片（测试）。 */
  gitOps?: () => GitOpsService | undefined;
  /** 非敏感的项目外只读交给协调助手判断（2026-11-26 已定）；缺省时都交给你。 */
  coordinatorApprovals?: boolean;
}

/** 一次 Run 的提示词与原生会话：续做或退回重做时沿用 thread，重新开始时不带。 */
export interface RunPlan {
  prompt: string;
  /** 角色说明：只在新建原生会话时发（见 RunStartRequest.instructions）。 */
  instructions?: string;
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
  /** 待审批的写文件请求带的内容（批准后记成写入证据）。 */
  writeRequests: Map<string, RuntimeWrite[]>;
  /** 计划节点和审阅的 Run 占用的角色会话（P1 / P2 单子任务和协调助手没有）。 */
  lease: RoleSessionLease | undefined;
  /** 项目设置算出的隔离方式和审批严格度（2026-11-26 已定，项目级助手设置）。 */
  policy: RunPolicy;
  /** 这次 Run 在项目目录里干活（同一项目同一时刻只有一个）。 */
  inProject: boolean;
  /** 在项目目录里干活时，开始时的工作区快照（tree）和分支、HEAD；结束快照记下后清掉 startTree 以外的部分。 */
  snapshot: { startTree: string; branch: string | null; head: string; ended: boolean; index: string } | undefined;
  /** 分支保护：开始时 HEAD 的内容（`ref: refs/heads/x`）、git 目录、停止监视的函数；检测到切换后为真。 */
  guard: { headRef: string; gitDir: string; stop: () => void; tripped: boolean } | undefined;
  /** 审批合并展示：这次 Run 当前这一组的编号和开始时间。 */
  approvalGroup: { id: string; at: number } | undefined;
}

/** 角色会话池的键和池大小（角色的 maxConcurrency）。 */
interface PoolSlot {
  key: { workspaceId: string; role: string; executor: string };
  max: number;
}

const TERMINAL_EVENTS = new Set<RuntimeEvent['type']>(['completed', 'failed', 'interrupted', 'disconnected']);
const CANCELLED = '用户取消';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (error: unknown) => sharedErrorText(error, 500);

/**
 * 执行器监管：启动 Run、把执行器事件写成状态与事件、处理审批与取消、断线后按 turn 核对、
 * Run 结束后收集证据。确定性规则都在这里，模型说「完成」只会让子任务进入待命中（等用户继续或结束）。
 */
export class RunSupervisor {
  /** 按 subtaskId 索引：同一子任务同时最多一次 Run。 */
  private readonly live = new Map<string, LiveRun>();
  private readonly queue: { subtaskId: string; taskId: string; plan: RunPlan }[] = [];
  private readonly limits: Limits;
  /** 交给协调助手判断的审批的时限（停止时清掉）。 */
  private readonly routeTimers = new Set<ReturnType<typeof setTimeout>>();
  private expiryTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  /** 进行中的异步收尾（启动、证据收集、断线核对）；退出时等它们结束，避免在数据库关闭后写入。 */
  private readonly inflight = new Set<Promise<void>>();

  /** 角色会话池（2026-11-26 已定）：计划节点和审阅按（项目，角色，执行器）复用原生会话。 */
  readonly pool: RoleSessionPool;

  constructor(private readonly deps: SupervisorDeps) {
    this.limits = { ...P1_DEFAULTS, ...deps.limits };
    this.pool = new RoleSessionPool({
      store: deps.store,
      log: deps.log,
      archive: (executor, threadId) => this.adapter(executor)?.archiveThread?.(threadId),
      ...(deps.roleSessionLimits ? { limits: deps.roleSessionLimits } : {}),
    });
  }

  start(): void {
    this.pool.start();
    this.expiryTimer = setInterval(() => this.expireApprovals(), this.limits.expiryScanMs);
    this.expiryTimer.unref();
  }

  /** 正常退出：结束所有执行器进程树和检查命令；状态由存储层的恢复程序统一置为 interrupted。 */
  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.expiryTimer);
    for (const timer of this.routeTimers) clearTimeout(timer);
    this.routeTimers.clear();
    this.queue.length = 0;
    await Promise.all(
      [...this.live.values()].map(async (live) => {
        live.guard?.stop();
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
    if (this.hasRoom(subtask.taskId, subtaskId, plan)) this.background(this.launch(subtaskId, plan));
    else this.queue.push({ subtaskId, taskId: subtask.taskId, plan });
  }

  /** 全局、所在任务的并发，以及（用角色会话的 Run）这个角色的会话池都还有名额。 */
  private hasRoom(taskId: string, subtaskId: string, plan: RunPlan): boolean {
    if (this.live.size >= this.limits.maxConcurrentRuns) return false;
    let ofTask = 0;
    for (const live of this.live.values()) if (live.subtask.taskId === taskId) ofTask++;
    if (ofTask >= this.limits.maxRunsPerTask) return false;
    const slot = this.poolSlot(subtaskId, plan);
    if (slot && !this.pool.hasRoom(slot.key, slot.max)) return false;
    // 在项目目录里干活的 Run（当前工作区方式的计划节点与审阅、直接写入者、单人主会话）：同一个项目同一时刻只跑一个，其余排队；
    // 切了分支暂停写入时也不开始
    const project = this.projectOf(subtaskId, plan);
    if (project) {
      if (this.deps.store.tasks.getWorkspace(project)?.pausedReason) return false;
      for (const live of this.live.values()) if (live.task.workspaceId === project && live.inProject) return false;
    }
    return true;
  }

  /** 这次 Run 要不要占用项目目录（是的话返回项目 ID）。 */
  private projectOf(subtaskId: string, plan: RunPlan): string | undefined {
    const { store } = this.deps;
    const subtask = store.tasks.getSubtask(subtaskId);
    const task = subtask && store.tasks.getTask(subtask.taskId);
    if (!subtask || !task) return undefined;
    return this.occupiesProject(task, subtask, plan.review?.role ?? subtask.role, this.modeOf(task, plan)) ? task.workspaceId : undefined;
  }

  /**
   * 在项目目录里干活：当前工作区方式（或角色设成直接改）下计划节点的工作与审阅、单人模式直接改的主会话、单人模式改完后的审阅。
   * 团队模式的协调助手只读、不占用（不然它要等开发跑完才能回你话）；旧入口的单子任务始终在自己的 worktree 里。
   */
  private occupiesProject(task: TaskRecord, subtask: SubtaskRecord, role: string, mode: LiveRun['mode']): boolean {
    if (task.kind === 'conversation') return mode === 'review' || this.policyOf(task, subtask, role, mode).isolation === 'direct';
    if (!subtask.planId) return false;
    return worksInProject(this.deps.store, task.workspaceId, role) || this.policyOf(task, subtask, role, mode).isolation === 'direct';
  }

  private modeOf(task: TaskRecord, plan: RunPlan): LiveRun['mode'] {
    return plan.review ? 'review' : task.kind === 'conversation' ? 'conversation' : 'work';
  }

  /**
   * 这次 Run 的隔离与审批（项目设置）。「直接在项目目录里改」只用于计划节点和单人主会话：
   * 旧入口的单子任务（新建任务、/new）始终在自己的 worktree 里，它们的继续 / 结束都靠那个 worktree。
   */
  private policyOf(task: TaskRecord, subtask: SubtaskRecord | null, role: string, mode: LiveRun['mode']): RunPolicy {
    const policy = runPolicy(this.deps.store, task.workspaceId, role, mode);
    const single = mode === 'work' && task.kind !== 'conversation' && !(subtask?.planId ?? null);
    return single && policy.isolation === 'direct' ? { ...policy, isolation: 'worktree' } : policy;
  }

  /**
   * 这次 Run 用不用角色会话：计划节点的工作 Run 和审阅 Run 用；P1 / P2 的单子任务（续做沿用自己的会话）
   * 和协调助手（有自己的主会话）不用。
   */
  private poolSlot(subtaskId: string, plan: RunPlan): PoolSlot | undefined {
    const { store } = this.deps;
    const subtask = store.tasks.getSubtask(subtaskId);
    const task = subtask && store.tasks.getTask(subtask.taskId);
    // 审阅（含单人模式改完后的审阅）都用审阅助手的角色会话；工作 Run 只有计划节点用
    if (!subtask || !task || (!plan.review && (task.kind === 'conversation' || !subtask.planId))) return undefined;
    const role = plan.review?.role ?? subtask.role;
    const executor = this.executorOf(role, task, this.modeOf(task, plan), plan.review ? null : nodeOf(store, subtask)?.executor);
    const parsed = AgentRole.safeParse(role);
    const max = (parsed.success && store.agents.getProfile(parsed.data)?.maxConcurrency) || 1;
    return { key: { workspaceId: task.workspaceId, role, executor: executor.name }, max };
  }

  /**
   * 重启恢复：被中断的工作 Run 按原生会话查实这一轮其实已经完成，补记结果：
   * 子任务回到执行中（阻塞 → 排队 → 执行中），然后照常收集证据、进待验收（闸门接手）。
   */
  adoptCompleted(runId: string, finalMessage: string | null): void {
    const { store } = this.deps;
    const run = store.runs.getRun(runId);
    if (!run || run.status !== 'interrupted' || this.live.has(run.subtaskId)) return;
    const live = store.transaction(() => {
      const queued = moveSubtask(store, run.subtaskId, 'queued');
      const running = moveSubtask(store, run.subtaskId, 'running');
      const taskEvents = settleTask(store, running.record.taskId);
      this.publish([...queued.events, ...running.events, ...taskEvents]);
      const task = store.tasks.getTask(running.record.taskId)!;
      return this.track(run, running.record, task, running.record.role);
    });
    this.background(this.finishSucceeded(live, finalMessage));
  }

  /** 项目恢复写入后，把排着队的再推一次。 */
  kick(): void {
    queueMicrotask(() => this.dequeue());
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
    // 批准的写文件请求：内容记成写入证据
    const writes = live.writeRequests.get(nativeId);
    live.writeRequests.delete(nativeId);
    if (writes && decision === 'allow_once') this.recordWrites(live, writes);
    if (live.handle) live.handle.respondApproval(nativeId, decision);
    else live.pendingReplies.push([nativeId, decision]);
  }

  /** 助手的写入证据（路径统一成相对项目目录、`/` 分隔；项目目录外的不记）。 */
  private recordWrites(live: LiveRun, writes: readonly RuntimeWrite[]): void {
    if (!live.worktree) return;
    for (const write of writes) {
      const path = relative(live.worktree, resolve(live.worktree, write.path));
      if (!path || path.startsWith('..') || isAbsolute(path)) continue;
      // 整文件写入：记下写之前文件的样子，重放时据此确认助手是在它看到的内容上写的（期间有人改过就不算证据）
      const full = join(live.worktree, path);
      const beforeHash = write.kind === 'content' && write.beforeHash === undefined ? (existsSync(full) ? contentDigest(toLf(readFileSync(full, 'utf8'))) : 'absent') : (write.beforeHash ?? null);
      this.deps.store.git.addWrite({ runId: live.run.id, path: path.split(sep).join('/'), kind: write.kind, detail: write.detail, beforeHash });
    }
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
  adapter(name: string): RuntimeAdapter | undefined {
    const adapters = Object.values(this.deps.runtimes);
    return adapters.length === 1 ? adapters[0] : this.deps.runtimes[name];
  }

  /**
   * 子任务用哪个执行器：角色在项目里的执行器（项目覆盖优先）。只有一个适配器时直接用它。
   * 角色不在设置里（旧数据）时退回开发助手的设置。
   */
  private executorOf(roleName: string, task: TaskRecord, mode: LiveRun['mode'], override?: Executor | null): { name: string; access?: WorkspaceAccess; label: string } {
    const adapters = Object.values(this.deps.runtimes);
    if (adapters.length === 1) return { name: adapters[0]!.name, label: roleName };
    const parsed = AgentRole.safeParse(roleName);
    const role = parsed.success ? parsed.data : 'developer';
    const profile = this.deps.store.agents.getProfile(role)!;
    // 计划节点上指定的执行器（确认前可改）优先，其次单人模式的执行器、项目覆盖，最后角色默认
    // 只有主会话本身用单人设置；单人模式改完后的审阅（挂在对话任务上）照审阅角色的设置走
    const settings = mode === 'conversation' ? this.deps.store.projectSettings.get(task.workspaceId) : undefined;
    const solo = settings?.mode === 'solo';
    const name = override ?? (solo ? settings!.soloExecutor : null) ?? this.deps.store.agents.resolveExecutor(task.workspaceId, role) ?? profile.executor;
    // 能力检查按这次 Run 实际的隔离方式（只读按只读检查，其余按可写）
    const access = accessOf(this.policyOf(task, null, role, mode).isolation);
    return { name, access, label: solo ? '单人助手' : profile.displayName };
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
      executor = this.executorOf(role, task, this.modeOf(task, plan), plan.review ? null : nodeOf(store, moved.record)?.executor);
      const run = store.runs.createRun({
        subtaskId,
        sessionId,
        runtime: executor.name,
        ...(plan.threadId ? { nativeThreadId: plan.threadId } : {}),
        ...(plan.resumesRunId ? { resumesRunId: plan.resumesRunId } : {}),
        ...(plan.review ? { purpose: 'review' as const } : {}),
      });
      this.publish([...moved.events, ...taskEvents, ...run.events]);
      const tracked = this.track(run.record, moved.record, task, role);
      // 计划节点和审阅：占用一个角色会话（优先上次用过的原生会话），Run 沿用它的原生会话
      const slot = this.poolSlot(subtaskId, plan);
      if (slot) {
        tracked.lease = this.pool.acquire(slot.key, plan.threadId);
        tracked.run = store.runs.setRoleSession(tracked.run.id, tracked.lease.session.id, tracked.lease.session.nativeThreadId);
      }
      return tracked;
    });

    try {
      const runtime = await this.readyRuntime(executor);
      live.worktree = await this.ensureWorktree(live);
      live.handle = await this.startRuntime(runtime, live, plan);
    } catch (error) {
      if (this.stopping) return;
      const resumed = live.lease ? !!live.lease.session.nativeThreadId : !!plan.threadId;
      const reason = resumed ? `续做失败：${errorText(error)}` : `启动失败：${errorText(error)}`;
      if (resumed) this.publish([store.runs.addNotice(live.run.id, 'resume_failed', reason)]);
      return this.finishFailed(live, reason);
    }
    for (const [nativeId, decision] of live.pendingReplies.splice(0)) live.handle.respondApproval(nativeId, decision);
    if (this.stopping) return live.handle.dispose();
    if (live.cancelRequested) await live.handle.cancel();
  }

  /**
   * 启动执行器。用角色会话时：会话已有原生会话就续用（cwd 切到这一轮的 worktree，只发任务包），
   * 新会话首轮带角色说明和前一个会话留下的摘要；续用失败时换下这个会话，开新会话重试一次。
   */
  private async startRuntime(runtime: RuntimeAdapter, live: LiveRun, plan: RunPlan): Promise<RuntimeRun> {
    const { store } = this.deps;
    const mcpServer = this.mcpServerFor(live.run, live.role);
    const start = (request: { prompt: string; resumeThreadId?: string; instructions?: string }) =>
      runtime.start(
        {
          runId: live.run.id,
          cwd: live.worktree!,
          prompt: request.prompt,
          ...(request.resumeThreadId ? { resumeThreadId: request.resumeThreadId } : {}),
          ...(mcpServer ? { mcpServer } : {}),
          ...(request.instructions ? { instructions: request.instructions } : {}),
          ...(live.policy.isolation === 'readonly' ? { readOnly: true } : {}),
        },
        (event) => this.onEvent(live, event),
      );
    const lease = live.lease;
    if (!lease) {
      return start({ prompt: plan.prompt, ...(plan.threadId ? { resumeThreadId: plan.threadId } : {}), ...(plan.instructions ? { instructions: plan.instructions } : {}) });
    }
    const turn = (fresh: boolean) => {
      const project = store.tasks.getWorkspace(live.task.workspaceId)!;
      const profile = AgentRole.safeParse(live.role);
      const displayName = (profile.success && store.agents.getProfile(profile.data)?.displayName) || live.role;
      return {
        prompt: roleTurnPrompt({
          worktree: live.worktree!,
          packet: plan.prompt,
          inheritedSummary: fresh ? this.pool.inheritedSummary(live.lease!.session) : null,
          writeSummary: live.lease!.summaryTurn,
        }),
        ...(fresh ? { instructions: roleInstructions({ name: live.role, displayName }, project) } : { resumeThreadId: live.lease!.session.nativeThreadId! }),
      };
    };
    if (!lease.session.nativeThreadId) return start(turn(true));
    try {
      return await start(turn(false));
    } catch (error) {
      // 原生会话续不上（被删、执行器换了）：换下它，开新会话重试一次
      this.deps.log(`role session ${lease.session.id} resume failed, starting a new one: ${errorText(error)}`);
      this.publish([store.runs.addNotice(live.run.id, 'resume_failed', `角色会话续不上，换新会话：${errorText(error)}`)]);
      this.pool.abandon(lease);
      const slot = { workspaceId: lease.session.workspaceId, role: lease.session.role, executor: lease.session.executor };
      live.lease = this.pool.createFresh(slot);
      live.run = store.runs.setRoleSession(live.run.id, live.lease.session.id, null);
      return start(turn(true));
    }
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
      lease: undefined,
      policy: { isolation: 'worktree', approval: 'worktree_auto' },
      inProject: false,
      snapshot: undefined,
      guard: undefined,
      approvalGroup: undefined,
      writeRequests: new Map(),
    };
    live.policy = this.policyOf(task, subtask, role, live.mode);
    live.inProject = this.occupiesProject(task, subtask, role, live.mode);
    this.live.set(subtask.id, live);
    return live;
  }

  /**
   * 写入型子任务的 worktree 只建一次（数据根下，分支名小写），之后各次 Run 共用。
   * 任务编号取 12 位十六进制（48 位）；计划节点再加上节点键，同一任务的各节点互不干扰。
   */
  private async ensureWorktree(live: LiveRun): Promise<string> {
    const workspace = this.deps.store.tasks.getWorkspace(live.task.workspaceId)!;
    // 在项目目录里干活（当前工作区方式的计划节点与审阅、直接写入者、单人主会话）：工作目录就是项目根目录，不建 worktree，
    // 也不把它记成 worktree（记成 worktree 会被当成 PalDock 的目录清理）；记下开始前已有的改动，交付时不算进去
    const soloWorktree = live.task.kind === 'conversation' && this.deps.store.projectSettings.get(live.task.workspaceId).soloIsolation === 'worktree';
    if (live.inProject && !soloWorktree) {
      await this.startSnapshot(live, workspace.rootPath);
      return workspace.rootPath;
    }
    // 主会话（和单人模式改完后的审阅）：单人模式独立 worktree 时用那个长期的 worktree，其余在项目根目录里
    if (live.task.kind === 'conversation') {
      const settings = this.deps.store.projectSettings.get(live.task.workspaceId);
      const soloWorktree = settings.mode === 'solo' && settings.soloIsolation === 'worktree';
      if (live.mode === 'review') return soloWorktree && live.subtask.worktreePath ? live.subtask.worktreePath : workspace.rootPath;
      return soloWorktree ? this.soloWorktree(live, workspace.rootPath) : workspace.rootPath;
    }
    if (live.subtask.worktreePath) return live.subtask.worktreePath;
    const key = taskKey(live.task.id).slice(0, 12);
    // 运行中改计划时被替换的节点会建同名的新子任务：第 2 版起建的子任务带上版本号，不落进旧子任务的 worktree 和分支
    const revision = live.subtask.planId ? (this.deps.store.plans.getPlan(live.subtask.planId)?.revision ?? 1) : 1;
    const node = live.subtask.nodeKey ? `-${live.subtask.nodeKey}${revision > 1 ? `-r${revision}` : ''}` : '';
    const slug = `${key}${node}`;
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
   * 在项目目录里干活的 Run 开始时给工作区拍快照（2026-11-26 已定）：之后按两次快照的差算这次的改动，不动用户的暂存区。
   * 同时记下分支和 HEAD，供分支保护核对。
   */
  private async startSnapshot(live: LiveRun, repo: string): Promise<void> {
    const { branch, head } = await branchAndHead(repo);
    // 每轮开始前核对：同一任务上一轮在别的分支上，说明你中途切了分支，暂停，不在新分支上接着写
    const previous = this.deps.store.git.lastSnapshotOfTask(live.task.id);
    const resumedAt = this.deps.store.tasks.getWorkspace(live.task.workspaceId)?.resumedAt;
    if (previous && previous.branch !== branch && !(resumedAt && previous.createdAt <= resumedAt)) {
      const reason = `分支从 ${previous.branch ?? '分离 HEAD'} 变成了 ${branch ?? '分离 HEAD'}，已暂停这个项目的写入`;
      this.publish(this.deps.store.tasks.setPaused(live.task.workspaceId, reason).events);
      this.notifyBranch(live, reason, []);
      throw new Error(reason);
    }
    if (!branch) throw new Error('当前是分离 HEAD：请先切到一个分支再让助手改');
    // 暂存区保护（0.3.7）：记下开始时的暂存区；读不出来（比如有未解决的合并冲突）就不开始，不能当成「没变」
    const index = await indexTree(repo, join(this.deps.dataRoot, 'tmp')).catch((error: unknown) => {
      throw new Error(`${errorText(error)}；没法核对暂存区，先解决之后再让助手改`);
    });
    const startTree = await snapshotTree(repo, join(this.deps.dataRoot, 'tmp'));
    live.snapshot = { startTree, branch, head, ended: false, index };
    this.deps.store.git.startSnapshot({ runId: live.run.id, workspaceId: live.task.workspaceId, branch, head, startTree });
    this.watchBranch(live, repo);
  }

  /**
   * 分支保护（运行中）：监视 git 目录里的 HEAD（fs.watch 加每秒一次的轮询兜底，Windows 上 watch 可能漏事件）。
   * 切了分支：暂停这个项目的写入，中止检查命令、中断这一轮并结束执行器的进程树（含正在跑的测试），列出这段时间变动的文件告诉你。
   * 检测到之前已经启动的进程可能已经写了文件，无法撤销，只能报告。
   */
  private watchBranch(live: LiveRun, repo: string): void {
    const gitDir = gitDirOf(repo);
    const headRef = readHeadRef(gitDir);
    const check = () => {
      if (this.stopping || !live.guard || live.guard.tripped) return;
      if (readHeadRef(gitDir) !== live.guard.headRef) this.branchChanged(live, repo);
    };
    let watcher: FSWatcher | undefined;
    try {
      watcher = watch(gitDir, (_event, file) => {
        if (!file || String(file) === 'HEAD') check();
      });
      watcher.on('error', () => {});
    } catch {
      // 监视不了就只靠轮询
    }
    const timer = setInterval(check, this.limits.branchPollMs ?? 1000);
    timer.unref();
    live.guard = { headRef, gitDir, tripped: false, stop: () => (clearInterval(timer), watcher?.close()) };
  }

  /** 核对点（审批放行前、取证时）：分支变了就按切换处理。返回真表示已经变了。 */
  private branchMoved(live: LiveRun): boolean {
    if (!live.guard || !live.worktree) return false;
    if (!live.guard.tripped && readHeadRef(live.guard.gitDir) !== live.guard.headRef) this.branchChanged(live, live.worktree);
    return live.guard.tripped;
  }

  private branchChanged(live: LiveRun, repo: string): void {
    const guard = live.guard!;
    guard.tripped = true;
    const now = readHeadRef(guard.gitDir);
    const name = (ref: string) => ref.replace(/^ref: refs\/heads\//, '') || '（读不到）';
    const reason = `分支从 ${name(guard.headRef)} 变成了 ${name(now)}，已暂停这个项目的写入`;
    const detectedAt = Date.now();
    this.publish(this.deps.store.tasks.setPaused(live.task.workspaceId, reason).events);
    this.publish([this.deps.store.runs.addNotice(live.run.id, 'branch_changed', reason)]);
    live.check.abort();
    void live.handle?.cancel().catch(() => {});
    // 中断不一定能让执行器马上停：稍后结束整棵进程树
    setTimeout(() => void live.handle?.dispose().catch(() => {}), 2000).unref();
    // 这段时间变动的文件（含切换后已经写进去的，无法撤销）
    const start = live.snapshot?.startTree;
    // 记进进行中的收尾：退出时等它做完，免得在数据库关闭后写入
    this.background(
      (async () => {
        const changed = start ? await treeChangedFiles(repo, start, await snapshotTree(repo, join(this.deps.dataRoot, 'tmp'))).catch(() => []) : [];
        if (this.stopping) return;
        this.deps.log(`branch changed for run ${live.run.id} after ${Date.now() - detectedAt}ms; changed files: ${changed.join(', ')}`);
        this.notifyBranch(live, reason, changed);
      })(),
    );
  }

  /** 在这个项目的主会话里留一条通知（桌面「待我处理」和对话里都看得到，没人看时按规则发到手机）。 */
  private notifyBranch(live: LiveRun, reason: string, changed: readonly string[]): void {
    const session = this.deps.store.coordinator.mainSessions(live.task.workspaceId)[0];
    if (!session) return;
    const files = changed.length > 0 ? `\n这段时间工作区里变动的文件（切换前后都有可能，已经写入的无法撤销）：\n${changed.slice(0, 50).map((f) => `- ${f}`).join('\n')}` : '';
    const body = `${reason}。正在跑的执行已中断（含测试）。请在「项目」页选择「在新分支上继续」或「取消」。${files}`;
    this.publish(this.deps.store.coordinator.addNotice({ sessionId: session.sessionId, runId: live.run.id, kind: 'info', body }).events);
  }

  /** 结束快照（取证时、或 Run 结束时）；返回这段时间改动的文件。 */
  private async endSnapshot(live: LiveRun, repo: string): Promise<string[]> {
    if (!live.snapshot || live.snapshot.ended) return [];
    live.snapshot.ended = true;
    const endTree = await snapshotTree(repo, join(this.deps.dataRoot, 'tmp'));
    this.deps.store.git.endSnapshot(live.run.id, endTree);
    await this.checkIndex(live, repo);
    return treeChangedFiles(repo, live.snapshot.startTree, endTree);
  }

  /**
   * 暂存区保护（0.3.7）：这一轮结束时暂存区和开始时不一样（助手 git add 了、执行器沙箱里绕过了拦截，或你同时暂存了），
   * 暂停这个项目，提出「保留 / 恢复」卡片，默认不自动恢复。读不出暂存区时也暂停并照实说明，不当成「没变」。
   */
  private async checkIndex(live: LiveRun, repo: string): Promise<void> {
    const before = live.snapshot!.index;
    let after: string;
    try {
      after = await indexTree(repo, join(this.deps.dataRoot, 'tmp'));
    } catch (error) {
      const reason = `${errorText(error)}；没法核对这一轮有没有改动暂存区，已暂停这个项目的写入。处理好之后在「项目」页选择继续`;
      this.publish(this.deps.store.tasks.setPaused(live.task.workspaceId, reason).events);
      this.publish([this.deps.store.runs.addNotice(live.run.id, 'index_changed', reason)]);
      return;
    }
    if (after === before) return;
    const paths = (await git(repo, ['-c', 'core.quotepath=false', 'diff-tree', '-r', '--name-only', '-z', before, after])).split('\0').filter((f) => f !== '');
    this.deps.log(`index changed during run ${live.run.id}: ${paths.join(', ')}`);
    const gitOps = this.deps.gitOps?.();
    if (gitOps) gitOps.proposeIndexChange(live.task.workspaceId, live.run.id, before, after, paths);
    else this.publish(this.deps.store.tasks.setPaused(live.task.workspaceId, `这一轮里暂存区变了（${paths.join('、')}），已暂停`).events);
    this.publish([this.deps.store.runs.addNotice(live.run.id, 'index_changed', `这一轮里暂存区变了：${paths.slice(0, 20).join('、')}`)]);
  }

  /** 宿主自己改了暂存区（提交卡片、恢复卡片）：这个项目里正在跑的 Run 以现在的暂存区为准，免得结束时误报。 */
  async rebaseIndex(workspaceId: string): Promise<void> {
    for (const live of this.live.values()) {
      if (live.task.workspaceId !== workspaceId || !live.snapshot || live.snapshot.ended || !live.worktree) continue;
      live.snapshot.index = await indexTree(live.worktree, join(this.deps.dataRoot, 'tmp')).catch(() => live.snapshot!.index);
    }
  }

  /** 单人模式的独立 worktree：每个项目一个（`paldock/solo-<项目>`），第一次用时从项目 HEAD 建，之后一直用；改动留在那里由你合。 */
  private async soloWorktree(live: LiveRun, repo: string): Promise<string> {
    if (live.subtask.worktreePath) return live.subtask.worktreePath;
    const slug = `solo-${taskKey(live.task.workspaceId).slice(0, 12)}`;
    const path = join(this.deps.dataRoot, 'worktrees', slug);
    mkdirSync(join(this.deps.dataRoot, 'worktrees'), { recursive: true });
    const start = await addWorktree(repo, path, `${this.limits.branchPrefix}${slug}`, 'HEAD');
    const updated = this.deps.store.tasks.setWorktree(live.subtask.id, path, `${this.limits.branchPrefix}${slug}`, start);
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
        if (live.lease) this.pool.recordThread(live.lease, event.threadId);
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
        if (event.request.writes?.length) live.writeRequests.set(event.request.nativeRequestId, event.request.writes);
        return this.onApprovalRequest(live, event.request);
      case 'file_written':
        return this.recordWrites(live, event.writes);
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
    // 宿主直接放行（2026-11-25 / 11-26 已定：Windows 上可写角色「不隔离」，不逐条审批）：worktree 内的文件改动，
    // 以及 Claude 在 worktree 内跑的普通命令。Codex 的 workspace-write 沙箱本来就不会为这些来要审批，它来审批的命令
    // 都是要越过沙箱的，照旧审批；不认识的执行器同样按越过沙箱对待。规则见 domain 的 classifyCommand / isAutoApproved。
    // 协调助手的对话 Run 不自动放行。每次记一条审计。
    // 项目设置（2026-11-26 已定）：只读时写文件一律拒绝；审批严格度决定哪些由宿主直接放行。直接在项目目录里改时，工作目录就是项目目录。
    // 审批放行前核对分支：变了就不放行
    if (this.branchMoved(live)) return this.reply(live, request.nativeRequestId, 'deny');
    if (live.worktree) {
      const operation = operationOf(request, live.worktree);
      const actor = `run:${live.run.id}`;
      // 当前工作区方式：提交、推送、合并由你在对话里指挥（卡片确认），助手自己运行改仓库状态的 git 命令一律拒绝
      const current = this.deps.store.tasks.getWorkspace(live.task.workspaceId)?.workspaceMode === 'current';
      if (current && request.kind === 'command' && isGitWrite(request.command ?? '')) {
        this.deps.store.audit.append(actor, 'approval.auto', request.summary.slice(0, 200), 'deny:git_write');
        this.publish([this.deps.store.runs.addNotice(live.run.id, 'git_write_denied', `拒绝了助手自己运行的 git 命令：${(request.command ?? '').slice(0, 200)}`)]);
        return this.reply(live, request.nativeRequestId, 'deny');
      }
      if (live.policy.isolation === 'readonly' && request.kind === 'file_change') {
        this.deps.store.audit.append(actor, 'approval.auto', request.summary.slice(0, 200), 'deny:readonly');
        return this.reply(live, request.nativeRequestId, 'deny');
      }
      // 只读工具要读允许范围之外的路径：按分层处理（2026-11-26 已定），不走下面的通用放行规则
      if (request.readPaths?.length) {
        const route = this.readRoute(live, request.readPaths);
        if (route === 'inside' || route === 'own_output') {
          this.deps.store.audit.append(actor, 'approval.auto', request.summary.slice(0, 200), route === 'inside' ? 'allow:read' : 'allow:read_own_output');
          return this.reply(live, request.nativeRequestId, 'allow_once');
        }
        return this.askApproval(live, request, route);
      }
      const auto =
        live.policy.approval === 'high_only'
          ? riskOf(request, live.worktree) !== 'high'
          : live.policy.approval === 'worktree_auto' && isAutoApproved(operation, { commandsAreSandboxEscapes: live.run.runtime !== 'claude' });
      if (auto && !(live.policy.isolation === 'readonly' && operation === 'write_in_worktree')) {
        this.deps.store.audit.append(actor, 'approval.auto', request.summary.slice(0, 200), `allow:${operation}${live.policy.approval === 'worktree_auto' ? '' : `:${live.policy.approval}`}`);
        return this.reply(live, request.nativeRequestId, 'allow_once');
      }
    }
    this.askApproval(live, request, request.readPaths?.length ? 'user' : undefined);
  }

  /**
   * 记一条待审批。同一次 Run 在 approvalGroupMs 之内的审批归为一组（桌面一张卡、外部渠道一条消息），各项仍独立审计、独立过期。
   * 项目外只读：敏感路径高风险、只能你批；交给协调助手的先标上 routed_to，协调助手 coordinatorApprovalMs 内没答复就回到你这里。
   */
  private askApproval(live: LiveRun, request: RuntimeApprovalRequest, read: ReadRoute | undefined): void {
    const now = Date.now();
    if (!live.approvalGroup || now - live.approvalGroup.at > this.limits.approvalGroupMs) live.approvalGroup = { id: `grp_${randomUUID()}`, at: now };
    const change = this.deps.store.runs.requestApproval({
      runId: live.run.id,
      kind: request.kind,
      riskLevel: read ? (read === 'sensitive' ? 'high' : 'medium') : riskOf(request, live.worktree ?? ''),
      summary: request.summary,
      detail: request.reason ? `${request.detail ?? ''}\n理由（执行器自述）：${request.reason}`.trim() : (request.detail ?? null),
      cwd: request.cwd ?? null,
      nativeRequestId: request.nativeRequestId,
      ttlMs: this.limits.approvalTtlMs,
      access: read ? 'read' : null,
      sensitive: read === 'sensitive',
      groupId: live.approvalGroup.id,
      routedTo: read === 'coordinator' ? 'coordinator' : null,
    });
    live.approvals.set(change.record.id, request.nativeRequestId);
    if (read === 'coordinator') this.coordinatorDeadline(change.record.id);
    // 审批请求可能先于 turn 事件到达（Run 仍是 starting），先进入 running
    const started = live.run.status === 'starting' ? this.runTo(live, 'running') : [];
    this.publish([...change.events, ...started, ...this.runTo(live, 'waiting_approval')]);
  }

  /**
   * 项目外只读的分层：都在项目里、或都是这一轮生成的文件（创建时间不早于 Run 开始）→ 直接放行；
   * 有敏感路径 → 只能你批；发起读取的不是协调助手自己、项目有主会话 → 交协调助手判断；其余你批。路径按真实路径（跟随链接）判断。
   */
  private readRoute(live: LiveRun, paths: readonly string[]): ReadRoute {
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    const startMs = Date.parse(live.run.startedAt);
    const home = homedir();
    const isCoordinator = live.task.kind === 'conversation' || live.subtask.role === 'coordinator';
    return routeRead({
      paths,
      inside: (p) => isInside(live.worktree!, real(p)),
      sensitive: (p) => isSensitivePath(p, home, [this.deps.dataRoot]) || isSensitivePath(real(p), home, [this.deps.dataRoot]),
      createdThisRun: (p) => {
        try {
          return statSync(real(p)).birthtimeMs >= startMs;
        } catch {
          return false;
        }
      },
      coordinatorAvailable: (this.deps.coordinatorApprovals ?? false) && !isCoordinator && this.deps.store.coordinator.mainSessions(live.task.workspaceId).length > 0,
    });
  }

  /** 协调助手没在时限内答复：回到你这里（桌面和外部渠道照常提醒）。 */
  private coordinatorDeadline(approvalId: string): void {
    const timer = setTimeout(() => {
      this.routeTimers.delete(timer);
      if (this.stopping) return;
      const change = this.deps.store.runs.routeApproval(approvalId, null, `协调助手 ${Math.round(this.limits.coordinatorApprovalMs / 1000)} 秒内没有答复`);
      if (change) this.publish(change.events);
    }, this.limits.coordinatorApprovalMs);
    timer.unref();
    this.routeTimers.add(timer);
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
    live.guard?.stop();
    // 没取证的 Run（单人主会话、审阅、失败的）也记下结束快照，提交时据此找「这次的改动」
    if (live.snapshot && !live.snapshot.ended && live.worktree) {
      this.background(this.endSnapshot(live, live.worktree).then(() => undefined).catch((error) => this.deps.log(`end snapshot ${live.run.id} failed: ${errorText(error)}`)));
    }
    if (live.lease) {
      const usage = this.deps.store.runs.getUsage(live.run.id);
      const tokens = usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : 0;
      this.pool.release(live.lease, tokens);
      live.lease = undefined;
    }
    if (this.live.get(live.subtask.id) === live) this.live.delete(live.subtask.id);
    queueMicrotask(() => this.dequeue());
  }

  /** 按入队顺序启动还有名额的；所在任务已满的留在队里，不挡后面其他任务的。 */
  private dequeue(): void {
    for (let i = 0; !this.stopping && i < this.queue.length && this.live.size < this.limits.maxConcurrentRuns; ) {
      const next = this.queue[i]!;
      if (!this.hasRoom(next.taskId, next.subtaskId, next.plan)) {
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
    else this.finish(live, 'interrupted', 'blocked', live.guard?.tripped ? '分支变了，已暂停' : reason);
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
    if (live.mode === 'review') {
      // 单人模式改完后的审阅：结论作为一条消息出现在对话里（不卡流程）
      if (live.task.kind === 'conversation' && finalMessage && live.run.sessionId) {
        this.publish(store.messages.append(live.run.sessionId, 'assistant', `审阅助手：${finalMessage}`, live.run.id).events);
      }
      return this.release(live);
    }
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
    const node = nodeOf(this.deps.store, live.subtask);
    // 工作目录就是项目根目录（直接在项目目录里改）：那是用户自己的工作区，不暂存、不提交，按内容变化核对这次的改动
    const rootPath = this.deps.store.tasks.getWorkspace(live.task.workspaceId)!.rootPath;
    const inProject = resolve(worktree).toLowerCase() === resolve(rootPath).toLowerCase();
    const base: Omit<NewRunResult, 'checkStatus'> = this.resultBase(live, finalMessage, inProject ? await workingDiffStat(worktree) : await stageAndDiffStat(worktree, baseCommit));
    let check: { command: TaskRecord['checkCommand']; confirmed: boolean } = { command: live.task.checkCommand, confirmed: live.task.checkConfirmedAt !== null };
    if (inProject) {
      // 取证时核对分支（变了照样记下改动，但项目已暂停）
      this.branchMoved(live);
      base.commitSha = null;
      if (node) {
        const parsed = AgentRole.safeParse(live.subtask.role);
        const roleScope = parsed.success ? (this.deps.store.agents.getProfile(parsed.data)?.deliveryScope ?? []) : [];
        base.outOfScope = outOfScope(await this.endSnapshot(live, worktree), [...roleScope, ...node.paths]);
        check = { command: node.checkCommand, confirmed: true };
      }
    } else if (node) {
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
