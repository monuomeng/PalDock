/**
 * P3-08 计划确认与自动处理：节点可在确认前改执行器；项目的自动处理设置（默认全关）；
 * 自动处理记录单：凡是没经过用户的决定都留一条（跳过审阅、审阅助手放行或退回、唤醒被跳过或因请求上限中断；
 * 按等级自动批准 P3 还没有，类别先留着）。约定同 001。
 */
export const planEditAutoSchema = /* sql */ `
-- 空表示按角色在项目里的执行器
ALTER TABLE plan_nodes ADD COLUMN executor TEXT CHECK (executor IS NULL OR executor IN ('codex', 'claude'));

-- { skipReviewRoles[] }；只在桌面修改。没有「跳过计划确认」：P3 的每个计划都要用户确认（2026-11-25 已定）
ALTER TABLE workspaces ADD COLUMN auto_policy TEXT NOT NULL DEFAULT '{"skipReviewRoles":[]}' CHECK (json_valid(auto_policy));

CREATE TABLE auto_decisions (
  id           INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  task_id      TEXT NOT NULL REFERENCES tasks (id),
  plan_id      TEXT REFERENCES plans (id),
  subtask_id   TEXT REFERENCES subtasks (id),
  kind         TEXT NOT NULL CHECK (kind IN ('skip_review', 'review_passed', 'review_rework', 'wake_dropped', 'wake_aborted', 'auto_approve')),
  reason       TEXT NOT NULL,
  created_at   TEXT NOT NULL
) STRICT;
-- 记录单按项目筛选、按时间倒序（id 递增即时间顺序）
CREATE INDEX auto_decisions_by_workspace ON auto_decisions (workspace_id, id);
`;
