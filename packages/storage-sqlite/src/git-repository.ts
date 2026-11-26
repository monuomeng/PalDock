import {
  CodedError,
  type Change,
  type GitOpRecord,
  type GitOpRequest,
  type GitOpStatus,
  type GitStorePort,
  type RunSnapshotRecord,
  type RunWriteRecord,
} from '@paldock/contracts';
import type { Clock } from './clock.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import { newId } from './writes.js';

const SNAPSHOT = `run_id AS runId, workspace_id AS workspaceId, branch, head, start_tree AS startTree, end_tree AS endTree,
  created_at AS createdAt, ended_at AS endedAt`;
const OP = `id, workspace_id AS workspaceId, session_id AS sessionId, run_id AS runId, kind, status, request, result, version,
  created_at AS createdAt, decided_at AS decidedAt`;
type OpRow = Omit<GitOpRecord, 'request'> & { request: string };
const toOp = (row: OpRow): GitOpRecord => ({ ...row, request: JSON.parse(row.request) as GitOpRequest });

const SQL = {
  startSnapshot: `INSERT OR REPLACE INTO run_snapshots (run_id, workspace_id, branch, head, start_tree, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  endSnapshot: `UPDATE run_snapshots SET end_tree = ?2, ended_at = ?3 WHERE run_id = ?1`,
  snapshot: `SELECT ${SNAPSHOT} FROM run_snapshots WHERE run_id = ?`,
  // run_snapshots_by_workspace
  snapshotsSince: `SELECT ${SNAPSHOT} FROM run_snapshots WHERE workspace_id = ?1 AND (?2 IS NULL OR created_at > ?2) ORDER BY created_at`,
  addWrite: `INSERT INTO run_writes (run_id, path, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)`,
  insertOp: `
    INSERT INTO git_ops (id, workspace_id, session_id, run_id, kind, status, request, created_at)
    VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?) RETURNING ${OP}`,
  getOp: `SELECT ${OP} FROM git_ops WHERE id = ?`,
  finishOp: `
    UPDATE git_ops SET status = ?2, result = ?3, decided_at = ?4, version = version + 1
     WHERE id = ?1 AND version = ?5 AND status = 'proposed' RETURNING ${OP}`,
  // git_ops_by_session，取最近的
  opsOfSession: `SELECT * FROM (SELECT ${OP} FROM git_ops WHERE session_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY createdAt`,
  // git_ops_open
  openOps: `SELECT ${OP} FROM git_ops WHERE workspace_id = ? AND status = 'proposed' ORDER BY created_at`,
  lastCommit: `SELECT ${OP} FROM git_ops WHERE workspace_id = ? AND kind = 'commit' AND status = 'done' ORDER BY decided_at DESC LIMIT 1`,
} as const;

/** 快照、写入记录、提交 / 推送 / 合并卡片（默认在当前仓库协作，2026-11-26 已定）。 */
export class GitRepository implements GitStorePort {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly clock: Clock,
  ) {}

  startSnapshot(input: Omit<RunSnapshotRecord, 'endTree' | 'createdAt' | 'endedAt'>): void {
    this.db.run(SQL.startSnapshot, input.runId, input.workspaceId, input.branch, input.head, input.startTree, this.clock.iso());
  }

  endSnapshot(runId: string, endTree: string): void {
    this.db.run(SQL.endSnapshot, runId, endTree, this.clock.iso());
  }

  snapshot(runId: string): RunSnapshotRecord | undefined {
    return this.db.get<RunSnapshotRecord>(SQL.snapshot, runId);
  }

  snapshotsSince(workspaceId: string, since: string | null): RunSnapshotRecord[] {
    return this.db.all<RunSnapshotRecord>(SQL.snapshotsSince, workspaceId, since);
  }

  addWrite(input: Omit<RunWriteRecord, 'id' | 'createdAt'>): void {
    this.db.run(SQL.addWrite, input.runId, input.path, input.kind, input.detail.slice(0, 200_000), this.clock.iso());
  }

  writesOfRuns(runIds: readonly string[]): RunWriteRecord[] {
    if (runIds.length === 0) return [];
    const marks = runIds.map(() => '?').join(', ');
    return this.db.all<RunWriteRecord>(
      `SELECT id, run_id AS runId, path, kind, detail, created_at AS createdAt FROM run_writes WHERE run_id IN (${marks}) ORDER BY id`,
      ...runIds,
    );
  }

  proposeOp(input: { workspaceId: string; sessionId: string | null; runId: string | null; request: GitOpRequest }): Change<GitOpRecord> {
    return this.db.transaction(() => {
      const op = toOp(
        this.db.get<OpRow>(SQL.insertOp, newId('git'), input.workspaceId, input.sessionId, input.runId, input.request.kind, JSON.stringify(input.request), this.clock.iso())!,
      );
      return { record: op, events: [this.events.append(op.id, { type: 'git.proposed', payload: { kind: op.kind, workspaceId: op.workspaceId, sessionId: op.sessionId } })] };
    });
  }

  getOp(id: string): GitOpRecord | undefined {
    const row = this.db.get<OpRow>(SQL.getOp, id);
    return row && toOp(row);
  }

  finishOp(id: string, expectedVersion: number, status: Exclude<GitOpStatus, 'proposed'>, result: string | null): Change<GitOpRecord> {
    return this.db.transaction(() => {
      const row = this.db.get<OpRow>(SQL.finishOp, id, status, result, this.clock.iso(), expectedVersion);
      if (!row) throw new CodedError(this.getOp(id) ? 'conflict' : 'not_found', '这张卡片已经处理过或已被修改，请刷新');
      return { record: toOp(row), events: [this.events.append(id, { type: 'git.finished', payload: { status } })] };
    });
  }

  opsOfSession(sessionId: string, limit: number): GitOpRecord[] {
    return this.db.all<OpRow>(SQL.opsOfSession, sessionId, limit).map(toOp);
  }

  openOps(workspaceId: string): GitOpRecord[] {
    return this.db.all<OpRow>(SQL.openOps, workspaceId).map(toOp);
  }

  lastCommit(workspaceId: string): GitOpRecord | undefined {
    const row = this.db.get<OpRow>(SQL.lastCommit, workspaceId);
    return row && toOp(row);
  }
}
