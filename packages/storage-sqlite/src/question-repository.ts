import { CodedError, type Change, type QuestionDelivery, type QuestionItem, type QuestionRecord, type QuestionStatus, type QuestionStorePort } from '@paldock/contracts';
import type { Clock } from './clock.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import { newId } from './writes.js';

const COLS = `id, session_id AS sessionId, run_id AS runId, message_id AS messageId, author, text, items, status, delivery,
  escalated_at AS escalatedAt, result, version, created_at AS createdAt, closed_at AS closedAt`;
type Row = Omit<QuestionRecord, 'items'> & { items: string };
const toRecord = (row: Row): QuestionRecord => ({ ...row, items: JSON.parse(row.items) as QuestionItem[] });

/** 协调助手在对话里问你的问题（0.3.8）。 */
export class QuestionRepository implements QuestionStorePort {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly clock: Clock,
  ) {}

  create(input: Omit<QuestionRecord, 'id' | 'status' | 'escalatedAt' | 'result' | 'version' | 'createdAt' | 'closedAt'>): Change<QuestionRecord> {
    return this.db.transaction(() => {
      if (this.openOf(input.sessionId)) throw new CodedError('conflict', '这个对话里已经有一个问题在等回答');
      const row = this.db.get<Row>(
        `INSERT INTO approval_questions (id, session_id, run_id, message_id, author, text, items, status, delivery, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?) RETURNING ${COLS}`,
        newId('q'),
        input.sessionId,
        input.runId,
        input.messageId,
        input.author,
        input.text,
        JSON.stringify(input.items),
        input.delivery,
        this.clock.iso(),
      )!;
      const record = toRecord(row);
      // 不改审批的版本：标上问题编号只是归属，不算审批本身的变化
      for (const item of record.items) if (item.kind === 'approval') this.db.run(`UPDATE approvals SET question_id = ? WHERE id = ? AND status = 'pending'`, record.id, item.ref);
      return { record, events: [this.events.append(record.id, { type: 'question.created', payload: { sessionId: record.sessionId, author: record.author } })] };
    });
  }

  get(id: string): QuestionRecord | undefined {
    const row = this.db.get<Row>(`SELECT ${COLS} FROM approval_questions WHERE id = ?`, id);
    return row && toRecord(row);
  }

  openOf(sessionId: string): QuestionRecord | undefined {
    const row = this.db.get<Row>(`SELECT ${COLS} FROM approval_questions WHERE session_id = ? AND status = 'open'`, sessionId);
    return row && toRecord(row);
  }

  byMessage(messageId: number): QuestionRecord | undefined {
    const row = this.db.get<Row>(`SELECT ${COLS} FROM approval_questions WHERE message_id = ?`, messageId);
    return row && toRecord(row);
  }

  ofSession(sessionId: string, limit: number): QuestionRecord[] {
    return this.db
      .all<Row>(`SELECT * FROM (SELECT ${COLS} FROM approval_questions WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY createdAt`, sessionId, limit)
      .map(toRecord);
  }

  allOpen(): QuestionRecord[] {
    return this.db.all<Row>(`SELECT ${COLS} FROM approval_questions WHERE status = 'open' ORDER BY created_at`).map(toRecord);
  }

  close(id: string, expectedVersion: number, status: Exclude<QuestionStatus, 'open'>, result: string | null, decidedRefs: readonly string[]): Change<QuestionRecord> {
    return this.db.transaction(() => {
      const row = this.db.get<Row>(
        `UPDATE approval_questions SET status = ?2, result = ?3, closed_at = ?4, version = version + 1
          WHERE id = ?1 AND version = ?5 AND status = 'open' RETURNING ${COLS}`,
        id,
        status,
        result,
        this.clock.iso(),
        expectedVersion,
      );
      if (!row) throw new CodedError(this.get(id) ? 'conflict' : 'not_found', '这个问题已经处理过了');
      const record = toRecord(row);
      // 没有在这次执行的审批回到队列（之后再问）；执行了的保留问题编号作记录
      const decided = new Set(decidedRefs);
      for (const item of record.items) {
        if (item.kind === 'approval' && !decided.has(item.ref)) this.db.run(`UPDATE approvals SET question_id = NULL WHERE id = ? AND status = 'pending'`, item.ref);
      }
      return { record, events: [this.events.append(id, { type: 'question.closed', payload: { sessionId: record.sessionId, status } })] };
    });
  }

  setDelivery(id: string, delivery: QuestionDelivery): void {
    this.db.run(`UPDATE approval_questions SET delivery = ? WHERE id = ?`, delivery, id);
  }

  markEscalated(id: string): boolean {
    return this.db.run(`UPDATE approval_questions SET escalated_at = ? WHERE id = ? AND escalated_at IS NULL AND status = 'open'`, this.clock.iso(), id) > 0;
  }
}
