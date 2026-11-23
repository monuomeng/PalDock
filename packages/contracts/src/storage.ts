import type { PersistentEvent, RunNoticeCode } from './events.js';
import type {
  ApprovalRecord,
  AttentionItem,
  CheckCommand,
  MessageRecord,
  RunDetail,
  RunRecord,
  RunResultRecord,
  RunReviewRecord,
  SessionRecord,
  SubtaskRecord,
  TaskRecord,
  TaskSummary,
  WorkspaceRecord,
} from './records.js';
import type {
  ApprovalChannel,
  ApprovalKind,
  ApprovalStatus,
  AttentionKind,
  MessageRole,
  ReviewDecision,
  RiskLevel,
  RunStatus,
  SubtaskStatus,
  TaskStatus,
} from './states.js';

/**
 * 存储适配器契约（02「适配器契约 · Storage」）：应用层只依赖这里的接口，不直接依赖 SQLite。
 * 写方法返回最新记录（RETURNING）与同事务写入的持久事件，调用方负责广播。
 */

export interface Change<T> {
  record: T;
  events: PersistentEvent[];
}

export interface NewTask {
  workspaceId: string;
  title: string;
  goal: string;
  role: string;
  checkCommand: CheckCommand | null;
  checkConfirmed: boolean;
  idempotencyKey: string;
}

export interface CreatedTask {
  task: TaskRecord;
  subtask: SubtaskRecord;
  session: SessionRecord;
}

export interface NewRun {
  subtaskId: string;
  sessionId: string;
  runtime: string;
  /** 续做时沿用的原生会话，以及被续做的那次 Run。 */
  nativeThreadId?: string;
  resumesRunId?: string;
}

export interface NewApproval {
  runId: string;
  kind: ApprovalKind;
  riskLevel: RiskLevel;
  summary: string;
  detail: string | null;
  cwd: string | null;
  nativeRequestId: string | null;
  ttlMs: number;
}

export type NewRunResult = Omit<RunResultRecord, 'collectedAt'>;

export interface InterruptedRun {
  id: string;
  subtaskId: string;
  /** 可按原生会话 ID 尝试续做；为空则只能重新开始或放弃。 */
  nativeThreadId: string | null;
}

export interface RecoveryReport {
  interruptedRuns: InterruptedRun[];
  reopenedInbox: number;
  events: PersistentEvent[];
}

export interface TaskStorePort {
  ensureWorkspace(name: string, rootPath: string): WorkspaceRecord;
  getWorkspace(id: string): WorkspaceRecord | undefined;
  createTask(input: NewTask): Change<CreatedTask>;
  findTaskByIdempotencyKey(key: string): TaskRecord | undefined;
  getTask(id: string): TaskRecord | undefined;
  getSubtask(id: string): SubtaskRecord | undefined;
  getSubtaskOfTask(taskId: string): SubtaskRecord | undefined;
  getSessionOfSubtask(subtaskId: string): SessionRecord | undefined;
  listTasks(limit: number): TaskSummary[];
  setWorktree(subtaskId: string, worktreePath: string, branch: string, baseCommit: string): SubtaskRecord | undefined;
  transitionTask(id: string, expectedVersion: number, to: TaskStatus, reason?: string): Change<TaskRecord>;
  transitionSubtask(id: string, expectedVersion: number, to: SubtaskStatus, reason?: string): Change<SubtaskRecord>;
}

export interface RunStorePort {
  createRun(input: NewRun): Change<RunRecord>;
  getRun(id: string): RunRecord | undefined;
  latestRun(subtaskId: string): RunRecord | undefined;
  recordThread(run: Pick<RunRecord, 'id' | 'runtime' | 'sessionId'>, threadId: string): RunRecord | undefined;
  recordTurn(runId: string, turnId: string): RunRecord | undefined;
  transitionRun(id: string, expectedVersion: number, to: RunStatus, reason?: string): Change<RunRecord>;
  requestApproval(input: NewApproval): Change<ApprovalRecord>;
  getApproval(id: string): ApprovalRecord | undefined;
  cancelPendingApprovals(runId: string): Change<ApprovalRecord[]>;
  expiredApprovals(): ApprovalRecord[];
  decideApproval(id: string, expectedVersion: number, status: Exclude<ApprovalStatus, 'pending'>, via: ApprovalChannel): Change<ApprovalRecord>;
  saveResult(result: NewRunResult): Change<RunResultRecord>;
  getResult(runId: string): RunResultRecord | undefined;
  addReview(runId: string, decision: ReviewDecision, note: string | null): Change<RunReviewRecord>;
  runDetails(subtaskId: string): RunDetail[];
  /** 不改变状态、只需让用户知道的情况（未识别的请求、恢复失败、输出截断）。 */
  addNotice(runId: string, code: RunNoticeCode, detail: string): PersistentEvent;
}

export interface StorePort {
  tasks: TaskStorePort;
  runs: RunStorePort;
  messages: { append(sessionId: string, role: MessageRole, body: string, runId?: string | null): Change<MessageRecord> };
  attention: { list(): AttentionItem[]; markRead(kind: AttentionKind, itemId: string): void };
  /** 多个写入合成一个事务（内层用 SAVEPOINT）。 */
  transaction<T>(fn: () => T): T;
  interruptActiveWork(reason: string): RecoveryReport;
}
