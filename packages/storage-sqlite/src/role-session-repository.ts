import type { RoleSessionKey, RoleSessionRecord, RoleSessionStorePort } from '@paldock/contracts';
import type { Clock } from './clock.js';
import type { Database } from './database.js';
import { newId } from './writes.js';

const COLUMNS = `id, workspace_id AS workspaceId, role, executor, native_thread_id AS nativeThreadId, status, turns, tokens, summary,
  retire_requested AS retireRequested, archived, created_at AS createdAt, last_used_at AS lastUsedAt, retired_at AS retiredAt`;
type Row = Omit<RoleSessionRecord, 'retireRequested' | 'archived'> & { retireRequested: number; archived: number };
const toRecord = (row: Row): RoleSessionRecord => ({ ...row, retireRequested: row.retireRequested === 1, archived: row.archived === 1 });

const SQL = {
  // role_sessions_open，条件逐字一致；先用最近用过的（上下文更新）
  open: `SELECT ${COLUMNS} FROM role_sessions WHERE workspace_id = ? AND role = ? AND executor = ? AND status <> 'retired' ORDER BY last_used_at DESC, created_at`,
  get: `SELECT ${COLUMNS} FROM role_sessions WHERE id = ?`,
  insert: `
    INSERT INTO role_sessions (id, workspace_id, role, executor, status, created_at, last_used_at) VALUES (?1, ?2, ?3, ?4, 'busy', ?5, ?5)
    RETURNING ${COLUMNS}`,
  lease: `UPDATE role_sessions SET status = 'busy', last_used_at = ?2 WHERE id = ?1 AND status = 'idle' RETURNING ${COLUMNS}`,
  release: `
    UPDATE role_sessions SET status = CASE status WHEN 'busy' THEN 'idle' ELSE status END, turns = turns + 1, tokens = tokens + ?2, last_used_at = ?3
     WHERE id = ?1 RETURNING ${COLUMNS}`,
  setThread: `UPDATE role_sessions SET native_thread_id = ?2 WHERE id = ?1`,
  requestRetire: `UPDATE role_sessions SET retire_requested = 1 WHERE id = ? AND status <> 'retired'`,
  retire: `UPDATE role_sessions SET status = 'retired', retired_at = ?2 WHERE id = ?1 AND status <> 'retired'`,
  setSummary: `UPDATE role_sessions SET summary = ?2 WHERE id = ?1`,
  markArchived: `UPDATE role_sessions SET archived = 1 WHERE id = ?`,
  // role_sessions_summary
  latestSummary: `
    SELECT summary FROM role_sessions WHERE workspace_id = ? AND role = ? AND executor = ? AND summary IS NOT NULL
     ORDER BY retired_at IS NULL, retired_at DESC LIMIT 1`,
  releaseAll: `UPDATE role_sessions SET status = 'idle' WHERE status = 'busy'`,
} as const;

/** 角色会话池的存储：占用 / 放回用条件更新，同一会话同一时刻只有一个 turn。 */
export class RoleSessionRepository implements RoleSessionStorePort {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  open({ workspaceId, role, executor }: RoleSessionKey): RoleSessionRecord[] {
    return this.db.all<Row>(SQL.open, workspaceId, role, executor).map(toRecord);
  }

  get(id: string): RoleSessionRecord | undefined {
    const row = this.db.get<Row>(SQL.get, id);
    return row && toRecord(row);
  }

  create({ workspaceId, role, executor }: RoleSessionKey): RoleSessionRecord {
    return toRecord(this.db.get<Row>(SQL.insert, newId('rs'), workspaceId, role, executor, this.clock.iso())!);
  }

  lease(id: string): RoleSessionRecord | undefined {
    const row = this.db.get<Row>(SQL.lease, id, this.clock.iso());
    return row && toRecord(row);
  }

  release(id: string, tokens: number): RoleSessionRecord | undefined {
    const row = this.db.get<Row>(SQL.release, id, Math.max(0, Math.round(tokens)), this.clock.iso());
    return row && toRecord(row);
  }

  setThread(id: string, threadId: string): void {
    this.db.run(SQL.setThread, id, threadId);
  }

  requestRetire(id: string): void {
    this.db.run(SQL.requestRetire, id);
  }

  retire(id: string): void {
    this.db.run(SQL.retire, id, this.clock.iso());
  }

  setSummary(id: string, summary: string): void {
    this.db.run(SQL.setSummary, id, summary);
  }

  markArchived(id: string): void {
    this.db.run(SQL.markArchived, id);
  }

  latestSummary({ workspaceId, role, executor }: RoleSessionKey): string | null {
    return this.db.get<{ summary: string }>(SQL.latestSummary, workspaceId, role, executor)?.summary ?? null;
  }

  releaseAll(): void {
    this.db.run(SQL.releaseAll);
  }
}
