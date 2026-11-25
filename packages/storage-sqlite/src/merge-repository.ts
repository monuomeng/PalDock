import { CodedError, type MergeOpRecord, type MergePhase, type MergeStorePort, type NewMergeOp } from '@paldock/contracts';
import type { Clock } from './clock.js';
import { COLUMNS } from './columns.js';
import type { Database } from './database.js';
import { newId } from './writes.js';

type MergeRow = Omit<MergeOpRecord, 'conflictFiles'> & { conflictFiles: string | null };
const toMerge = (row: MergeRow): MergeOpRecord => ({ ...row, conflictFiles: row.conflictFiles === null ? null : (JSON.parse(row.conflictFiles) as string[]) });

/** 没结束的阶段；与部分索引 merge_ops_open 的条件逐字一致。 */
const OPEN = `phase IN ('started', 'candidate')`;

const SQL = {
  insert: `
    INSERT INTO merge_ops (id, task_id, subtask_id, source_sha, target_old, phase, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 'started', ?6, ?6)
    RETURNING ${COLUMNS.merge()}`,
  advance: `
    UPDATE merge_ops SET phase = ?2, candidate_sha = coalesce(?3, candidate_sha), conflict_files = coalesce(?4, conflict_files),
           detail = coalesce(?5, detail), updated_at = ?6
     WHERE id = ?1 AND ${OPEN}
    RETURNING ${COLUMNS.merge()}`,
  // merge_ops_by_subtask 倒序取一条
  latestOf: `SELECT ${COLUMNS.merge()} FROM merge_ops WHERE subtask_id = ? ORDER BY created_at DESC LIMIT 1`,
  get: `SELECT ${COLUMNS.merge()} FROM merge_ops WHERE id = ?`,
  // merge_ops_open，条件逐字一致
  open: `SELECT ${COLUMNS.merge()} FROM merge_ops WHERE ${OPEN} ORDER BY created_at`,
} as const;

/**
 * 合并操作记录：只记 Git 操作的进度，不改子任务状态（那由调用方在同一事务里做）。
 * 先写 started 再动 Git，阶段只能往后走，结束后不再改。
 */
export class MergeRepository implements MergeStorePort {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  start(input: NewMergeOp): MergeOpRecord {
    return toMerge(this.db.get<MergeRow>(SQL.insert, newId('merge'), input.taskId, input.subtaskId, input.sourceSha, input.targetOld, this.clock.iso())!);
  }

  advance(id: string, phase: MergePhase, fields: { candidateSha?: string; conflictFiles?: string[]; detail?: string } = {}): MergeOpRecord {
    const row = this.db.get<MergeRow>(
      SQL.advance,
      id,
      phase,
      fields.candidateSha ?? null,
      fields.conflictFiles ? JSON.stringify(fields.conflictFiles) : null,
      fields.detail ?? null,
      this.clock.iso(),
    );
    if (!row) throw new CodedError('conflict', '合并操作不存在或已结束');
    return toMerge(row);
  }

  get(id: string): MergeOpRecord | undefined {
    const row = this.db.get<MergeRow>(SQL.get, id);
    return row && toMerge(row);
  }

  open(): MergeOpRecord[] {
    return this.db.all<MergeRow>(SQL.open).map(toMerge);
  }

  latestOf(subtaskId: string): MergeOpRecord | undefined {
    const row = this.db.get<MergeRow>(SQL.latestOf, subtaskId);
    return row && toMerge(row);
  }
}
