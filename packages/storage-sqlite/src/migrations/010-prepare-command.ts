/**
 * worktree 准备命令：项目可选设置一条命令（例如 pnpm install --frozen-lockfile），新建的 worktree 在跑检查命令前先执行一次。
 * 节点 worktree 记下已准备的时间（之后各次 Run 共用，不重复准备）；证据记下准备命令的结果。约定同 001。
 */
export const prepareCommandSchema = /* sql */ `
-- 结构化的 { executable, args[] }，不经 shell；只能在桌面设置
ALTER TABLE workspaces ADD COLUMN prepare_command TEXT CHECK (prepare_command IS NULL OR json_valid(prepare_command));
ALTER TABLE subtasks ADD COLUMN prepared_at TEXT;
ALTER TABLE run_results ADD COLUMN prepare_status TEXT
  CHECK (prepare_status IS NULL OR prepare_status IN ('not_configured', 'not_confirmed', 'passed', 'failed', 'timed_out', 'cancelled', 'error'));
`;
