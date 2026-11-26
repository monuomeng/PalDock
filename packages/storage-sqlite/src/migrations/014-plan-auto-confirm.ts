/**
 * 简单计划自动确认（2026-11-26 已定）：计划记下排定的自动确认时间；自动处理记录单多两种决定。
 * auto_decisions 的 kind 是 CHECK 约束，SQLite 改不了约束，只能重建这张表（没有别的表引用它）。约定同 001。
 */
export const planAutoConfirmSchema = /* sql */ `
ALTER TABLE plans ADD COLUMN auto_confirm_at TEXT;
-- 重启后重新排定：还在待确认、排定了自动确认的计划
CREATE INDEX plans_auto_confirm ON plans (auto_confirm_at) WHERE status = 'proposed' AND auto_confirm_at IS NOT NULL;

CREATE TABLE auto_decisions_new (
  id           INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  task_id      TEXT NOT NULL REFERENCES tasks (id),
  plan_id      TEXT REFERENCES plans (id),
  subtask_id   TEXT REFERENCES subtasks (id),
  kind         TEXT NOT NULL CHECK (kind IN ('skip_review', 'review_passed', 'review_rework', 'wake_dropped', 'wake_aborted', 'auto_approve',
                                             'plan_auto_confirmed', 'plan_auto_withdrawn')),
  reason       TEXT NOT NULL,
  created_at   TEXT NOT NULL
) STRICT;
INSERT INTO auto_decisions_new SELECT id, workspace_id, task_id, plan_id, subtask_id, kind, reason, created_at FROM auto_decisions;
DROP TABLE auto_decisions;
ALTER TABLE auto_decisions_new RENAME TO auto_decisions;
CREATE INDEX auto_decisions_by_workspace ON auto_decisions (workspace_id, id);
`;
