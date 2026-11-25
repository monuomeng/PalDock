/**
 * P3-02 助手角色：角色设置（出厂六个角色）、按项目的执行器覆盖、每次 Run 的用量。
 * 出厂值与 domain 的 FACTORY_PROFILES 一致（测试校验）；之后改出厂值只追加新迁移。
 */
export const agentProfilesSchema = /* sql */ `
CREATE TABLE agent_profiles (
  role              TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  description       TEXT NOT NULL,
  prompt_version    INTEGER NOT NULL DEFAULT 1,
  executor          TEXT NOT NULL CHECK (executor IN ('codex', 'claude')),
  fallback_executor TEXT CHECK (fallback_executor IS NULL OR fallback_executor IN ('codex', 'claude')),
  workspace_access  TEXT NOT NULL CHECK (workspace_access IN ('none', 'read', 'worktree_write')),
  delivery_scope    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(delivery_scope)),
  max_run_minutes   INTEGER NOT NULL CHECK (max_run_minutes > 0),
  max_concurrency   INTEGER NOT NULL CHECK (max_concurrency > 0),
  version           INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL
) STRICT;

INSERT INTO agent_profiles (role, display_name, description, executor, workspace_access, delivery_scope, max_run_minutes, max_concurrency, updated_at) VALUES
  ('coordinator', '协调助手', '和你对话，拆分任务、提出计划、汇总结果；不直接改代码', 'claude', 'read', '[]', 30, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('developer', '开发助手', '在自己的 worktree 里改代码并提交结果', 'claude', 'worktree_write', '[]', 60, 4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('tester', '测试助手', '补测试、跑测试，只交付测试文件', 'codex', 'worktree_write', '["**/*.test.*", "**/*.spec.*", "test/**", "tests/**"]', 60, 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('reviewer', '审阅助手', '只读审阅改动，给出通过或退回意见', 'codex', 'read', '[]', 30, 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('docs', '文档助手', '写和更新文档，只交付文档', 'claude', 'worktree_write', '["docs/**", "**/*.md"]', 30, 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('researcher', '调研助手', '只读调研代码和资料，产出结论', 'codex', 'read', '[]', 30, 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 主键 (workspace_id, role) 同时服务「某项目的全部覆盖」和「某项目某角色」两种查询
CREATE TABLE agent_overrides (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  role         TEXT NOT NULL REFERENCES agent_profiles (role),
  executor     TEXT NOT NULL CHECK (executor IN ('codex', 'claude')),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, role)
) STRICT, WITHOUT ROWID;

ALTER TABLE runs ADD COLUMN input_tokens INTEGER;
ALTER TABLE runs ADD COLUMN output_tokens INTEGER;
ALTER TABLE runs ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE runs ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE runs ADD COLUMN cost_usd REAL;
`;
