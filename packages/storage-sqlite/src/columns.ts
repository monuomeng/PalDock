import type { CheckCommand, TaskRecord } from '@paldock/contracts';

/**
 * 每张表的 RETURNING / SELECT 列只定义一次，插入、更新和查询返回同一形状（contracts 的记录类型）。
 * `alias` 用于联表查询时加表前缀。
 */
const cols = (list: string) => (alias = '') =>
  list
    .split(',')
    .map((c) => c.trim())
    .map((c) => {
      const [column, as] = c.split(/\s+AS\s+/);
      return `${alias}${column}${as ? ` AS ${as}` : ''}`;
    })
    .join(', ');

export const COLUMNS = {
  workspace: cols(`id, name, root_path AS rootPath, remote_approval_level AS remoteApprovalLevel, version`),
  task: cols(
    `id, workspace_id AS workspaceId, title, goal, status, check_command AS checkCommand,
     check_confirmed_at AS checkConfirmedAt, version, created_at AS createdAt, updated_at AS updatedAt`,
  ),
  subtask: cols(
    `id, task_id AS taskId, role, goal, status, status_reason AS statusReason, rework_count AS reworkCount,
     worktree_path AS worktreePath, branch, base_commit AS baseCommit, version, updated_at AS updatedAt`,
  ),
  session: cols(`id, kind, subtask_id AS subtaskId, role`),
  run: cols(
    `id, subtask_id AS subtaskId, session_id AS sessionId, attempt, runtime, native_thread_id AS nativeThreadId,
     native_turn_id AS nativeTurnId, resumes_run_id AS resumesRunId, status, failure_reason AS failureReason,
     version, started_at AS startedAt, ended_at AS endedAt`,
  ),
  approval: cols(
    `id, run_id AS runId, kind, risk_level AS riskLevel, summary, detail, cwd, status, requested_at AS requestedAt,
     expires_at AS expiresAt, decided_via AS decidedVia, version`,
  ),
  result: cols(
    `run_id AS runId, final_message AS finalMessage, diff_stat AS diffStat, check_status AS checkStatus,
     check_exit_code AS checkExitCode, check_duration_ms AS checkDurationMs, check_output_ref AS checkOutputRef,
     collected_at AS collectedAt`,
  ),
  review: cols(`id, run_id AS runId, decision, note, decided_at AS decidedAt`),
  message: cols(`id, session_id AS sessionId, run_id AS runId, role, body, created_at AS createdAt`),
} as const;

/** check_command 以 JSON 文本存储，读出时还原；其余列与记录类型一一对应。 */
export type TaskRow = Omit<TaskRecord, 'checkCommand'> & { checkCommand: string | null };

export function toTask(row: TaskRow): TaskRecord {
  return { ...row, checkCommand: row.checkCommand === null ? null : (JSON.parse(row.checkCommand) as CheckCommand) };
}
