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

/** 助手的一次写入（执行器报告的）：patch 为统一补丁；replace 为 {old,new}；content 为写入的全文。 */
export interface RunWriteRecord {
  id: number;
  runId: string;
  path: string;
  kind: 'patch' | 'replace' | 'content';
  detail: string;
  createdAt: string;
}

export type GitOpKind = 'commit' | 'push' | 'merge';
export type GitOpStatus = 'proposed' | 'done' | 'failed' | 'cancelled' | 'stale';

/** 拟提交的一个改动块。evidenced：能用助手的写入记录核对上内容（默认勾选）。 */
export interface CommitHunk {
  id: string;
  path: string;
  /** 统一补丁里这个块的文本（含 @@ 行）。 */
  patch: string;
  evidenced: boolean;
  /** 这个文件里你已经暂存了内容。 */
  stagedByUser: boolean;
}

export type GitOpRequest =
  | { kind: 'commit'; message: string; branch: string; head: string; hunks: CommitHunk[]; staged: string[] }
  | { kind: 'push'; remote: string; remoteUrl: string; branch: string; remoteBranch: string; commits: string[] }
  | { kind: 'merge'; source: string; target: string; commits: string[]; fastForward: boolean };

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
  /** 项目里 since 之后开始的 Run 的快照（按时间）。 */
  snapshotsSince(workspaceId: string, since: string | null): RunSnapshotRecord[];
  addWrite(input: Omit<RunWriteRecord, 'id' | 'createdAt'>): void;
  writesOfRuns(runIds: readonly string[]): RunWriteRecord[];
  proposeOp(input: { workspaceId: string; sessionId: string | null; runId: string | null; request: GitOpRequest }): Change<GitOpRecord>;
  getOp(id: string): GitOpRecord | undefined;
  /** 带版本结束一张卡片（先到者为准）。 */
  finishOp(id: string, expectedVersion: number, status: Exclude<GitOpStatus, 'proposed'>, result: string | null): Change<GitOpRecord>;
  opsOfSession(sessionId: string, limit: number): GitOpRecord[];
  openOps(workspaceId: string): GitOpRecord[];
  /** 项目里最近一次成功的提交（之后的 Run 算「这次的改动」）。 */
  lastCommit(workspaceId: string): GitOpRecord | undefined;
}
