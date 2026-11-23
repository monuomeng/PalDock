import {
  PersistentEvent,
  SCHEMA_VERSION,
  type PersistentEvent as PersistentEventT,
  type PersistentEventBody,
} from '@paldock/contracts';
import type { Database } from './database.js';

const INSERT = `
  INSERT INTO events (aggregate_id, type, payload, schema_version, occurred_at)
  VALUES (?, ?, ?, ?, ?)
  RETURNING seq`;

const SELECT_SINCE = `
  SELECT seq, aggregate_id, type, payload, schema_version, occurred_at
    FROM events
   WHERE seq > ?
   ORDER BY seq
   LIMIT ?`;

interface EventRow {
  seq: number;
  aggregate_id: string;
  type: string;
  payload: string;
  schema_version: number;
  occurred_at: string;
}

/**
 * 持久事件日志。append 必须在调用方的事务里执行，与状态表更新同时提交；
 * 返回的完整事件直接用于广播，不再回查。
 */
export class EventLog {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  append(aggregateId: string, body: PersistentEventBody): PersistentEventT {
    const occurredAt = this.now().toISOString();
    const row = this.db.get<{ seq: number }>(INSERT, aggregateId, body.type, JSON.stringify(body.payload), SCHEMA_VERSION, occurredAt)!;
    return { schemaVersion: SCHEMA_VERSION, seq: row.seq, aggregateId, occurredAt, ...body };
  }

  /** 断线续拉：读库时再按契约校验一次，旧版本或损坏的行会在这里暴露。 */
  since(afterSeq: number, limit: number): PersistentEventT[] {
    return this.db.all<EventRow>(SELECT_SINCE, afterSeq, limit).map((r) =>
      PersistentEvent.parse({
        schemaVersion: r.schema_version,
        seq: r.seq,
        aggregateId: r.aggregate_id,
        occurredAt: r.occurred_at,
        type: r.type,
        payload: JSON.parse(r.payload),
      }),
    );
  }
}
