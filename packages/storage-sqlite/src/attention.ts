import type { AttentionItem, AttentionKind } from '@paldock/contracts';
import type { Clock } from './clock.js';
import type { Database } from './database.js';

const SQL = {
  list: `
    SELECT i.kind, i.item_id AS itemId, i.task_id AS taskId, i.run_id AS runId, i.title, i.reason, i.since, r.item_id IS NOT NULL AS read
      FROM attention_items AS i
      LEFT JOIN attention_reads AS r ON r.item_kind = i.kind AND r.item_id = i.item_id
     ORDER BY i.since`,
  markRead: `
    INSERT INTO attention_reads (item_kind, item_id, read_at) VALUES (?, ?, ?)
    ON CONFLICT (item_kind, item_id) DO NOTHING`,
} as const;

/**
 * 「待我处理」：列表由业务状态实时派生，只有已读单独存储。
 * 已读不改变待办本身；审批决定、验收完成或退回后，对应条目自然从视图消失。
 */
export class AttentionQueries {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  list(): AttentionItem[] {
    return this.db.all<Omit<AttentionItem, 'read'> & { read: number }>(SQL.list).map((row) => ({
      ...row,
      read: row.read === 1,
    }));
  }

  markRead(kind: AttentionKind, itemId: string): void {
    this.db.run(SQL.markRead, kind, itemId, this.clock.iso());
  }
}
