/**
 * 角色会话（2026-11-26 已定）：每个（项目，角色，执行器）的长期原生会话池；Run 记下用的是哪个。约定同 001。
 */
export const roleSessionsSchema = /* sql */ `
CREATE TABLE role_sessions (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces (id),
  role             TEXT NOT NULL,
  executor         TEXT NOT NULL,
  native_thread_id TEXT,
  status           TEXT NOT NULL CHECK (status IN ('idle', 'busy', 'retired')),
  turns            INTEGER NOT NULL DEFAULT 0,
  tokens           INTEGER NOT NULL DEFAULT 0,
  summary          TEXT,
  retire_requested INTEGER NOT NULL DEFAULT 0 CHECK (retire_requested IN (0, 1)),
  archived         INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at       TEXT NOT NULL,
  last_used_at     TEXT,
  retired_at       TEXT
) STRICT;
-- 池：按组合找没换下的会话
CREATE INDEX role_sessions_open ON role_sessions (workspace_id, role, executor) WHERE status <> 'retired';
-- 新会话首轮注入：同一组合最近写下的摘要
CREATE INDEX role_sessions_summary ON role_sessions (workspace_id, role, executor, retired_at) WHERE summary IS NOT NULL;

ALTER TABLE runs ADD COLUMN role_session_id TEXT REFERENCES role_sessions (id);
`;
