import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CodedError,
  type CommitHunk,
  type CommitScope,
  type GitOpRecord,
  type GitOpRequest,
  type PersistentEvent,
  type PushTarget,
  type RunWriteRecord,
  type StorePort,
} from '@paldock/contracts';
import { classifyHunk, joinHunks, splitDiff, type DiffHunk } from '@paldock/domain';
import { attributeHunks } from './attribution.js';
import { branchAndHead, git, gitInput, indexTree, snapshotTree, treeChangedFiles } from './git.js';
import { errorText } from './util.js';

export interface GitOpsDeps {
  store: StorePort;
  dataRoot: string;
  publish(events: PersistentEvent[]): void;
  log(message: string): void;
  /** 宿主自己改了暂存区（提交、恢复）：正在跑的 Run 以现在的暂存区为准重新核对，免得误报。 */
  indexChanged?(workspaceId: string): void;
  /** 项目恢复写入后，让调度器接着排。 */
  kick?(): void;
}

/** 暂存区保护暂停项目时的原因前缀（0.3.7）。 */
export const INDEX_PAUSE = '这一轮里暂存区变了';
const SCOPE_LIMIT = 500;

/**
 * 提交、推送、合并分开指挥（默认在当前仓库协作，2026-11-26 已定；0.3.7 收紧）。助手只能提出卡片，你在桌面上确认后才由宿主执行；
 * 执行前再核对一次，和你看到的不一样就作废。只在当前工作区方式的项目里用。
 * - 提交：只列这个任务 / 这个对话的改动块（按行归属，不是按文件名）；默认只勾每一行都能用助手自己的写入重放核对上的块；
 *   你原来暂存的内容提交后仍是暂存状态，工作区不动。
 * - 推送：推的是预览时的那个提交；目标状态取实际推送地址上的分支（ls-remote），确认时再核对一次，变了就作废；不强推。
 * - 合并：锁定预览时源和目标两边的提交；冲突不落地、交给你。
 * - 暂存区变了：这一轮里暂存区和开始时不一样，暂停项目，由你选择保留或恢复。
 */
export class GitOpsService {
  constructor(private readonly deps: GitOpsDeps) {}

  private scratch(): string {
    const dir = join(this.deps.dataRoot, 'tmp');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 协调助手这次 Run 所在的项目（必须是当前工作区方式）、主会话和它自己的任务。 */
  private contextOf(runId: string): { workspaceId: string; repo: string; sessionId: string | null; taskId: string } {
    const { store } = this.deps;
    const run = store.runs.getRun(runId);
    const subtask = run && store.tasks.getSubtask(run.subtaskId);
    const task = subtask && store.tasks.getTask(subtask.taskId);
    const workspace = task && store.tasks.getWorkspace(task.workspaceId);
    if (!workspace) throw new CodedError('not_found', '找不到这次 Run 所在的项目');
    if (workspace.workspaceMode !== 'current') {
      throw new CodedError('bad_request', '这个项目用独立 worktree：改动在任务集成分支上，做完显示「待合并」，由用户自己合并');
    }
    if (workspace.pausedReason) throw new CodedError('bad_request', `项目已暂停：${workspace.pausedReason}`);
    return { workspaceId: workspace.id, repo: workspace.rootPath, sessionId: run.sessionId, taskId: task.id };
  }

  private propose(ctx: { workspaceId: string; sessionId: string | null }, runId: string | null, request: GitOpRequest): GitOpRecord {
    const { record, events } = this.deps.store.git.proposeOp({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, runId, request });
    this.deps.publish(events);
    return record;
  }

  // ---- 提交 ----

  /**
   * 提交卡片的范围：默认这个对话发起的任务（加上协调助手自己，单人模式时它也会改文件）；
   * 指定任务时只看这个任务，而且必须是这个对话发起的；整个项目只在你明确要求时（wholeProject）。
   */
  private scopeOf(ctx: { sessionId: string | null; taskId: string }, taskId: string | undefined, wholeProject: boolean): CommitScope {
    const { store } = this.deps;
    if (wholeProject) return { kind: 'project', label: '整个项目（你明确要求扩大的范围）', taskIds: [] };
    const mine = [...new Set([ctx.taskId, ...(ctx.sessionId ? store.plans.plansOfSession(ctx.sessionId, 200).map((p) => p.taskId) : [])])];
    if (taskId) {
      if (!mine.includes(taskId)) throw new CodedError('bad_request', '这个任务不是这个对话发起的；要看别的任务或整个项目的改动，请用户明确说');
      return { kind: 'task', label: `任务「${store.tasks.getTask(taskId)?.title ?? taskId}」`, taskIds: [taskId] };
    }
    return { kind: 'session', label: '这个对话发起的任务', taskIds: mine };
  }

  /**
   * 拟提交：范围内的 Run 改过、现在相对 HEAD 还有改动的文件；逐块、逐行看归属（见 attributeHunks）：
   * 只列有范围内 Run 期间改动的块（别的任务、你在 Run 之外改的块不列）；每一行都是范围内助手自己的改动才默认勾选。
   * 不按时间截断：已经提交的块在 HEAD 里，自然不在差异里；提交了任务 B 之后，任务 A 还没提交的块照样在。
   */
  async proposeCommit(runId: string, message: string, options: { taskId?: string; wholeProject?: boolean } = {}): Promise<GitOpRecord> {
    const ctx = this.contextOf(runId);
    const { store } = this.deps;
    const scope = this.scopeOf(ctx, options.taskId, options.wholeProject ?? false);
    const { branch, head } = await branchAndHead(ctx.repo);
    if (!branch) throw new CodedError('bad_request', '当前是分离 HEAD，请先切到一个分支再提交');
    const scratch = this.scratch();
    const nowTree = await snapshotTree(ctx.repo, scratch);
    const dirty = new Set(await treeChangedFiles(ctx.repo, head, nowTree));
    if (dirty.size === 0) throw new CodedError('bad_request', '工作区相对 HEAD 没有改动');
    const all = store.git.snapshotsOfWorkspace(ctx.workspaceId, SCOPE_LIMIT);
    const inScope = (taskId: string) => scope.kind === 'project' || scope.taskIds.includes(taskId);
    let first = -1;
    const files = new Set<string>();
    for (const [i, s] of all.entries()) {
      if (!inScope(s.taskId)) continue;
      const end = s.endTree ?? all[i + 1]?.startTree ?? nowTree;
      const changed = (await treeChangedFiles(ctx.repo, s.startTree, end)).filter((f) => dirty.has(f));
      if (changed.length === 0) continue;
      if (first < 0) first = i;
      for (const f of changed) files.add(f);
    }
    if (first < 0) throw new CodedError('bad_request', `没有找到${scope.label}还没提交的改动`);
    // 从范围内第一次相关的 Run 起，项目里所有的 Run 都进快照链（别的任务的改动才能认成别的任务的）
    const chain = all.slice(first);
    const writes = new Map<string, RunWriteRecord[]>();
    for (const w of store.git.writesOfRuns(chain.map((s) => s.runId))) {
      const list = writes.get(w.runId);
      if (list) list.push(w);
      else writes.set(w.runId, [w]);
    }
    const scopedRuns = new Set(chain.filter((s) => inScope(s.taskId)).map((s) => s.runId));
    const attributed = await attributeHunks(
      ctx.repo,
      scratch,
      head,
      nowTree,
      chain.map((s) => ({ runId: s.runId, startTree: s.startTree, endTree: s.endTree, writes: writes.get(s.runId) ?? [] })),
      [...files],
    );
    const staged = (await git(ctx.repo, ['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only', '-z'])).split('\0').filter((f) => f !== '');
    const stagedSet = new Set(staged);
    const scoped = (id: string) => scopedRuns.has(id);
    const items: CommitHunk[] = attributed.flatMap(({ hunk, owners, lineless, fileRuns }) => {
      const base = { id: hunk.id, path: hunk.path, patch: hunk.header + hunk.body, stagedByUser: stagedSet.has(hunk.path) };
      if (lineless) {
        return fileRuns.some(scoped) ? [{ ...base, evidenced: false, note: '没有可以逐行核对的内容（二进制、改权限等），默认不勾' }] : [];
      }
      const { show, evidenced } = classifyHunk(owners, scoped);
      if (!show) return [];
      const note = evidenced
        ? '助手写的（和它的写入记录逐行核对上了）'
        : owners.some((o) => o.kind === 'other' || !scoped(o.runId))
          ? '和不属于这次的改动挨在一起（你在别的时候改的或别的任务的），默认不勾'
          : '这次任务期间发生、但核对不上助手的写入（你同时改的、命令写的或证据对不上），默认不勾';
      return [{ ...base, evidenced, note }];
    });
    if (items.length === 0) throw new CodedError('bad_request', `${scope.label}的改动现在相对 HEAD 已经没有了`);
    return this.propose(ctx, runId, { kind: 'commit', message, branch, head, scope, hunks: items, staged });
  }

  // ---- 推送 ----

  /**
   * 拟推送：推的是现在的 HEAD 这个提交；实际写入地址取 remote 的全部 pushurl；每个地址上这个分支现在的提交用 ls-remote 现查
   * （本地的 origin/分支 可能落后）。几个地址状态不一致、远端有本地没有的提交、不是快进，都直接说明，不提出卡片。
   */
  async proposePush(runId: string, remote?: string, remoteBranch?: string): Promise<GitOpRecord> {
    const ctx = this.contextOf(runId);
    const { branch, head } = await branchAndHead(ctx.repo);
    if (!branch) throw new CodedError('bad_request', '当前是分离 HEAD，没有可推送的分支');
    const upstream = (await git(ctx.repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
    const [upRemote, ...upBranch] = upstream ? upstream.split('/') : [];
    const target = remote ?? upRemote ?? 'origin';
    const targetBranch = remoteBranch ?? (upBranch.length > 0 ? upBranch.join('/') : branch);
    const urls = await pushUrls(ctx.repo, target).catch(() => {
      throw new CodedError('bad_request', `没有名为 ${target} 的远端`);
    });
    const targets: PushTarget[] = [];
    for (const url of urls) targets.push({ url, remoteSha: await lsRemote(ctx.repo, url, targetBranch) });
    if (new Set(targets.map((t) => t.remoteSha)).size > 1) {
      const states = targets.map((t) => `${t.url}：${t.remoteSha?.slice(0, 10) ?? '没有这个分支'}`).join('；');
      throw new CodedError('bad_request', `远端 ${target} 配了 ${targets.length} 个推送地址，它们上面 ${targetBranch} 的状态不一致（${states}），请先处理好再推送`);
    }
    const remoteSha = targets[0]?.remoteSha ?? null;
    if (remoteSha) {
      if (remoteSha === head) throw new CodedError('bad_request', `${target}/${targetBranch} 已经是 ${head.slice(0, 10)}，没有要推送的提交`);
      const known = await git(ctx.repo, ['cat-file', '-e', `${remoteSha}^{commit}`]).then(() => true, () => false);
      if (!known) throw new CodedError('bad_request', `${target}/${targetBranch} 上有本地没有的提交（${remoteSha.slice(0, 10)}），请先拉取（git fetch）再推送`);
      const fastForward = await git(ctx.repo, ['merge-base', '--is-ancestor', remoteSha, head]).then(() => true, () => false);
      if (!fastForward) throw new CodedError('bad_request', `${target}/${targetBranch} 上有当前分支没有的提交，推送不是快进；PalDock 不强推，请先合并或变基`);
    }
    const range = remoteSha ? [`${remoteSha}..${head}`] : [head, '--not', `--remotes=${target}`];
    const { commits, total } = await commitList(ctx.repo, range);
    return this.propose(ctx, runId, { kind: 'push', remote: target, targets, branch, remoteBranch: targetBranch, head, commits, totalCommits: total });
  }

  // ---- 合并 ----

  async proposeMerge(runId: string, source: string, target: string): Promise<GitOpRecord> {
    const ctx = this.contextOf(runId);
    const sha = async (name: string) =>
      (
        await git(ctx.repo, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]).catch(() => {
          throw new CodedError('bad_request', `没有本地分支 ${name}`);
        })
      ).trim();
    const sourceSha = await sha(source);
    const targetSha = await sha(target);
    const { commits, total } = await commitList(ctx.repo, [`${targetSha}..${sourceSha}`]);
    if (total === 0) throw new CodedError('bad_request', `${source} 没有 ${target} 上没有的提交，不需要合并`);
    const fastForward = await git(ctx.repo, ['merge-base', '--is-ancestor', targetSha, sourceSha]).then(() => true, () => false);
    return this.propose(ctx, runId, { kind: 'merge', source, target, sourceSha, targetSha, commits, totalCommits: total, fastForward });
  }

  // ---- 暂存区保护 ----

  /** 这一轮里暂存区变了：暂停项目、提出一张「保留 / 恢复」卡片（由监管器在 Run 结束时调用）。 */
  proposeIndexChange(workspaceId: string, runId: string, before: string, after: string, paths: string[]): GitOpRecord {
    const { store } = this.deps;
    const session = store.coordinator.mainSessions(workspaceId)[0];
    const files = `${paths.slice(0, 5).join('、')}${paths.length > 5 ? ` 等 ${paths.length} 个文件` : ''}`;
    this.deps.publish(store.tasks.setPaused(workspaceId, `${INDEX_PAUSE}（${files}），已暂停；请在对话里的暂存区卡片上选择保留或恢复`).events);
    return this.propose({ workspaceId, sessionId: session?.sessionId ?? null }, runId, { kind: 'index', runId, before, after, paths });
  }

  // ---- 你的决定 ----

  /** 确认或取消一张卡片（带版本，先到者为准）；确认时提交卡片要给出勾选的改动块。暂存区卡片：确认 = 恢复，取消 = 保留。 */
  async decide(opId: string, expectedVersion: number, decision: 'confirm' | 'cancel', hunkIds: readonly string[] = []): Promise<GitOpRecord> {
    const { store } = this.deps;
    const op = store.git.getOp(opId);
    if (!op) throw new CodedError('not_found', '卡片不存在');
    if (op.status !== 'proposed' || op.version !== expectedVersion) throw new CodedError('conflict', '这张卡片已经处理过，请刷新');
    const request = op.request;
    if (decision === 'cancel') {
      const cancelled = this.finish(op, 'cancelled', request.kind === 'index' ? '保留了现在的暂存区' : '你取消了');
      return request.kind === 'index' ? this.resumeAfterIndex(cancelled) : cancelled;
    }
    const repo = store.tasks.getWorkspace(op.workspaceId)!.rootPath;
    try {
      const result =
        request.kind === 'commit'
          ? await this.commit(repo, request, hunkIds)
          : request.kind === 'push'
            ? await this.push(repo, request)
            : request.kind === 'merge'
              ? await this.merge(repo, request)
              : await this.restoreIndex(repo, request);
      if (request.kind === 'commit' && result.status === 'done') this.deps.indexChanged?.(op.workspaceId);
      const finished = this.finish(op, result.status, result.detail);
      return request.kind === 'index' && result.status === 'done' ? this.resumeAfterIndex(finished) : finished;
    } catch (error) {
      // 执行中出错（查不到远端、git 失败）都如实记在卡片上
      this.deps.log(`git op ${op.id} failed: ${errorText(error)}`);
      return this.finish(op, 'failed', errorText(error, 1000));
    }
  }

  private finish(op: GitOpRecord, status: 'done' | 'failed' | 'cancelled' | 'stale', detail: string): GitOpRecord {
    const { record, events } = this.deps.store.git.finishOp(op.id, op.version, status, detail);
    this.deps.store.audit.append('desktop', `git.${op.request.kind}`, op.id, `${status}: ${detail.slice(0, 300)}`);
    this.deps.publish(events);
    return record;
  }

  /**
   * 只提交勾选的块：临时索引里以 HEAD 为底打上这些块，写出提交树；再以新提交为底重打你原来的暂存差异，
   * 打不上（和你暂存的块重叠）就在推进分支之前停下。推进分支用带旧值核对的 update-ref；最后只更新这几个文件的索引项。
   */
  private async commit(repo: string, request: Extract<GitOpRequest, { kind: 'commit' }>, hunkIds: readonly string[]) {
    const { branch, head } = await branchAndHead(repo);
    if (branch !== request.branch || head !== request.head) {
      return { status: 'stale' as const, detail: `分支或 HEAD 变了（卡片：${request.branch}@${request.head.slice(0, 10)}，现在：${branch ?? '分离 HEAD'}@${head.slice(0, 10)}），这张卡片作废，请重新让助手提出` };
    }
    const chosen = new Set(hunkIds);
    const selected: DiffHunk[] = splitDiff(request.hunks.filter((h) => chosen.has(h.id)).map((h) => h.patch).join(''));
    if (selected.length === 0) return { status: 'cancelled' as const, detail: '没有勾选任何改动块' };
    const paths = [...new Set(selected.map((h) => h.path))];
    const dir = this.scratch();
    const id = randomUUID();
    const patchFile = join(dir, `commit-${id}.patch`);
    const stagedFile = join(dir, `staged-${id}.patch`);
    const commitIndex = join(dir, `index-commit-${id}`);
    const keepIndex = join(dir, `index-keep-${id}`);
    try {
      writeFileSync(patchFile, joinHunks(selected));
      // 1. 提交树：HEAD + 选中的块
      await git(repo, ['read-tree', head], 60_000, { GIT_INDEX_FILE: commitIndex });
      await git(repo, ['apply', '--cached', '--whitespace=nowarn', patchFile], 60_000, { GIT_INDEX_FILE: commitIndex });
      const tree = (await git(repo, ['write-tree'], 60_000, { GIT_INDEX_FILE: commitIndex })).trim();
      // 2. 先在临时索引里试：新提交为底，重打你在这些文件上的暂存差异；打不上就停下，分支不动
      const commit = (await gitInput(repo, ['commit-tree', tree, '-p', head], request.message)).trim();
      writeFileSync(stagedFile, await git(repo, ['diff', '--cached', '--binary', head, '--', ...paths]));
      await git(repo, ['read-tree', commit], 60_000, { GIT_INDEX_FILE: keepIndex });
      const userStaged = (await git(repo, ['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only', head, '--', ...paths])).trim();
      if (userStaged) {
        const ok = await git(repo, ['apply', '--cached', '--whitespace=nowarn', stagedFile], 60_000, { GIT_INDEX_FILE: keepIndex }).then(() => true, () => false);
        if (!ok) {
          return {
            status: 'failed' as const,
            detail: `这些文件里你暂存的改动和要提交的块重叠，没法安全保留，没有提交：${userStaged.split('\n').join('、')}。可以先提交或取消暂存你的改动，或者只勾选不重叠的块，再让助手重新提出`,
          };
        }
      }
      // 3. 推进分支（旧值核对：期间有人动过就失败）
      await git(repo, ['update-ref', `refs/heads/${branch}`, commit, head]);
      // 4. 只更新这几个文件的索引项：新提交的内容，加上你原来暂存的差异
      const entries = (await git(repo, ['ls-files', '-s', '--', ...paths], 60_000, { GIT_INDEX_FILE: keepIndex })).trim();
      const present = new Set(entries.split('\n').filter(Boolean).map((l) => l.split('\t')[1]!));
      if (entries) await gitInput(repo, ['update-index', '--index-info'], `${entries}\n`);
      const gone = paths.filter((p) => !present.has(p));
      if (gone.length > 0) await git(repo, ['update-index', '--force-remove', '--', ...gone]);
      return { status: 'done' as const, detail: `已提交 ${commit.slice(0, 10)} 到 ${branch}（${selected.length} 个改动块，${paths.length} 个文件）` };
    } finally {
      for (const f of [patchFile, stagedFile, commitIndex, keepIndex]) rmSync(f, { force: true });
    }
  }

  /** 推送：只推预览时的那个提交；HEAD、推送地址、每个地址上分支的状态任一和预览时不同就作废。不强推（租约只用来核对远端没被别人动过）。 */
  private async push(repo: string, request: Extract<GitOpRequest, { kind: 'push' }>) {
    const { branch, head } = await branchAndHead(repo);
    if (branch !== request.branch || head !== request.head) {
      return {
        status: 'stale' as const,
        detail: `分支或 HEAD 变了（卡片：${request.branch}@${request.head.slice(0, 10)}，现在：${branch ?? '分离 HEAD'}@${head.slice(0, 10)}），只推你看过的提交，这张卡片作废，没有推送`,
      };
    }
    const urls = await pushUrls(repo, request.remote);
    if (urls.join('\n') !== request.targets.map((t) => t.url).join('\n')) {
      return { status: 'stale' as const, detail: `远端 ${request.remote} 的推送地址变了（现在是 ${urls.join('、')}），这张卡片作废，没有推送` };
    }
    for (const t of request.targets) {
      const now = await lsRemote(repo, t.url, request.remoteBranch);
      if (now !== t.remoteSha) {
        return {
          status: 'stale' as const,
          detail: `${t.url} 上的 ${request.remoteBranch} 变了（预览时 ${t.remoteSha?.slice(0, 10) ?? '没有这个分支'}，现在 ${now?.slice(0, 10) ?? '没有这个分支'}），这张卡片作废，没有推送`,
        };
      }
    }
    const ref = `refs/heads/${request.remoteBranch}`;
    const expect = request.targets[0]?.remoteSha ?? '';
    // 租约：远端这个分支必须还是预览时的样子（空值表示必须还不存在）；预览时已确认是快进，所以不会强推
    const out = await git(repo, ['push', '--porcelain', `--force-with-lease=${ref}:${expect}`, request.remote, `${request.head}:${ref}`], 300_000);
    const where = request.targets.map((t) => t.url).join('、');
    return { status: 'done' as const, detail: `已推送 ${request.head.slice(0, 10)}（${request.totalCommits} 个提交）到 ${where} 的 ${request.remoteBranch}${out.trim() ? `：${out.trim().slice(0, 300)}` : ''}` };
  }

  /** 本地合并：源和目标两边都还是预览时的提交才合并，合并的是那个源提交。 */
  private async merge(repo: string, request: Extract<GitOpRequest, { kind: 'merge' }>) {
    const now = async (name: string) => (await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]).catch(() => '')).trim();
    const sourceNow = await now(request.source);
    const targetNow = await now(request.target);
    if (sourceNow !== request.sourceSha || targetNow !== request.targetSha) {
      return {
        status: 'stale' as const,
        detail:
          `分支变了（预览时 ${request.source}@${request.sourceSha.slice(0, 10)} → ${request.target}@${request.targetSha.slice(0, 10)}，` +
          `现在 ${request.source}@${sourceNow.slice(0, 10) || '不存在'} → ${request.target}@${targetNow.slice(0, 10) || '不存在'}），这张卡片作废，没有合并`,
      };
    }
    const message = `Merge branch '${request.source}' into ${request.target}`;
    const { branch } = await branchAndHead(repo);
    if (branch === request.target) {
      // 合进当前分支：工作区要干净，否则会和你的改动搅在一起
      if ((await git(repo, ['status', '--porcelain'])).trim()) {
        return { status: 'failed' as const, detail: `目标分支 ${request.target} 就是当前分支，工作区里还有没提交的改动，没有合并；先提交或暂存后再试` };
      }
      const ok = await git(repo, ['merge', '--no-edit', '-m', message, request.sourceSha], 300_000).then(() => true, () => false);
      if (!ok) {
        const conflicts = (await git(repo, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim();
        await git(repo, ['merge', '--abort']).catch(() => {});
        return { status: 'failed' as const, detail: `合并冲突，已中止、没有改动：${conflicts.split('\n').join('、') || '（未知文件）'}` };
      }
      return { status: 'done' as const, detail: `已把 ${request.source}@${request.sourceSha.slice(0, 10)} 合进 ${request.target}（当前分支）` };
    }
    // 目标不是当前分支：在临时 worktree 里合并，成功后推进目标分支（旧值核对）
    const temp = join(this.scratch(), `merge-${randomUUID()}`);
    await git(repo, ['worktree', 'add', '--detach', temp, request.targetSha]);
    try {
      const ok = await git(temp, ['merge', '--no-edit', '-m', message, request.sourceSha], 300_000).then(() => true, () => false);
      if (!ok) {
        const conflicts = (await git(temp, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim();
        await git(temp, ['merge', '--abort']).catch(() => {});
        return { status: 'failed' as const, detail: `合并冲突，没有改动 ${request.target}：${conflicts.split('\n').join('、') || '（未知文件）'}` };
      }
      const merged = (await git(temp, ['rev-parse', 'HEAD'])).trim();
      await git(repo, ['update-ref', `refs/heads/${request.target}`, merged, request.targetSha]);
      return { status: 'done' as const, detail: `已把 ${request.source}@${request.sourceSha.slice(0, 10)} 合进 ${request.target}（${merged.slice(0, 10)}）` };
    } finally {
      await git(repo, ['worktree', 'remove', '--force', temp]).catch(() => rmSync(temp, { recursive: true, force: true }));
    }
  }

  /**
   * 恢复暂存区：先核对现在的暂存区还等于弹卡时的（之后你又暂存了就作废，不覆盖你刚做的）；
   * 再 read-tree 回这一轮开始前的 tree，只改索引，工作区文件不动；最后刷新一下文件状态缓存。
   */
  private async restoreIndex(repo: string, request: Extract<GitOpRequest, { kind: 'index' }>) {
    let now: string;
    try {
      now = await indexTree(repo, this.scratch());
    } catch (error) {
      return { status: 'failed' as const, detail: `${errorText(error)}，没有恢复` };
    }
    if (now !== request.after) {
      return { status: 'stale' as const, detail: '弹卡之后暂存区又变了（可能是你刚暂存或取消暂存了文件），这张卡片作废，没有恢复；现在的暂存区保持原样' };
    }
    await git(repo, ['read-tree', request.before]);
    await git(repo, ['update-index', '-q', '--refresh']).catch(() => {});
    return { status: 'done' as const, detail: `已把暂存区恢复到这一轮开始前（${request.paths.length} 个文件），工作区里的文件没动` };
  }

  /** 暂存区卡片处理完：项目还因为它暂停着就恢复写入。 */
  private resumeAfterIndex(op: GitOpRecord): GitOpRecord {
    const { store } = this.deps;
    if (store.tasks.getWorkspace(op.workspaceId)?.pausedReason?.startsWith(INDEX_PAUSE)) {
      this.deps.publish(store.tasks.setPaused(op.workspaceId, null).events);
      this.deps.kick?.();
    }
    this.deps.indexChanged?.(op.workspaceId);
    return op;
  }
}

/** remote 实际会写入的全部地址（配了 pushurl 时就是它们，可能有多个；没配时是 url）。 */
async function pushUrls(repo: string, remote: string): Promise<string[]> {
  return (await git(repo, ['remote', 'get-url', '--push', '--all', remote])).split('\n').map((l) => l.trim()).filter(Boolean);
}

/** 推送地址上这个分支现在的提交（ls-remote 现查；没有这个分支为 null）。 */
async function lsRemote(repo: string, url: string, branch: string): Promise<string | null> {
  const out = await git(repo, ['ls-remote', url, `refs/heads/${branch}`], 120_000).catch((error: unknown) => {
    throw new CodedError('bad_request', `查不到推送地址 ${url} 上的分支状态：${errorText(error, 300)}`);
  });
  const line = out.split('\n').find((l) => l.trim().endsWith(`refs/heads/${branch}`));
  return line ? line.split('\t')[0]!.trim() : null;
}

/** 要推 / 要合入的提交：最多列 50 条，另给总数。 */
async function commitList(repo: string, range: readonly string[]): Promise<{ commits: string[]; total: number }> {
  const total = Number((await git(repo, ['rev-list', '--count', ...range])).trim()) || 0;
  const commits = (await git(repo, ['log', '--oneline', '-n', '50', ...range])).trim().split('\n').filter(Boolean);
  return { commits, total };
}
