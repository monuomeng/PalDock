import { CodedError } from '@paldock/contracts';
import type {
  ApprovalChannel,
  Change,
  NewApproval,
  NewRun,
  NewRunResult,
  PersistentEvent,
  RunNoticeCode,
  RunStorePort,
  ApprovalKind,
  ApprovalRecord,
  ApprovalStatus,
  MessageRecord,
  ReviewDecision,
  RiskLevel,
  RunDetail,
  RunRecord,
  RunResultRecord,
  RunReviewRecord,
  RunStatus,
  RunUsageRecord,
  RunHandoffRecord,
} from '@paldock/contracts';
import { approvalMachine, runMachine } from '@paldock/domain';
import type { Clock } from './clock.js';
import { COLUMNS, toResult, type ResultRow } from './columns.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import { applyTransition, insertWithEvent, newId, statusChanged, type TransitionSpec } from './writes.js';

const SQL = {
  // 每次 Run 是独立尝试，attempt 在子任务内递增（走 UNIQUE (subtask_id, attempt) 索引）；旧 Run 及其证据保留
  insertRun: `
    INSERT INTO runs (id, subtask_id, session_id, attempt, runtime, native_thread_id, resumes_run_id, status, started_at, purpose)
    VALUES (?1, ?2, ?3, (SELECT coalesce(max(attempt), 0) + 1 FROM runs WHERE subtask_id = ?2), ?4, ?5, ?6, 'starting', ?7, ?8)
    RETURNING ${COLUMNS.run()}`,
  selectRun: `SELECT ${COLUMNS.run()} FROM runs WHERE id = ?`,
  selectRunsOfSubtask: `SELECT ${COLUMNS.run()} FROM runs WHERE subtask_id = ? ORDER BY attempt`,
  // 审阅 Run 不算：按 attempt 倒序跳过（每轮最多一次审阅，扫描很短）
  selectLatestRun: `SELECT ${COLUMNS.run()} FROM runs WHERE subtask_id = ? AND purpose = 'work' ORDER BY attempt DESC LIMIT 1`,
  // 原生 ID 只写一次：thread 在续做时已预先填好，turn 一旦记录就不再覆盖
  setThread: `
    UPDATE runs SET native_thread_id = ?2 WHERE id = ?1 AND (native_thread_id IS NULL OR native_thread_id = ?2)
    RETURNING ${COLUMNS.run()}`,
  insertRuntimeSession: `
    INSERT INTO runtime_sessions (runtime, native_id, session_id, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (runtime, native_id) DO NOTHING`,
  setTurn: `
    UPDATE runs SET native_turn_id = ? WHERE id = ? AND native_turn_id IS NULL
    RETURNING ${COLUMNS.run()}`,
  insertApproval: `
    INSERT INTO approvals (id, run_id, kind, risk_level, summary, detail, cwd, native_request_id, status, requested_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    RETURNING ${COLUMNS.approval()}`,
  selectApproval: `SELECT ${COLUMNS.approval()} FROM approvals WHERE id = ?`,
  // 走部分索引 approvals_pending（条件逐字一致）
  selectExpired: `SELECT ${COLUMNS.approval()} FROM approvals WHERE status = 'pending' AND expires_at <= ? ORDER BY requested_at`,
  // Run 结束时一次取消它全部挂起的审批（走 approvals_by_run）
  cancelPendingOfRun: `
    UPDATE approvals SET status = 'cancelled', version = version + 1, decided_at = ?, decided_via = 'policy'
     WHERE run_id = ? AND status = 'pending'
    RETURNING ${COLUMNS.approval()}`,
  insertResult: `
    INSERT INTO run_results (run_id, final_message, diff_stat, check_status, check_exit_code, check_duration_ms, check_output_ref,
                             commit_sha, out_of_scope, prepare_status, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING ${COLUMNS.result()}`,
  selectResult: `SELECT ${COLUMNS.result()} FROM run_results WHERE run_id = ?`,
  insertReview: `
    INSERT INTO run_reviews (id, run_id, decision, note, reviewer_run_id, commit_sha, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING ${COLUMNS.review()}`,
  // 走部分唯一索引 run_reviews_by_reviewer（= 隐含 IS NOT NULL）
  // 走 run_reviews_by_run
  selectReviewsOfRun: `SELECT ${COLUMNS.review()} FROM run_reviews WHERE run_id = ? ORDER BY decided_at`,
  selectReviewByReviewer: `SELECT ${COLUMNS.review()} FROM run_reviews WHERE reviewer_run_id = ?`,
  autoReworkCount: `
    SELECT count(*) AS n FROM runs r JOIN run_reviews x ON x.run_id = r.id
     WHERE r.subtask_id = ? AND x.reviewer_run_id IS NOT NULL AND x.decision = 'rework'`,
  // 任务详情：每类数据一条查询，按子任务的各次 Run 联表取，分别走各自按 run_id 的索引
  resultsOfSubtask: `
    SELECT ${COLUMNS.result('x.')} FROM runs r JOIN run_results x ON x.run_id = r.id WHERE r.subtask_id = ?`,
  reviewsOfSubtask: `
    SELECT ${COLUMNS.review('x.')} FROM runs r JOIN run_reviews x ON x.run_id = r.id WHERE r.subtask_id = ? ORDER BY x.decided_at`,
  approvalsOfSubtask: `
    SELECT ${COLUMNS.approval('x.')} FROM runs r JOIN approvals x ON x.run_id = r.id WHERE r.subtask_id = ? ORDER BY x.requested_at`,
  messagesOfSubtask: `
    SELECT ${COLUMNS.message('x.')} FROM runs r JOIN messages x ON x.run_id = r.id WHERE r.subtask_id = ? ORDER BY x.id`,
  // 用量只写一次：input_tokens 为空才写
  setUsage: `
    UPDATE runs SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?
     WHERE id = ? AND input_tokens IS NULL`,
  selectUsage: `SELECT ${COLUMNS.usage()} FROM runs WHERE id = ? AND input_tokens IS NOT NULL`,
  // 每次 Run 一份：主键冲突时不插入，RETURNING 为空
  insertHandoff: `
    INSERT INTO run_handoffs (run_id, summary, notes, submitted_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (run_id) DO NOTHING
    RETURNING ${COLUMNS.handoff()}`,
  selectHandoff: `SELECT ${COLUMNS.handoff()} FROM run_handoffs WHERE run_id = ?`,
} as const;

const TRANSITIONS = {
  run: {
    machine: runMachine,
    select: `SELECT status, version FROM runs WHERE id = ?`,
    update: `
      UPDATE runs SET status = $to, version = version + 1, ended_at = coalesce($endedAt, ended_at),
             failure_reason = coalesce($reason, failure_reason)
       WHERE id = $id AND version = $version
      RETURNING ${COLUMNS.run()}`,
  },
  approval: {
    machine: approvalMachine,
    select: `SELECT status, version FROM approvals WHERE id = ?`,
    update: `
      UPDATE approvals SET status = $to, version = version + 1, decided_at = $at, decided_via = $via
       WHERE id = $id AND version = $version
      RETURNING ${COLUMNS.approval()}`,
  },
} satisfies { run: TransitionSpec<RunStatus>; approval: TransitionSpec<ApprovalStatus> };

const groupByRun = <T extends { runId: string | null }>(rows: T[]) => {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.runId) continue;
    const list = map.get(row.runId);
    if (list) list.push(row);
    else map.set(row.runId, [row]);
  }
  return map;
};

/** Run、审批、证据与验收记录的写入口；规则同 TaskRepository。 */
export class RunRepository implements RunStorePort {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly clock: Clock,
  ) {}

  createRun(input: NewRun): Change<RunRecord> {
    const params = [
      newId('run'),
      input.subtaskId,
      input.sessionId,
      input.runtime,
      input.nativeThreadId ?? null,
      input.resumesRunId ?? null,
      this.clock.iso(),
      input.purpose ?? 'work',
    ];
    return insertWithEvent<RunRecord>(this.db, this.events, SQL.insertRun, params, (run) => ({
      type: 'run.created',
      payload: { subtaskId: run.subtaskId, runtime: run.runtime, attempt: run.attempt },
    }));
  }

  getRun(id: string): RunRecord | undefined {
    return this.db.get<RunRecord>(SQL.selectRun, id);
  }

  latestRun(subtaskId: string): RunRecord | undefined {
    return this.db.get<RunRecord>(SQL.selectLatestRun, subtaskId);
  }

  /** 记录原生会话，并登记到 runtime_sessions；同一 Run 换 thread 会被拒绝（返回 undefined）。 */
  recordThread(run: Pick<RunRecord, 'id' | 'runtime' | 'sessionId'>, threadId: string): RunRecord | undefined {
    return this.db.transaction(() => {
      const updated = this.db.get<RunRecord>(SQL.setThread, run.id, threadId);
      if (updated && run.sessionId) this.db.run(SQL.insertRuntimeSession, run.runtime, threadId, run.sessionId, this.clock.iso());
      return updated;
    });
  }

  /** turn 只记录一次；已有值时返回 undefined，调用方据此发现执行器异常。 */
  recordTurn(runId: string, turnId: string): RunRecord | undefined {
    return this.db.get<RunRecord>(SQL.setTurn, turnId, runId);
  }

  /** 进入终态时写结束时间；reason 缺省时保留原有失败原因。 */
  transitionRun(id: string, expectedVersion: number, to: RunStatus, reason?: string): Change<RunRecord> {
    return applyTransition(this.db, this.events, TRANSITIONS.run, id, expectedVersion, to, (from) => ({
      params: { endedAt: runMachine.isTerminal(to) ? this.clock.iso() : null, reason: reason ?? null },
      event: { type: 'run.status_changed', payload: statusChanged(from, to, reason) },
    }));
  }

  requestApproval(input: NewApproval): Change<ApprovalRecord> {
    const expiresAt = this.clock.isoAfter(input.ttlMs);
    const params = [
      newId('appr'),
      input.runId,
      input.kind,
      input.riskLevel,
      input.summary,
      input.detail,
      input.cwd,
      input.nativeRequestId,
      this.clock.iso(),
      expiresAt,
    ];
    return insertWithEvent(this.db, this.events, SQL.insertApproval, params, () => ({
      type: 'approval.requested',
      payload: { runId: input.runId, kind: input.kind, riskLevel: input.riskLevel, expiresAt },
    }));
  }

  getApproval(id: string): ApprovalRecord | undefined {
    return this.db.get<ApprovalRecord>(SQL.selectApproval, id);
  }

  /** Run 结束或执行器断线时，把这次 Run 仍挂起的审批一次置为 cancelled（policy），每条各写一个事件。 */
  cancelPendingApprovals(runId: string): Change<ApprovalRecord[]> {
    return this.db.transaction(() => {
      const record = this.db.all<ApprovalRecord>(SQL.cancelPendingOfRun, this.clock.iso(), runId);
      const events = record.map((a) => this.events.append(a.id, { type: 'approval.decided', payload: { status: 'cancelled', via: 'policy' } }));
      return { record, events };
    });
  }

  expiredApprovals(): ApprovalRecord[] {
    return this.db.all<ApprovalRecord>(SQL.selectExpired, this.clock.iso());
  }

  /** 先到者为准：两端同时处理时只有带着正确 version 的一方成功，另一方得到 conflict。 */
  decideApproval(
    id: string,
    expectedVersion: number,
    status: Exclude<ApprovalStatus, 'pending'>,
    via: ApprovalChannel,
  ): Change<ApprovalRecord> {
    return applyTransition(this.db, this.events, TRANSITIONS.approval, id, expectedVersion, status, () => ({
      params: { at: this.clock.iso(), via },
      event: { type: 'approval.decided', payload: { status, via } },
    }));
  }

  saveResult(result: NewRunResult): Change<RunResultRecord> {
    const params = [
      result.runId,
      result.finalMessage,
      result.diffStat,
      result.checkStatus,
      result.checkExitCode,
      result.checkDurationMs,
      result.checkOutputRef,
      result.commitSha ?? null,
      result.outOfScope ? JSON.stringify(result.outOfScope) : null,
      result.prepareStatus ?? null,
      this.clock.iso(),
    ];
    const change = insertWithEvent<ResultRow>(
      this.db,
      this.events,
      SQL.insertResult,
      params,
      (r) => ({ type: 'run.result_collected', payload: { checkStatus: r.checkStatus } }),
      (r) => r.runId,
    );
    return { record: toResult(change.record), events: change.events };
  }

  getResult(runId: string): RunResultRecord | undefined {
    const row = this.db.get<ResultRow>(SQL.selectResult, runId);
    return row && toResult(row);
  }

  addReview(runId: string, decision: ReviewDecision, note: string | null, reviewer?: { runId: string; commitSha: string | null }): Change<RunReviewRecord> {
    const params = [newId('rev'), runId, decision, note, reviewer?.runId ?? null, reviewer?.commitSha ?? null, this.clock.iso()];
    return insertWithEvent(this.db, this.events, SQL.insertReview, params, () => ({ type: 'review.decided', payload: { decision } }));
  }

  reviewsOfRun(runId: string): RunReviewRecord[] {
    return this.db.all<RunReviewRecord>(SQL.selectReviewsOfRun, runId);
  }

  reviewOf(reviewerRunId: string): RunReviewRecord | undefined {
    return this.db.get<RunReviewRecord>(SQL.selectReviewByReviewer, reviewerRunId);
  }

  autoReworkCount(subtaskId: string): number {
    return this.db.get<{ n: number }>(SQL.autoReworkCount, subtaskId)!.n;
  }

  recordUsage(runId: string, u: RunUsageRecord): void {
    this.db.run(SQL.setUsage, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, u.costUsd, runId);
  }

  getUsage(runId: string): RunUsageRecord | undefined {
    return this.db.get<RunUsageRecord>(SQL.selectUsage, runId);
  }

  submitHandoff(runId: string, summary: string, notes: string | null): Change<RunHandoffRecord> {
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new CodedError('not_found', 'Run 不存在');
      const record = this.db.get<RunHandoffRecord>(SQL.insertHandoff, runId, summary, notes, this.clock.iso());
      if (!record) throw new CodedError('conflict', '这次 Run 已经提交过交接记录');
      return { record, events: [this.events.append(runId, { type: 'run.handoff_submitted', payload: { subtaskId: run.subtaskId } })] };
    });
  }

  getHandoff(runId: string): RunHandoffRecord | undefined {
    return this.db.get<RunHandoffRecord>(SQL.selectHandoff, runId);
  }

  addNotice(runId: string, code: RunNoticeCode, detail: string): PersistentEvent {
    return this.events.append(runId, { type: 'run.notice', payload: { code, detail: detail.slice(0, 500) } });
  }

  /** 子任务的全部 Run 及其证据，按 attempt 升序；共 5 条查询，与 Run 的数量无关。 */
  runDetails(subtaskId: string, options: { messages?: boolean } = {}): RunDetail[] {
    const runs = this.db.all<RunRecord>(SQL.selectRunsOfSubtask, subtaskId);
    const results = new Map(this.db.all<ResultRow>(SQL.resultsOfSubtask, subtaskId).map((r) => [r.runId, toResult(r)]));
    const reviews = groupByRun(this.db.all<RunReviewRecord>(SQL.reviewsOfSubtask, subtaskId));
    const approvals = groupByRun(this.db.all<ApprovalRecord>(SQL.approvalsOfSubtask, subtaskId));
    const messages = options.messages === false ? new Map<string, MessageRecord[]>() : groupByRun(this.db.all<MessageRecord>(SQL.messagesOfSubtask, subtaskId));
    return runs.map((run) => ({
      run,
      result: results.get(run.id) ?? null,
      reviews: reviews.get(run.id) ?? [],
      approvals: approvals.get(run.id) ?? [],
      messages: messages.get(run.id) ?? [],
    }));
  }
}
