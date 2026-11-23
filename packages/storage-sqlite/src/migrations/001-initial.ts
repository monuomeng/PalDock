/**
 * P0 样机的初始表结构，只覆盖任务板、审批、事件、inbox/outbox、消息检索和「待我处理」。
 * 约定：状态表带 version 做乐观并发；时间统一为 ISO-8601 UTC 文本；
 * 部分索引的 WHERE 与查询条件逐字一致，保证 SQLite 能选中它们。
 */
export const initialSchema = /* sql */ `
CREATE TABLE workspaces (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  root_path             TEXT NOT NULL UNIQUE,
  remote_approval_level TEXT NOT NULL DEFAULT 'L1' CHECK (remote_approval_level IN ('L0', 'L1', 'L2')),
  worktree_location     TEXT NOT NULL DEFAULT 'data_root' CHECK (worktree_location IN ('data_root', 'beside_project')),
  version               INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL
) STRICT;

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  title        TEXT NOT NULL,
  status       TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE INDEX tasks_by_workspace ON tasks (workspace_id, status);

CREATE TABLE subtasks (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks (id),
  role         TEXT NOT NULL,
  goal         TEXT NOT NULL,
  status       TEXT NOT NULL,
  rework_count INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE INDEX subtasks_by_task ON subtasks (task_id);
CREATE INDEX subtasks_needing_attention ON subtasks (updated_at) WHERE status IN ('blocked', 'review');

CREATE TABLE subtask_deps (
  subtask_id    TEXT NOT NULL REFERENCES subtasks (id),
  depends_on_id TEXT NOT NULL REFERENCES subtasks (id),
  PRIMARY KEY (subtask_id, depends_on_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  subtask_id        TEXT NOT NULL REFERENCES subtasks (id),
  attempt           INTEGER NOT NULL,
  runtime           TEXT NOT NULL,
  native_session_id TEXT,
  status            TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 0,
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  UNIQUE (subtask_id, attempt)
) STRICT;
CREATE INDEX runs_active ON runs (status) WHERE status IN ('starting', 'running', 'waiting_approval', 'unconfirmed');
-- SQLite 不会从 status = 'x' 推出 status IN (...)，所以单值查询各自配一个部分索引
CREATE INDEX runs_unconfirmed ON runs (started_at) WHERE status = 'unconfirmed';

CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs (id),
  risk_level   TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  summary      TEXT NOT NULL,
  status       TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  escalated_at TEXT,
  decided_at   TEXT,
  decided_via  TEXT,
  version      INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX approvals_pending ON approvals (requested_at) WHERE status = 'pending';

-- 「待我处理」只存已读状态；待办本身从业务状态派生（见 attention_items 视图）。
CREATE TABLE attention_reads (
  item_kind TEXT NOT NULL,
  item_id   TEXT NOT NULL,
  read_at   TEXT NOT NULL,
  PRIMARY KEY (item_kind, item_id)
) STRICT, WITHOUT ROWID;

CREATE VIEW attention_items AS
SELECT 'approval' AS kind, a.id AS item_id, s.task_id, a.summary AS title, a.requested_at AS since
  FROM approvals a
  JOIN runs r ON r.id = a.run_id
  JOIN subtasks s ON s.id = r.subtask_id
 WHERE a.status = 'pending'
UNION ALL
SELECT s.status, s.id, s.task_id, s.goal, s.updated_at
  FROM subtasks s
 WHERE s.status IN ('blocked', 'review')
UNION ALL
SELECT 'unconfirmed_run', r.id, s.task_id, s.goal, r.started_at
  FROM runs r
  JOIN subtasks s ON s.id = r.subtask_id
 WHERE r.status = 'unconfirmed';

-- 持久事件：seq 全局递增，与状态表在同一事务内写入。
CREATE TABLE events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_id   TEXT NOT NULL,
  type           TEXT NOT NULL,
  payload        TEXT NOT NULL CHECK (json_valid(payload)),
  schema_version INTEGER NOT NULL,
  occurred_at    TEXT NOT NULL
) STRICT;
CREATE INDEX events_by_aggregate ON events (aggregate_id, seq);

-- 入站去重：处理完保留墓碑行（payload 置空），迟到的重复事件仍被主键拒绝。
CREATE TABLE inbox (
  queue            TEXT NOT NULL,
  event_id         TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'rejected')),
  payload          TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  lease_until      TEXT,
  received_at      TEXT NOT NULL,
  PRIMARY KEY (queue, event_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX inbox_open ON inbox (received_at) WHERE status IN ('pending', 'processing');
CREATE INDEX inbox_processing ON inbox (conversation_key, lease_until) WHERE status = 'processing';

CREATE TABLE outbox (
  id              INTEGER PRIMARY KEY,
  channel         TEXT NOT NULL,
  target          TEXT NOT NULL,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'unknown', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL
) STRICT;
CREATE INDEX outbox_due ON outbox (next_attempt_at) WHERE status = 'pending';

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX messages_by_session ON messages (session_id, id);

-- trigram 支持中文子串检索，但查询至少 3 个字符；更短的查询走 LIKE 回退。
CREATE VIRTUAL TABLE messages_fts USING fts5 (body, content = 'messages', content_rowid = 'id', tokenize = 'trigram');
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF body ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO messages_fts (rowid, body) VALUES (new.id, new.body);
END;

-- 审计不含秘密和消息正文。
CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY,
  at     TEXT NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  result TEXT NOT NULL
) STRICT;
`;
