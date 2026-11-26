import type { Change } from './storage.js';

/**
 * 默认在当前仓库协作（2026-11-26 已定，0.3.6）：快照、写入记录、提交 / 推送 / 合并卡片。
 */

/** 一次 Run 在项目目录里的前后快照（git tree，临时索引写的）和开始时的分支、HEAD。 */
export interface RunSnapshotRecord {
  runId: string;
  workspaceId: string;
  branch: string | null;
  head: string;
  startTree: string;
  endTree: string | null;
  createdAt: string;
  endedAt: string | null;
}

/**
 * 助手的一次写入（执行器报告的）：patch 为统一补丁；replace 为 {old,new}；content 为写入的全文。
 * beforeHash：整文件写入时，写之前文件内容（LF）的 sha1，文件不存在为 'absent'；重放时据此确认期间没人改过（0.3.7）。
 */
export interface RunWriteRecord {
  id: number;
  runId: string;
  path: string;
  kind: 'patch' | 'replace' | 'content';
  detail: string;
  beforeHash: string | null;
  createdAt: string;
}

/** 带所属任务的快照（提交卡片按任务 / 对话筛选候选改动）。 */
export type TaskSnapshot = RunSnapshotRecord & { taskId: string };

/** index：这一轮里暂存区变了（0.3.7），由你选择保留或恢复。 */
export type GitOpKind = 'commit' | 'push' | 'merge' | 'index';
export type GitOpStatus = 'proposed' | 'done' | 'failed' | 'cancelled' | 'stale';

/**
 * 拟提交的一个改动块。evidenced：块里每一行都是范围内助手自己的改动（重放它的写入核对上了），默认勾选；
 * note：给你看的归属说明（为什么勾或不勾）。
 */
export interface CommitHunk {
  id: string;
  path: string;
  /** 统一补丁里这个块的文本（含 @@ 行）。 */
  patch: string;
  evidenced: boolean;
  note: string;
  /** 这个文件里你已经暂存了内容。 */
  stagedByUser: boolean;
}

/** 提交卡片的范围（0.3.7）：默认这个对话发起的任务；指定任务时只看这个任务；整个项目只在你明确要求时用。 */
export interface CommitScope {
  kind: 'task' | 'session' | 'project';
  label: string;
  taskIds: string[];
}

/** 推送卡片上的一个实际写入地址（remote 的 pushurl，可能有多个）和预览时它上面这个分支的提交（没有这个分支为 null）。 */
export interface PushTarget {
  url: string;
  remoteSha: string | null;
}

export type GitOpRequest =
  | { kind: 'commit'; message: string; branch: string; head: string; scope: CommitScope; hunks: CommitHunk[]; staged: string[] }
  | {
      kind: 'push';
      remote: string;
      /** 实际会写入的全部地址（git remote get-url --push --all）。 */
      targets: PushTarget[];
      branch: string;
      remoteBranch: string;
      /** 预览时的本地提交：确认后推的就是它，不是确认那一刻的分支。 */
      head: string;
      commits: string[];
      totalCommits: number;
    }
  | { kind: 'merge'; source: string; target: string; sourceSha: string; targetSha: string; commits: string[]; totalCommits: number; fastForward: boolean }
  | {
      kind: 'index';
      runId: string;
      /** 这一轮开始前和结束时暂存区的 tree（临时复制索引后 git write-tree）。 */
      before: string;
      after: string;
      /** 暂存状态变了的文件。 */
      paths: string[];
    };

export interface GitOpRecord {
  id: string;
  workspaceId: string;
  sessionId: string | null;
  runId: string | null;
  kind: GitOpKind;
  status: GitOpStatus;
  request: GitOpRequest;
  /** 执行结果或失败原因。 */
  result: string | null;
  version: number;
  createdAt: string;
  decidedAt: string | null;
}

export interface GitStorePort {
  startSnapshot(input: Omit<RunSnapshotRecord, 'endTree' | 'createdAt' | 'endedAt'>): void;
  endSnapshot(runId: string, endTree: string): void;
  snapshot(runId: string): RunSnapshotRecord | undefined;
  /** 项目里最近的快照（按时间，最多 limit 个），带所属任务。 */
  snapshotsOfWorkspace(workspaceId: string, limit: number): TaskSnapshot[];
  /** 同一任务里最近一次 Run 的快照（分支保护：每轮开始前核对分支）。 */
  lastSnapshotOfTask(taskId: string): RunSnapshotRecord | undefined;
  addWrite(input: Omit<RunWriteRecord, 'id' | 'createdAt' | 'beforeHash'> & { beforeHash?: string | null }): void;
  writesOfRuns(runIds: readonly string[]): RunWriteRecord[];
  proposeOp(input: { workspaceId: string; sessionId: string | null; runId: string | null; request: GitOpRequest }): Change<GitOpRecord>;
  getOp(id: string): GitOpRecord | undefined;
  /** 带版本结束一张卡片（先到者为准）。 */
  finishOp(id: string, expectedVersion: number, status: Exclude<GitOpStatus, 'proposed'>, result: string | null): Change<GitOpRecord>;
  opsOfSession(sessionId: string, limit: number): GitOpRecord[];
  openOps(workspaceId: string): GitOpRecord[];
}
