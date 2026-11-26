import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  CodedError,
  type AutoPolicy,
  type ApprovalChannel,
  type ApprovalDecision,
  type CheckCommand,
  type PersistentEvent,
  type PlanDetail,
  type PlanRecord,
  type RemoteApprovalLevel,
  type ReviewDecision,
  type RunRecord,
  type StorePort,
  type SubtaskRecord,
  type TaskActions,
  type TaskDetail,
  type TaskRecord,
  type TaskSummary,
  type WorkspaceRecord,
} from '@paldock/contracts';
import { subtaskMachine, taskMachine } from '@paldock/domain';
import { isInside, isSystemDirectory, samePath } from '@paldock/platform';
import { commitStaged, headCommit, repositoryRoot } from './git.js';
import { continuationPrompt, firstRunPrompt, nextStepPrompt, resumePrompt, titleOf } from './prompts.js';
import type { RunSupervisor } from './run-supervisor.js';
import { executorOfRole } from './agent-service.js';
import type { IntegrationService } from './integration.js';
import type { TaskGraphScheduler } from './task-graph-scheduler.js';
import { requireSubtask, settleTask } from './transitions.js';

export interface CreateTaskInput {
  /** 新任务的项目目录；接续任务时不填，项目取自来源任务。 */
  rootPath?: string | undefined;
  goal: string;
  check?: CheckCommand | undefined;
  checkConfirmed: boolean;
  idempotencyKey: string;
  /** 从外部渠道建任务时的来源会话，结果回发到这里。 */
  originConversationId?: string;
  /** 基于这个已结束的任务继续：同一项目，worktree 从它的分支出发。 */
  continuedFromTaskId?: string | undefined;
}

export interface TaskServiceDeps {
  store: StorePort;
  supervisor: RunSupervisor;
  /** 计划子任务重新开始时用节点的提示词；缺省时（测试）按任务目标。 */
  scheduler?: TaskGraphScheduler;
  /** 计划节点人工通过时合进任务集成分支；缺省时（测试）直接成功。 */
  integration?: IntegrationService;
  dataRoot: string;
  publish(events: PersistentEvent[]): void;
}

/** P1 只有开发助手一个角色。 */
const DEVELOPER = 'developer';

/** 真实路径（解开符号链接与 8.3 短名）；路径不存在时退回 resolve。 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** 被中断且有原生会话的 Run 才能续做（新 Run 指回它、沿用同一 thread）。 */
function resumePlan(latest: RunRecord | undefined): { threadId: string; resumesRunId: string } | undefined {
  return latest?.status === 'interrupted' && latest.nativeThreadId ? { threadId: latest.nativeThreadId, resumesRunId: latest.id } : undefined;
}

/** 已结束且建过 worktree 的任务，分支上有它的结果，可以基于它新建任务继续。 */
const canContinueFrom = (subtask: SubtaskRecord) => subtask.status === 'succeeded' && subtask.branch !== null;

const CANCELLED = '用户取消';
/** 子任务已经结束、取消任务时不再动它（failed 在子任务状态机里还能重新排队，但取消不碰它）。 */
const isFinished = (subtask: SubtaskRecord) => subtask.status === 'succeeded' || subtask.status === 'failed' || subtask.status === 'cancelled';

/**
 * 当前允许的用户操作；界面只按它显示按钮，规则只在这里一处。计划子任务不能单独取消或被接续。
 * busy：子任务有 Run 在跑或排队（审阅中）；这时不能人工通过或退回，等这一轮结束。
 */
function actionsOf(subtask: SubtaskRecord, latest: RunRecord | undefined, busy = false): TaskActions {
  const blocked = subtask.status === 'blocked';
  const single = subtask.planId === null;
  return {
    cancel: single && !subtaskMachine.isTerminal(subtask.status),
    review: subtask.status === 'review' && !busy,
    continueFrom: single && canContinueFrom(subtask),
    resume: blocked && resumePlan(latest) !== undefined,
    restart: blocked,
    abandon: blocked,
  };
}

/**
 * 管理窗口命令对应的用例。规则：用户操作都带客户端看到的版本号（先到者为准）；
 * 状态变更与事件同事务写入后立即广播；需要执行器参与的部分交给 RunSupervisor。
 */
export class TaskService {
  /** 正在结束任务提交（git commit 期间）的子任务；期间的取消、恢复一律返回冲突，避免分支已提交而状态写入失败。 */
  private readonly committing = new Set<string>();

  constructor(private readonly deps: TaskServiceDeps) {}

  private assertNotCommitting(subtaskId: string): void {
    if (this.committing.has(subtaskId)) throw new CodedError('conflict', '正在结束任务（提交到分支），请稍后再试');
  }

  private get store() {
    return this.deps.store;
  }

  private publish(events: PersistentEvent[]): void {
    if (events.length > 0) this.deps.publish(events);
  }

  async createTask(input: CreateTaskInput): Promise<TaskDetail> {
    const existing = this.store.tasks.findTaskByIdempotencyKey(input.idempotencyKey);
    if (existing) return this.getTask(existing.id);

    const { workspace, prompt } = input.continuedFromTaskId
      ? this.continuation(input.continuedFromTaskId, input.goal)
      : await this.freshStart(input.rootPath, input.goal);
    // 校验期间（await）可能已有同一幂等键的请求建好了任务
    const raced = this.store.tasks.findTaskByIdempotencyKey(input.idempotencyKey);
    if (raced) return this.getTask(raced.id);
    const { record, events } = this.store.tasks.createTask({
      workspaceId: workspace.id,
      title: titleOf(input.goal),
      goal: input.goal,
      role: DEVELOPER,
      checkCommand: input.check ?? null,
      checkConfirmed: input.checkConfirmed,
      idempotencyKey: input.idempotencyKey,
      originConversationId: input.originConversationId ?? null,
      continuedFromTaskId: input.continuedFromTaskId ?? null,
    });
    this.publish(events);
    this.deps.supervisor.enqueue(record.subtask.id, { prompt });
    // 刚写入的记录都在手里（RETURNING），不回查；Run 由监管器异步创建
    return { task: record.task, workspace, subtask: record.subtask, runs: [], actions: actionsOf(record.subtask, undefined), plan: null };
  }

  /** 登记项目（不建任务）：和建任务同一套校验。 */
  async addWorkspace(rootPath: string): Promise<WorkspaceRecord> {
    const root = await this.validateProject(rootPath);
    return this.store.tasks.ensureWorkspace(basename(root), root);
  }

  /** 新任务：校验并登记项目。 */
  private async freshStart(rootPath: string | undefined, goal: string): Promise<{ workspace: WorkspaceRecord; prompt: string }> {
    if (!rootPath) throw new CodedError('bad_request', '请选择项目目录');
    const root = await this.validateProject(rootPath);
    return { workspace: this.store.tasks.ensureWorkspace(basename(root), root), prompt: firstRunPrompt(goal) };
  }

  /** 接续任务：项目取自来源任务（已登记、校验过）；来源必须已结束、有分支。提示词带上来源的目标和最后说明。 */
  private continuation(sourceTaskId: string, instruction: string): { workspace: WorkspaceRecord; prompt: string } {
    const source = this.store.tasks.getTask(sourceTaskId);
    const subtask = source && this.store.tasks.getSubtaskOfTask(source.id);
    const workspace = source && this.store.tasks.getWorkspace(source.workspaceId);
    if (!source || !subtask || !workspace) throw new CodedError('not_found', '要接续的任务不存在');
    if (!canContinueFrom(subtask)) throw new CodedError('bad_request', '只能接续已结束（已提交到分支）的任务');
    const latest = this.store.runs.latestRun(subtask.id);
    const finalMessage = (latest && this.store.runs.getResult(latest.id)?.finalMessage) ?? null;
    return { workspace, prompt: continuationPrompt({ goal: source.goal, finalMessage }, instruction) };
  }

  /** 项目必须是 git 仓库根目录，不能是系统目录或 PalDock 自己的数据根。 */
  private async validateProject(path: string): Promise<string> {
    if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) {
      throw new CodedError('bad_request', '项目目录不存在');
    }
    // 比较前统一成真实路径：Windows 临时目录常是 8.3 短名（RUNNER~1），macOS 的 /var 是 /private/var 的链接，
    // 而 git 返回的是长名、真实路径（CI 实测）
    const full = canonical(path);
    const dataRoot = canonical(this.deps.dataRoot);
    if (isInside(dataRoot, full) || isInside(full, dataRoot)) {
      throw new CodedError('bad_request', '项目目录不能与 PalDock 数据目录重叠');
    }
    if (isSystemDirectory(full)) throw new CodedError('bad_request', '不能选择系统目录');
    const root = await repositoryRoot(full).catch(() => {
      throw new CodedError('bad_request', '所选目录不是 git 仓库');
    });
    if (!samePath(canonical(root), full)) throw new CodedError('bad_request', `请选择仓库根目录：${root}`);
    // 没有任何提交就无法建 worktree，建任务时就说清楚，而不是等执行时才失败（用户实测）
    await headCommit(full).catch(() => {
      throw new CodedError('bad_request', '这个仓库还没有任何提交，请先提交一次再建任务');
    });
    return full;
  }

  setRemoteApprovalLevel(workspaceId: string, expectedVersion: number, level: RemoteApprovalLevel): void {
    this.publish(this.store.tasks.setRemoteApprovalLevel(workspaceId, expectedVersion, level).events);
  }

  /** worktree 准备命令（只能在桌面设置）；null 为取消。 */
  setPrepareCommand(workspaceId: string, expectedVersion: number, command: CheckCommand | null): void {
    this.publish(this.store.tasks.setPrepareCommand(workspaceId, expectedVersion, command).events);
  }

  listTasks(limit: number): TaskSummary[] {
    return this.store.tasks.listTasks(limit);
  }

  getTask(taskId: string): TaskDetail {
    const task = this.store.tasks.getTask(taskId);
    const workspace = task && this.store.tasks.getWorkspace(task.workspaceId);
    if (!task || !workspace) throw new CodedError('not_found', '任务不存在');
    const subtask = this.store.tasks.getSubtaskOfTask(task.id);
    if (subtask) {
      const runs = this.store.runs.runDetails(subtask.id);
      return { task, workspace, subtask, runs, actions: actionsOf(subtask, runs.at(-1)?.run), plan: null };
    }
    const plan = this.store.plans.latestPlan(task.id);
    if (!plan) throw new CodedError('not_found', '任务不存在');
    const none = { cancel: false, review: false, continueFrom: false, resume: false, restart: false, abandon: false };
    return { task, workspace, subtask: null, runs: [], actions: { ...none, cancel: !taskMachine.isTerminal(task.status) }, plan: this.planDetail(task, plan) };
  }

  /** 最新一版计划的节点；确认后带上物化出的子任务和各自允许的操作（逐个验收、恢复）。 */
  /**
   * 最新一版计划的节点。确认后带上当前在执行的子任务（按节点键；运行中提出的新一版还没确认时，显示同名节点现在的状态）、
   * 允许的操作、实际会用的执行器和各次 Run（不含输出正文）。
   */
  private planDetail(task: TaskRecord, plan: PlanRecord): PlanDetail {
    const subtasks = new Map(this.store.tasks.listSubtasks(task.id).map((s) => [s.nodeKey, s]));
    const pending = plan.status === 'proposed' && !taskMachine.isTerminal(task.status);
    return {
      plan,
      nodes: this.store.plans.nodes(plan.id).map((node) => {
        const executor = node.executor ?? executorOfRole(this.store, task.workspaceId, node.role);
        const subtask = subtasks.get(node.key) ?? null;
        if (!subtask) return { node, subtask, actions: null, gate: null, merge: null, executor, runs: [] };
        // 各次 Run 不带输出正文（详情页每次事件都会重读）；闸门取最近一次工作 Run 的证据和结论
        const runs = this.store.runs.runDetails(subtask.id, { messages: false });
        const latest = runs.findLast((r) => r.run.purpose === 'work');
        const gate = latest ? { result: latest.result, reviews: latest.reviews } : null;
        const merge = this.store.merges.latestOf(subtask.id) ?? null;
        return { node, subtask, actions: actionsOf(subtask, latest?.run, this.deps.supervisor.isActive(subtask.id)), gate, merge, executor, runs };
      }),
      actions: { confirm: pending, reject: pending, edit: pending },
      confirmedRevision: this.store.plans.confirmedPlan(task.id)?.revision ?? null,
    };
  }

  /** 自动处理设置（只能在桌面改）；没给的项沿用现在的设置。 */
  setAutoPolicy(workspaceId: string, expectedVersion: number, policy: Partial<AutoPolicy>): void {
    const workspace = this.store.tasks.getWorkspace(workspaceId);
    if (!workspace) throw new CodedError('not_found', '项目不存在');
    this.publish(this.store.tasks.setAutoPolicy(workspaceId, expectedVersion, { ...workspace.autoPolicy, ...policy }).events);
  }

  /** 会话里协调助手提出的计划，每一版一张卡片（对话页在消息流里显示，可以直接确认）。 */
  sessionPlans(sessionId: string, limit = 10): PlanDetail[] {
    return this.store.plans.plansOfSession(sessionId, limit).map((plan) => this.planDetail(this.store.tasks.getTask(plan.taskId)!, plan));
  }

  /** 执行中的 Run 由监管器中断，收尾时置为 cancelled；其余状态直接取消。 */
  cancelTask(taskId: string): void {
    const task = this.store.tasks.getTask(taskId);
    if (!task) throw new CodedError('not_found', '任务不存在');
    const subtask = this.store.tasks.getSubtaskOfTask(taskId);
    if (!subtask) return this.cancelGraph(task);
    this.assertNotCommitting(subtask.id);
    if (!this.deps.supervisor.cancel(subtask.id)) this.close(subtask, 'cancelled', CANCELLED);
  }

  /**
   * 取消按计划拆分的任务：还在等确认的计划退回、任务直接取消；已确认的，运行中的子任务交给监管器中断
   * （收尾时记为取消），其余没结束的同一事务直接取消。任务状态随子任务推导。
   */
  private cancelGraph(task: TaskRecord): void {
    if (taskMachine.isTerminal(task.status)) throw new CodedError('conflict', '任务已经结束');
    const subtasks = this.store.tasks.listSubtasks(task.id).filter((s) => !isFinished(s));
    for (const s of subtasks) this.assertNotCommitting(s.id);
    const idle = subtasks.filter((s) => !this.deps.supervisor.cancel(s.id));
    this.publish(
      this.store.transaction(() => {
        if (task.status === 'draft') {
          const plan = this.store.plans.latestPlan(task.id);
          return [
            ...(plan?.status === 'proposed' ? this.store.plans.reject(plan.id, plan.version, '任务已取消').events : []),
            ...this.store.tasks.transitionTask(task.id, task.version, 'cancelled', CANCELLED).events,
          ];
        }
        return [...idle.flatMap((s) => this.cancelEvents(s)), ...settleTask(this.store, task.id, CANCELLED)];
      }),
    );
  }

  /** 子任务直接结束（取消或放弃）；被中断的最新 Run 一并结束。 */
  private cancelEvents(subtask: SubtaskRecord, status: 'cancelled' | 'failed' = 'cancelled', reason = CANCELLED): PersistentEvent[] {
    const latest = this.store.runs.latestRun(subtask.id);
    return [
      ...(latest?.status === 'interrupted' ? this.store.runs.transitionRun(latest.id, latest.version, status, reason).events : []),
      ...this.store.tasks.transitionSubtask(subtask.id, subtask.version, status, reason).events,
    ];
  }

  /** 先到者为准（版本号）；权限扩展只能拒绝。via 记录决定来自桌面还是哪个外部渠道。 */
  decideApproval(approvalId: string, expectedVersion: number, decision: ApprovalDecision, via: ApprovalChannel = 'desktop'): void {
    const approval = this.store.runs.getApproval(approvalId);
    if (!approval) throw new CodedError('not_found', '审批不存在');
    if (decision === 'allow_once' && approval.kind === 'permissions') {
      throw new CodedError('bad_request', '暂不支持批准权限扩展，只能拒绝');
    }
    const change = this.store.runs.decideApproval(approval.id, expectedVersion, decision === 'allow_once' ? 'approved' : 'denied', via);
    this.publish(change.events);
    this.deps.supervisor.forwardDecision(change.record, decision);
  }

  /**
   * 待命中的任务：意见绑定到产生证据的那次（最新）Run。「结束任务」（accept）把 worktree 的改动提交到 PalDock 分支（不合并）；
   * 「继续」（rework，必须带下一步指令）新开一次 Run，沿用 worktree 和原生会话，旧 Run 的证据保留。
   */
  async decideReview(subtaskId: string, expectedVersion: number, decision: ReviewDecision, note?: string): Promise<void> {
    this.assertNotCommitting(subtaskId);
    const subtask = requireSubtask(this.store, subtaskId, 'review', expectedVersion);
    // 计划节点审阅中（审阅 Run 在跑或排队）时不能人工覆盖，等这一轮结束
    if (this.deps.supervisor.isActive(subtaskId)) throw new CodedError('conflict', '审阅助手正在审这次交付，请等它结束');
    const run = this.store.runs.latestRun(subtaskId)!;
    const task = this.store.tasks.getTask(subtask.taskId)!;

    // 计划节点人工通过（或冲突处理后重试）：和闸门通过一样合进任务集成分支，合并成功才算成功
    if (decision === 'accept' && subtask.planId && this.deps.integration) {
      this.publish(this.store.runs.addReview(run.id, 'accept', note ?? null).events);
      return this.deps.integration.merge(subtaskId);
    }
    if (decision === 'accept') {
      this.committing.add(subtaskId);
      try {
        if (subtask.worktreePath) await commitStaged(subtask.worktreePath, `paldock: ${task.title}`);
      } finally {
        this.committing.delete(subtaskId);
      }
      this.publish(
        this.store.transaction(() => [
          ...this.store.runs.addReview(run.id, 'accept', note ?? null).events,
          ...this.store.tasks.transitionSubtask(subtaskId, expectedVersion, 'succeeded').events,
          ...settleTask(this.store, task.id),
        ]),
      );
      return;
    }
    const reason = note?.trim() ?? '';
    if (!reason) throw new CodedError('bad_request', '请写下一步要做什么');
    this.publish(
      this.store.transaction(() => [
        ...this.store.runs.addReview(run.id, 'rework', reason).events,
        ...this.store.tasks.transitionSubtask(subtaskId, expectedVersion, 'queued', reason).events,
        ...settleTask(this.store, task.id),
      ]),
    );
    this.deps.supervisor.enqueue(subtaskId, {
      prompt: nextStepPrompt(subtask.planId ? subtask.goal : task.goal, reason),
      ...(run.nativeThreadId ? { threadId: run.nativeThreadId } : {}),
    });
  }

  /**
   * 被中断（阻塞）的子任务：恢复 = 新 Run 续做同一 thread 并指回原 Run；重新开始 = 新 Run、新 thread；
   * 放弃 = 失败。恢复失败不会静默新建会话，由用户再选。
   */
  recover(subtaskId: string, expectedVersion: number, action: 'resume' | 'restart' | 'abandon'): void {
    this.assertNotCommitting(subtaskId);
    const subtask = requireSubtask(this.store, subtaskId, 'blocked', expectedVersion);
    if (action === 'abandon') return this.close(subtask, 'failed', '用户放弃');

    const plan = action === 'resume' ? resumePlan(this.store.runs.latestRun(subtaskId)) : {};
    if (!plan) throw new CodedError('bad_request', '这次执行无法续做，请选择重新开始或放弃');
    const task = this.store.tasks.getTask(subtask.taskId)!;
    this.publish(
      this.store.transaction(() => [
        ...this.store.tasks.transitionSubtask(subtaskId, expectedVersion, 'queued').events,
        ...settleTask(this.store, task.id),
      ]),
    );
    // 重新开始是新会话：接续任务要重新带上来源任务的上下文，计划子任务带节点目标与上游交接
    const restart = () => {
      if (subtask.planId && this.deps.scheduler) return this.deps.scheduler.promptFor(subtask);
      return task.continuedFromTaskId ? this.continuation(task.continuedFromTaskId, task.goal).prompt : firstRunPrompt(task.goal);
    };
    const goal = subtask.planId ? subtask.goal : task.goal;
    this.deps.supervisor.enqueue(subtaskId, { prompt: action === 'resume' ? resumePrompt(goal) : restart(), ...plan });
  }

  /** 取消或放弃：被中断的最新 Run、子任务、任务同一事务进入终态。 */
  private close(subtask: SubtaskRecord, status: 'cancelled' | 'failed', reason: string): void {
    this.publish(this.store.transaction(() => [...this.cancelEvents(subtask, status, reason), ...settleTask(this.store, subtask.taskId, reason)]));
  }

  /** 读检查命令的脱敏输出；文件被删时如实说明。 */
  checkOutput(runId: string): string {
    const result = this.store.runs.getResult(runId);
    if (!result?.checkOutputRef) throw new CodedError('not_found', '这次 Run 没有检查输出');
    const artifacts = join(this.deps.dataRoot, 'artifacts');
    const path = resolve(artifacts, result.checkOutputRef);
    if (!isInside(artifacts, path)) throw new CodedError('bad_request', '产物路径不合法');
    if (!existsSync(path)) return '（证据文件缺失：可能已被删除，或从不含该文件的备份恢复）';
    return readFileSync(path, 'utf8');
  }
}
