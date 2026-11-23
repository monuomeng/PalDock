import type { PersistentEvent } from '@paldock/contracts';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import type { Change } from './status-transition.js';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface MessageRecord {
  id: number;
  sessionId: string;
  role: MessageRole;
  body: string;
  createdAt: string;
}

const columns = (alias: string) =>
  `${alias}id, ${alias}session_id AS sessionId, ${alias}role, ${alias}body, ${alias}created_at AS createdAt`;

/** trigram 分词至少需要 3 个字符；更短的查询（例如两字中文词）只能 LIKE 全表扫描。 */
export const TRIGRAM_MIN_CHARS = 3;

const SQL = {
  insert: `
    INSERT INTO messages (session_id, role, body, created_at) VALUES (?, ?, ?, ?)
    RETURNING ${columns('')}`,
  searchFts: `
    SELECT ${columns('m.')}
      FROM messages_fts AS f
      JOIN messages AS m ON m.id = f.rowid
     WHERE messages_fts MATCH ?
     ORDER BY f.rank
     LIMIT ?`,
  searchLike: `
    SELECT ${columns('m.')}
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
    private readonly now: () => Date = () => new Date(),
  ) {}

  append(sessionId: string, role: MessageRole, body: string): Change<MessageRecord> {
    return this.db.transaction(() => {
      const record = this.db.get<MessageRecord>(SQL.insert, sessionId, role, body, this.now().toISOString())!;
      const event: PersistentEvent = this.events.append(String(record.id), {
        type: 'message.created',
        payload: { sessionId, role },
      });
      return { record, events: [event] };
    });
  }

  search(query: string, limit: number): MessageRecord[] {
    const q = query.trim();
    if (q.length === 0) return [];
    return [...q].length >= TRIGRAM_MIN_CHARS
      ? this.db.all<MessageRecord>(SQL.searchFts, toFtsPhrase(q), limit)
      : this.db.all<MessageRecord>(SQL.searchLike, toLikePattern(q), limit);
  }
}
