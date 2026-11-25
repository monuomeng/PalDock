import { WAKE_STATUSES } from '@paldock/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './index.js';

let clock = Date.parse('2026-11-25T08:00:00.000Z');
let store: Store;
beforeEach(async () => {
  store = await openStore(':memory:', () => new Date((clock += 1000)));
});
afterEach(() => store.close());

const queryPlan = (sql: string, ...params: string[]) =>
  store.db.raw
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((r) => String(r.detail))
    .join(' | ');

function seed() {
  const ws = store.tasks.ensureWorkspace('demo', 'D:/demo');
  const { record: session } = store.coordinator.createMainSession(ws.id, '默认会话');
  return { ws, session };
}

describe('协调助手主会话的存储', () => {
  it('主会话建在对话任务上：任务列表不列它，子任务一直是草稿', () => {
    const { ws, session } = seed();
    expect(store.coordinator.mainSessions(ws.id)).toEqual([session]);
    expect(store.coordinator.getMainSession(session.sessionId)).toEqual(session);
    expect(store.tasks.getTask(session.taskId)).toMatchObject({ kind: 'conversation', status: 'draft' });
    expect(store.tasks.getSubtask(session.subtaskId)).toMatchObject({ role: 'coordinator', status: 'draft' });
    expect(store.tasks.listTasks(10)).toEqual([]);
    expect(store.tasks.recentTasks(10)).toEqual([]);
    expect(store.attention.list()).toEqual([]);
  });

  it('唤醒按去重键只记一次；同会话按到达顺序取，状态写开始和结束时间', () => {
    const { session } = seed();
    const sid = session.sessionId;
    const first = store.coordinator.addWake({ sessionId: sid, trigger: 'user_message', dedupeKey: 'msg:1', summary: '你好' })!;
    expect(first.events[0]).toMatchObject({ type: 'wake.changed', aggregateId: sid, payload: { status: 'pending', trigger: 'user_message' } });
    expect(store.coordinator.addWake({ sessionId: sid, trigger: 'user_message', dedupeKey: 'msg:1', summary: '重复' })).toBeUndefined();
    store.coordinator.addWake({ sessionId: sid, trigger: 'task_event', dedupeKey: 'evt:9', summary: '节点阻塞' });
    expect(store.coordinator.sessionsWithPendingWakes()).toEqual([sid]);
    expect(store.coordinator.nextPendingWake(sid)?.id).toBe(first.record.id);

    const running = store.coordinator.setWake(first.record.id, 'running').record;
    expect(running.startedAt).not.toBeNull();
    expect(store.coordinator.runningWake(sid)?.id).toBe(first.record.id);
    expect(store.coordinator.countRequest(first.record.id)).toBe(1);
    expect(store.coordinator.countRequest(first.record.id)).toBe(2);
    const done = store.coordinator.setWake(first.record.id, 'done', { note: 'ok' }).record;
    expect(done).toMatchObject({ status: 'done', requests: 2, note: 'ok' });
    expect(done.endedAt).not.toBeNull();
    expect(store.coordinator.doneWakes(sid)).toBe(1);

    const event = store.coordinator.nextPendingWake(sid)!;
    store.coordinator.setWake(event.id, 'running');
    const since = new Date(clock - 60_000).toISOString();
    expect(store.coordinator.eventWakesSince(sid, since)).toMatchObject({ count: 1 });
    expect(store.coordinator.failRunningWakes('服务重启').record.map((w) => w.status)).toEqual(['failed']);
    expect(store.coordinator.listWakes(sid, 10).map((w) => w.status)).toEqual(['failed', 'done']);
  });

  it('通知进「待我处理」；看过后不再出现、不再升级；升级只标一次', () => {
    const { session } = seed();
    const sid = session.sessionId;
    const { record: notice, events } = store.coordinator.addNotice({ sessionId: sid, runId: null, kind: 'question', body: '要不要加测试？' });
    expect(events[0]).toMatchObject({ type: 'notice.created', payload: { noticeId: notice.id, kind: 'question' } });
    expect(store.attention.list()).toEqual([expect.objectContaining({ kind: 'notice', itemId: String(notice.id), taskId: session.taskId, title: `Q${notice.id} · 协调助手`, reason: '要不要加测试？' })]);
    expect(store.coordinator.unescalatedNotices().map((n) => n.id)).toEqual([notice.id]);
    expect(store.coordinator.markNoticeEscalated(notice.id, ['feishu'])).toMatchObject({ type: 'notice.escalated' });
    expect(store.coordinator.markNoticeEscalated(notice.id, ['feishu'])).toBeUndefined();
    expect(store.coordinator.unescalatedNotices()).toEqual([]);

    const second = store.coordinator.addNotice({ sessionId: sid, runId: null, kind: 'info', body: '做完了' }).record;
    expect(store.coordinator.ackNotices(sid).record).toBe(2);
    expect(store.coordinator.ackNotices(sid)).toMatchObject({ record: 0, events: [] });
    expect(store.attention.list()).toEqual([]);
    expect(store.coordinator.unescalatedNotices()).toEqual([]);
    expect(store.coordinator.notices(sid, 10).map((n) => [n.id, n.status])).toEqual([
      [second.id, 'read'],
      [notice.id, 'read'],
    ]);
  });

  it('滚动摘要按会话带版本号；最近消息按时间升序', () => {
    const { session } = seed();
    const sid = session.sessionId;
    expect(store.coordinator.latestSummary(sid)).toBeUndefined();
    store.coordinator.writeSummary({ sessionId: sid, body: '第一版', runId: null, wakesDone: 3 });
    const { record, events } = store.coordinator.writeSummary({ sessionId: sid, body: '第二版', runId: null, wakesDone: 23 });
    expect(record).toMatchObject({ version: 2, body: '第二版', wakesDone: 23 });
    expect(events[0]).toMatchObject({ type: 'summary.written', payload: { version: 2 } });
    expect(store.coordinator.latestSummary(sid)?.version).toBe(2);
    for (const body of ['一', '二', '三']) store.messages.append(sid, 'user', body);
    expect(store.coordinator.recentMessages(sid, 2).map((m) => m.body)).toEqual(['二', '三']);
  });

  it('status 的 CHECK 列表与契约一致；查询走索引', () => {
    const sql = store.db.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'wakes'`)!.sql;
    const list = /status\s+TEXT NOT NULL DEFAULT 'pending' CHECK \(status IN \(([^)]*)\)\)/.exec(sql)![1]!;
    expect(list.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...WAKE_STATUSES]);
    expect(queryPlan(`SELECT id FROM wakes WHERE session_id = ? AND status = 'pending' ORDER BY id LIMIT 1`, 's')).toContain('wakes_pending');
    expect(queryPlan(`SELECT id FROM wakes WHERE session_id = ? AND status = 'running'`, 's')).toContain('wakes_running');
    expect(queryPlan(`SELECT count(*) FROM wakes WHERE session_id = ? AND trigger = 'task_event' AND started_at >= ?`, 's', 'x')).toContain('wakes_event_starts');
    expect(queryPlan(`SELECT id FROM user_notices WHERE status = 'open' AND escalated_at IS NULL ORDER BY created_at`)).toContain('notices_unescalated');
    expect(queryPlan(`SELECT version FROM session_summaries WHERE session_id = ? ORDER BY version DESC LIMIT 1`, 's')).toMatch(/PRIMARY KEY/);
    const sessions = queryPlan(
      `SELECT ss.id FROM tasks t JOIN subtasks s ON s.task_id = t.id JOIN sessions ss ON ss.subtask_id = s.id WHERE t.workspace_id = ? AND t.kind = 'conversation' ORDER BY t.created_at`,
      'w',
    );
    expect(sessions).toContain('tasks_conversations');
    expect(queryPlan(`SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10`, 's')).toContain('messages_by_session');
  });
});
