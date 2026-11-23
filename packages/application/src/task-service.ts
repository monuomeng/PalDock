import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  CodedError,
  type ApprovalDecision,
  type CheckCommand,
  type PersistentEvent,
  type ReviewDecision,
  type RunRecord,
  type StorePort,
  type SubtaskRecord,
  type TaskActions,
  type TaskDetail,
  type TaskSummary,
} from '@paldock/contracts';
import { subtaskMachine } from '@paldock/domain';
import { isInside, samePath } from '@paldock/platform';
import { commitStaged, repositoryRoot } from './git.js';
import { firstRunPrompt, resumePrompt, reworkPrompt, titleOf } from './prompts.js';
import type { RunSupervisor } from './run-supervisor.js';
import { moveTask, requireSubtask } from './transitions.js';

export interface CreateTaskInput {
  rootPath: string;
  goal: string;
  check?: CheckCommand | undefined;
  checkConfirmed: boolean;
  idempotencyKey: string;
}

export interface TaskServiceDeps {
  store: StorePort;
  supervisor: RunSupervisor;
  dataRoot: string;
  publish(events: PersistentEvent[]): void;
}

/** P1 只有开发助手一个角色。 */
const DEVELOPER = 'developer';

/** 不允许把系统目录当作项目（Windows 系统与程序目录、macOS 系统目录）。 */
function systemDirectories(): string[] {
  const env = process.env;
  const windows = [env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData].filter((p): p is string => !!p);
  return process.platform === 'win32' ? windows : ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/private'];
}

/** 被中断且有原生会话的 Run 才能续做（新 Run 指回它、沿用同一 thread）。 */
function resumePlan(latest: RunRecord | undefined): { threadId: string; resumesRunId: string } | undefined {
  return latest?.status === 'interrupted' && latest.nativeThreadId ? { threadId: latest.nativeThreadId, resumesRunId: latest.id } : undefined;
}

/** 当前允许的用户操作；界面只按它显示按钮，规则只在这里一处。 */
function actionsOf(subtask: SubtaskRecord, latest: RunRecord | undefined): TaskActions {
  const blocked = subtask.status === 'blocked';
  return {
    cancel: !subtaskMachine.isTerminal(subtask.status),
    review: subtask.status === 'review',
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
  /** 正在验收提交（git commit 期间）的子任务；期间的取消、恢复一律返回冲突，避免分支已提交而状态写入失败。 */
  private readonly committing = new Set<string>();

  constructor(private readonly deps: TaskServiceDeps) {}

  private assertNotCommitting(subtaskId: string): void {
    if (this.committing.has(subtaskId)) throw new CodedError('conflict', '正在提交验收结果，请稍后再试');
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

    const rootPath = await this.validateProject(input.rootPath);
    // 校验期间（await）可能已有同一幂等键的请求建好了任务
    const raced = this.store.tasks.findTaskByIdempotencyKey(input.idempotencyKey);
    if (raced) return this.getTask(raced.id);
    const workspace = this.store.tasks.ensureWorkspace(basename(rootPath), rootPath);
    const { record, events } = this.store.tasks.createTask({
      workspaceId: workspace.id,
      title: titleOf(input.goal),
      goal: input.goal,
      role: DEVELOPER,
      checkCommand: input.check ?? null,
      checkConfirmed: input.checkConfirmed,
      idempotencyKey: input.idempotencyKey,
    });
    this.publish(events);
    this.deps.supervisor.enqueue(record.subtask.id, { prompt: firstRunPrompt(input.goal) });
    // 刚写入的记录都在手里（RETURNING），不回查；Run 由监管器异步创建
    return { task: record.task, workspace, subtask: record.subtask, runs: [], actions: actionsOf(record.subtask, undefined) };
  }

  /** 项目必须是 git 仓库根目录，不能是系统目录或 PalDock 自己的数据根。 */
  private async validateProject(path: string): Promise<string> {
    if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) {
      throw new CodedError('bad_request', '项目目录不存在');
    }
    const full = resolve(path);
    if (isInside(this.deps.dataRoot, full) || isInside(full, this.deps.dataRoot)) {
      throw new CodedError('bad_request', '项目目录不能与 PalDock 数据目录重叠');
    }
    if (systemDirectories().some((dir) => isInside(dir, full))) throw new CodedError('bad_request', '不能选择系统目录');
    const root = await repositoryRoot(full).catch(() => {
      throw new CodedError('bad_request', '所选目录不是 git 仓库');
    });
    if (!samePath(root, full)) throw new CodedError('bad_request', `请选择仓库根目录：${root}`);
    return full;
  }

  listTasks(limit: number): TaskSummary[] {
    return this.store.tasks.listTasks(limit);
  }

  getTask(taskId: string): TaskDetail {
    const task = this.store.tasks.getTask(taskId);
    const subtask = task && this.store.tasks.getSubtaskOfTask(task.id);
    const workspace = task && this.store.tasks.getWorkspace(task.workspaceId);
    if (!task || !subtask || !workspace) throw new CodedError('not_found', '任务不存在');
    const runs = this.store.runs.runDetails(subtask.id);
    return { task, workspace, subtask, runs, actions: actionsOf(subtask, runs.at(-1)?.run) };
  }

  /** 执行中的 Run 由监管器中断，收尾时置为 cancelled；其余状态直接取消。 */
  cancelTask(taskId: string): void {
    const subtask = this.store.tasks.getSubtaskOfTask(taskId);
    if (!subtask) throw new CodedError('not_found', '任务不存在');
    this.assertNotCommitting(subtask.id);
    if (!this.deps.supervisor.cancel(subtask.id)) this.close(subtask, 'cancelled', '用户取消');
  }

  /** 先到者为准（版本号）；权限扩展在 P1 只能拒绝。 */
  decideApproval(approvalId: string, expectedVersion: number, decision: ApprovalDecision): void {
    const approval = this.store.runs.getApproval(approvalId);
    if (!approval) throw new CodedError('not_found', '审批不存在');
    if (decision === 'allow_once' && approval.kind === 'permissions') {
      throw new CodedError('bad_request', 'P1 不支持批准权限扩展，只能拒绝');
    }
    const change = this.store.runs.decideApproval(approval.id, expectedVersion, decision === 'allow_once' ? 'approved' : 'denied', 'desktop');
    this.publish(change.events);
    this.deps.supervisor.forwardDecision(change.record, decision);
  }

  /**
   * 验收：意见绑定到产生证据的那次（最新）Run。通过时把 worktree 的改动提交到 PalDock 分支（不合并）；
   * 退回时新开一次 Run，沿用原生会话并带上意见，旧 Run 的证据保留。
   */
  async decideReview(subtaskId: string, expectedVersion: number, decision: ReviewDecision, note?: string): Promise<void> {
    this.assertNotCommitting(subtaskId);
    const subtask = requireSubtask(this.store, subtaskId, 'review', expectedVersion);
    const run = this.store.runs.latestRun(subtaskId)!;
    const task = this.store.tasks.getTask(subtask.taskId)!;

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
          ...this.store.tasks.transitionTask(task.id, task.version, 'succeeded').events,
        ]),
      );
      return;
    }
    const reason = note ?? '';
    this.publish(
      this.store.transaction(() => [
        ...this.store.runs.addReview(run.id, 'rework', reason).events,
        ...this.store.tasks.transitionSubtask(subtaskId, expectedVersion, 'queued', reason).events,
      ]),
    );
    this.deps.supervisor.enqueue(subtaskId, {
      prompt: reworkPrompt(task.goal, reason),
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
        ...this.store.tasks.transitionTask(task.id, task.version, 'queued').events,
      ]),
    );
    this.deps.supervisor.enqueue(subtaskId, { prompt: action === 'resume' ? resumePrompt(task.goal) : firstRunPrompt(task.goal), ...plan });
  }

  /** 取消或放弃：被中断的最新 Run、子任务、任务同一事务进入终态。 */
  private close(subtask: SubtaskRecord, status: 'cancelled' | 'failed', reason: string): void {
    this.publish(
      this.store.transaction(() => {
        const latest = this.store.runs.latestRun(subtask.id);
        return [
          ...(latest?.status === 'interrupted' ? this.store.runs.transitionRun(latest.id, latest.version, status, reason).events : []),
          ...this.store.tasks.transitionSubtask(subtask.id, subtask.version, status, reason).events,
          ...moveTask(this.store, subtask.taskId, status, reason),
        ];
      }),
    );
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
