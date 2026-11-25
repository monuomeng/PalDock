import type { ChannelProvider, MessageRecord, MessageRole } from '@paldock/contracts';
import type { Clock } from './clock.js';
import { COLUMNS } from './columns.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import { insertWithEvent, type Change } from './writes.js';


/** trigram 分词至少需要 3 个字符；更短的查询（例如两字中文词）只能 LIKE 全表扫描。 */
const TRIGRAM_MIN_CHARS = 3;

const SQL = {
  insert: `
    INSERT INTO messages (session_id, run_id, role, body, channel, created_at) VALUES (?, ?, ?, ?, ?, ?)
    RETURNING ${COLUMNS.message()}`,
  select: `SELECT ${COLUMNS.message()} FROM messages WHERE id = ?`,
  searchFts: `
    SELECT ${COLUMNS.message('m.')}
      FROM messages_fts AS f
      JOIN messages AS m ON m.id = f.rowid
     WHERE messages_fts MATCH ?
     ORDER BY f.rank
     LIMIT ?`,
  searchLike: `
    SELECT ${COLUMNS.message('m.')}
      FROM messages AS m
     WHERE m.body LIKE ? ESCAPE '\\'
     ORDER BY m.id DESC
     LIMIT ?`,
} as const;

/** 用双引号包成 FTS5 短语，用户输入里的运算符（AND、*、:）不会被解释。 */
const toFtsPhrase = (query: string) => `"${query.replaceAll('"', '""')}"`;
const toLikePattern = (query: string) => `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export class MessageStore {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly clock: Clock,
  ) {}

  /** runId 为空表示不属于某次 Run 的消息（例如以后的主会话对话）。 */
  append(sessionId: string, role: MessageRole, body: string, runId: string | null = null, channel: ChannelProvider | null = null): Change<MessageRecord> {
    const params = [sessionId, runId, role, body, channel, this.clock.iso()];
    return insertWithEvent<MessageRecord>(this.db, this.events, SQL.insert, params, () => ({
      type: 'message.created',
      payload: channel ? { sessionId, runId, role, channel } : { sessionId, runId, role },
    }));
  }

  get(id: number): MessageRecord | undefined {
    return this.db.get<MessageRecord>(SQL.select, id);
  }

  search(query: string, limit: number): MessageRecord[] {
    const q = query.trim();
    if (q.length === 0) return [];
    return [...q].length >= TRIGRAM_MIN_CHARS
      ? this.db.all<MessageRecord>(SQL.searchFts, toFtsPhrase(q), limit)
      : this.db.all<MessageRecord>(SQL.searchLike, toLikePattern(q), limit);
  }
}
