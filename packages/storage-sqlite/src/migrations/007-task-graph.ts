/**
 * P3-04 任务图：协调助手提出的计划（每版一行，确认后不改）与节点；计划节点物化出的子任务记下所属计划与节点键。
 * 依赖沿用 001 的 subtask_deps。约定同 001：部分索引的 WHERE 与查询条件逐字一致。
 */
export const taskGraphSchema = /* sql */ `
CREATE TABLE plans (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL REFERENCES tasks (id),
  -- 第几版（任务内从 1 递增）；version 是乐观锁，与其他状态表一致
  revision           INTEGER NOT NULL CHECK (revision > 0),
  status             TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected', 'superseded')),
  proposed_by_run_id TEXT REFERENCES runs (id),
  decision_note      TEXT,
  version            INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  decided_at         TEXT,
  UNIQUE (task_id, revision)
) STRICT;
-- 最新一版：UNIQUE (task_id, revision) 的自动索引倒序取一条

-- 主键按节点顺序，读计划节点不用排序；depends_on 存节点键
CREATE TABLE plan_nodes (
  plan_id    TEXT NOT NULL REFERENCES plans (id),
  position   INTEGER NOT NULL,
  node_key   TEXT NOT NULL,
  role       TEXT NOT NULL,
  title      TEXT NOT NULL,
  goal       TEXT NOT NULL,
  paths      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(paths)),
  depends_on TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(depends_on)),
  PRIMARY KEY (plan_id, position),
  UNIQUE (plan_id, node_key)
) STRICT, WITHOUT ROWID;

-- P1 / P2 的单子任务两列为空
ALTER TABLE subtasks ADD COLUMN plan_id TEXT REFERENCES plans (id);
ALTER TABLE subtasks ADD COLUMN node_key TEXT;
`;
