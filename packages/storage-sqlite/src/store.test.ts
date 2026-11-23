import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPROVAL_STATUSES, RUN_STATUSES, SUBTASK_STATUSES, TASK_STATUSES } from '@paldock/contracts';
import { DomainError, runMachine } from '@paldock/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from './database.js';
import { MIGRATIONS, migrate } from './migrations/index.js';
import { ACTIVE_RUN_STATUSES, interruptActiveWork, openStore, type Store } from './index.js';

let clock = new Date('2026-11-23T08:00:00.000Z');
const now = () => clock;
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

let store: Store;

beforeEach(async () => {
  clock = new Date('2026-11-23T08:00:00.000Z');
  store = await openStore(':memory:', now);
});
afterEach(() => store.close());

let seeded = 0;
function seedRun() {
  const ws = store.tasks.createWorkspace('demo', `D:/demo-${++seeded}`);
  const task = store.tasks.createTask(ws.id, '加记住我').record;
  const sub = store.tasks.createSubtask(task.id, 'developer', '实现记住我').record;
  const run = store.tasks.createRun(sub.id, 'mock').record;
  return { ws, task, sub, run };
}

const plan = (sql: string) =>
  store.db.raw
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((r) => String(r.detail))
    .join(' | ');

describe('任务状态与事件', () => {
  it('状态更新与事件同事务提交，返回值来自 RETURNING', () => {
    const { task } = seedRun();
    const change = store.tasks.transitionTask(task.id, 0, 'queued');
    expect(change.record).toMatchObject({ id: task.id, status: 'queued', version: 1 });
    expect(change.events[0]).toMatchObject({ type: 'task.status_changed', payload: { from: 'draft', to: 'queued' } });
    expect(store.events.since(change.events[0]!.seq - 1, 10)).toEqual(change.events);
  });

  it('版本不符返回 conflict，且不写入事件', () => {
    const { task } = seedRun();
    store.tasks.transitionTask(task.id, 0, 'queued');
    const before = store.events.since(0, 100).length;
    expect(() => store.tasks.transitionTask(task.id, 0, 'cancelled')).toThrowError(
      expect.objectContaining({ code: 'conflict' }) as unknown as Error,
    );
    expect(store.events.since(0, 100)).toHaveLength(before);
  });

  it('非法迁移整体回滚', () => {
    const { task } = seedRun();
    expect(() => store.tasks.transitionTask(task.id, 0, 'succeeded')).toThrow(DomainError);
    expect(store.tasks.getTask(task.id)).toMatchObject({ status: 'draft', version: 0 });
  });

  it('同一子任务的 Run 次数递增，退回重做累计次数', () => {
    const { sub } = seedRun();
    expect(store.tasks.createRun(sub.id, 'mock').record.attempt).toBe(2);
    let v = 0;
    for (const to of ['queued', 'running', 'review', 'queued'] as const) {
      v = store.tasks.transitionSubtask(sub.id, v, to).record.version;
    }
    expect(store.tasks.transitionSubtask(sub.id, v, 'running').record.reworkCount).toBe(1);
  });
});

describe('审批：先到者为准', () => {
  it('第二个决定拿到 conflict', () => {
    const { run } = seedRun();
    const approval = store.tasks.requestApproval(run.id, 'medium', '安装依赖', 60_000).record;
    const first = store.tasks.decideApproval(approval.id, 0, 'approved', 'feishu');
    expect(first.events[0]).toMatchObject({ type: 'approval.decided', payload: { status: 'approved', via: 'feishu' } });
    expect(() => store.tasks.decideApproval(approval.id, 0, 'denied', 'desktop')).toThrowError(/已被修改/);
  });
});

describe('待我处理', () => {
  it('已读不改变待办；审批决定后待办消失；退回后旧 Run 仍可查', () => {
    const a = seedRun();
    const approval = store.tasks.requestApproval(a.run.id, 'low', '运行测试', 60_000).record;

    const b = seedRun();
    let v = 0;
    for (const to of ['queued', 'running', 'review'] as const) v = store.tasks.transitionSubtask(b.sub.id, v, to).record.version;

    expect(store.attention.list().map((i) => i.kind)).toEqual(['approval', 'review']);
    store.attention.markRead('approval', approval.id);
    expect(store.attention.list()).toContainEqual(expect.objectContaining({ itemId: approval.id, read: true }));

    store.tasks.decideApproval(approval.id, 0, 'denied', 'desktop');
    expect(store.attention.list().map((i) => i.itemId)).toEqual([b.sub.id]);

    store.tasks.transitionSubtask(b.sub.id, v, 'queued', '缺少边界测试');
    const retry = store.tasks.createRun(b.sub.id, 'mock').record;
    expect(retry.attempt).toBe(2);
    expect(store.db.all('SELECT attempt FROM runs WHERE subtask_id = ? ORDER BY attempt', b.sub.id)).toHaveLength(2);
  });

  it('执行器断线的 Run 显示为待确认', () => {
    const { run } = seedRun();
    store.tasks.transitionRun(run.id, 0, 'running');
    store.tasks.transitionRun(run.id, 1, 'unconfirmed', '执行器断线');
    expect(store.attention.list()).toContainEqual(expect.objectContaining({ kind: 'unconfirmed_run', itemId: run.id }));
  });

  it('派生视图的每个分支都命中部分索引', () => {
    const detail = plan('SELECT * FROM attention_items');
    expect(detail).toContain('approvals_pending');
    expect(detail).toContain('subtasks_needing_attention');
    expect(detail).toContain('runs_unconfirmed');
  });
});

describe('启动恢复', () => {
  it('未结束的 Run 标为 interrupted，处理中的入站事件放回队列', () => {
    const { run } = seedRun();
    store.tasks.transitionRun(run.id, 0, 'running');
    store.inbox.accept('feishu', 'evt_1', 'chat_a', '{}');
    store.inbox.claim(30_000);

    const report = interruptActiveWork(store.db, store.events, '服务重启');
    expect(report.interruptedRuns).toEqual([{ id: run.id, nativeSessionId: null }]);
    expect(report.reopenedInbox).toBe(1);
    expect(store.db.get('SELECT status, version FROM runs WHERE id = ?', run.id)).toEqual({ status: 'interrupted', version: 2 });
    expect(plan(`SELECT id FROM runs WHERE status IN ('starting', 'running', 'waiting_approval', 'unconfirmed')`)).toContain('runs_active');
  });
});

describe('inbox', () => {
  it('重复事件被拒绝，墓碑在完成后依然去重', () => {
    expect(store.inbox.accept('feishu', 'evt_1', 'chat_a', '{"text":"hi"}')).toBe(true);
    expect(store.inbox.accept('feishu', 'evt_1', 'chat_a', '{"text":"hi"}')).toBe(false);
    const item = store.inbox.claim(30_000)!;
    expect(store.inbox.finish(item.queue, item.eventId, 'done')).toBe(true);
    expect(store.inbox.accept('feishu', 'evt_1', 'chat_a', '{}')).toBe(false);
    expect(store.db.get('SELECT payload FROM inbox WHERE event_id = ?', 'evt_1')).toEqual({ payload: null });
  });

  it('同一会话串行，不同会话可并行；租约过期后可被回收', () => {
    store.inbox.accept('feishu', 'a1', 'chat_a', '{}');
    advance(1);
    store.inbox.accept('feishu', 'a2', 'chat_a', '{}');
    advance(1);
    store.inbox.accept('feishu', 'b1', 'chat_b', '{}');

    expect(store.inbox.claim(30_000)?.eventId).toBe('a1');
    expect(store.inbox.claim(30_000)?.eventId).toBe('b1');
    expect(store.inbox.claim(30_000)).toBeUndefined();

    advance(31_000);
    expect(store.inbox.claim(30_000)).toMatchObject({ eventId: 'a1', attempts: 2 });
  });

  it('领取查询使用部分索引', () => {
    const detail = plan(`SELECT 1 FROM inbox WHERE status = 'processing' AND conversation_key = 'x' AND lease_until >= ''`);
    expect(detail).toContain('inbox_processing');
  });
});

describe('消息检索（FTS5 trigram）', () => {
  beforeEach(() => {
    store.messages.append('s1', 'user', '给登录页加记住我功能，并补测试');
    store.messages.append('s1', 'assistant', 'Remember-me checkbox added to login page');
    store.messages.append('s2', 'user', '明天提醒我交周报');
  });

  it('中文子串检索', () => {
    expect(store.messages.search('记住我', 10).map((m) => m.sessionId)).toEqual(['s1']);
    expect(plan(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH '"记住我"'`)).toContain('VIRTUAL TABLE');
  });

  it('两字查询走 LIKE 回退，运算符字符不被解释', () => {
    expect(store.messages.search('周报', 10).map((m) => m.body)).toEqual(['明天提醒我交周报']);
    expect(store.messages.search('login AND', 10)).toEqual([]);
    expect(store.messages.search('100%', 10)).toEqual([]);
  });
});

describe('迁移', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'paldock-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('文件库启用 WAL；重复打开不重复迁移', async () => {
    const first = await openStore(dir, now);
    expect(first.migration).toEqual({ from: 0, to: 1 });
    expect(first.db.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
    first.close();

    const second = await openStore(dir, now);
    expect(second.migration).toEqual({ from: 1, to: 1 });
    second.close();
  });

  it('已有数据时，迁移前先备份；迁移失败整体回滚', async () => {
    const db = Database.open(join(dir, 'paldock.db'));
    await migrate(db, { now });
    const broken = [...MIGRATIONS, { version: 2, name: 'broken', sql: 'CREATE TABLE ok_part (x); SELECT * FROM no_such_table;' }];
    await expect(migrate(db, { backupDir: join(dir, 'backups'), now, migrations: broken })).rejects.toThrow();

    expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
    expect(db.get(`SELECT max(version) AS v FROM schema_migrations`)).toEqual({ v: 1 });
    expect(db.get(`SELECT name FROM sqlite_master WHERE name = 'ok_part'`)).toBeUndefined();
    db.close();
  });
});

describe('表结构与契约一致', () => {
  const checkList = (table: string) => {
    const sql = String(store.db.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = ?`, table)!.sql);
    const list = /status\s+TEXT NOT NULL CHECK \(status IN \(([^)]*)\)\)/.exec(sql)![1]!;
    return list.split(',').map((s) => s.trim().slice(1, -1));
  };

  it('status 的 CHECK 列表等于 contracts 的状态数组', () => {
    expect(checkList('tasks')).toEqual([...TASK_STATUSES]);
    expect(checkList('subtasks')).toEqual([...SUBTASK_STATUSES]);
    expect(checkList('runs')).toEqual([...RUN_STATUSES]);
    expect(checkList('approvals')).toEqual([...APPROVAL_STATUSES]);
  });

  it('恢复程序的活动状态集合由状态机推导一致', () => {
    const derived = RUN_STATUSES.filter((s) => !runMachine.isTerminal(s) && s !== 'interrupted');
    expect([...ACTIVE_RUN_STATUSES]).toEqual(derived);
  });
});
