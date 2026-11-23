import type { Database } from './database.js';

export interface InboxItem {
  queue: string;
  eventId: string;
  conversationKey: string;
  payload: string;
  attempts: number;
}

const SQL = {
  accept: `
    INSERT INTO inbox (queue, event_id, conversation_key, payload, received_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (queue, event_id) DO NOTHING
    RETURNING event_id`,
  /**
   * 取最早的可处理事件，同一会话串行：该会话已有未过期租约时跳过。
   * 过期的 processing 视为崩溃遗留，可被重新领取。候选走 inbox_open，会话占用检查走 inbox_processing。
   */
  claim: `
    UPDATE inbox SET status = 'processing', lease_until = $leaseUntil, attempts = attempts + 1
     WHERE (queue, event_id) = (
       SELECT queue, event_id FROM inbox AS candidate
        WHERE status IN ('pending', 'processing')
          AND (status = 'pending' OR lease_until < $now)
          AND NOT EXISTS (
            SELECT 1 FROM inbox AS busy
             WHERE busy.status = 'processing'
               AND busy.conversation_key = candidate.conversation_key
               AND busy.lease_until >= $now)
        ORDER BY received_at
        LIMIT 1)
    RETURNING queue, event_id AS eventId, conversation_key AS conversationKey, payload, attempts`,
  // 墓碑：清空正文，保留主键以拒绝迟到的重复事件
  finish: `
    UPDATE inbox SET status = ?, payload = NULL, lease_until = NULL
     WHERE queue = ? AND event_id = ? AND status = 'processing'`,
} as const;

/** 入站先落库再处理；以（队列, 平台事件 ID）为主键去重，重启后依然有效。 */
export class Inbox {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 返回 false 表示重复事件，调用方直接丢弃。 */
  accept(queue: string, eventId: string, conversationKey: string, payload: string): boolean {
    return this.db.get(SQL.accept, queue, eventId, conversationKey, payload, this.now().toISOString()) !== undefined;
  }

  claim(leaseMs: number): InboxItem | undefined {
    const now = this.now();
    return this.db.statement(SQL.claim).get({
      now: now.toISOString(),
      leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
    }) as InboxItem | undefined;
  }

  finish(queue: string, eventId: string, outcome: 'done' | 'rejected'): boolean {
    return this.db.run(SQL.finish, outcome, queue, eventId) === 1;
  }
}
