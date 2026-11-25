import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodedError, type CheckCommand, type GateDecision, type PersistentEvent, type StorePort, type SubtaskRecord, type TaskRecord } from '@paldock/contracts';
import { P1_DEFAULTS, taskKey } from '@paldock/domain';
import { runCheck } from './check-runner.js';
import { addWorktree, branchCommit, git, headCommit, mergeInto, mergeNoCommit, removeWorktree } from './git.js';
import { mergeRedoPrompt } from './prompts.js';
import type { RunPlan } from './run-supervisor.js';
import { nodeOf } from './task-graph-scheduler.js';
import { settleTask } from './transitions.js';

export interface IntegrationDeps {
  store: StorePort;
  supervisor: { enqueue(subtaskId: string, plan: RunPlan): void };
  dataRoot: string;
  publish(events: PersistentEvent[]): void;
  log(message: string): void;
  limits?: Partial<Pick<typeof P1_DEFAULTS, 'checkTimeoutMs' | 'checkOutputMaxBytes' | 'branchPrefix'>>;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const commandText = (c: CheckCommand) => [c.executable, ...c.args].join(' ');

/**
 * 任务集成分支：计划确认时从项目 HEAD 建 `paldock/<任务编号>`；节点通过闸门后合进去（同一任务串行）。
 * 合并先在临时 worktree 里出候选提交、跑集成检查，通过后才把集成分支（连同它的 worktree）快进到候选提交；
 * 冲突或检查失败时集成分支不动，节点交给人。全程本地，不推送，不碰你自己的分支。每一步记在 merge_ops。
 */
export class IntegrationService {
  /** 每个任务一条合并队列。 */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly limits: typeof P1_DEFAULTS;

  constructor(private readonly deps: IntegrationDeps) {
    this.limits = { ...P1_DEFAULTS, ...deps.limits };
  }

  /** 等所有进行中的合并结束（退出前调用，避免在数据库关闭、目录删除后还在动 Git）。 */
  async idle(): Promise<void> {
    while (this.queues.size > 0) await Promise.allSettled([...this.queues.values()]);
  }

  /** 建任务集成分支并检出到数据根的 worktree；已建过就直接返回（可重入）。 */
  async ensureBranch(task: TaskRecord): Promise<TaskRecord> {
    if (task.integrationBranch) return task;
    const { store } = this.deps;
    const repo = store.tasks.getWorkspace(task.workspaceId)!.rootPath;
    const key = taskKey(task.id).slice(0, 12);
    const branch = `${this.limits.branchPrefix}${key}`;
    const path = join(this.deps.dataRoot, 'worktrees', `${key}-integration`);
    const head = await headCommit(repo).catch(() => {
      throw new CodedError('bad_request', '项目还没有任何提交，无法建任务集成分支');
    });
    mkdirSync(join(this.deps.dataRoot, 'worktrees'), { recursive: true });
    const base = await addWorktree(repo, path, branch, head);
    return store.tasks.setIntegration(task.id, branch, path, base) ?? store.tasks.getTask(task.id)!;
  }

  /** 节点通过闸门后合进集成分支；没有集成分支的旧任务直接成功。按任务排队，返回这次合并结束的 Promise。 */
  merge(subtaskId: string): Promise<void> {
    const subtask = this.deps.store.tasks.getSubtask(subtaskId);
    if (!subtask) return Promise.resolve();
    const previous = this.queues.get(subtask.taskId) ?? Promise.resolve();
    const next = previous.then(() => this.mergeNow(subtaskId)).catch((error) => this.deps.log(`merge ${subtaskId} failed: ${errorText(error)}`));
    this.queues.set(subtask.taskId, next);
    void next.finally(() => {
      if (this.queues.get(subtask.taskId) === next) this.queues.delete(subtask.taskId);
    });
    return next;
  }

  private async mergeNow(subtaskId: string): Promise<void> {
    const { store } = this.deps;
    const subtask = store.tasks.getSubtask(subtaskId);
    // 排队期间可能已被取消或人工处理过
    if (subtask?.status !== 'review') return;
    const task = store.tasks.getTask(subtask.taskId)!;
    const work = store.runs.latestRun(subtask.id);
    const runId = work?.id ?? subtask.id;
    if (!task.integrationBranch || !task.integrationWorktree) return this.succeed(subtask, { stage: 'merge', outcome: 'passed', runId, reason: '任务没有集成分支' });

    const repo = store.tasks.getWorkspace(task.workspaceId)!.rootPath;
    // 节点分支当前的提交：通常就是交付时提交、检查和审阅过的那个；人工处理冲突后是你在节点 worktree 里新提交的
    const source = subtask.worktreePath ? await headCommit(subtask.worktreePath) : work && store.runs.getResult(work.id)?.commitSha;
    if (!source) return this.handOver(subtask.id, { stage: 'merge', outcome: 'human', runId, reason: '找不到节点的交付提交' });
    const oldHead = await branchCommit(repo, task.integrationBranch);
    const op = store.merges.start({ taskId: task.id, subtaskId: subtask.id, sourceSha: source, targetOld: oldHead });
    const title = nodeOf(store, subtask)?.title ?? subtask.goal.slice(0, 40);
    const temp = join(this.deps.dataRoot, 'merges', op.id);
    mkdirSync(join(this.deps.dataRoot, 'merges'), { recursive: true });
    await git(repo, ['worktree', 'add', '--detach', temp, oldHead]);
    try {
      const merged = await mergeInto(temp, source, `paldock: 合入「${title}」`);
      if (!merged.ok) {
        const reason = `合并到集成分支冲突：${merged.files.join('、')}`;
        store.merges.advance(op.id, 'conflict', { conflictFiles: merged.files, detail: reason });
        return this.handOver(subtask.id, { stage: 'merge', outcome: 'human', runId, reason });
      }
      const candidate = await headCommit(temp);
      store.merges.advance(op.id, 'candidate', { candidateSha: candidate });

      const failed = await this.integrationChecks(task, subtask, temp);
      if (failed) {
        store.merges.advance(op.id, 'check_failed', { detail: failed });
        return this.handOver(subtask.id, { stage: 'merge', outcome: 'human', runId, reason: failed });
      }
      // 推进前再确认：节点仍待验收（没被取消、没被别处处理），集成分支没被别人动过
      const fresh = store.tasks.getSubtask(subtask.id);
      if (fresh?.status !== 'review') return void store.merges.advance(op.id, 'check_failed', { detail: '合并期间节点已被取消或处理' });
      if ((await branchCommit(repo, task.integrationBranch)) !== oldHead) {
        const reason = '集成分支在合并期间被改动过，没有推进';
        store.merges.advance(op.id, 'check_failed', { detail: reason });
        return this.handOver(subtask.id, { stage: 'merge', outcome: 'human', runId, reason });
      }
      await git(task.integrationWorktree, ['merge', '--ff-only', candidate]);
      this.deps.publish(
        store.transaction(() => {
          store.merges.advance(op.id, 'done');
          return this.succeedEvents(fresh, { stage: 'merge', outcome: 'passed', runId });
        }),
      );
    } finally {
      await removeWorktree(repo, temp).catch((error) => this.deps.log(`remove ${temp} failed: ${errorText(error)}`));
    }
  }

  /**
   * 集成检查：已合入的节点和这个节点的检查命令（去重，按节点顺序），在候选提交上跑。返回失败原因，全部通过返回 undefined。
   */
  private async integrationChecks(task: TaskRecord, subtask: SubtaskRecord, cwd: string): Promise<string | undefined> {
    const { store } = this.deps;
    const merged = new Set(store.tasks.listSubtasks(task.id).filter((s) => s.status === 'succeeded' || s.id === subtask.id).map((s) => s.nodeKey));
    const seen = new Set<string>();
    const commands = store.plans
      .nodes(subtask.planId!)
      .filter((n) => merged.has(n.key) && n.checkCommand)
      .map((n) => n.checkCommand!)
      .filter((c) => !seen.has(JSON.stringify(c)) && seen.add(JSON.stringify(c)));
    for (const command of commands) {
      const outcome = await runCheck(command, { cwd, timeoutMs: this.limits.checkTimeoutMs, maxOutputBytes: this.limits.checkOutputMaxBytes });
      if (outcome.status !== 'passed') return `集成检查没通过：${commandText(command)}（${outcome.exitCode === null ? outcome.status : `退出码 ${outcome.exitCode}`}）`;
    }
    return undefined;
  }

  private handOver(subtaskId: string, decision: GateDecision): void {
    const subtask = this.deps.store.tasks.getSubtask(subtaskId);
    if (subtask?.status !== 'review') return;
    this.deps.publish(this.deps.store.tasks.setGateStage(subtask.id, subtask.version, 'human', decision).events);
  }

  private succeed(subtask: SubtaskRecord, decision: GateDecision): void {
    this.deps.publish(this.deps.store.transaction(() => this.succeedEvents(subtask, decision)));
  }

  /** 节点成功（调度器据此放行下游），任务状态重新推导。 */
  private succeedEvents(subtask: SubtaskRecord, decision: GateDecision): PersistentEvent[] {
    const { store } = this.deps;
    return [store.tasks.gateDecided(subtask.id, decision), ...store.tasks.transitionSubtask(subtask.id, subtask.version, 'succeeded').events, ...settleTask(store, subtask.taskId)];
  }

  /**
   * 合并冲突（或集成检查失败）的节点交回开发助手：在节点 worktree 里把集成分支最新提交合进来但不提交（冲突文件留着冲突标记），
   * 基线改为这个提交，回到开发助手同一个会话处理。之后照常交付、检查、审阅、合并。
   */
  async redo(subtaskId: string, expectedVersion: number): Promise<void> {
    const { store } = this.deps;
    const subtask = store.tasks.getSubtask(subtaskId);
    if (!subtask) throw new CodedError('not_found', '子任务不存在');
    if (subtask.status !== 'review' || subtask.version !== expectedVersion) throw new CodedError('conflict', '子任务状态已变化，请刷新');
    const op = store.merges.latestOf(subtask.id);
    if (!op || (op.phase !== 'conflict' && op.phase !== 'check_failed')) throw new CodedError('bad_request', '只有合入集成分支失败的节点能交回重做');
    const task = store.tasks.getTask(subtask.taskId)!;
    const repo = store.tasks.getWorkspace(task.workspaceId)!.rootPath;
    const head = await branchCommit(repo, task.integrationBranch!);
    const conflicts = await mergeNoCommit(subtask.worktreePath!, head);
    const work = store.runs.latestRun(subtask.id);
    const reason = conflicts.length > 0 ? `合并冲突，交回重做：${conflicts.join('、')}` : `集成检查没通过，交回重做`;
    this.deps.publish(
      store.transaction(() => {
        const rebased = store.tasks.rebaseSubtask(subtask.id, expectedVersion, head);
        return [...store.tasks.transitionSubtask(subtask.id, rebased.version, 'queued', reason.slice(0, 500)).events, ...settleTask(store, task.id)];
      }),
    );
    this.deps.supervisor.enqueue(subtask.id, {
      prompt: mergeRedoPrompt(subtask.goal, conflicts, op.detail),
      ...(work?.nativeThreadId ? { threadId: work.nativeThreadId } : {}),
    });
  }
}
