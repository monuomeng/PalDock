import type {
  Card,
  ChannelAccountRecord,
  ChannelAccountStatus,
  ChannelActionKind,
  ChannelActionRecord,
  ChannelAddress,
  ChannelProvider,
  ChannelSettingsRecord,
  ConversationRecord,
  InboundRejection,
  PairingRecord,
} from './channels.js';
import type { PersistentEvent, RunNoticeCode } from './events.js';
import type {
  AgentOverrideRecord,
  AgentProfileRecord,
  RunUsageRecord,
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
  AgentRole,
  Executor,
  ApprovalChannel,
  ApprovalKind,
  ApprovalStatus,
  AttentionKind,
  MessageRole,
  RemoteApprovalLevel,
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
  /** 从外部渠道建任务时的来源会话。 */
  originConversationId?: string | null;
  /** 接着这个已结束的任务做：worktree 从它的分支出发。 */
  continuedFromTaskId?: string | null;
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
  unknownOutbox: number;
  events: PersistentEvent[];
}

export interface TaskStorePort {
  ensureWorkspace(name: string, rootPath: string): WorkspaceRecord;
  getWorkspace(id: string): WorkspaceRecord | undefined;
  listWorkspaces(): WorkspaceRecord[];
  setRemoteApprovalLevel(id: string, expectedVersion: number, level: RemoteApprovalLevel): Change<WorkspaceRecord>;
  createTask(input: NewTask): Change<CreatedTask>;
  findTaskByIdempotencyKey(key: string): TaskRecord | undefined;
  getTask(id: string): TaskRecord | undefined;
  getSubtask(id: string): SubtaskRecord | undefined;
  getSubtaskOfTask(taskId: string): SubtaskRecord | undefined;
  getSessionOfSubtask(subtaskId: string): SessionRecord | undefined;
  listTasks(limit: number): TaskSummary[];
  /** 按最近活动（子任务最后变化）倒序。 */
  recentTasks(limit: number): TaskSummary[];
  /** ID 以 prefix 开头的任务（主键范围查询），最多 limit 个。 */
  findTasksByIdPrefix(prefix: string, limit: number): TaskRecord[];
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
  /** Run 结束时记下用量（只写一次）；执行器不报告时不调用。 */
  recordUsage(runId: string, usage: RunUsageRecord): void;
  getUsage(runId: string): RunUsageRecord | undefined;
}

/** 助手角色设置与按项目的执行器覆盖。 */
export interface AgentStorePort {
  listProfiles(): AgentProfileRecord[];
  getProfile(role: AgentRole): AgentProfileRecord | undefined;
  setExecutor(role: AgentRole, expectedVersion: number, executor: Executor): Change<AgentProfileRecord>;
  listOverrides(workspaceId: string): AgentOverrideRecord[];
  /** executor 为 null 时取消覆盖。 */
  setOverride(workspaceId: string, role: AgentRole, executor: Executor | null): Change<AgentOverrideRecord | null>;
  /** 角色在某个项目里实际用的执行器：项目覆盖优先，否则角色默认。 */
  resolveExecutor(workspaceId: string, role: AgentRole): Executor | undefined;
}

export interface NewChannelAction {
  conversationId: string;
  kind: ChannelActionKind;
  targetId: string;
  /** 目标（审批、子任务）在下发卡片时的版本；点击时按它做先到者为准。 */
  targetVersion?: number | null;
  payload?: string | null;
  ttlMs: number;
}

/** 待升级的审批及其所在项目的远程审批等级、任务标题。 */
export interface EscalationCandidate {
  approval: ApprovalRecord;
  remoteApprovalLevel: RemoteApprovalLevel;
  workspaceName: string;
  taskId: string;
  taskTitle: string;
}

export interface ChannelStorePort {
  upsertAccount(address: ChannelAddress, externalId: string, displayName: string): ChannelAccountRecord;
  getAccount(id: string): ChannelAccountRecord | undefined;
  listAccounts(): ChannelAccountRecord[];
  setAccountStatus(id: string, expectedVersion: number, to: ChannelAccountStatus): Change<ChannelAccountRecord>;
  upsertConversation(address: ChannelAddress, ownerAccountId: string | null, title: string): ConversationRecord;
  getConversation(id: string): ConversationRecord | undefined;
  listGroups(): ConversationRecord[];
  activeDirectConversations(): ConversationRecord[];
  setConversation(id: string, expectedVersion: number, settings: { groupAllowed: boolean; defaultWorkspaceId: string | null }): Change<ConversationRecord>;
  setCurrentTask(conversationId: string, taskId: string | null): void;
  conversationsFocusedOn(taskId: string): ConversationRecord[];
  /** 任务结束时清掉所有以它为当前任务的会话。 */
  clearCurrentTask(taskId: string): void;
  openPairing(
    account: ChannelAccountRecord,
    conversationId: string,
    ttlMs: number,
    maxPending: number,
  ): { code: string; events: PersistentEvent[] } | undefined;
  listPairings(): PairingRecord[];
  decidePairing(code: string, approve: boolean): Change<{ account: ChannelAccountRecord; conversationId: string }>;
  createAction(input: NewChannelAction): ChannelActionRecord;
  useAction(token: string, conversationId: string): ChannelActionRecord | undefined;
  voidActions(targetId: string): number;
  listSettings(): ChannelSettingsRecord[];
  updateSettings(provider: ChannelProvider, expectedVersion: number, enabled: boolean, proxyUrl: string | null): Change<ChannelSettingsRecord>;
  getCursor(provider: ChannelProvider, account: string): string | undefined;
  setCursor(provider: ChannelProvider, account: string, cursor: string): void;
  escalationCandidates(): EscalationCandidate[];
  approvalContext(approvalId: string): EscalationCandidate | undefined;
  markEscalated(approvalId: string, channels: ChannelProvider[]): PersistentEvent | undefined;
  audit(aggregateId: string, provider: ChannelProvider, reason: InboundRejection): PersistentEvent;
}

/** 待投递的出站卡片。 */
export interface OutboxItem {
  id: number;
  provider: ChannelProvider;
  conversationId: string;
  subject: string | null;
  card: Card;
  attempts: number;
}

export interface OutboxPort {
  /** subject 非空时：同一会话里该主题已有卡片就更新它，否则发新卡片。 */
  enqueue(provider: ChannelProvider, conversationId: string, card: Card, subject?: string | null): number;
  claimDue(): OutboxItem | undefined;
  messageRef(conversationId: string, subject: string): string | undefined;
  /** 这个会话里该主题的卡片已发出或在待发队列里。 */
  hasSubject(conversationId: string, subject: string): boolean;
  markSent(item: OutboxItem, messageRef: string): void;
  markRetry(id: number, delayMs: number, error: string): void;
  markFinal(id: number, status: 'unknown' | 'failed', error: string): void;
  /** 渠道停用：待发送的一律失败，不在重新启用时补发。 */
  failPending(provider: ChannelProvider, error: string): number;
}

export interface InboxPort {
  accept(queue: string, eventId: string, conversationKey: string, payload: string): boolean;
  claim(leaseMs: number): { queue: string; eventId: string; conversationKey: string; payload: string; attempts: number } | undefined;
  finish(queue: string, eventId: string, outcome: 'done' | 'rejected'): boolean;
}

export interface StorePort {
  tasks: TaskStorePort;
  runs: RunStorePort;
  agents: AgentStorePort;
  messages: { append(sessionId: string, role: MessageRole, body: string, runId?: string | null): Change<MessageRecord> };
  attention: { list(): AttentionItem[]; markRead(kind: AttentionKind, itemId: string): void };
  channels: ChannelStorePort;
  outbox: OutboxPort;
  inbox: InboxPort;
  /** 多个写入合成一个事务（内层用 SAVEPOINT）。 */
  transaction<T>(fn: () => T): T;
  interruptActiveWork(reason: string): RecoveryReport;
}
