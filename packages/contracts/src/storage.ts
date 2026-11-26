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
import type { MainSessionRecord, NoticeKind, NoticeRecord, SummaryRecord, WakeRecord, WakeStatus, WakeTrigger } from './conversations.js';
import type { AutoDecisionRecord, AutoPolicy, PlanNodeEdit, RecoveryItem } from './plans.js';
import type { RoleSessionStorePort } from './role-sessions.js';
import type { ProjectSettingsStorePort } from './project-settings.js';
import type { GitStorePort } from './git-ops.js';
import type { GateStage, GraphNode, MergeOpRecord, MergePhase, PlanNodeInput, PlanNodeRecord, PlanRecord } from './plans.js';
import type {
  AgentOverrideRecord,
  AgentProfileRecord,
  RunUsageRecord,
  RunHandoffRecord,
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
  RunPurpose,
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
  /** 缺省为 work；审阅 Run 用独立的审阅会话。 */
  purpose?: RunPurpose;
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
  access?: 'read' | null;
  sensitive?: boolean;
  groupId?: string | null;
  routedTo?: 'coordinator' | null;
}

/** 提交 SHA 与越界文件只有计划节点才有。 */
export type NewRunResult = Omit<RunResultRecord, 'collectedAt' | 'commitSha' | 'outOfScope' | 'prepareStatus'> &
  Partial<Pick<RunResultRecord, 'commitSha' | 'outOfScope' | 'prepareStatus'>>;

export interface InterruptedRun {
  id: string;
  subtaskId: string;
  /** 可按原生会话 ID 尝试续做；为空则只能重新开始或放弃。 */
  nativeThreadId: string | null;
}

export interface RecoveryReport {
  interruptedRuns: InterruptedRun[];
  /** 因重启被阻塞的子任务和它之前的状态（排队中或执行中）。 */
  blockedSubtasks: { id: string; from: SubtaskStatus }[];
  reopenedInbox: number;
  unknownOutbox: number;
  events: PersistentEvent[];
}

export interface TaskStorePort {
  ensureWorkspace(name: string, rootPath: string): WorkspaceRecord;
  getWorkspace(id: string): WorkspaceRecord | undefined;
  listWorkspaces(): WorkspaceRecord[];
  setRemoteApprovalLevel(id: string, expectedVersion: number, level: RemoteApprovalLevel): Change<WorkspaceRecord>;
  /** 准备命令只能在桌面设置；null 为取消。 */
  setPrepareCommand(id: string, expectedVersion: number, command: CheckCommand | null): Change<WorkspaceRecord>;
  setAutoPolicy(id: string, expectedVersion: number, policy: AutoPolicy): Change<WorkspaceRecord>;
  /** 工作区方式（current / worktree）；带版本。 */
  setWorkspaceMode(id: string, expectedVersion: number, mode: 'current' | 'worktree'): Change<WorkspaceRecord>;
  /** 暂停写入（原因）或恢复（null）；不带版本（由分支监视触发）。 */
  setPaused(id: string, reason: string | null): Change<WorkspaceRecord>;
  /** 节点 worktree 已跑过准备命令（之后各次 Run 共用）。 */
  markPrepared(subtaskId: string): void;
  createTask(input: NewTask): Change<CreatedTask>;
  findTaskByIdempotencyKey(key: string): TaskRecord | undefined;
  getTask(id: string): TaskRecord | undefined;
  getSubtask(id: string): SubtaskRecord | undefined;
  getSubtaskOfTask(taskId: string): SubtaskRecord | undefined;
  getSessionOfSubtask(subtaskId: string): SessionRecord | undefined;
  listTasks(limit: number): TaskSummary[];
  /** 某个项目最近的任务（不含对话任务）。 */
  listTasksOfWorkspace(workspaceId: string, limit: number): TaskSummary[];
  /** 按最近活动（子任务最后变化）倒序。 */
  recentTasks(limit: number): TaskSummary[];
  /** ID 以 prefix 开头的任务（主键范围查询），最多 limit 个。 */
  findTasksByIdPrefix(prefix: string, limit: number): TaskRecord[];
  setWorktree(subtaskId: string, worktreePath: string, branch: string, baseCommit: string): SubtaskRecord | undefined;
  /** 设置 review 内的闸门阶段，带版本（先到者为准），记 gate.decided 事件；只在子任务处于 review 时有效。 */
  setGateStage(subtaskId: string, expectedVersion: number, stage: GateStage, decision: GateDecision): Change<SubtaskRecord>;
  /** 只记闸门结论（通过后直接成功、退回重做时，状态由 transitionSubtask 改）。 */
  gateDecided(subtaskId: string, decision: GateDecision): PersistentEvent;
  /** 新建一个不挂在子任务上的助手会话（审阅助手每轮一个）。 */
  createSession(role: string): SessionRecord;
  /** 记下任务的集成分支（只写一次）。 */
  setIntegration(taskId: string, branch: string, worktree: string, base: string): TaskRecord | undefined;
  /** 节点改从新的基线继续（合入集成分支最新提交后重做），带版本。 */
  rebaseSubtask(subtaskId: string, expectedVersion: number, baseCommit: string): SubtaskRecord;
  transitionTask(id: string, expectedVersion: number, to: TaskStatus, reason?: string): Change<TaskRecord>;
  transitionSubtask(id: string, expectedVersion: number, to: SubtaskStatus, reason?: string): Change<SubtaskRecord>;
  /** 审阅中的计划节点（重启恢复重新发起审阅用）。 */
  subtasksInReview(): SubtaskRecord[];
  /** 任务的全部子任务（单子任务的任务只有一个），按创建顺序。 */
  listSubtasks(taskId: string): SubtaskRecord[];
}

export interface NewPlan {
  /** 给已有草稿任务提新一版；缺省时在 workspaceId 下新建草稿任务。 */
  taskId?: string;
  workspaceId: string;
  title: string;
  goal: string;
  nodes: PlanNodeInput[];
  proposedByRunId: string;
}

/** 闸门的一个结论（gate.decided 事件的载荷）。 */
export interface GateDecision {
  stage: 'check' | 'review' | 'merge';
  outcome: 'passed' | 'rework' | 'human';
  runId: string;
  reason?: string;
}

export interface NewMergeOp {
  taskId: string;
  subtaskId: string;
  sourceSha: string;
  targetOld: string;
}

export interface MergeStorePort {
  start(input: NewMergeOp): MergeOpRecord;
  /** 推进阶段；只能从没结束的阶段（started / candidate）往后走。 */
  advance(id: string, phase: MergePhase, fields?: { candidateSha?: string; conflictFiles?: string[]; detail?: string }): MergeOpRecord;
  latestOf(subtaskId: string): MergeOpRecord | undefined;
  get(id: string): MergeOpRecord | undefined;
  /** 没结束的合并（started / candidate），按开始时间。 */
  open(): MergeOpRecord[];
  /** 集成检查通过（快进之前记）：重启后据此判断候选提交是不是检查过的。 */
  markChecked(id: string): void;
}

export interface NewWake {
  sessionId: string;
  trigger: WakeTrigger;
  dedupeKey: string;
  summary: string;
}

/** 协调助手主会话：会话、唤醒、通知、滚动摘要。 */
export interface CoordinatorStorePort {
  /** 建对话任务、协调助手子任务和主会话，同一事务。 */
  createMainSession(workspaceId: string, title: string): Change<MainSessionRecord>;
  mainSessions(workspaceId: string): MainSessionRecord[];
  getMainSession(sessionId: string): MainSessionRecord | undefined;
  /** 同一去重键只记一次；已有时返回 undefined。 */
  addWake(input: NewWake): Change<WakeRecord> | undefined;
  /** 下一条待处理唤醒；给了 trigger 时只看这一类。 */
  nextPendingWake(sessionId: string, trigger?: WakeTrigger): WakeRecord | undefined;
  runningWake(sessionId: string): WakeRecord | undefined;
  /** 有待处理唤醒的会话。 */
  sessionsWithPendingWakes(): string[];
  setWake(id: number, status: WakeStatus, fields?: { runId?: string; note?: string }): Change<WakeRecord>;
  /** 唤醒里的一次工具调用，返回累计次数。 */
  countRequest(wakeId: number): number;
  /** 某时刻之后开始的任务事件唤醒：次数和最近一次的开始时间。 */
  eventWakesSince(sessionId: string, sinceIso: string): { count: number; lastStartedAt: string | null };
  doneWakes(sessionId: string): number;
  listWakes(sessionId: string, limit: number): WakeRecord[];
  /** 服务重启：正在跑的唤醒放回队列（对应的 Run 已中断），开始时间保留，频率计数照旧。 */
  requeueRunningWakes(note: string): Change<WakeRecord[]>;
  recentMessages(sessionId: string, limit: number): MessageRecord[];
  addNotice(input: { sessionId: string; runId: string | null; kind: NoticeKind; body: string }): Change<NoticeRecord>;
  notices(sessionId: string, limit: number): NoticeRecord[];
  getNotice(id: number): NoticeRecord | undefined;
  ackNotices(sessionId: string): Change<number>;
  /** 把一条消息记为问题的答复；问题已答过时返回 undefined。 */
  answerNotice(id: number, messageId: number, channel: ChannelProvider): Change<NoticeRecord> | undefined;
  /** 发到过这个外部会话、还没答的问题。 */
  openQuestionsSentTo(conversationId: string): NoticeRecord[];
  unescalatedNotices(): NoticeRecord[];
  markNoticeEscalated(id: number, channels: ChannelProvider[]): PersistentEvent | undefined;
  writeSummary(input: { sessionId: string; body: string; runId: string | null; wakesDone: number }): Change<SummaryRecord>;
  latestSummary(sessionId: string): SummaryRecord | undefined;
}

export interface AutoDecisionStorePort {
  record(input: Omit<AutoDecisionRecord, 'id' | 'createdAt'>): Change<AutoDecisionRecord>;
  list(workspaceId: string | null, limit: number): AutoDecisionRecord[];
}

export interface PlanStorePort {
  /** 写入新一版计划（同任务里还在等确认的旧版本置为 superseded）。 */
  propose(input: NewPlan): Change<PlanRecord>;
  getPlan(id: string): PlanRecord | undefined;
  latestPlan(taskId: string): PlanRecord | undefined;
  nodes(planId: string): PlanNodeRecord[];
  /** 计划里的一个节点（走 UNIQUE (plan_id, node_key)）。 */
  node(planId: string, key: string): PlanNodeRecord | undefined;
  /**
   * 确认，同一事务：计划 confirmed，按节点建子任务与会话和依赖；草稿任务 draft → queued。
   * 运行中确认新一版时：上一版 superseded，没变的节点沿用原子任务，改了的和新增的建新子任务，没了的和被替换的取消。
   * 返回新建的子任务和被取消的子任务（有 Run 在跑的由调用方中断）。
   */
  confirm(id: string, expectedVersion: number, note?: string | null, via?: 'desktop' | 'feishu' | 'telegram' | null): Change<{ created: SubtaskRecord[]; cancelled: string[] }>;
  /** 排定或撤回（at 为 null）待确认计划的自动确认；带计划版本。 */
  setAutoConfirm(id: string, expectedVersion: number, at: string | null): Change<PlanRecord>;
  /** 排定了自动确认、还在待确认的计划（重启后重新排定用）。 */
  pendingAutoConfirms(): PlanRecord[];
  /** 这个会话里的协调助手 Run 提出的计划，按提出时间升序，最多 limit 份（取最近的）。 */
  plansOfSession(sessionId: string, limit: number): PlanRecord[];
  /** 确认前改一个节点（调用方先校验）；带计划版本，先到者为准。 */
  editNode(id: string, expectedVersion: number, edit: PlanNodeEdit): Change<PlanRecord>;
  /** 有确认过的计划、还没结束的任务（重启后重新推进用）。 */
  openPlanTasks(): string[];
  /** 任务当前在执行的那一版。 */
  confirmedPlan(taskId: string): PlanRecord | undefined;
  reject(id: string, expectedVersion: number, note: string | null, via?: 'desktop' | 'feishu' | 'telegram'): Change<PlanRecord>;
  /** 调度器读的任务图（按计划节点顺序）。 */
  graph(taskId: string): GraphNode[];
}

export interface RunStorePort {
  createRun(input: NewRun): Change<RunRecord>;
  getRun(id: string): RunRecord | undefined;
  /** 最近一次工作 Run（审阅 Run 不算）。 */
  latestRun(subtaskId: string): RunRecord | undefined;
  recordThread(run: Pick<RunRecord, 'id' | 'runtime' | 'sessionId'>, threadId: string): RunRecord | undefined;
  /** 这次 Run 用的角色会话和它的原生会话（换了新会话重试时 threadId 为 null，之后由 recordThread 记）。 */
  setRoleSession(runId: string, roleSessionId: string, threadId: string | null): RunRecord;
  recordTurn(runId: string, turnId: string): RunRecord | undefined;
  transitionRun(id: string, expectedVersion: number, to: RunStatus, reason?: string): Change<RunRecord>;
  requestApproval(input: NewApproval): Change<ApprovalRecord>;
  /** 交给协调助手判断，或回到你这里（to 为 null）；只改还在等待的，已处理的返回 undefined。 */
  routeApproval(id: string, to: 'coordinator' | null, reason?: string): Change<ApprovalRecord> | undefined;
  approvalsOfGroup(groupId: string): ApprovalRecord[];
  getApproval(id: string): ApprovalRecord | undefined;
  cancelPendingApprovals(runId: string): Change<ApprovalRecord[]>;
  expiredApprovals(): ApprovalRecord[];
  decideApproval(id: string, expectedVersion: number, status: Exclude<ApprovalStatus, 'pending'>, via: ApprovalChannel): Change<ApprovalRecord>;
  saveResult(result: NewRunResult): Change<RunResultRecord>;
  getResult(runId: string): RunResultRecord | undefined;
  /** 用户的验收或退回；审阅助手的结论带 reviewer（交结论的审阅 Run 与被审的 SHA），每次审阅 Run 只收一份。 */
  addReview(runId: string, decision: ReviewDecision, note: string | null, reviewer?: { runId: string; commitSha: string | null }): Change<RunReviewRecord>;
  /** 针对某次工作 Run 的验收与审阅结论，按时间。 */
  reviewsOfRun(runId: string): RunReviewRecord[];
  /** 某次审阅 Run 交的结论。 */
  reviewOf(reviewerRunId: string): RunReviewRecord | undefined;
  /** 子任务被审阅助手退回过几次（自动返工的轮数）。 */
  autoReworkCount(subtaskId: string): number;
  /** messages: false 时不读输出正文（列表、计划详情用）。 */
  runDetails(subtaskId: string, options?: { messages?: boolean }): RunDetail[];
  /** 不改变状态、只需让用户知道的情况（未识别的请求、恢复失败、输出截断）。 */
  addNotice(runId: string, code: RunNoticeCode, detail: string): PersistentEvent;
  /** Run 结束时记下用量（只写一次）；执行器不报告时不调用。 */
  recordUsage(runId: string, usage: RunUsageRecord): void;
  getUsage(runId: string): RunUsageRecord | undefined;
  /** 交接记录每次 Run 只收一份；已有时抛 conflict。 */
  submitHandoff(runId: string, summary: string, notes: string | null): Change<RunHandoffRecord>;
  getHandoff(runId: string): RunHandoffRecord | undefined;
}

/** 审计日志：只追加。actor 是调用者（例如 run:<id>），result 是 ok 或拒绝原因。 */
export interface AuditPort {
  append(actor: string, action: string, target: string | null, result: string): void;
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
  /** 外部会话对应的主会话（只写一次）。 */
  setMainSession(conversationId: string, sessionId: string): ConversationRecord | undefined;
  /** 主会话对应的外部会话（协调助手的回复要发回去）。 */
  conversationOfMainSession(sessionId: string): ConversationRecord | undefined;
  /** 本会话里平台消息 ID 对应的已发卡片主题（引用回复用）。 */
  subjectOfMessage(conversationId: string, messageRef: string): string | undefined;
  /** 待升级的计划确认卡片及其项目的远程审批等级。 */
  planEscalationCandidates(): { plan: PlanRecord; remoteApprovalLevel: RemoteApprovalLevel; workspaceName: string; taskTitle: string }[];
  markPlanEscalated(planId: string, channels: ChannelProvider[]): PersistentEvent | undefined;
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
  plans: PlanStorePort;
  merges: MergeStorePort;
  coordinator: CoordinatorStorePort;
  autoDecisions: AutoDecisionStorePort;
  audit: AuditPort;
  messages: {
    append(sessionId: string, role: MessageRole, body: string, runId?: string | null, channel?: ChannelProvider | null): Change<MessageRecord>;
    get(id: number): MessageRecord | undefined;
    /** FTS5（trigram）检索，短查询退回 LIKE。 */
    search(query: string, limit: number): MessageRecord[];
  };
  attention: { list(): AttentionItem[]; markRead(kind: AttentionKind, itemId: string): void };
  channels: ChannelStorePort;
  outbox: OutboxPort;
  inbox: InboxPort;
  roleSessions: RoleSessionStorePort;
  projectSettings: ProjectSettingsStorePort;
  git: GitStorePort;
  /** 多个写入合成一个事务（内层用 SAVEPOINT）。 */
  transaction<T>(fn: () => T): T;
  interruptActiveWork(reason: string): RecoveryReport;
  /** 记一条重启恢复事件。 */
  recordRecovery(item: Omit<RecoveryItem, 'at'>): PersistentEvent;
}
