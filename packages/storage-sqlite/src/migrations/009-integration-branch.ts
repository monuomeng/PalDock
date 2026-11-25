/**
 * P3-06 任务集成分支：任务的集成分支、它的 worktree 与起点；每次把节点合进集成分支的操作记录（merge_ops）。
 * merge_ops 先写后做：重启时（P3-09）对照 Git 决定补记、重试或交给人。约定同 001。
 */
export const integrationBranchSchema = /* sql */ `
ALTER TABLE tasks ADD COLUMN integration_branch TEXT;
ALTER TABLE tasks ADD COLUMN integration_worktree TEXT;
ALTER TABLE tasks ADD COLUMN integration_base TEXT;

CREATE TABLE merge_ops (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks (id),
  subtask_id     TEXT NOT NULL REFERENCES subtasks (id),
  source_sha     TEXT NOT NULL,
  target_old     TEXT NOT NULL,
  candidate_sha  TEXT,
  phase          TEXT NOT NULL CHECK (phase IN ('started', 'candidate', 'done', 'conflict', 'check_failed')),
  conflict_files TEXT CHECK (conflict_files IS NULL OR json_valid(conflict_files)),
  detail         TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;
-- 子任务最近一次合并：按 (subtask_id, created_at) 倒序取一条
CREATE INDEX merge_ops_by_subtask ON merge_ops (subtask_id, created_at);
-- 重启恢复（P3-09）：还没结束的合并
CREATE INDEX merge_ops_open ON merge_ops (created_at) WHERE phase IN ('started', 'candidate');
`;
