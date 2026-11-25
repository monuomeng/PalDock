import {
  CodedError,
  type Change,
  type ChannelProvider,
  type CoordinatorStorePort,
  type MainSessionRecord,
  type MessageRecord,
  type NewWake,
  type NoticeKind,
  type NoticeRecord,
  type PersistentEvent,
  type SummaryRecord,
  type WakeRecord,
  type WakeStatus,
} from '@paldock/contracts';
import type { Clock } from './clock.js';
import { COLUMNS } from './columns.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import { newId } from './writes.js';

const MAIN_SESSION = `ss.id AS sessionId, t.id AS taskId, s.id AS subtaskId, t.workspace_id AS workspaceId, t.title, ss.created_at AS createdAt`;

const SQL = {
  insertTask: `
    INSERT INTO tasks (id, workspace_id, title, goal, status, kind, created_at, updated_at)
    VALUES (?1, ?2, ?3, '与协调助手的对话', 'draft', 'conversation', ?4, ?4)`,
  insertSubtask: `
    INSERT INTO subtasks (id, task_id, role, goal, status, created_at, updated_at) VALUES (?1, ?2, 'coordinator', '协调助手主会话', 'draft', ?3, ?3)`,
  insertSession: `INSERT INTO sessions (id, kind, subtask_id, role, created_at) VALUES (?, 'main', ?, 'coordinator', ?)`,
  // 走部分索引 tasks_conversations；子任务和会话各走自己的索引（subtasks_by_task、sessions_by_subtask）
  mainSessions: `
    SELECT ${MAIN_SESSION}
      FROM tasks t
      JOIN subtasks s ON s.task_id = t.id
      JOIN sessions ss ON ss.subtask_id = s.id
     WHERE t.workspace_id = ? AND t.kind = 'conversation'
     ORDER BY t.created_at`,
  mainSession: `
    SELECT ${MAIN_SESSION}
      FROM sessions ss
      JOIN subtasks s ON s.id = ss.subtask_id
      JOIN tasks t ON t.id = s.task_id
     WHERE ss.id = ? AND ss.kind = 'main'`,
  insertWake: `
    INSERT INTO wakes (session_id, trigger, dedupe_key, summary, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING ${COLUMNS.wake()}`,
  // 部分索引 wakes_pending / wakes_running，条件逐字一致
  nextPending: `SELECT ${COLUMNS.wake()} FROM wakes WHERE session_id = ? AND status = 'pending' ORDER BY id LIMIT 1`,
  running: `SELECT ${COLUMNS.wake()} FROM wakes WHERE session_id = ? AND status = 'running'`,
  sessionsPending: `SELECT DISTINCT session_id AS sessionId FROM wakes WHERE status = 'pending'`,
  setWake: `
    UPDATE wakes SET status = ?2, run_id = coalesce(?3, run_id), note = coalesce(?4, note),
           started_at = CASE WHEN ?2 = 'running' THEN ?5 ELSE started_at END,
           ended_at = CASE WHEN ?2 IN ('done', 'failed', 'dropped') THEN ?5 ELSE ended_at END
     WHERE id = ?1
    RETURNING ${COLUMNS.wake()}`,
  countRequest: `UPDATE wakes SET requests = requests + 1 WHERE id = ? RETURNING requests`,
  // wakes_event_starts：(session_id, started_at) WHERE trigger = 'task_event'
  eventWakesSince: `
    SELECT count(*) AS count, max(started_at) AS lastStartedAt
      FROM wakes WHERE session_id = ? AND trigger = 'task_event' AND started_at >= ?`,
  doneWakes: `SELECT count(*) AS n FROM wakes WHERE session_id = ? AND status = 'done'`,
  listWakes: `SELECT ${COLUMNS.wake()} FROM wakes WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
  failRunning: `
    UPDATE wakes SET status = 'failed', note = ?, ended_at = ? WHERE status = 'running'
    RETURNING ${COLUMNS.wake()}`,
  // messages_by_session 倒序取最近 N 条
  recentMessages: `SELECT ${COLUMNS.message()} FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
  insertNotice: `
    INSERT INTO user_notices (session_id, run_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)
    RETURNING ${COLUMNS.notice()}`,
  notices: `SELECT ${COLUMNS.notice()} FROM user_notices WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
  getNotice: `SELECT ${COLUMNS.notice()} FROM user_notices WHERE id = ?`,
  ackNotices: `UPDATE user_notices SET status = 'read' WHERE session_id = ? AND status = 'open'`,
  // notices_unescalated，条件逐字一致
  unescalated: `SELECT ${COLUMNS.notice()} FROM user_notices WHERE status = 'open' AND escalated_at IS NULL ORDER BY created_at`,
  markEscalated: `
    UPDATE user_notices SET escalated_at = ? WHERE id = ? AND status = 'open' AND escalated_at IS NULL
    RETURNING session_id AS sessionId`,
  insertSummary: `
    INSERT INTO session_summaries (session_id, version, body, run_id, wakes_done, created_at)
    VALUES (?1, (SELECT coalesce(max(version), 0) + 1 FROM session_summaries WHERE session_id = ?1), ?2, ?3, ?4, ?5)
    RETURNING ${COLUMNS.summary()}`,
  // 主键 (session_id, version) 倒序取一条
  latestSummary: `SELECT ${COLUMNS.summary()} FROM session_summaries WHERE session_id = ? ORDER BY version DESC LIMIT 1`,
} as const;

/** 协调助手主会话的存储：会话、唤醒、通知、滚动摘要。每个写方法一个事务，写入与事件同时提交。 */
export class CoordinatorRepository implements CoordinatorStorePort {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly clock: Clock,
  ) {}

  createMainSession(workspaceId: string, title: string): Change<MainSessionRecord> {
    return this.db.transaction(() => {
      const at = this.clock.iso();
      const [taskId, subtaskId, sessionId] = [newId('task'), newId('sub'), newId('sess')];
      this.db.run(SQL.insertTask, taskId, workspaceId, title, at);
      this.db.run(SQL.insertSubtask, subtaskId, taskId, at);
      this.db.run(SQL.insertSession, sessionId, subtaskId, at);
      const record: MainSessionRecord = { sessionId, taskId, subtaskId, workspaceId, title, createdAt: at };
      return { record, events: [this.events.append(sessionId, { type: 'main_session.created', payload: { workspaceId } })] };
    });
  }

  mainSessions(workspaceId: string): MainSessionRecord[] {
    return this.db.all<MainSessionRecord>(SQL.mainSessions, workspaceId);
  }

  getMainSession(sessionId: string): MainSessionRecord | undefined {
    return this.db.get<MainSessionRecord>(SQL.mainSession, sessionId);
  }

  addWake(input: NewWake): Change<WakeRecord> | undefined {
    return this.db.transaction(() => {
      const record = this.db.get<WakeRecord>(SQL.insertWake, input.sessionId, input.trigger, input.dedupeKey, input.summary.slice(0, 2000), this.clock.iso());
      return record && { record, events: [this.wakeEvent(record)] };
    });
  }

  private wakeEvent(wake: WakeRecord): PersistentEvent {
    return this.events.append(wake.sessionId, { type: 'wake.changed', payload: { wakeId: wake.id, status: wake.status, trigger: wake.trigger } });
  }

  nextPendingWake(sessionId: string): WakeRecord | undefined {
    return this.db.get<WakeRecord>(SQL.nextPending, sessionId);
  }

  runningWake(sessionId: string): WakeRecord | undefined {
    return this.db.get<WakeRecord>(SQL.running, sessionId);
  }

  sessionsWithPendingWakes(): string[] {
    return this.db.all<{ sessionId: string }>(SQL.sessionsPending).map((r) => r.sessionId);
  }

  setWake(id: number, status: WakeStatus, fields: { runId?: string; note?: string } = {}): Change<WakeRecord> {
    return this.db.transaction(() => {
      const record = this.db.get<WakeRecord>(SQL.setWake, id, status, fields.runId ?? null, fields.note?.slice(0, 500) ?? null, this.clock.iso());
      if (!record) throw new CodedError('not_found', '唤醒不存在');
      return { record, events: [this.wakeEvent(record)] };
    });
  }

  countRequest(wakeId: number): number {
    return this.db.get<{ requests: number }>(SQL.countRequest, wakeId)?.requests ?? 0;
  }

  eventWakesSince(sessionId: string, sinceIso: string): { count: number; lastStartedAt: string | null } {
    return this.db.get<{ count: number; lastStartedAt: string | null }>(SQL.eventWakesSince, sessionId, sinceIso)!;
  }

  doneWakes(sessionId: string): number {
    return this.db.get<{ n: number }>(SQL.doneWakes, sessionId)!.n;
  }

  listWakes(sessionId: string, limit: number): WakeRecord[] {
    return this.db.all<WakeRecord>(SQL.listWakes, sessionId, limit);
  }

  failRunningWakes(note: string): Change<WakeRecord[]> {
    return this.db.transaction(() => {
      const record = this.db.all<WakeRecord>(SQL.failRunning, note, this.clock.iso());
      return { record, events: record.map((w) => this.wakeEvent(w)) };
    });
  }

  recentMessages(sessionId: string, limit: number): MessageRecord[] {
    return this.db.all<MessageRecord>(SQL.recentMessages, sessionId, limit).reverse();
  }

  addNotice(input: { sessionId: string; runId: string | null; kind: NoticeKind; body: string }): Change<NoticeRecord> {
    return this.db.transaction(() => {
      const record = this.db.get<NoticeRecord>(SQL.insertNotice, input.sessionId, input.runId, input.kind, input.body, this.clock.iso())!;
      return { record, events: [this.events.append(input.sessionId, { type: 'notice.created', payload: { noticeId: record.id, kind: record.kind } })] };
    });
  }

  notices(sessionId: string, limit: number): NoticeRecord[] {
    return this.db.all<NoticeRecord>(SQL.notices, sessionId, limit);
  }

  getNotice(id: number): NoticeRecord | undefined {
    return this.db.get<NoticeRecord>(SQL.getNotice, id);
  }

  ackNotices(sessionId: string): Change<number> {
    return this.db.transaction(() => {
      const count = this.db.run(SQL.ackNotices, sessionId);
      return { record: count, events: count > 0 ? [this.events.append(sessionId, { type: 'notice.read', payload: { count } })] : [] };
    });
  }

  unescalatedNotices(): NoticeRecord[] {
    return this.db.all<NoticeRecord>(SQL.unescalated);
  }

  markNoticeEscalated(id: number, channels: ChannelProvider[]): PersistentEvent | undefined {
    const row = this.db.get<{ sessionId: string }>(SQL.markEscalated, this.clock.iso(), id);
    return row && this.events.append(row.sessionId, { type: 'notice.escalated', payload: { noticeId: id, channels } });
  }

  writeSummary(input: { sessionId: string; body: string; runId: string | null; wakesDone: number }): Change<SummaryRecord> {
    return this.db.transaction(() => {
      const record = this.db.get<SummaryRecord>(SQL.insertSummary, input.sessionId, input.body, input.runId, input.wakesDone, this.clock.iso())!;
      return { record, events: [this.events.append(input.sessionId, { type: 'summary.written', payload: { version: record.version } })] };
    });
  }

  latestSummary(sessionId: string): SummaryRecord | undefined {
    return this.db.get<SummaryRecord>(SQL.latestSummary, sessionId);
  }
}
