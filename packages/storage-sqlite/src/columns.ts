import type { CheckCommand, RunResultRecord, TaskRecord, WorkspaceRecord } from '@paldock/contracts';

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
  workspace: cols(`id, name, root_path AS rootPath, remote_approval_level AS remoteApprovalLevel, prepare_command AS prepareCommand, version`),
  task: cols(
    `id, workspace_id AS workspaceId, title, goal, status, check_command AS checkCommand,
     check_confirmed_at AS checkConfirmedAt, origin_conversation_id AS originConversationId,
     continued_from_task_id AS continuedFromTaskId, integration_branch AS integrationBranch,
     integration_worktree AS integrationWorktree, integration_base AS integrationBase, kind,
     version, created_at AS createdAt, updated_at AS updatedAt`,
  ),
  subtask: cols(
    `id, task_id AS taskId, role, goal, status, status_reason AS statusReason, rework_count AS reworkCount,
     worktree_path AS worktreePath, branch, base_commit AS baseCommit, plan_id AS planId, node_key AS nodeKey,
     gate_stage AS gateStage, prepared_at AS preparedAt, version, updated_at AS updatedAt`,
  ),
  session: cols(`id, kind, subtask_id AS subtaskId, role`),
  run: cols(
    `id, subtask_id AS subtaskId, session_id AS sessionId, attempt, runtime, native_thread_id AS nativeThreadId,
     native_turn_id AS nativeTurnId, resumes_run_id AS resumesRunId, status, failure_reason AS failureReason, purpose,
     version, started_at AS startedAt, ended_at AS endedAt`,
  ),
  approval: cols(
    `id, run_id AS runId, kind, risk_level AS riskLevel, summary, detail, cwd, status, requested_at AS requestedAt,
     expires_at AS expiresAt, decided_via AS decidedVia, escalated_at AS escalatedAt, version`,
  ),
  result: cols(
    `run_id AS runId, final_message AS finalMessage, diff_stat AS diffStat, check_status AS checkStatus,
     check_exit_code AS checkExitCode, check_duration_ms AS checkDurationMs, check_output_ref AS checkOutputRef,
     commit_sha AS commitSha, out_of_scope AS outOfScope, prepare_status AS prepareStatus, collected_at AS collectedAt`,
  ),
  review: cols(`id, run_id AS runId, decision, note, reviewer_run_id AS reviewerRunId, commit_sha AS commitSha, decided_at AS decidedAt`),
  message: cols(`id, session_id AS sessionId, run_id AS runId, role, body, created_at AS createdAt`),
  account: cols(
    `id, provider, account, external_id AS externalId, display_name AS displayName, status, version,
     created_at AS createdAt, updated_at AS updatedAt`,
  ),
  conversation: cols(
    `id, provider, account, tenant_key AS tenant, chat_id AS chatId, thread_key AS threadKey, kind,
     owner_account_id AS ownerAccountId, default_workspace_id AS defaultWorkspaceId, group_allowed AS groupAllowed,
     title, current_task_id AS currentTaskId, version, last_seen_at AS lastSeenAt`,
  ),
  pairing: cols(`code, account_id AS accountId, status, created_at AS createdAt, expires_at AS expiresAt`),
  action: cols(
    `token, conversation_id AS conversationId, kind, target_id AS targetId, target_version AS targetVersion, payload,
     status, expires_at AS expiresAt`,
  ),
  settings: cols(`provider, enabled, proxy_url AS proxyUrl, version`),
  agentProfile: cols(
    `role, display_name AS displayName, description, prompt_version AS promptVersion, executor,
     fallback_executor AS fallbackExecutor, workspace_access AS workspaceAccess, delivery_scope AS deliveryScope,
     max_run_minutes AS maxRunMinutes, max_concurrency AS maxConcurrency, version, updated_at AS updatedAt`,
  ),
  agentOverride: cols(`workspace_id AS workspaceId, role, executor`),
  plan: cols(
    `id, task_id AS taskId, revision, status, proposed_by_run_id AS proposedByRunId, decision_note AS decisionNote,
     version, created_at AS createdAt, decided_at AS decidedAt`,
  ),
  planNode: cols(`plan_id AS planId, position, node_key AS key, role, title, goal, paths, depends_on AS dependsOn, check_command AS checkCommand`),
  merge: cols(
    `id, task_id AS taskId, subtask_id AS subtaskId, source_sha AS sourceSha, target_old AS targetOld,
     candidate_sha AS candidateSha, phase, conflict_files AS conflictFiles, detail, created_at AS createdAt, updated_at AS updatedAt`,
  ),
  wake: cols(
    `id, session_id AS sessionId, trigger, summary, status, run_id AS runId, requests, note, created_at AS createdAt,
     started_at AS startedAt, ended_at AS endedAt`,
  ),
  notice: cols(`id, session_id AS sessionId, run_id AS runId, kind, body, status, escalated_at AS escalatedAt, created_at AS createdAt`),
  summary: cols(`session_id AS sessionId, version, body, run_id AS runId, wakes_done AS wakesDone, created_at AS createdAt`),
  handoff: cols(`run_id AS runId, summary, notes, submitted_at AS submittedAt`),
  usage: cols(
    `input_tokens AS inputTokens, output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens,
     cache_write_tokens AS cacheWriteTokens, cost_usd AS costUsd`,
  ),
  outbox: cols(`id, channel AS provider, target AS conversationId, subject, payload, attempts`),
} as const;

/** prepare_command 以 JSON 文本存储，读出时还原。 */
export type WorkspaceRow = Omit<WorkspaceRecord, 'prepareCommand'> & { prepareCommand: string | null };
export const toWorkspace = (row: WorkspaceRow): WorkspaceRecord => ({
  ...row,
  prepareCommand: row.prepareCommand === null ? null : (JSON.parse(row.prepareCommand) as CheckCommand),
});

/** out_of_scope 以 JSON 文本存储，读出时还原。 */
export type ResultRow = Omit<RunResultRecord, 'outOfScope'> & { outOfScope: string | null };
export const toResult = (row: ResultRow): RunResultRecord => ({ ...row, outOfScope: row.outOfScope === null ? null : (JSON.parse(row.outOfScope) as string[]) });

/** check_command 以 JSON 文本存储，读出时还原；其余列与记录类型一一对应。 */
export type TaskRow = Omit<TaskRecord, 'checkCommand'> & { checkCommand: string | null };

export function toTask(row: TaskRow): TaskRecord {
  return { ...row, checkCommand: row.checkCommand === null ? null : (JSON.parse(row.checkCommand) as CheckCommand) };
}
