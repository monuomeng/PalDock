/**
 * P1：任务目标与检查命令、助手会话与原生会话映射、Run 的 turn 身份与续做关系、
 * 审批细节、每次 Run 的证据与验收记录；重建「待我处理」视图。
 * 001 已发布，不修改；部分索引的 WHERE 与查询条件逐字一致。
 */
export const p1Schema = /* sql */ `
ALTER TABLE tasks ADD COLUMN goal TEXT NOT NULL DEFAULT '';
-- 结构化的 { executable, args[] }，不经 shell
ALTER TABLE tasks ADD COLUMN check_command TEXT CHECK (check_command IS NULL OR json_valid(check_command));
ALTER TABLE tasks ADD COLUMN check_confirmed_at TEXT;
ALTER TABLE tasks ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX tasks_by_idempotency_key ON tasks (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX tasks_by_created ON tasks (created_at);

ALTER TABLE subtasks ADD COLUMN status_reason TEXT;
-- P1 每个写入型子任务一个 worktree，各次 Run 共用
ALTER TABLE subtasks ADD COLUMN worktree_path TEXT;
ALTER TABLE subtasks ADD COLUMN branch TEXT;
ALTER TABLE subtasks ADD COLUMN base_commit TEXT;

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('main', 'agent')),
  parent_id  TEXT REFERENCES sessions (id),
  subtask_id TEXT REFERENCES subtasks (id),
  role       TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX sessions_by_subtask ON sessions (subtask_id) WHERE subtask_id IS NOT NULL;

-- 原生会话（Codex thread）与 PalDock 会话分开存；一个 PalDock 会话可能先后用过多个原生会话
CREATE TABLE runtime_sessions (
  runtime    TEXT NOT NULL,
  native_id  TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (runtime, native_id)
) STRICT, WITHOUT ROWID;

ALTER TABLE runs RENAME COLUMN native_session_id TO native_thread_id;
ALTER TABLE runs ADD COLUMN session_id TEXT REFERENCES sessions (id);
-- 一次 Run 只对应一个 turn，写入后不再修改；续做时新建 Run 并指向被续做的那次
ALTER TABLE runs ADD COLUMN native_turn_id TEXT;
ALTER TABLE runs ADD COLUMN resumes_run_id TEXT REFERENCES runs (id);
ALTER TABLE runs ADD COLUMN failure_reason TEXT;

-- 迁移前已有的审批行没有类别，记为 other
ALTER TABLE approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'other'
  CHECK (kind IN ('command', 'file_change', 'permissions', 'other'));
ALTER TABLE approvals ADD COLUMN native_request_id TEXT;
ALTER TABLE approvals ADD COLUMN cwd TEXT;
ALTER TABLE approvals ADD COLUMN detail TEXT;
CREATE INDEX approvals_by_run ON approvals (run_id);

-- 每次 Run 的证据；退回重做后旧 Run 的证据保留。检查输出脱敏后存为 artifacts/ 下的文件
CREATE TABLE run_results (
  run_id            TEXT PRIMARY KEY REFERENCES runs (id),
  final_message     TEXT,
  diff_stat         TEXT,
  check_status      TEXT NOT NULL
    CHECK (check_status IN ('not_configured', 'not_confirmed', 'passed', 'failed', 'timed_out', 'cancelled', 'error')),
  check_exit_code   INTEGER,
  check_duration_ms INTEGER,
  check_output_ref  TEXT,
  collected_at      TEXT NOT NULL
) STRICT;

-- 验收或退回的意见绑定到产生证据的那次 Run
CREATE TABLE run_reviews (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs (id),
  decision   TEXT NOT NULL CHECK (decision IN ('accept', 'rework')),
  note       TEXT,
  decided_at TEXT NOT NULL
) STRICT;
CREATE INDEX run_reviews_by_run ON run_reviews (run_id);

ALTER TABLE messages ADD COLUMN run_id TEXT REFERENCES runs (id);
CREATE INDEX messages_by_run ON messages (run_id, id) WHERE run_id IS NOT NULL;

-- 条目指向「点开后要看的那次 Run」：审批所在的 Run，或子任务最新的 Run。
-- 阻塞与待验收用最新 Run 的 ID 作为条目 ID，退回重做后的新一轮验收是一条新的（未读）待办。
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
    -- 最新 Run 走 UNIQUE (subtask_id, attempt) 索引倒序取第一条
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
 WHERE r.status = 'unconfirmed';
`;
