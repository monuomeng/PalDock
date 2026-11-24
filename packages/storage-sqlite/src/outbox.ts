import type { Card, ChannelProvider, OutboxItem, OutboxPort } from '@paldock/contracts';
import type { Clock } from './clock.js';
import { COLUMNS } from './columns.js';
import type { Database } from './database.js';

const SQL = {
  insert: `
    INSERT INTO outbox (channel, target, subject, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
  // 取最早到期的一条并标为发送中（走部分索引 outbox_due）；同一时刻只有投递工作器一个消费者
  claimDue: `
    UPDATE outbox SET status = 'sending', attempts = attempts + 1
     WHERE id = (SELECT id FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT 1)
    RETURNING ${COLUMNS.outbox()}`,
  // 以下两条走部分索引 outbox_pending_by_subject
  supersede: `UPDATE outbox SET status = 'failed', last_error = '已被同主题的新卡片取代' WHERE status = 'pending' AND target = ? AND subject = ?`,
  hasSubject: `
    SELECT 1 FROM channel_messages WHERE conversation_id = ? AND subject = ?
    UNION ALL
    SELECT 1 FROM outbox WHERE status = 'pending' AND target = ? AND subject = ?
    LIMIT 1`,
  markSent: `UPDATE outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?`,
  upsertRef: `
    INSERT INTO channel_messages (conversation_id, subject, message_ref, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (conversation_id, subject) DO UPDATE SET message_ref = excluded.message_ref, updated_at = excluded.updated_at`,
  selectRef: `SELECT message_ref AS ref FROM channel_messages WHERE conversation_id = ? AND subject = ?`,
  markRetry: `UPDATE outbox SET status = 'pending', next_attempt_at = ?, last_error = ? WHERE id = ?`,
  markFinal: `UPDATE outbox SET status = ?, last_error = ? WHERE id = ?`,
  // 走部分索引 outbox_pending_by_channel
  failPending: `UPDATE outbox SET status = 'failed', last_error = ? WHERE channel = ? AND status = 'pending'`,
} as const;

type OutboxRow = Omit<OutboxItem, 'card'> & { payload: string };

/**
 * 出站队列：业务代码与状态变更同一事务写入，投递工作器按到期时间逐条发送。
 * 发送超时记为 unknown，不盲目重发；平台明确拒绝记为 failed。
 */
export class Outbox implements OutboxPort {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /** 有主题时，同会话同主题还没发出的旧卡片作废：发出去的只会是最新内容，也不会在新卡片之后才到。 */
  enqueue(provider: ChannelProvider, conversationId: string, card: Card, subject: string | null = null): number {
    return this.db.transaction(() => {
      const at = this.clock.iso();
      if (subject) this.db.run(SQL.supersede, conversationId, subject);
      return this.db.get<{ id: number }>(SQL.insert, provider, conversationId, subject, JSON.stringify(card), at, at)!.id;
    });
  }

  hasSubject(conversationId: string, subject: string): boolean {
    return this.db.get(SQL.hasSubject, conversationId, subject, conversationId, subject) !== undefined;
  }

  claimDue(): OutboxItem | undefined {
    const row = this.db.get<OutboxRow>(SQL.claimDue, this.clock.iso());
    if (!row) return undefined;
    const { payload, ...rest } = row;
    return { ...rest, card: JSON.parse(payload) as Card };
  }

  messageRef(conversationId: string, subject: string): string | undefined {
    return this.db.get<{ ref: string }>(SQL.selectRef, conversationId, subject)?.ref;
  }

  markSent(item: OutboxItem, messageRef: string): void {
    this.db.transaction(() => {
      const at = this.clock.iso();
      this.db.run(SQL.markSent, at, item.id);
      if (item.subject) this.db.run(SQL.upsertRef, item.conversationId, item.subject, messageRef, at);
    });
  }

  markRetry(id: number, delayMs: number, error: string): void {
    this.db.run(SQL.markRetry, this.clock.isoAfter(delayMs), error.slice(0, 500), id);
  }

  markFinal(id: number, status: 'unknown' | 'failed', error: string): void {
    this.db.run(SQL.markFinal, status, error.slice(0, 500), id);
  }

  failPending(provider: ChannelProvider, error: string): number {
    return this.db.run(SQL.failPending, error, provider);
  }
}
