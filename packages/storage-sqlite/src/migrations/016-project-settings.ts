/**
 * 项目级助手设置（2026-11-26 已定，0.3.4）：工作模式与单人设置；按角色的启用、隔离方式、审批严格度。
 * 执行器仍在 agent_overrides。没有行时按默认（团队模式、角色全部启用、可写角色独立 worktree、只读角色只读、
 * worktree 内自动批准），所以旧数据迁移后行为不变。约定同 001。
 */
export const projectSettingsSchema = /* sql */ `
CREATE TABLE project_agent_settings (
  workspace_id   TEXT PRIMARY KEY REFERENCES workspaces (id),
  mode           TEXT NOT NULL CHECK (mode IN ('team', 'solo')),
  solo_executor  TEXT CHECK (solo_executor IS NULL OR solo_executor IN ('codex', 'claude')),
  solo_isolation TEXT NOT NULL CHECK (solo_isolation IN ('worktree', 'direct', 'readonly')),
  solo_approval  TEXT NOT NULL CHECK (solo_approval IN ('worktree_auto', 'all', 'high_only')),
  solo_review    INTEGER NOT NULL CHECK (solo_review IN (0, 1)),
  version        INTEGER NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

CREATE TABLE project_role_settings (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  role         TEXT NOT NULL,
  enabled      INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  isolation    TEXT NOT NULL CHECK (isolation IN ('worktree', 'direct', 'readonly')),
  approval     TEXT NOT NULL CHECK (approval IN ('worktree_auto', 'all', 'high_only')),
  version      INTEGER NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, role)
) STRICT, WITHOUT ROWID;
`;
