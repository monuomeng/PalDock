import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPROVAL_STATUSES, RUN_STATUSES, SUBTASK_STATUSES, TASK_STATUSES, type SubtaskStatus } from '@paldock/contracts';
import { DomainError, runMachine } from '@paldock/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from './database.js';
import { MIGRATIONS, migrate } from './migrations/index.js';
import { ACTIVE_RUN_STATUSES, openStore, type Store } from './index.js';

let clock = new Date('2026-11-23T08:00:00.000Z');
const now = () => clock;
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

let store: Store;
const LATEST = MIGRATIONS.at(-1)!.version;

beforeEach(async () => {
  clock = new Date('2026-11-23T08:00:00.000Z');
  store = await openStore(':memory:', now);
});
afterEach(() => store.close());

let seeded = 0;
function seedTask() {
  const ws = store.tasks.ensureWorkspace('demo', `D:/demo-${++seeded}`);
  const { task, subtask: sub, session } = store.tasks.createTask({
    workspaceId: ws.id,
    title: '加记住我',
    goal: '实现记住我',
    role: 'developer',
    checkCommand: { executable: 'pnpm', args: ['test'] },
    checkConfirmed: true,
    idempotencyKey: `key-${seeded}`,
  }).record;
  return { ws, task, sub, session };
}
function seedRun() {
  const base = seedTask();
  const run = store.runs.createRun({ subtaskId: base.sub.id, sessionId: base.session.id, runtime: 'mock' }).record;
  return { ...base, run };
}
/** 依次迁移子任务，返回最后的版本号。 */
function walkSubtask(id: string, version: number, ...states: SubtaskStatus[]) {
  for (const to of states) version = store.tasks.transitionSubtask(id, version, to).record.version;
  return version;
}
const approvalOf = (runId: string) =>
  store.runs.requestApproval({
    runId,
    kind: 'command',
    riskLevel: 'medium',
    summary: 'pnpm install',
    detail: 'pnpm install --frozen-lockfile',
    cwd: 'D:/wt',
    nativeRequestId: 'req-1',
    ttlMs: 60_000,
  }).record;

const plan = (sql: string) =>
  store.db.raw
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((r) => String(r.detail))
    .join(' | ');

describe('任务创建', () => {
  it('任务、子任务、会话同一事务创建并直接排队；检查命令按 JSON 往返', () => {
    const { task, sub, session } = seedTask();
    expect(task).toMatchObject({ status: 'queued', checkCommand: { executable: 'pnpm', args: ['test'] } });
    expect(task.checkConfirmedAt).not.toBeNull();
    expect(sub).toMatchObject({ taskId: task.id, status: 'queued', worktreePath: null });
    expect(session).toMatchObject({ kind: 'agent', subtaskId: sub.id });
    expect(store.tasks.getTask(task.id)).toEqual(task);
  });

  it('同一项目路径复用工作区；幂等键查回已建任务并走唯一部分索引', () => {
    const a = store.tasks.ensureWorkspace('x', 'D:/same');
    expect(store.tasks.ensureWorkspace('y', 'D:/same').id).toBe(a.id);
    const { task } = seedTask();
    expect(store.tasks.findTaskByIdempotencyKey(`key-${seeded}`)?.id).toBe(task.id);
    expect(plan(`SELECT id FROM tasks WHERE idempotency_key = 'k'`)).toContain('tasks_by_idempotency_key');
  });

  it('任务列表带子任务与最新 Run 状态', () => {
    const { task, sub, session } = seedTask();
    store.runs.createRun({ subtaskId: sub.id, sessionId: session.id, runtime: 'mock' });
    expect(store.tasks.listTasks(10)[0]).toMatchObject({
      task: { id: task.id },
      subtaskStatus: 'queued',
      latestRunStatus: 'starting',
    });
  });

  it('worktree 只设置一次', () => {
    const { sub } = seedTask();
    expect(store.tasks.setWorktree(sub.id, 'D:/wt', 'paldock/x', 'abc')).toMatchObject({ worktreePath: 'D:/wt', version: 1 });
    expect(store.tasks.setWorktree(sub.id, 'D:/other', 'paldock/y', 'def')).toBeUndefined();
  });
});

describe('任务状态与事件', () => {
  it('状态更新与事件同事务提交，返回值来自 RETURNING', () => {
    const { task } = seedTask();
    const change = store.tasks.transitionTask(task.id, 0, 'running');
    expect(change.record).toMatchObject({ id: task.id, status: 'running', version: 1 });
    expect(change.events[0]).toMatchObject({ type: 'task.status_changed', payload: { from: 'queued', to: 'running' } });
    expect(store.events.since(change.events[0]!.seq - 1, 10)).toEqual(change.events);
  });

  it('版本不符返回 conflict，且不写入事件', () => {
    const { task } = seedTask();
    store.tasks.transitionTask(task.id, 0, 'running');
    const before = store.events.since(0, 100).length;
    expect(() => store.tasks.transitionTask(task.id, 0, 'cancelled')).toThrowError(
      expect.objectContaining({ code: 'conflict' }) as unknown as Error,
    );
    expect(store.events.since(0, 100)).toHaveLength(before);
  });

  it('非法迁移整体回滚', () => {
    const { task } = seedTask();
    expect(() => store.tasks.transitionTask(task.id, 0, 'succeeded')).toThrow(DomainError);
    expect(store.tasks.getTask(task.id)).toMatchObject({ status: 'queued', version: 0 });
  });

  it('同一子任务的 Run 次数递增，退回重做累计次数并记原因', () => {
    const { sub, session } = seedRun();
    expect(store.runs.createRun({ subtaskId: sub.id, sessionId: session.id, runtime: 'mock' }).record.attempt).toBe(2);
    const v = walkSubtask(sub.id, 0, 'running', 'review');
    const reworked = store.tasks.transitionSubtask(sub.id, v, 'queued', '缺少边界测试').record;
    expect(reworked).toMatchObject({ reworkCount: 1, statusReason: '缺少边界测试' });
    expect(store.tasks.transitionSubtask(sub.id, reworked.version, 'running').record.statusReason).toBeNull();
  });
});

describe('Run 的原生身份', () => {
  it('thread 与 turn 各只写一次；续做的新 Run 指向原 Run 且共用 thread', () => {
    const { run, sub, session } = seedRun();
    expect(store.runs.recordThread(run, 'thr_1')?.nativeThreadId).toBe('thr_1');
    expect(store.runs.recordThread(run, 'thr_2')).toBeUndefined();
    expect(store.runs.recordTurn(run.id, 'turn_1')?.nativeTurnId).toBe('turn_1');
    expect(store.runs.recordTurn(run.id, 'turn_2')).toBeUndefined();

    const resumed = store.runs.createRun({
      subtaskId: sub.id,
      sessionId: session.id,
      runtime: 'mock',
      nativeThreadId: 'thr_1',
      resumesRunId: run.id,
    }).record;
    expect(resumed).toMatchObject({ attempt: 2, nativeThreadId: 'thr_1', nativeTurnId: null, resumesRunId: run.id });
    expect(store.runs.recordThread(resumed, 'thr_1')?.nativeThreadId).toBe('thr_1');
    expect(store.runs.getRun(run.id)?.nativeTurnId).toBe('turn_1');
    expect(store.db.all('SELECT native_id FROM runtime_sessions')).toEqual([{ native_id: 'thr_1' }]);
  });

  it('失败原因在终态时写入，结束时间随之填写', () => {
    const { run } = seedRun();
    const failed = store.runs.transitionRun(run.id, 0, 'failed', '启动失败').record;
    expect(failed).toMatchObject({ status: 'failed', failureReason: '启动失败' });
    expect(failed.endedAt).not.toBeNull();
  });
});

describe('审批', () => {
  it('先到者为准：第二个决定拿到 conflict', () => {
    const { run } = seedRun();
    const approval = approvalOf(run.id);
    const first = store.runs.decideApproval(approval.id, 0, 'approved', 'feishu');
    expect(first.events[0]).toMatchObject({ type: 'approval.decided', payload: { status: 'approved', via: 'feishu' } });
    expect(() => store.runs.decideApproval(approval.id, 0, 'denied', 'desktop')).toThrowError(/已被修改/);
  });

  it('到期查询与按 Run 查询都走索引', () => {
    const { run } = seedRun();
    const approval = approvalOf(run.id);
    expect(store.runs.expiredApprovals()).toEqual([]);
    advance(60_000);
    expect(store.runs.expiredApprovals().map((a) => a.id)).toEqual([approval.id]);
    expect(plan(`UPDATE approvals SET status = 'cancelled' WHERE run_id = 'r' AND status = 'pending'`)).toContain('approvals_by_run');
    expect(store.runs.cancelPendingApprovals(run.id).record.map((a) => a.status)).toEqual(['cancelled']);
    expect(plan(`SELECT id FROM approvals WHERE status = 'pending' AND expires_at <= ''`)).toContain('approvals_pending');
    expect(plan(`SELECT id FROM approvals WHERE run_id = 'r' AND status = 'pending'`)).toContain('approvals_by_run');
  });
});

describe('证据与验收', () => {
  it('任务详情按 Run 分组返回证据、验收、审批与输出，退回后旧证据仍在', () => {
    const { sub, session, run } = seedRun();
    store.runs.saveResult({
      runId: run.id,
      finalMessage: '完成',
      diffStat: ' 1 file changed',
      checkStatus: 'failed',
      checkExitCode: 1,
      checkDurationMs: 120,
      checkOutputRef: 'checks/x.log',
    });
    store.runs.addReview(run.id, 'rework', '测试没过');
    store.messages.append(session.id, 'assistant', '输出', run.id);
    approvalOf(run.id);
    const retry = store.runs.createRun({ subtaskId: sub.id, sessionId: session.id, runtime: 'mock' }).record;

    const details = store.runs.runDetails(sub.id);
    expect(details.map((d) => d.run.id)).toEqual([run.id, retry.id]);
    expect(details[0]).toMatchObject({
      result: { checkStatus: 'failed', checkExitCode: 1 },
      reviews: [{ decision: 'rework', note: '测试没过' }],
      approvals: [{ kind: 'command', detail: 'pnpm install --frozen-lockfile' }],
      messages: [{ body: '输出', runId: run.id }],
    });
    expect(details[1]).toMatchObject({ result: null, reviews: [], approvals: [], messages: [] });
  });

  it('按 Run 读取输出走部分索引', () => {
    expect(plan(`SELECT id FROM messages WHERE run_id = 'r' ORDER BY id`)).toContain('messages_by_run');
  });
});

describe('待我处理', () => {
  it('A/B：已读不改变待办；拒绝只移除 A；退回重做后新一轮验收是新条目', () => {
    const a = seedRun();
    const approval = approvalOf(a.run.id);
    const b = seedRun();
    const v = walkSubtask(b.sub.id, 0, 'running', 'review');

    expect(store.attention.list()).toEqual([
      expect.objectContaining({ kind: 'approval', itemId: approval.id, taskId: a.task.id, runId: a.run.id, title: '加记住我' }),
      expect.objectContaining({ kind: 'review', itemId: b.run.id, taskId: b.task.id, runId: b.run.id }),
    ]);
    store.attention.markRead('approval', approval.id);
    expect(store.attention.list()).toContainEqual(expect.objectContaining({ itemId: approval.id, read: true }));

    store.runs.decideApproval(approval.id, 0, 'denied', 'desktop');
    expect(store.attention.list().map((i) => i.itemId)).toEqual([b.run.id]);

    store.attention.markRead('review', b.run.id);
    const reworked = store.tasks.transitionSubtask(b.sub.id, v, 'queued', '缺少边界测试').record;
    const retry = store.runs.createRun({ subtaskId: b.sub.id, sessionId: b.session.id, runtime: 'mock' }).record;
    walkSubtask(b.sub.id, reworked.version, 'running', 'review');
    expect(store.attention.list()).toEqual([expect.objectContaining({ kind: 'review', itemId: retry.id, read: false })]);
  });

  it('执行器断线的 Run 显示为待确认，带原因', () => {
    const { run } = seedRun();
    store.runs.transitionRun(run.id, 0, 'running');
    store.runs.transitionRun(run.id, 1, 'unconfirmed', '执行器断线');
    expect(store.attention.list()).toContainEqual(
      expect.objectContaining({ kind: 'unconfirmed_run', itemId: run.id, reason: '执行器断线' }),
    );
  });

  it('派生视图的每个分支都命中索引', () => {
    const detail = plan('SELECT * FROM attention_items');
    expect(detail).toContain('approvals_pending');
    expect(detail).toContain('subtasks_needing_attention');
    expect(detail).toContain('runs_unconfirmed');
  });
});

describe('启动恢复', () => {
  it('未结束的 Run 中断，挂起审批取消，子任务与任务进入阻塞；处理中的入站事件放回队列', () => {
    const { run, sub, task } = seedRun();
    store.tasks.transitionTask(task.id, 0, 'running');
    store.tasks.transitionSubtask(sub.id, 0, 'running');
    store.runs.transitionRun(run.id, 0, 'running');
    store.runs.recordThread(run, 'thr_1');
    const approval = approvalOf(run.id);
    store.inbox.accept('feishu', 'evt_1', 'chat_a', '{}');
    store.inbox.claim(30_000);

    const report = store.interruptActiveWork('服务重启');
    expect(report.interruptedRuns).toEqual([{ id: run.id, subtaskId: sub.id, nativeThreadId: 'thr_1' }]);
    expect(report.reopenedInbox).toBe(1);
    expect(report.events.map((e) => e.type)).toEqual([
      'run.status_changed',
      'approval.decided',
      'subtask.status_changed',
      'task.status_changed',
    ]);
    expect(store.runs.getRun(run.id)).toMatchObject({ status: 'interrupted', failureReason: '服务重启' });
    expect(store.runs.getApproval(approval.id)).toMatchObject({ status: 'cancelled', decidedVia: 'policy' });
    expect(store.tasks.getSubtask(sub.id)).toMatchObject({ status: 'blocked', statusReason: '服务重启' });
    expect(store.tasks.getTask(task.id)?.status).toBe('blocked');
    expect(store.attention.list()).toEqual([expect.objectContaining({ kind: 'blocked', itemId: run.id, reason: '服务重启' })]);
    expect(plan(`SELECT id FROM runs WHERE status IN ('starting', 'running', 'waiting_approval', 'unconfirmed')`)).toContain(
      'runs_active',
    );
    expect(plan(`SELECT id FROM subtasks WHERE status IN ('queued', 'running')`)).toContain('subtasks_in_progress');
    expect(plan(`SELECT id FROM tasks WHERE status IN ('queued', 'running')`)).toContain('tasks_in_progress');
  });

  it('只在内存里排队、还没开始的任务重启后也转为阻塞，可重新开始', () => {
    const { sub, task } = seedTask();
    store.interruptActiveWork('服务重启');
    expect(store.tasks.getSubtask(sub.id)).toMatchObject({ status: 'blocked', statusReason: '服务重启' });
    expect(store.tasks.getTask(task.id)?.status).toBe('blocked');
    expect(store.attention.list()).toEqual([expect.objectContaining({ kind: 'blocked', itemId: sub.id, runId: null })]);
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

describe('迁移与备份', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'paldock-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('文件库启用 WAL；重复打开不重复迁移', async () => {
    const first = await openStore(dir, now);
    expect(first.migration).toEqual({ from: 0, to: LATEST });
    expect(first.db.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
    first.close();

    const second = await openStore(dir, now);
    expect(second.migration).toEqual({ from: LATEST, to: LATEST });
    second.close();
  });

  it('v1 的库带数据升级到最新：先备份，原有行保留，原生会话列改名', async () => {
    const db = Database.open(join(dir, 'paldock.db'));
    await migrate(db, { now, migrations: MIGRATIONS.slice(0, 1) });
    db.run(`INSERT INTO workspaces (id, name, root_path, created_at) VALUES ('w', 'n', 'D:/p', 't')`);
    db.run(`INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at) VALUES ('t', 'w', '旧任务', 'draft', 't', 't')`);
    const result = await migrate(db, { backupDir: join(dir, 'backups'), now });
    expect(result).toMatchObject({ from: 1, to: LATEST });
    expect(result.backupPath).toBeDefined();
    expect(db.get(`SELECT title, goal, check_command FROM tasks`)).toEqual({ title: '旧任务', goal: '', check_command: null });
    expect(db.all(`SELECT name FROM pragma_table_info('runs') WHERE name LIKE 'native_%' ORDER BY cid`)).toEqual([
      { name: 'native_thread_id' },
      { name: 'native_turn_id' },
    ]);
    db.close();
  });

  it('已有数据时，迁移前先备份；迁移失败整体回滚', async () => {
    const db = Database.open(join(dir, 'paldock.db'));
    await migrate(db, { now });
    const broken = [...MIGRATIONS, { version: 99, name: 'broken', sql: 'CREATE TABLE ok_part (x); SELECT * FROM no_such_table;' }];
    await expect(migrate(db, { backupDir: join(dir, 'backups'), now, migrations: broken })).rejects.toThrow();

    expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
    expect(db.get(`SELECT max(version) AS v FROM schema_migrations`)).toEqual({ v: LATEST });
    expect(db.get(`SELECT name FROM sqlite_master WHERE name = 'ok_part'`)).toBeUndefined();
    db.close();
  });

  it('手动备份包含数据库与 artifacts，可单独打开', async () => {
    const live = await openStore(dir, now);
    live.tasks.ensureWorkspace('demo', 'D:/demo');
    mkdirSync(join(dir, 'artifacts', 'checks'), { recursive: true });
    writeFileSync(join(dir, 'artifacts', 'checks', 'run.log'), 'ok');
    const { path } = await live.backup();
    live.close();

    expect(readFileSync(join(path, 'artifacts', 'checks', 'run.log'), 'utf8')).toBe('ok');
    const copy = Database.open(join(path, 'paldock.db'));
    expect(copy.get(`SELECT root_path FROM workspaces`)).toEqual({ root_path: 'D:/demo' });
    copy.close();
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
