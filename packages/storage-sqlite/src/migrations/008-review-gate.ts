/**
 * P3-05 验收闸门与审阅：节点的检查命令（随计划确认）、子任务在 review 内的闸门阶段、Run 的用途（工作 / 审阅）、
 * 证据与审阅结论绑定的提交 SHA、越出交付范围的文件。约定同 001。
 */
export const reviewGateSchema = /* sql */ `
-- 结构化的 { executable, args[] }，不经 shell；确认计划即确认这些命令
ALTER TABLE plan_nodes ADD COLUMN check_command TEXT CHECK (check_command IS NULL OR json_valid(check_command));

-- review 状态内的阶段：review 审阅中、human 交给人；空表示刚交付。子任务换状态时清空
ALTER TABLE subtasks ADD COLUMN gate_stage TEXT CHECK (gate_stage IS NULL OR gate_stage IN ('review', 'human'));

-- 审阅也是子任务的一次 Run，但用独立的会话，不改子任务状态；「最新一次 Run」只看 work
ALTER TABLE runs ADD COLUMN purpose TEXT NOT NULL DEFAULT 'work' CHECK (purpose IN ('work', 'review'));

ALTER TABLE run_results ADD COLUMN commit_sha TEXT;
ALTER TABLE run_results ADD COLUMN out_of_scope TEXT CHECK (out_of_scope IS NULL OR json_valid(out_of_scope));

-- 审阅助手的结论：run_id 仍是被审的那次工作 Run，reviewer_run_id 是交结论的审阅 Run（每次只收一份）
ALTER TABLE run_reviews ADD COLUMN reviewer_run_id TEXT REFERENCES runs (id);
ALTER TABLE run_reviews ADD COLUMN commit_sha TEXT;
CREATE UNIQUE INDEX run_reviews_by_reviewer ON run_reviews (reviewer_run_id) WHERE reviewer_run_id IS NOT NULL;
`;
