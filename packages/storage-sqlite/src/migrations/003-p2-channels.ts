/**
 * P2 外部渠道：身份（Principal、渠道账号、配对码）、渠道会话、一次性卡片动作、已发卡片、渠道设置与长轮询游标。
 * 约定同 001：部分索引的 WHERE 与查询条件逐字一致；时间为 ISO-8601 UTC 文本。
 */
export const p2Schema = /* sql */ `
-- P2 只有一个用户：本机所有者。多人与角色以后再说
CREATE TABLE principals (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL
) STRICT;
INSERT INTO principals (id, display_name, created_at) VALUES ('principal_owner', '本机所有者', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 外部平台上的一个人；绑定（active）后才能使用，解绑（revoked）后一律拒绝
CREATE TABLE channel_accounts (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL CHECK (provider IN ('feishu', 'telegram')),
  account      TEXT NOT NULL,
  tenant_key   TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  display_name TEXT NOT NULL,
  principal_id TEXT REFERENCES principals (id),
  status       TEXT NOT NULL CHECK (status IN ('unbound', 'active', 'revoked')),
  version      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (provider, account, tenant_key, external_id)
) STRICT;

CREATE TABLE external_conversations (
  id                   TEXT PRIMARY KEY,
  provider             TEXT NOT NULL CHECK (provider IN ('feishu', 'telegram')),
  account              TEXT NOT NULL,
  tenant_key           TEXT NOT NULL,
  chat_id              TEXT NOT NULL,
  thread_key           TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
  owner_account_id     TEXT REFERENCES channel_accounts (id),
  default_workspace_id TEXT REFERENCES workspaces (id),
  group_allowed        INTEGER NOT NULL DEFAULT 0 CHECK (group_allowed IN (0, 1)),
  title                TEXT NOT NULL DEFAULT '',
  awaiting_token       TEXT,
  version              INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  UNIQUE (provider, account, tenant_key, chat_id, thread_key)
) STRICT;
-- 审批升级与配对通知：找已绑定账号的单聊
CREATE INDEX conversations_dm_of_account ON external_conversations (owner_account_id) WHERE kind = 'dm';
CREATE INDEX conversations_groups ON external_conversations (last_seen_at) WHERE kind = 'group';

CREATE TABLE pairing_requests (
  code            TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES channel_accounts (id),
  conversation_id TEXT NOT NULL REFERENCES external_conversations (id),
  status          TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  decided_at      TEXT
) STRICT;
CREATE INDEX pairing_pending ON pairing_requests (account_id, expires_at) WHERE status = 'pending';

-- 卡片按钮背后的一次性动作：令牌随卡片下发，点击时核对会话、目标版本与有效期
CREATE TABLE channel_actions (
  token           TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES external_conversations (id),
  kind            TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  target_version  INTEGER,
  payload         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used', 'void')),
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
) STRICT;
-- 目标状态变了（审批已在桌面处理）时作废同一目标的其余按钮
CREATE INDEX channel_actions_pending_by_target ON channel_actions (target_id) WHERE status = 'pending';

-- 按主题发出的卡片（如 approval:<id>），后续更新同一张卡片
CREATE TABLE channel_messages (
  conversation_id TEXT NOT NULL REFERENCES external_conversations (id),
  subject         TEXT NOT NULL,
  message_ref     TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (conversation_id, subject)
) STRICT, WITHOUT ROWID;

-- 渠道的非秘密设置；凭据在系统凭据库
CREATE TABLE channel_settings (
  provider   TEXT PRIMARY KEY CHECK (provider IN ('feishu', 'telegram')),
  enabled    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  proxy_url  TEXT,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
) STRICT;
INSERT INTO channel_settings (provider, updated_at) VALUES
  ('feishu', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('telegram', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Telegram getUpdates 的 offset 等长轮询游标
CREATE TABLE channel_cursors (
  provider   TEXT NOT NULL,
  account    TEXT NOT NULL,
  cursor     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, account)
) STRICT, WITHOUT ROWID;

-- 从外部渠道建的任务，结果回发到这个会话
ALTER TABLE tasks ADD COLUMN origin_conversation_id TEXT REFERENCES external_conversations (id);

-- outbox：target 为会话 ID；subject 非空时同主题的后续卡片更新已发出的那张
ALTER TABLE outbox ADD COLUMN subject TEXT;
ALTER TABLE outbox ADD COLUMN last_error TEXT;
ALTER TABLE outbox ADD COLUMN sent_at TEXT;
-- 启动恢复与渠道停用：找发送中、待发送的行
CREATE INDEX outbox_sending ON outbox (channel) WHERE status = 'sending';
CREATE INDEX outbox_pending_by_channel ON outbox (channel) WHERE status = 'pending';

-- 审批升级扫描：只看还没升级的待审批
CREATE INDEX approvals_pending_unescalated ON approvals (requested_at) WHERE status = 'pending' AND escalated_at IS NULL;
`;
