import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodedError, type CommitHunk, type GitOpRecord, type GitOpRequest, type PersistentEvent, type StorePort } from '@paldock/contracts';
import { evidenceOf, isEvidenced, joinHunks, splitDiff, type DiffHunk } from '@paldock/domain';
import { branchAndHead, git, gitInput, snapshotTree, treeChangedFiles } from './git.js';
import { errorText } from './util.js';

export interface GitOpsDeps {
  store: StorePort;
  dataRoot: string;
  publish(events: PersistentEvent[]): void;
  log(message: string): void;
}

/**
 * 提交、推送、合并分开指挥（默认在当前仓库协作，2026-11-26 已定）。助手只能提出卡片，你在桌面上确认后才由宿主执行；
 * 执行前再核对一次分支和 HEAD，变了就作废。只在当前工作区方式的项目里用。
 * - 提交：只提交你勾选的改动块（默认只勾能用助手写入记录核对上的），你原来暂存的内容提交后仍是暂存状态，工作区不动。
 * - 推送：当前分支推到它的上游（或指定的远端分支），不强推，用本机已有的 git 凭据。
 * - 合并：本地合并（远端 PR 以后再做），冲突不落地、交给你。
 */
export class GitOpsService {
  constructor(private readonly deps: GitOpsDeps) {}

  private scratch(): string {
    const dir = join(this.deps.dataRoot, 'tmp');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 协调助手这次 Run 所在的项目（必须是当前工作区方式）和主会话。 */
  private contextOf(runId: string): { workspaceId: string; repo: string; sessionId: string | null } {
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
    return { workspaceId: workspace.id, repo: workspace.rootPath, sessionId: run.sessionId };
  }

  private propose(ctx: { workspaceId: string; sessionId: string | null }, runId: string, request: GitOpRequest): GitOpRecord {
    const { record, events } = this.deps.store.git.proposeOp({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, runId, request });
    this.deps.publish(events);
    return record;
  }

  // ---- 提交 ----

  /** 拟提交：上次提交之后各次 Run 改过的文件，相对 HEAD 的改动块；有写入证据的默认勾选，其余「本轮期间发生的改动」默认不勾。 */
  async proposeCommit(runId: string, message: string): Promise<GitOpRecord> {
    const ctx = this.contextOf(runId);
    const { store } = this.deps;
    const { branch, head } = await branchAndHead(ctx.repo);
    if (!branch) throw new CodedError('bad_request', '当前是分离 HEAD，请先切到一个分支再提交');
    const since = store.git.lastCommit(ctx.workspaceId)?.decidedAt ?? null;
    const snapshots = store.git.snapshotsSince(ctx.workspaceId, since).filter((s) => s.endTree);
    const files = new Set<string>();
    for (const s of snapshots) for (const f of await treeChangedFiles(ctx.repo, s.startTree, s.endTree!)) files.add(f);
    if (files.size === 0) throw new CodedError('bad_request', '没有找到助手上次提交之后的改动');
    const now = await snapshotTree(ctx.repo, this.scratch());
    const patch = await git(ctx.repo, ['diff', '--no-color', '--binary', '-U1', head, now, '--', ...files]);
    const hunks = splitDiff(patch);
    if (hunks.length === 0) throw new CodedError('bad_request', '这些文件相对 HEAD 已经没有改动');
    const evidence = evidenceOf(store.git.writesOfRuns(snapshots.map((s) => s.runId)));
    const staged = (await git(ctx.repo, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter((f) => f !== '');
    const stagedSet = new Set(staged);
    const items: CommitHunk[] = hunks.map((h) => ({ id: h.id, path: h.path, patch: h.header + h.body, evidenced: isEvidenced(h, evidence), stagedByUser: stagedSet.has(h.path) }));
    return this.propose(ctx, runId, { kind: 'commit', message, branch, head, hunks: items, staged });
  }

  // ---- 推送 ----

  async proposePush(runId: string, remote?: string, remoteBranch?: string): Promise<GitOpRecord> {
    const ctx = this.contextOf(runId);
    const { branch } = await branchAndHead(ctx.repo);
    if (!branch) throw new CodedError('bad_request', '当前是分离 HEAD，没有可推送的分支');
    const upstream = (await git(ctx.repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
    const [upRemote, ...upBranch] = upstream ? upstream.split('/') : [];
    const target = remote ?? upRemote ?? 'origin';
    const targetBranch = remoteBranch ?? (upBranch.length > 0 ? upBranch.join('/') : branch);
    const remoteUrl = (await git(ctx.repo, ['remote', 'get-url', target]).catch(() => {
      throw new CodedError('bad_request', `没有名为 ${target} 的远端`);
    })).trim();
    const known = await git(ctx.repo, ['rev-parse', '--verify', '-q', `refs/remotes/${target}/${targetBranch}`]).then(() => true, () => false);
    const commits = (await git(ctx.repo, ['log', '--oneline', '-n', '50', known ? `${target}/${targetBranch}..HEAD` : 'HEAD'])).trim().split('\n').filter(Boolean);
    return this.propose(ctx, runId, { kind: 'push', remote: target, remoteUrl, branch, remoteBranch: targetBranch, commits });
  }

  // ---- 合并 ----

  async proposeMerge(runId: string, source: string, target: string): Promise<GitOpRecord> {
    const ctx = this.contextOf(runId);
    for (const name of [source, target]) {
      await git(ctx.repo, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]).catch(() => {
        throw new CodedError('bad_request', `没有本地分支 ${name}`);
      });
    }
    const commits = (await git(ctx.repo, ['log', '--oneline', '-n', '50', `${target}..${source}`])).trim().split('\n').filter(Boolean);
    const fastForward = await git(ctx.repo, ['merge-base', '--is-ancestor', target, source]).then(() => true, () => false);
    return this.propose(ctx, runId, { kind: 'merge', source, target, commits, fastForward });
  }

  // ---- 你的决定 ----

  /** 确认或取消一张卡片（带版本，先到者为准）；确认时提交卡片要给出勾选的改动块。 */
  async decide(opId: string, expectedVersion: number, decision: 'confirm' | 'cancel', hunkIds: readonly string[] = []): Promise<GitOpRecord> {
    const { store } = this.deps;
    const op = store.git.getOp(opId);
    if (!op) throw new CodedError('not_found', '卡片不存在');
    if (op.status !== 'proposed' || op.version !== expectedVersion) throw new CodedError('conflict', '这张卡片已经处理过，请刷新');
    if (decision === 'cancel') return this.finish(op, 'cancelled', '你取消了');
    const repo = store.tasks.getWorkspace(op.workspaceId)!.rootPath;
    try {
      const result =
        op.request.kind === 'commit'
          ? await this.commit(repo, op.request, hunkIds)
          : op.request.kind === 'push'
            ? await this.push(repo, op.request)
            : await this.merge(repo, op.request);
      return this.finish(op, result.status, result.detail);
    } catch (error) {
      if (error instanceof CodedError) throw error;
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
      const userStaged = (await git(repo, ['diff', '--cached', '--name-only', head, '--', ...paths])).trim();
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

  private async push(repo: string, request: Extract<GitOpRequest, { kind: 'push' }>) {
    const { branch } = await branchAndHead(repo);
    if (branch !== request.branch) return { status: 'stale' as const, detail: `当前分支是 ${branch ?? '分离 HEAD'}，不是卡片上的 ${request.branch}，没有推送` };
    const url = (await git(repo, ['remote', 'get-url', request.remote])).trim();
    if (url !== request.remoteUrl) return { status: 'stale' as const, detail: `远端 ${request.remote} 的地址变了（现在是 ${url}），没有推送` };
    // 不强推；远端的保护规则拒绝时如实报错
    const out = await git(repo, ['push', request.remote, `refs/heads/${branch}:refs/heads/${request.remoteBranch}`], 300_000);
    return { status: 'done' as const, detail: `已推送 ${branch} → ${request.remote}/${request.remoteBranch}${out.trim() ? `：${out.trim().slice(0, 300)}` : ''}` };
  }

  private async merge(repo: string, request: Extract<GitOpRequest, { kind: 'merge' }>) {
    const { branch } = await branchAndHead(repo);
    if (branch === request.target) {
      // 合进当前分支：工作区要干净，否则会和你的改动搅在一起
      if ((await git(repo, ['status', '--porcelain'])).trim()) {
        return { status: 'failed' as const, detail: `目标分支 ${request.target} 就是当前分支，工作区里还有没提交的改动，没有合并；先提交或暂存后再试` };
      }
      const ok = await git(repo, ['merge', '--no-edit', request.source], 300_000).then(() => true, () => false);
      if (!ok) {
        const conflicts = (await git(repo, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim();
        await git(repo, ['merge', '--abort']).catch(() => {});
        return { status: 'failed' as const, detail: `合并冲突，已中止、没有改动：${conflicts.split('\n').join('、') || '（未知文件）'}` };
      }
      return { status: 'done' as const, detail: `已把 ${request.source} 合进 ${request.target}（当前分支）` };
    }
    // 目标不是当前分支：在临时 worktree 里合并，成功后推进目标分支
    const old = (await git(repo, ['rev-parse', `refs/heads/${request.target}`])).trim();
    const temp = join(this.scratch(), `merge-${randomUUID()}`);
    await git(repo, ['worktree', 'add', '--detach', temp, old]);
    try {
      const ok = await git(temp, ['merge', '--no-edit', request.source], 300_000).then(() => true, () => false);
      if (!ok) {
        const conflicts = (await git(temp, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim();
        await git(temp, ['merge', '--abort']).catch(() => {});
        return { status: 'failed' as const, detail: `合并冲突，没有改动 ${request.target}：${conflicts.split('\n').join('、') || '（未知文件）'}` };
      }
      const merged = (await git(temp, ['rev-parse', 'HEAD'])).trim();
      await git(repo, ['update-ref', `refs/heads/${request.target}`, merged, old]);
      return { status: 'done' as const, detail: `已把 ${request.source} 合进 ${request.target}（${merged.slice(0, 10)}）` };
    } finally {
      await git(repo, ['worktree', 'remove', '--force', temp]).catch(() => rmSync(temp, { recursive: true, force: true }));
    }
  }
}
