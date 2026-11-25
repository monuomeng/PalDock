/**
 * P3-07 协调助手主会话：对话任务（主会话的 Run 挂在它的协调助手子任务上，任务列表不列）、唤醒记录、
 * 协调助手发给用户的通知（编号即问题编号）、滚动摘要；「待我处理」视图加上未读的通知。约定同 001。
 */
export const coordinatorSchema = /* sql */ `
-- conversation：主会话的载体，子任务一直是 draft，不进状态机
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work', 'conversation'));
CREATE INDEX tasks_conversations ON tasks (workspace_id, created_at) WHERE kind = 'conversation';

CREATE TABLE wakes (
  id          INTEGER PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions (id),
  trigger     TEXT NOT NULL CHECK (trigger IN ('user_message', 'task_event')),
  -- 用户消息 ID 或事件序号：同一触发只唤醒一次
  dedupe_key  TEXT NOT NULL UNIQUE,
  summary     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'dropped')),
  run_id      TEXT REFERENCES runs (id),
  requests    INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  ended_at    TEXT
) STRICT;
-- 下一条待处理（按会话、按到达顺序）、正在跑的、频率限制要数的任务事件唤醒
CREATE INDEX wakes_pending ON wakes (session_id, id) WHERE status = 'pending';
CREATE INDEX wakes_running ON wakes (session_id) WHERE status = 'running';
CREATE INDEX wakes_event_starts ON wakes (session_id, started_at) WHERE trigger = 'task_event';
CREATE INDEX wakes_by_session ON wakes (session_id, id);

CREATE TABLE user_notices (
  id           INTEGER PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions (id),
  run_id       TEXT REFERENCES runs (id),
  kind         TEXT NOT NULL CHECK (kind IN ('info', 'question')),
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'read')),
  escalated_at TEXT,
  created_at   TEXT NOT NULL
) STRICT;
CREATE INDEX notices_by_session ON user_notices (session_id, id);
-- 升级扫描：桌面没人看、还没发出去的
CREATE INDEX notices_unescalated ON user_notices (created_at) WHERE status = 'open' AND escalated_at IS NULL;

-- 滚动摘要：协调助手经 write_summary 写，按会话带版本号保留历史；新开原生会话时注入最新一份。原生压缩不作数据来源
CREATE TABLE session_summaries (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  version    INTEGER NOT NULL CHECK (version > 0),
  body       TEXT NOT NULL,
  run_id     TEXT REFERENCES runs (id),
  -- 写摘要时这个会话已完成的唤醒数，用来判断下一次什么时候该写
  wakes_done INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, version)
) STRICT, WITHOUT ROWID;

DROP VIEW attention_items;
CREATE VIEW attention_items AS
SELECT 'approval' AS kind, a.id AS item_id, s.task_id, a.run_id, t.title, a.summary AS reason, a.requested_at AS since
  FROM approvals a
  JOIN runs r ON r.id = a.run_id
  JOIN subtasks s ON s.id = r.subtask_id
  JOIN tasks t ON t.id = s.task_id
 WHERE a.status = 'pending'
UNION ALL
SELECT s.status, coalesce(s.latest_run_id, s.id), s.task_id, s.latest_run_id, t.title, s.status_reason, s.updated_at
  FROM (
    SELECT id, task_id, status, status_reason, updated_at,
           (SELECT r.id FROM runs r WHERE r.subtask_id = subtasks.id ORDER BY r.attempt DESC LIMIT 1) AS latest_run_id
      FROM subtasks
     WHERE status IN ('blocked', 'review')
  ) s
  JOIN tasks t ON t.id = s.task_id
UNION ALL
SELECT 'unconfirmed_run', r.id, s.task_id, r.id, t.title, r.failure_reason, r.started_at
  FROM runs r
  JOIN subtasks s ON s.id = r.subtask_id
  JOIN tasks t ON t.id = s.task_id
 WHERE r.status = 'unconfirmed'
UNION ALL
-- 协调助手的通知：task_id 是对话任务，点开去对话页
SELECT 'notice', CAST(n.id AS TEXT), s.task_id, n.run_id, 'Q' || n.id || ' · 协调助手', n.body, n.created_at
  FROM user_notices n
  JOIN sessions ss ON ss.id = n.session_id
  JOIN subtasks s ON s.id = ss.subtask_id
 WHERE n.status = 'open';
`;
