/**
 * 默认在当前仓库协作（2026-11-26 已定，0.3.6）。约定同 001。
 * - 工作区方式：current（所有助手共用项目目录，新项目默认）/ worktree（以前的做法，已有项目迁移后保持）；
 *   切了分支时暂停写入的原因。
 * - 每次 Run 在项目目录里的前后快照（git tree，用临时索引写，不动用户的暂存区）和开始时的分支、HEAD。
 * - 助手的写入记录（执行器报告的补丁 / 替换 / 写入内容）：提交时据此决定哪些改动块默认勾选。
 * - 提交 / 推送 / 合并卡片：都要你确认，确认后由宿主执行。
 * - 合并：集成检查通过的时间（重启后据此判断候选提交是不是检查过的）。
 */
export const currentWorkspaceSchema = /* sql */ `
ALTER TABLE workspaces ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'worktree' CHECK (workspace_mode IN ('current', 'worktree'));
ALTER TABLE workspaces ADD COLUMN paused_reason TEXT;
ALTER TABLE merge_ops ADD COLUMN checked_at TEXT;

CREATE TABLE run_snapshots (
  run_id       TEXT PRIMARY KEY REFERENCES runs (id),
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  branch       TEXT,
  head         TEXT NOT NULL,
  start_tree   TEXT NOT NULL,
  end_tree     TEXT,
  created_at   TEXT NOT NULL,
  ended_at     TEXT
) STRICT;
-- 提交时按项目找「上次提交之后」的各次 Run
CREATE INDEX run_snapshots_by_workspace ON run_snapshots (workspace_id, created_at);

CREATE TABLE run_writes (
  id         INTEGER PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs (id),
  path       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('patch', 'replace', 'content')),
  detail     TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX run_writes_by_run ON run_writes (run_id);

CREATE TABLE git_ops (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  session_id   TEXT,
  run_id       TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('commit', 'push', 'merge')),
  status       TEXT NOT NULL CHECK (status IN ('proposed', 'done', 'failed', 'cancelled', 'stale')),
  request      TEXT NOT NULL CHECK (json_valid(request)),
  result       TEXT,
  version      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  decided_at   TEXT
) STRICT;
CREATE INDEX git_ops_open ON git_ops (workspace_id, created_at) WHERE status = 'proposed';
CREATE INDEX git_ops_by_session ON git_ops (session_id, created_at);
`;
