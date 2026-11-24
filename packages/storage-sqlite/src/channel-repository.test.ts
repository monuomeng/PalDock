import { CHANNEL_ACCOUNT_STATUSES, CHANNEL_PROVIDERS, type Card, type ChannelAddress } from '@paldock/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './index.js';

let clock = new Date('2026-11-24T08:00:00.000Z');
const now = () => clock;
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

let store: Store;
beforeEach(async () => {
  clock = new Date('2026-11-24T08:00:00.000Z');
  store = await openStore(':memory:', now);
});
afterEach(() => store.close());

const dm: ChannelAddress = { provider: 'feishu', account: 'cli_app', tenant: 't1', chatId: 'oc_dm', threadKey: '', kind: 'dm' };
const group: ChannelAddress = { ...dm, chatId: 'oc_group', kind: 'group' };
const card: Card = { title: 't', tone: 'info', lines: ['x'], buttons: [] };

function seedDm(externalId = 'ou_1') {
  const account = store.channels.upsertAccount(dm, externalId, '小王');
  const conversation = store.channels.upsertConversation({ ...dm, chatId: `oc_${externalId}` }, account.id, '小王');
  return { account, conversation };
}

const plan = (sql: string) =>
  store.db.raw
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((r) => String(r.detail))
    .join(' | ');

describe('渠道账号与会话', () => {
  it('同一个人重复出现时复用账号，只更新显示名，版本不变', () => {
    const first = store.channels.upsertAccount(dm, 'ou_1', '小王');
    const again = store.channels.upsertAccount(dm, 'ou_1', '王小明');
    expect(again).toMatchObject({ id: first.id, displayName: '王小明', status: 'unbound', version: 0 });
  });

  it('单聊记住所属账号，群聊不记；同一会话只有一行', () => {
    const { account } = seedDm();
    const g1 = store.channels.upsertConversation(group, account.id, '');
    const g2 = store.channels.upsertConversation(group, account.id, '');
    expect(g1.id).toBe(g2.id);
    expect(g1).toMatchObject({ kind: 'group', ownerAccountId: null, groupAllowed: false });
    expect(store.channels.listGroups().map((g) => g.id)).toEqual([g1.id]);
  });

  it('已绑定账号的单聊才是审批升级的目标，查询走部分索引', () => {
    const { account, conversation } = seedDm();
    expect(store.channels.activeDirectConversations()).toEqual([]);
    store.channels.setAccountStatus(account.id, account.version, 'active');
    expect(store.channels.activeDirectConversations().map((c) => c.id)).toEqual([conversation.id]);
    const sql = plan(`SELECT c.id FROM channel_accounts a JOIN external_conversations c ON c.owner_account_id = a.id AND c.kind = 'dm' WHERE a.status = 'active'`);
    expect(sql).toContain('conversations_dm_of_account');
    expect(sql).not.toMatch(/SCAN a\b/);
  });

  it('会话设置带版本号，旧版本得到 conflict', () => {
    const g = store.channels.upsertConversation(group, null, '');
    const changed = store.channels.setConversation(g.id, g.version, { groupAllowed: true, defaultWorkspaceId: null });
    expect(changed.record.groupAllowed).toBe(true);
    expect(changed.events[0]).toMatchObject({ type: 'channel.conversation_changed', aggregateId: g.id });
    expect(() => store.channels.setConversation(g.id, g.version, { groupAllowed: false, defaultWorkspaceId: null })).toThrow(/已被修改/);
  });
});

describe('配对', () => {
  it('未过期的配对码沿用，过期后新建；达到上限时返回 undefined', () => {
    const { account, conversation } = seedDm();
    const first = store.channels.openPairing(account, conversation.id, 60_000, 2)!;
    expect(first.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(first.events[0]).toMatchObject({ type: 'channel.pairing_requested', aggregateId: account.id });
    expect(store.channels.openPairing(account, conversation.id, 60_000, 2)).toEqual({ code: first.code, events: [] });
    advance(60_001);
    const second = store.channels.openPairing(account, conversation.id, 60_000, 2)!;
    expect(second.code).not.toBe(first.code);
    expect(store.channels.listPairings().map((p) => p.code)).toEqual([second.code]);
    // 上限按全部待确认的配对算：第二个陌生账号还能拿到，第三个拿不到
    const other = seedDm('ou_2');
    expect(store.channels.openPairing(other.account, other.conversation.id, 60_000, 2)).toBeDefined();
    const third = seedDm('ou_3');
    expect(store.channels.openPairing(third.account, third.conversation.id, 60_000, 2)).toBeUndefined();
    expect(plan(`SELECT code FROM pairing_requests WHERE status = 'pending' AND account_id = 'a' AND expires_at > ''`)).toContain('pairing_pending');
    expect(plan(`SELECT count(*) FROM pairing_requests WHERE status = 'pending' AND expires_at > ''`)).toContain('pairing_pending');
  });

  it('确认后账号绑定到本机所有者，其余待处理的配对作废；配对码只能用一次', () => {
    const { account, conversation } = seedDm();
    const { code } = store.channels.openPairing(account, conversation.id, 60_000, 3)!;
    const listed = store.channels.listPairings();
    expect(listed).toEqual([expect.objectContaining({ code, provider: 'feishu', displayName: '小王', status: 'pending' })]);

    const decided = store.channels.decidePairing(code, true);
    expect(decided.record.account).toMatchObject({ status: 'active', version: 1 });
    expect(decided.record.conversationId).toBe(conversation.id);
    expect(decided.events[0]).toMatchObject({ type: 'channel.account_changed', payload: { from: 'unbound', to: 'active' } });
    expect(store.db.get(`SELECT principal_id AS p FROM channel_accounts WHERE id = ?`, account.id)).toEqual({ p: 'principal_owner' });
    expect(() => store.channels.decidePairing(code, true)).toThrow(/不存在或已过期/);
    expect(store.channels.listPairings()).toEqual([]);
  });

  it('拒绝或过期的配对不改变账号；解绑清除所有者', () => {
    const { account, conversation } = seedDm();
    const { code } = store.channels.openPairing(account, conversation.id, 60_000, 3)!;
    expect(store.channels.decidePairing(code, false).record.account.status).toBe('unbound');
    const late = store.channels.openPairing(account, conversation.id, 60_000, 3)!;
    advance(60_001);
    expect(() => store.channels.decidePairing(late.code, true)).toThrow(/不存在或已过期/);

    const active = store.channels.setAccountStatus(account.id, 0, 'active').record;
    store.channels.setAccountStatus(active.id, active.version, 'revoked');
    expect(store.db.get(`SELECT principal_id AS p, status FROM channel_accounts WHERE id = ?`, account.id)).toEqual({ p: null, status: 'revoked' });
  });
});

describe('一次性卡片动作', () => {
  it('只在本会话、有效期内用一次；同一目标的其余按钮可一并作废', () => {
    const { conversation } = seedDm();
    const other = seedDm('ou_2').conversation;
    const base = { conversationId: conversation.id, targetId: 'prop_1', ttlMs: 60_000 };
    const confirm = store.channels.createAction({ ...base, kind: 'create_task', payload: '{}' });
    const dismiss = store.channels.createAction({ ...base, kind: 'dismiss' });
    expect(confirm.token).toMatch(/^[\w-]{16}$/);

    expect(store.channels.useAction(confirm.token, other.id)).toBeUndefined();
    expect(store.channels.useAction(confirm.token, conversation.id)).toMatchObject({ kind: 'create_task', status: 'used' });
    expect(store.channels.useAction(confirm.token, conversation.id)).toBeUndefined();
    expect(store.channels.voidActions('prop_1')).toBe(1);
    expect(store.channels.useAction(dismiss.token, conversation.id)).toBeUndefined();

    const late = store.channels.createAction({ ...base, targetId: 'prop_2', kind: 'dismiss' });
    advance(60_000);
    expect(store.channels.useAction(late.token, conversation.id)).toBeUndefined();
    expect(plan(`UPDATE channel_actions SET status = 'void' WHERE target_id = 'x' AND status = 'pending'`)).toContain(
      'channel_actions_pending_by_target',
    );
  });
});

describe('outbox', () => {
  it('按到期顺序投递；有主题的卡片记下平台消息 ID 供后续更新', () => {
    const { conversation } = seedDm();
    const a = store.outbox.enqueue('feishu', conversation.id, card, 'approval:1');
    const b = store.outbox.enqueue('feishu', conversation.id, { ...card, title: 'b' });
    const first = store.outbox.claimDue()!;
    expect(first).toMatchObject({ id: a, provider: 'feishu', conversationId: conversation.id, subject: 'approval:1', attempts: 1, card });
    store.outbox.markSent(first, 'om_1');
    expect(store.outbox.messageRef(conversation.id, 'approval:1')).toBe('om_1');
    expect(store.outbox.claimDue()!.id).toBe(b);
    expect(store.outbox.claimDue()).toBeUndefined();
    expect(plan(`SELECT id FROM outbox WHERE status = 'pending' AND next_attempt_at <= '' ORDER BY next_attempt_at, id LIMIT 1`)).toContain('outbox_due');
  });

  it('重试按退避时间再次到期；停用渠道时待发送的一律失败', () => {
    const { conversation } = seedDm();
    const id = store.outbox.enqueue('feishu', conversation.id, card);
    store.outbox.markRetry(store.outbox.claimDue()!.id, 2_000, 'network');
    expect(store.outbox.claimDue()).toBeUndefined();
    advance(2_000);
    expect(store.outbox.claimDue()).toMatchObject({ id, attempts: 2 });
    store.outbox.markRetry(id, 0, 'network');
    expect(store.outbox.failPending('feishu', '渠道已停用')).toBe(1);
    expect(store.db.get(`SELECT status, last_error AS e FROM outbox WHERE id = ?`, id)).toEqual({ status: 'failed', e: '渠道已停用' });
  });

  it('启动恢复把发送中的消息记为 unknown，不重发', () => {
    const { conversation } = seedDm();
    const id = store.outbox.enqueue('feishu', conversation.id, card);
    store.outbox.claimDue();
    expect(store.interruptActiveWork('服务重启').unknownOutbox).toBe(1);
    expect(store.db.get(`SELECT status FROM outbox WHERE id = ?`, id)).toEqual({ status: 'unknown' });
    expect(store.outbox.claimDue()).toBeUndefined();
  });
});

describe('渠道设置与游标', () => {
  it('默认两个渠道都未启用；保存带版本号', () => {
    expect(store.channels.listSettings()).toEqual([
      { provider: 'feishu', enabled: false, proxyUrl: null, version: 0 },
      { provider: 'telegram', enabled: false, proxyUrl: null, version: 0 },
    ]);
    const saved = store.channels.updateSettings('telegram', 0, true, 'http://127.0.0.1:7890');
    expect(saved.record).toEqual({ provider: 'telegram', enabled: true, proxyUrl: 'http://127.0.0.1:7890', version: 1 });
    expect(saved.events[0]).toMatchObject({ type: 'channel.settings_changed', payload: { provider: 'telegram', enabled: true } });
    expect(() => store.channels.updateSettings('telegram', 0, false, null)).toThrow(/已被修改/);
  });

  it('长轮询游标按渠道账号保存', () => {
    expect(store.channels.getCursor('telegram', '123')).toBeUndefined();
    store.channels.setCursor('telegram', '123', '42');
    store.channels.setCursor('telegram', '123', '43');
    expect(store.channels.getCursor('telegram', '123')).toBe('43');
  });
});

describe('审批升级', () => {
  function seedApproval() {
    const ws = store.tasks.ensureWorkspace('demo', 'D:/demo');
    const { subtask, session } = store.tasks.createTask({
      workspaceId: ws.id,
      title: '加记住我',
      goal: '加记住我',
      role: 'developer',
      checkCommand: null,
      checkConfirmed: false,
      idempotencyKey: 'k1',
    }).record;
    const run = store.runs.createRun({ subtaskId: subtask.id, sessionId: session.id, runtime: 'mock' }).record;
    const approval = store.runs.requestApproval({
      runId: run.id,
      kind: 'command',
      riskLevel: 'medium',
      summary: 'pnpm install',
      detail: null,
      cwd: null,
      nativeRequestId: 'r1',
      ttlMs: 30 * 60_000,
    }).record;
    return { ws, approval };
  }

  it('待升级的审批带项目等级和任务标题；只升级一次，已决定的不再升级', () => {
    const { approval } = seedApproval();
    expect(store.channels.escalationCandidates()).toEqual([
      expect.objectContaining({ remoteApprovalLevel: 'L1', workspaceName: 'demo', taskTitle: '加记住我', approval: expect.objectContaining({ id: approval.id, escalatedAt: null }) }),
    ]);
    expect(store.channels.markEscalated(approval.id, ['feishu'])).toMatchObject({ type: 'approval.escalated', payload: { channels: ['feishu'] } });
    expect(store.channels.markEscalated(approval.id, ['feishu'])).toBeUndefined();
    expect(store.channels.escalationCandidates()).toEqual([]);
    expect(store.channels.approvalContext(approval.id)!.approval.escalatedAt).toBe(clock.toISOString());
    expect(plan(`SELECT id FROM approvals WHERE status = 'pending' AND escalated_at IS NULL ORDER BY requested_at`)).toContain(
      'approvals_pending_unescalated',
    );
  });

  it('远程审批等级只能按版本修改，并写入事件', () => {
    const { ws } = seedApproval();
    const changed = store.tasks.setRemoteApprovalLevel(ws.id, ws.version, 'L2');
    expect(changed.record.remoteApprovalLevel).toBe('L2');
    expect(changed.events[0]).toMatchObject({ type: 'workspace.settings_changed', payload: { remoteApprovalLevel: 'L2' } });
    expect(() => store.tasks.setRemoteApprovalLevel(ws.id, ws.version, 'L0')).toThrow(/已被修改/);
    expect(store.tasks.listWorkspaces().map((w) => w.remoteApprovalLevel)).toEqual(['L2']);
  });
});

describe('表结构与契约一致', () => {
  const checkList = (table: string, column: string) => {
    const sql = String(store.db.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = ?`, table)!.sql);
    const list = new RegExp(`${column}\\s+TEXT NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(sql)![1]!;
    return list.split(',').map((s) => s.trim().slice(1, -1));
  };

  it('渠道与账号状态的 CHECK 列表等于 contracts 的数组', () => {
    expect(checkList('channel_accounts', 'status')).toEqual([...CHANNEL_ACCOUNT_STATUSES]);
    expect(checkList('channel_accounts', 'provider')).toEqual([...CHANNEL_PROVIDERS]);
    expect(checkList('external_conversations', 'provider')).toEqual([...CHANNEL_PROVIDERS]);
  });
});
