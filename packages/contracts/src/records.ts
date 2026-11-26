import { z } from 'zod';
import type {
  AgentRole,
  ApprovalChannel,
  ApprovalKind,
  ApprovalStatus,
  AttentionKind,
  CheckStatus,
  MessageRole,
  RemoteApprovalLevel,
  ReviewDecision,
  RiskLevel,
  RunPurpose,
  RunStatus,
  SessionKind,
  SubtaskStatus,
  TaskStatus,
  Executor,
  WorkspaceAccess,
} from './states.js';
import type { RuntimeDiscovery } from './runtime.js';
import type { ChannelProvider } from './channels.js';
import type { AutoPolicy, GateStage, PlanDetail } from './plans.js';
import type { TaskKind } from './conversations.js';

/**
 * 跨进程传递的记录形状（存储层 RETURNING 的列与这里一一对应，管理窗口直接显示）。
 * 时间统一为 ISO-8601 UTC 文本。
 */

/** 检查命令：结构化的「可执行文件 + 参数数组」，不经 shell 拼接、不按空白拆分。 */
export const CheckCommand = z.object({
  executable: z.string().min(1).max(1000),
  args: z.array(z.string().max(4000)).max(64),
});
export type CheckCommand = z.infer<typeof CheckCommand>;

export interface WorkspaceRecord {
  id: string;
  name: string;
  rootPath: string;
  remoteApprovalLevel: RemoteApprovalLevel;
  /** worktree 准备命令（例如安装依赖）：新建的 worktree 在跑检查命令前先执行一次；没有设置为 null。 */
  prepareCommand: CheckCommand | null;
  /** 自动处理设置（默认全关）。 */
  autoPolicy: AutoPolicy;
  version: number;
}

export interface TaskRecord {
  id: string;
  workspaceId: string;
  title: string;
  goal: string;
  status: TaskStatus;
  checkCommand: CheckCommand | null;
  checkConfirmedAt: string | null;
  /** 从外部渠道建的任务：结果回发到这个会话。 */
  originConversationId: string | null;
  /** 接续自哪个已结束的任务（worktree 从它的分支出发）。 */
  continuedFromTaskId: string | null;
  /** 按计划拆分的任务：集成分支、它的 worktree 和起点（计划确认时从项目 HEAD 建）。 */
  integrationBranch: string | null;
  integrationWorktree: string | null;
  integrationBase: string | null;
  /** conversation：协调助手主会话的载体，任务列表不列。 */
  kind: TaskKind;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubtaskRecord {
  id: string;
  taskId: string;
  role: string;
  goal: string;
  status: SubtaskStatus;
  /** 阻塞、失败或退回的原因，展示给用户。 */
  statusReason: string | null;
  reworkCount: number;
  worktreePath: string | null;
  branch: string | null;
  baseCommit: string | null;
  /** 由计划节点物化出的子任务所属的计划与节点键；P1 / P2 的单子任务为空。 */
  planId: string | null;
  nodeKey: string | null;
  /** 计划节点在 review 内的闸门阶段（见 GateStage）。 */
  gateStage: GateStage | null;
  /** 节点 worktree 跑过准备命令的时间。 */
  preparedAt: string | null;
  version: number;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  kind: SessionKind;
  subtaskId: string | null;
  role: string;
}

export interface RunRecord {
  id: string;
  subtaskId: string;
  sessionId: string | null;
  attempt: number;
  runtime: string;
  /** 原生会话（Codex thread）。同一子任务续做时沿用，重新开始时换新。 */
  nativeThreadId: string | null;
  /** 这次 Run 唯一对应的 turn，写入后不再修改；恢复核对只认它。 */
  nativeTurnId: string | null;
  /** 续做时指向被中断的那次 Run。 */
  resumesRunId: string | null;
  /** 计划节点和审阅的 Run 用的角色会话（P1 / P2 的单子任务和协调助手为空）。 */
  roleSessionId: string | null;
  status: RunStatus;
  failureReason: string | null;
  /** work：助手做子任务；review：审阅助手在独立会话里审这个子任务的交付。 */
  purpose: RunPurpose;
  version: number;
  startedAt: string;
  endedAt: string | null;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  kind: ApprovalKind;
  riskLevel: RiskLevel;
  summary: string;
  /** 展示用的命令、改动文件或权限说明；不含凭据。 */
  detail: string | null;
  cwd: string | null;
  status: ApprovalStatus;
  requestedAt: string;
  expiresAt: string;
  decidedVia: ApprovalChannel | null;
  /** 已升级到外部单聊的时间。 */
  escalatedAt: string | null;
  version: number;
}

export interface RunResultRecord {
  runId: string;
  finalMessage: string | null;
  diffStat: string | null;
  checkStatus: CheckStatus;
  checkExitCode: number | null;
  checkDurationMs: number | null;
  /** 数据根 artifacts/ 下的相对路径；输出已脱敏。 */
  checkOutputRef: string | null;
  /** 计划节点：交付提交到节点分支后的 SHA，检查与审阅都针对它。 */
  commitSha: string | null;
  /** 计划节点：越出交付范围的文件（相对 worktree）；null 表示没核对。 */
  outOfScope: string[] | null;
  /** 这次检查前跑了准备命令时的结果；没跑为 null。 */
  prepareStatus: CheckStatus | null;
  collectedAt: string;
}

export interface RunReviewRecord {
  id: string;
  runId: string;
  decision: ReviewDecision;
  note: string | null;
  /** 审阅助手给的结论：交结论的审阅 Run；用户自己的决定为 null。 */
  reviewerRunId: string | null;
  commitSha: string | null;
  decidedAt: string;
}

export interface MessageRecord {
  id: number;
  sessionId: string;
  runId: string | null;
  role: MessageRole;
  body: string;
  /** 从哪个外部渠道来（P3-10）；桌面上写的为 null。 */
  channel: ChannelProvider | null;
  createdAt: string;
}

/** 「待我处理」条目；`runId` 是点击后要打开的那次 Run（审批所在或最新一次）。 */
export interface AttentionItem {
  kind: AttentionKind;
  itemId: string;
  taskId: string;
  runId: string | null;
  title: string;
  reason: string | null;
  since: string;
  read: boolean;
  /** 审批条目带上审批本身，「待我处理」里直接批准或拒绝（P3 计划节点的审批以前只能在详情里找）。 */
  approval?: ApprovalRecord;
}

export interface TaskSummary {
  task: TaskRecord;
  subtaskStatus: SubtaskStatus;
  latestRunStatus: RunStatus | null;
  /** 子任务最后一次变化的时间（开始、待命、继续、结束等）。 */
  lastActivityAt: string;
}

export interface RunDetail {
  run: RunRecord;
  result: RunResultRecord | null;
  reviews: RunReviewRecord[];
  approvals: ApprovalRecord[];
  messages: MessageRecord[];
}

/** 当前允许的用户操作，由服务端按状态机与续做条件给出，界面只按它显示按钮。 */
export interface TaskActions {
  cancel: boolean;
  review: boolean;
  /** 已结束且分支上有提交，可以基于它新建任务继续。 */
  continueFrom: boolean;
  resume: boolean;
  restart: boolean;
  abandon: boolean;
}

export interface TaskDetail {
  task: TaskRecord;
  workspace: WorkspaceRecord;
  /** 单子任务的任务（P1 / P2）才有；按计划拆分的任务看 plan。 */
  subtask: SubtaskRecord | null;
  /** 单子任务的各次 Run，按 attempt 升序；任务图的任务为空。 */
  runs: RunDetail[];
  actions: TaskActions;
  /** 最新一版计划及其节点；没有计划的任务为 null。 */
  plan: PlanDetail | null;
}

/** 助手角色的设置（agent_profiles）；执行器可按项目覆盖。 */
export interface AgentProfileRecord {
  role: AgentRole;
  displayName: string;
  description: string;
  promptVersion: number;
  executor: Executor;
  fallbackExecutor: Executor | null;
  workspaceAccess: WorkspaceAccess;
  /** 交付范围（glob，相对 worktree）；空表示整个 worktree。能否强制见能力检查，否则只由验收闸门核对。 */
  deliveryScope: string[];
  maxRunMinutes: number;
  maxConcurrency: number;
  version: number;
  updatedAt: string;
}

/** 某个项目对某个角色的执行器覆盖。 */
export interface AgentOverrideRecord {
  workspaceId: string;
  role: AgentRole;
  executor: Executor;
}

/** 一次 Run 的用量（主会话 + 子代理合计）。 */
export interface RunUsageRecord {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

/** 隔离程度，设置页和派单时原样显示：只读、隔离（实测能限定目录）、不隔离、未验证。 */
export type Isolation = 'read_only' | 'isolated' | 'not_isolated' | 'unverified';

/** 角色能不能用某个执行器。ok 为 false 时拒绝启动，problems 说明原因；warnings 只提醒。 */
export interface CapabilityCheck {
  ok: boolean;
  isolation: Isolation;
  problems: string[];
  warnings: string[];
}

/** 设置页「助手」：每个角色的设置与当前执行器的能力检查，以及各执行器的发现结果。 */
export interface AgentSettings {
  agents: { profile: AgentProfileRecord; check: CapabilityCheck }[];
  runtimes: RuntimeDiscovery[];
}

/** 专业助手经 MCP 桥提交的交接记录（每次 Run 一份）。 */
export interface RunHandoffRecord {
  runId: string;
  summary: string;
  notes: string | null;
  submittedAt: string;
}
