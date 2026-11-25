import { randomBytes, randomInt } from 'node:crypto';
import {
  CodedError,
  type ApprovalRecord,
  type Change,
  type ChannelAccountRecord,
  type ChannelAccountStatus,
  type ChannelActionRecord,
  type ChannelAddress,
  type ChannelProvider,
  type ChannelSettingsRecord,
  type ChannelStorePort,
  type ConversationRecord,
  type EscalationCandidate,
  type InboundRejection,
  type NewChannelAction,
  type PairingRecord,
  type PersistentEvent,
  type PlanRecord,
  type RemoteApprovalLevel,
} from '@paldock/contracts';
import type { Clock } from './clock.js';
import { COLUMNS } from './columns.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import { newId } from './writes.js';

const OWNER = 'principal_owner';
/** 配对码字母表：去掉 0/O、1/I/L 等容易看错的字符。 */
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 审批连同项目等级和任务标题（升级卡片与远程审批要用）。 */
const CANDIDATE_SELECT = `
    SELECT ${COLUMNS.approval('a.')}, w.remote_approval_level AS remoteApprovalLevel, w.name AS workspaceName,
           t.id AS taskId, t.title AS taskTitle
      FROM approvals a
      JOIN runs r ON r.id = a.run_id
      JOIN subtasks s ON s.id = r.subtask_id
      JOIN tasks t ON t.id = s.task_id
      JOIN workspaces w ON w.id = t.workspace_id`;

/** P3-10：外部会话 ↔ 主会话、引用回复反查、计划确认卡片。 */
const P310 = {
  // 只写一次
  setMainSession: `
    UPDATE external_conversations SET main_session_id = ?, version = version + 1 WHERE id = ? AND main_session_id IS NULL
    RETURNING ${COLUMNS.conversation()}`,
  // 部分唯一索引 conversations_by_main_session
  byMainSession: `SELECT ${COLUMNS.conversation()} FROM external_conversations WHERE main_session_id = ?`,
  subjectOfMessage: `SELECT subject FROM channel_messages WHERE conversation_id = ? AND message_ref = ?`,
  // plans_unescalated，条件逐字一致；任务还没结束才发
  planCandidates: `
    SELECT ${COLUMNS.plan('p.')}, w.remote_approval_level AS remoteApprovalLevel, w.name AS workspaceName, t.title AS taskTitle
      FROM plans p
      JOIN tasks t ON t.id = p.task_id
      JOIN workspaces w ON w.id = t.workspace_id
     WHERE p.status = 'proposed' AND p.escalated_at IS NULL AND t.status NOT IN ('succeeded', 'failed', 'cancelled')
     ORDER BY p.created_at`,
  markPlanEscalated: `UPDATE plans SET escalated_at = ? WHERE id = ? AND status = 'proposed' AND escalated_at IS NULL`,
} as const;

const SQL = {
  // 显示名会变：已存在时只更新显示名，版本不变（版本只随状态变化）
  upsertAccount: `
    INSERT INTO channel_accounts (id, provider, account, tenant_key, external_id, display_name, status, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'unbound', ?7, ?7)
    ON CONFLICT (provider, account, tenant_key, external_id) DO UPDATE
       SET display_name = CASE WHEN excluded.display_name = '' THEN display_name ELSE excluded.display_name END
    RETURNING ${COLUMNS.account()}`,
  selectAccount: `SELECT ${COLUMNS.account()} FROM channel_accounts WHERE id = ?`,
  selectAccounts: `SELECT ${COLUMNS.account()} FROM channel_accounts ORDER BY created_at`,
  setAccountStatus: `
    UPDATE channel_accounts
       SET status = $to, principal_id = CASE WHEN $to = 'active' THEN '${OWNER}' ELSE NULL END,
           version = version + 1, updated_at = $at
     WHERE id = $id AND version = $version
    RETURNING ${COLUMNS.account()}`,
  // 单聊的所属账号第一次见到时写入，之后不变（同一 chat 不会换人）
  upsertConversation: `
    INSERT INTO external_conversations (id, provider, account, tenant_key, chat_id, thread_key, kind, owner_account_id, title, created_at, last_seen_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
    ON CONFLICT (provider, account, tenant_key, chat_id, thread_key) DO UPDATE
       SET last_seen_at = excluded.last_seen_at,
           owner_account_id = coalesce(owner_account_id, excluded.owner_account_id),
           title = CASE WHEN excluded.title = '' THEN title ELSE excluded.title END
    RETURNING ${COLUMNS.conversation()}`,
  selectConversation: `SELECT ${COLUMNS.conversation()} FROM external_conversations WHERE id = ?`,
  // 条件与部分索引 conversations_groups 一致
  selectGroups: `SELECT ${COLUMNS.conversation()} FROM external_conversations WHERE kind = 'group' ORDER BY last_seen_at DESC`,
  // 已绑定账号的单聊：扫单聊的部分索引 conversations_dm_of_account，再按主键查账号状态（单聊数量很少）
  selectActiveDms: `
    SELECT ${COLUMNS.conversation('c.')}
      FROM channel_accounts a
      JOIN external_conversations c ON c.owner_account_id = a.id AND c.kind = 'dm'
     WHERE a.status = 'active'
     ORDER BY c.last_seen_at DESC`,
  setConversation: `
    UPDATE external_conversations SET group_allowed = ?, default_workspace_id = ?, version = version + 1
     WHERE id = ? AND version = ?
    RETURNING ${COLUMNS.conversation()}`,
  setCurrentTask: `UPDATE external_conversations SET current_task_id = ? WHERE id = ?`,
  // 部分索引 conversations_by_current_task（= 隐含 IS NOT NULL）
  selectFocusedOn: `SELECT ${COLUMNS.conversation()} FROM external_conversations WHERE current_task_id = ?`,
  clearCurrentTask: `UPDATE external_conversations SET current_task_id = NULL WHERE current_task_id = ?`,
  // 以下三条都走部分索引 pairing_pending（status = 'pending'）
  selectOpenPairing: `
    SELECT code FROM pairing_requests WHERE status = 'pending' AND account_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
  countOpenPairings: `SELECT count(*) AS n FROM pairing_requests WHERE status = 'pending' AND expires_at > ?`,
  selectPairings: `
    SELECT ${COLUMNS.pairing('p.')}, a.provider, a.display_name AS displayName
      FROM pairing_requests p JOIN channel_accounts a ON a.id = p.account_id
     WHERE p.status = 'pending' AND p.expires_at > ?
     ORDER BY p.created_at`,
  insertPairing: `
    INSERT INTO pairing_requests (code, account_id, conversation_id, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)`,
  decidePairing: `
    UPDATE pairing_requests SET status = ?, decided_at = ? WHERE code = ? AND status = 'pending' AND expires_at > ?
    RETURNING account_id AS accountId, conversation_id AS conversationId`,
  rejectOtherPairings: `UPDATE pairing_requests SET status = 'rejected', decided_at = ? WHERE status = 'pending' AND account_id = ?`,
  insertAction: `
    INSERT INTO channel_actions (token, conversation_id, kind, target_id, target_version, payload, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING ${COLUMNS.action()}`,
  // 一次性：只有本会话里、未过期、未用过的令牌能用上，并发点击只有一次成功
  useAction: `
    UPDATE channel_actions SET status = 'used' WHERE token = ? AND conversation_id = ? AND status = 'pending' AND expires_at > ?
    RETURNING ${COLUMNS.action()}`,
  // 走 channel_actions_pending_by_target
  voidActions: `UPDATE channel_actions SET status = 'void' WHERE target_id = ? AND status = 'pending'`,
  selectSettings: `SELECT ${COLUMNS.settings()} FROM channel_settings ORDER BY provider`,
  updateSettings: `
    UPDATE channel_settings SET enabled = ?, proxy_url = ?, version = version + 1, updated_at = ?
     WHERE provider = ? AND version = ?
    RETURNING ${COLUMNS.settings()}`,
  selectCursor: `SELECT cursor FROM channel_cursors WHERE provider = ? AND account = ?`,
  upsertCursor: `
    INSERT INTO channel_cursors (provider, account, cursor, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (provider, account) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
  // 升级扫描走部分索引 approvals_pending_unescalated
  escalationCandidates: `${CANDIDATE_SELECT} WHERE a.status = 'pending' AND a.escalated_at IS NULL ORDER BY a.requested_at`,
  approvalContext: `${CANDIDATE_SELECT} WHERE a.id = ?`,
  markEscalated: `
    UPDATE approvals SET escalated_at = ? WHERE id = ? AND status = 'pending' AND escalated_at IS NULL RETURNING id`,
} as const;

/** 与 COLUMNS 中各表的形状一致，只把 0/1 列换成布尔。 */
type ConversationRow = Omit<ConversationRecord, 'groupAllowed'> & { groupAllowed: number };
type SettingsRow = Omit<ChannelSettingsRecord, 'enabled'> & { enabled: number };
type CandidateRow = Omit<EscalationCandidate, 'approval'> & ApprovalRecord;

const toConversation = (row: ConversationRow): ConversationRecord => ({ ...row, groupAllowed: row.groupAllowed === 1 });
const toSettings = (row: SettingsRow): ChannelSettingsRecord => ({ ...row, enabled: row.enabled === 1 });
function toCandidate({ remoteApprovalLevel, workspaceName, taskId, taskTitle, ...approval }: CandidateRow): EscalationCandidate {
  return { approval, remoteApprovalLevel, workspaceName, taskId, taskTitle };
}

function pairingCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return code;
}

/**
 * 渠道身份、会话、配对、一次性动作和设置。所有状态变更与审计事件同一事务写入，
 * 写方法直接返回 RETURNING 的记录，不回查。
 */
export class ChannelRepository implements ChannelStorePort {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly clock: Clock,
  ) {}

  upsertAccount(address: ChannelAddress, externalId: string, displayName: string): ChannelAccountRecord {
    const { provider, account, tenant } = address;
    return this.db.get<ChannelAccountRecord>(SQL.upsertAccount, newId('acct'), provider, account, tenant, externalId, displayName, this.clock.iso())!;
  }

  getAccount(id: string): ChannelAccountRecord | undefined {
    return this.db.get<ChannelAccountRecord>(SQL.selectAccount, id);
  }

  listAccounts(): ChannelAccountRecord[] {
    return this.db.all<ChannelAccountRecord>(SQL.selectAccounts);
  }

  /** 绑定（active）、解绑（revoked）或允许重新配对（unbound）。 */
  setAccountStatus(id: string, expectedVersion: number, to: ChannelAccountStatus): Change<ChannelAccountRecord> {
    return this.db.transaction(() => {
      const before = this.getAccount(id);
      if (!before) throw new CodedError('not_found', '渠道账号不存在');
      const record = this.db.statement(SQL.setAccountStatus).get({ id, version: expectedVersion, to, at: this.clock.iso() }) as
        | ChannelAccountRecord
        | undefined;
      if (!record) throw new CodedError('conflict', '渠道账号已被修改，请刷新');
      const payload = { provider: record.provider, from: before.status, to };
      return { record, events: [this.events.append(id, { type: 'channel.account_changed', payload })] };
    });
  }

  upsertConversation(address: ChannelAddress, ownerAccountId: string | null, title: string): ConversationRecord {
    const { provider, account, tenant, chatId, threadKey, kind } = address;
    const row = this.db.get<ConversationRow>(
      SQL.upsertConversation,
      newId('conv'),
      provider,
      account,
      tenant,
      chatId,
      threadKey,
      kind,
      kind === 'dm' ? ownerAccountId : null,
      title,
      this.clock.iso(),
    )!;
    return toConversation(row);
  }

  getConversation(id: string): ConversationRecord | undefined {
    const row = this.db.get<ConversationRow>(SQL.selectConversation, id);
    return row && toConversation(row);
  }

  listGroups(): ConversationRecord[] {
    return this.db.all<ConversationRow>(SQL.selectGroups).map(toConversation);
  }

  setMainSession(conversationId: string, sessionId: string): ConversationRecord | undefined {
    const row = this.db.get<ConversationRow>(P310.setMainSession, sessionId, conversationId);
    return row && toConversation(row);
  }

  conversationOfMainSession(sessionId: string): ConversationRecord | undefined {
    const row = this.db.get<ConversationRow>(P310.byMainSession, sessionId);
    return row && toConversation(row);
  }

  subjectOfMessage(conversationId: string, messageRef: string): string | undefined {
    return this.db.get<{ subject: string }>(P310.subjectOfMessage, conversationId, messageRef)?.subject;
  }

  planEscalationCandidates(): { plan: PlanRecord; remoteApprovalLevel: RemoteApprovalLevel; workspaceName: string; taskTitle: string }[] {
    return this.db
      .all<PlanRecord & { remoteApprovalLevel: RemoteApprovalLevel; workspaceName: string; taskTitle: string }>(P310.planCandidates)
      .map(({ remoteApprovalLevel, workspaceName, taskTitle, ...plan }) => ({ plan, remoteApprovalLevel, workspaceName, taskTitle }));
  }

  markPlanEscalated(planId: string, channels: ChannelProvider[]): PersistentEvent | undefined {
    if (this.db.run(P310.markPlanEscalated, this.clock.iso(), planId) === 0) return undefined;
    return this.events.append(planId, { type: 'plan.escalated', payload: { channels } });
  }

  activeDirectConversations(): ConversationRecord[] {
    return this.db.all<ConversationRow>(SQL.selectActiveDms).map(toConversation);
  }

  setConversation(
    id: string,
    expectedVersion: number,
    settings: { groupAllowed: boolean; defaultWorkspaceId: string | null },
  ): Change<ConversationRecord> {
    return this.db.transaction(() => {
      const row = this.db.get<ConversationRow>(SQL.setConversation, settings.groupAllowed ? 1 : 0, settings.defaultWorkspaceId, id, expectedVersion);
      if (!row) throw new CodedError(this.getConversation(id) ? 'conflict' : 'not_found', '会话不存在或已被修改');
      return { record: toConversation(row), events: [this.events.append(id, { type: 'channel.conversation_changed', payload: settings })] };
    });
  }

  /** 把这个任务设为当前任务的会话。 */
  conversationsFocusedOn(taskId: string): ConversationRecord[] {
    return this.db.all<ConversationRow>(SQL.selectFocusedOn, taskId).map(toConversation);
  }

  clearCurrentTask(taskId: string): void {
    this.db.run(SQL.clearCurrentTask, taskId);
  }

  /** 当前任务只是一个指针，不改版本号（不与白名单、默认项目的设置冲突）。 */
  setCurrentTask(conversationId: string, taskId: string | null): void {
    this.db.run(SQL.setCurrentTask, taskId, conversationId);
  }

  /**
   * 陌生账号的配对码：已有未过期的就沿用（不刷屏）；否则在全部渠道待确认的配对未达上限时新建，
   * 防止陌生人轮换账号把桌面的待确认列表刷满。返回 undefined 表示已达上限。
   */
  openPairing(
    account: ChannelAccountRecord,
    conversationId: string,
    ttlMs: number,
    maxPending: number,
  ): { code: string; events: PersistentEvent[] } | undefined {
    return this.db.transaction(() => {
      const now = this.clock.iso();
      const open = this.db.get<{ code: string }>(SQL.selectOpenPairing, account.id, now);
      if (open) return { code: open.code, events: [] };
      if (this.db.get<{ n: number }>(SQL.countOpenPairings, now)!.n >= maxPending) return undefined;
      const code = pairingCode();
      this.db.run(SQL.insertPairing, code, account.id, conversationId, now, this.clock.isoAfter(ttlMs));
      return { code, events: [this.events.append(account.id, { type: 'channel.pairing_requested', payload: { provider: account.provider } })] };
    });
  }

  listPairings(): PairingRecord[] {
    return this.db.all<PairingRecord>(SQL.selectPairings, this.clock.iso());
  }

  /** 桌面确认或拒绝配对；确认时账号绑定到本机所有者，同一账号其余待处理的配对作废。 */
  decidePairing(code: string, approve: boolean): Change<{ account: ChannelAccountRecord; conversationId: string }> {
    return this.db.transaction(() => {
      const now = this.clock.iso();
      const decided = this.db.get<{ accountId: string; conversationId: string }>(SQL.decidePairing, approve ? 'approved' : 'rejected', now, code, now);
      if (!decided) throw new CodedError('not_found', '配对码不存在或已过期');
      const account = this.getAccount(decided.accountId)!;
      if (!approve) return { record: { account, conversationId: decided.conversationId }, events: [] };
      this.db.run(SQL.rejectOtherPairings, now, account.id);
      const change = this.setAccountStatus(account.id, account.version, 'active');
      return { record: { account: change.record, conversationId: decided.conversationId }, events: change.events };
    });
  }

  createAction(input: NewChannelAction): ChannelActionRecord {
    return this.db.get<ChannelActionRecord>(
      SQL.insertAction,
      randomBytes(12).toString('base64url'),
      input.conversationId,
      input.kind,
      input.targetId,
      input.targetVersion ?? null,
      input.payload ?? null,
      this.clock.iso(),
      this.clock.isoAfter(input.ttlMs),
    )!;
  }

  useAction(token: string, conversationId: string): ChannelActionRecord | undefined {
    return this.db.get<ChannelActionRecord>(SQL.useAction, token, conversationId, this.clock.iso());
  }

  voidActions(targetId: string): number {
    return this.db.run(SQL.voidActions, targetId);
  }

  listSettings(): ChannelSettingsRecord[] {
    return this.db.all<SettingsRow>(SQL.selectSettings).map(toSettings);
  }

  updateSettings(provider: ChannelProvider, expectedVersion: number, enabled: boolean, proxyUrl: string | null): Change<ChannelSettingsRecord> {
    return this.db.transaction(() => {
      const row = this.db.get<SettingsRow>(SQL.updateSettings, enabled ? 1 : 0, proxyUrl, this.clock.iso(), provider, expectedVersion);
      if (!row) throw new CodedError('conflict', '渠道设置已被修改，请刷新');
      return { record: toSettings(row), events: [this.events.append(provider, { type: 'channel.settings_changed', payload: { provider, enabled } })] };
    });
  }

  getCursor(provider: ChannelProvider, account: string): string | undefined {
    return this.db.get<{ cursor: string }>(SQL.selectCursor, provider, account)?.cursor;
  }

  setCursor(provider: ChannelProvider, account: string, cursor: string): void {
    this.db.run(SQL.upsertCursor, provider, account, cursor, this.clock.iso());
  }

  escalationCandidates(): EscalationCandidate[] {
    return this.db.all<CandidateRow>(SQL.escalationCandidates).map(toCandidate);
  }

  approvalContext(approvalId: string): EscalationCandidate | undefined {
    const row = this.db.get<CandidateRow>(SQL.approvalContext, approvalId);
    return row && toCandidate(row);
  }

  /** 只升级一次：已决定或已升级的审批返回 undefined。 */
  markEscalated(approvalId: string, channels: ChannelProvider[]): PersistentEvent | undefined {
    return this.db.transaction(() => {
      if (!this.db.get(SQL.markEscalated, this.clock.iso(), approvalId)) return undefined;
      return this.events.append(approvalId, { type: 'approval.escalated', payload: { channels } });
    });
  }

  /** 入站被拒绝的审计记录；不含正文和对方 ID。 */
  audit(aggregateId: string, provider: ChannelProvider, reason: InboundRejection): PersistentEvent {
    return this.events.append(aggregateId, { type: 'channel.inbound_rejected', payload: { provider, reason } });
  }
}
