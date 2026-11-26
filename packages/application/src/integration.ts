import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CodedError, type CheckCommand, type GateDecision, type PersistentEvent, type StorePort, type SubtaskRecord, type TaskRecord } from '@paldock/contracts';
import { P1_DEFAULTS, taskKey } from '@paldock/domain';
import { runCheck } from './check-runner.js';
import { addWorktree, branchCommit, git, headCommit, mergeInto, mergeNoCommit, removeWorktree } from './git.js';
import { mergeRedoPrompt } from './prompts.js';
import type { RunPlan } from './run-supervisor.js';
import { nodeTitle } from './task-graph-scheduler.js';
import { requireSubtask, settleTask, succeedSubtask } from './transitions.js';
import { errorText } from './util.js';

export interface IntegrationDeps {
  store: StorePort;
  supervisor: { enqueue(subtaskId: string, plan: RunPlan): void };
  dataRoot: string;
  publish(events: PersistentEvent[]): void;
  log(message: string): void;
  limits?: Partial<Pick<typeof P1_DEFAULTS, 'checkTimeoutMs' | 'checkOutputMaxBytes' | 'branchPrefix'>>;
  /** 只在测试里注入：在合并的关键点停住，模拟服务在这里被杀掉。 */
  checkpoint?: (point: 'started' | 'candidate' | 'fast_forward') => Promise<void>;
}

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

  /**
   * 重启恢复：没结束的合并按集成分支现在的 HEAD 判断：等于候选提交（已快进、没记完）就补记完成；
   * 等于合并前的 HEAD（还没推进）就作废这次、从头再合；都不是就交给人。
   * 然后清掉残留的临时合并 worktree，集成 worktree 里残留的合并状态 merge --abort。
   */
  async recover(): Promise<{ targetId: string; outcome: string; detail: string | null }[]> {
    const { store } = this.deps;
    const items: { targetId: string; outcome: string; detail: string | null }[] = [];
    const repos = new Set<string>();
    for (const op of store.merges.open()) {
      const subtask = store.tasks.getSubtask(op.subtaskId);
      const task = store.tasks.getTask(op.taskId);
      if (!subtask || !task?.integrationBranch) continue;
      const repo = store.tasks.getWorkspace(task.workspaceId)!.rootPath;
      repos.add(repo);
      const head = await branchCommit(repo, task.integrationBranch).catch(() => undefined);
      const runId = store.runs.latestRun(subtask.id)?.id ?? subtask.id;
      if (op.candidateSha && head === op.candidateSha) {
        // 集成 worktree 可能还停在旧提交（快进到一半）：让它跟上分支
        if (task.integrationWorktree) await git(task.integrationWorktree, ['reset', '--keep', op.candidateSha]).catch(() => {});
        this.deps.publish(
          store.transaction(() => {
            store.merges.advance(op.id, 'done', { detail: '重启后核对：集成分支已快进，补记完成' });
            return subtask.status === 'review' ? succeedSubtask(store, subtask, { stage: 'merge', outcome: 'passed', runId }) : [];
          }),
        );
        items.push({ targetId: op.id, outcome: '补记完成', detail: `集成分支已在候选提交 ${op.candidateSha.slice(0, 10)}` });
      } else if (head === op.targetOld) {
        store.merges.advance(op.id, 'check_failed', { detail: '服务重启，重做合并' });
        if (subtask.status === 'review') void this.merge(subtask.id);
        items.push({ targetId: op.id, outcome: '重做合并', detail: op.candidateSha ? '候选提交已出但没快进' : '只记了开始' });
      } else {
        const reason = '重启后发现集成分支被改动过（不是合并前的提交，也不是候选提交），请人工处理';
        store.merges.advance(op.id, 'check_failed', { detail: reason });
        this.handOver(subtask.id, { stage: 'merge', outcome: 'human', runId, reason });
        items.push({ targetId: op.id, outcome: '交给人', detail: reason });
      }
    }
    items.push(...(await this.cleanLeftovers(repos)));
    return items;
  }

  /** 清掉临时合并 worktree（启动时没有合并在进行），集成 worktree 里残留的合并状态 merge --abort。 */
  private async cleanLeftovers(repos: Set<string>): Promise<{ targetId: string; outcome: string; detail: string | null }[]> {
    const { store } = this.deps;
    const items: { targetId: string; outcome: string; detail: string | null }[] = [];
    const dir = join(this.deps.dataRoot, 'merges');
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      const op = store.merges.get(name);
      const task = op ? store.tasks.getTask(op.taskId) : undefined;
      const repo = task ? store.tasks.getWorkspace(task.workspaceId)?.rootPath : [...repos][0];
      const path = join(dir, name);
      if (repo) await removeWorktree(repo, path).catch(() => rmSync(path, { recursive: true, force: true }));
      else rmSync(path, { recursive: true, force: true });
      items.push({ targetId: name, outcome: '清理临时 worktree', detail: path });
    }
    // 只看还没结束的计划任务；先查文件，有合并残留才动 git
    for (const taskId of store.plans.openPlanTasks()) {
      const task = store.tasks.getTask(taskId);
      if (!task?.integrationWorktree || !existsSync(task.integrationWorktree)) continue;
      const gitDir = await git(task.integrationWorktree, ['rev-parse', '--git-dir']).then((d) => resolve(task.integrationWorktree!, d.trim()), () => undefined);
      if (!gitDir || !existsSync(join(gitDir, 'MERGE_HEAD'))) continue;
      await git(task.integrationWorktree, ['merge', '--abort']).catch(() => {});
      items.push({ targetId: task.id, outcome: '清理集成 worktree 的合并残留', detail: task.integrationWorktree });
    }
    return items;
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
    const next = previous.then(() => this.mergeNow(subtaskId)).catch((error) => this.mergeFailed(subtaskId, error));
    this.queues.set(subtask.taskId, next);
    void next.finally(() => {
      if (this.queues.get(subtask.taskId) === next) this.queues.delete(subtask.taskId);
    });
    return next;
  }

  /**
   * 合并出了不是冲突的 git 错误（建临时 worktree 失败、快进失败、文件被占用……）：这次操作记失败，节点交给人，
   * 不让它卡在待验收里没人知道。
   */
  private mergeFailed(subtaskId: string, error: unknown): void {
    const reason = `合并到集成分支时出错：${errorText(error)}`;
    this.deps.log(`merge ${subtaskId} failed: ${errorText(error)}`);
    try {
      const op = this.deps.store.merges.latestOf(subtaskId);
      if (op && (op.phase === 'started' || op.phase === 'candidate')) this.deps.store.merges.advance(op.id, 'check_failed', { detail: reason });
      const runId = this.deps.store.runs.latestRun(subtaskId)?.id ?? subtaskId;
      this.handOver(subtaskId, { stage: 'merge', outcome: 'human', runId, reason });
    } catch (inner) {
      this.deps.log(`merge ${subtaskId} hand over failed: ${errorText(inner)}`);
    }
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
    // 直接在项目目录里改的节点（没有 worktree、交付没有提交）：改动已经在你的工作区里，不走集成分支合并
    if (!subtask.worktreePath && work && store.runs.getResult(work.id)?.commitSha === null) {
      return this.succeed(subtask, { stage: 'merge', outcome: 'passed', runId, reason: '直接在项目目录里改，不走集成分支合并' });
    }

    const repo = store.tasks.getWorkspace(task.workspaceId)!.rootPath;
    // 节点分支当前的提交：通常就是交付时提交、检查和审阅过的那个；人工处理冲突后是你在节点 worktree 里新提交的
    const source = subtask.worktreePath ? await headCommit(subtask.worktreePath) : work && store.runs.getResult(work.id)?.commitSha;
    if (!source) return this.handOver(subtask.id, { stage: 'merge', outcome: 'human', runId, reason: '找不到节点的交付提交' });
    const oldHead = await branchCommit(repo, task.integrationBranch);
    const op = store.merges.start({ taskId: task.id, subtaskId: subtask.id, sourceSha: source, targetOld: oldHead });
    const title = nodeTitle(store, subtask);
    const temp = join(this.deps.dataRoot, 'merges', op.id);
    mkdirSync(join(this.deps.dataRoot, 'merges'), { recursive: true });
    await this.deps.checkpoint?.('started');
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
      await this.deps.checkpoint?.('candidate');

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
      await this.deps.checkpoint?.('fast_forward');
      this.deps.publish(
        store.transaction(() => {
          store.merges.advance(op.id, 'done');
          return succeedSubtask(store, fresh, { stage: 'merge', outcome: 'passed', runId });
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
    // 候选 worktree 是新建的：有检查要跑时先跑项目的准备命令（例如安装依赖），失败就不跑检查
    const prepare = commands.length > 0 ? store.tasks.getWorkspace(task.workspaceId)?.prepareCommand : null;
    const steps = [...(prepare ? [{ command: prepare, failure: '准备命令失败' }] : []), ...commands.map((command) => ({ command, failure: '集成检查没通过' }))];
    for (const { command, failure } of steps) {
      const outcome = await runCheck(command, { cwd, timeoutMs: this.limits.checkTimeoutMs, maxOutputBytes: this.limits.checkOutputMaxBytes });
      if (outcome.status !== 'passed') return `${failure}：${commandText(command)}（${outcome.exitCode === null ? outcome.status : `退出码 ${outcome.exitCode}`}）`;
    }
    return undefined;
  }

  private handOver(subtaskId: string, decision: GateDecision): void {
    const subtask = this.deps.store.tasks.getSubtask(subtaskId);
    if (subtask?.status !== 'review') return;
    this.deps.publish(this.deps.store.tasks.setGateStage(subtask.id, subtask.version, 'human', decision).events);
  }

  private succeed(subtask: SubtaskRecord, decision: GateDecision): void {
    this.deps.publish(this.deps.store.transaction(() => succeedSubtask(this.deps.store, subtask, decision)));
  }

  /**
   * 合并冲突（或集成检查失败）的节点交回开发助手：在节点 worktree 里把集成分支最新提交合进来但不提交（冲突文件留着冲突标记），
   * 基线改为这个提交，回到开发助手同一个会话处理。之后照常交付、检查、审阅、合并。
   */
  async redo(subtaskId: string, expectedVersion: number): Promise<void> {
    const { store } = this.deps;
    const subtask = requireSubtask(store, subtaskId, 'review', expectedVersion);
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
