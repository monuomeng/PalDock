import { DEFAULT_ESCALATION_WAIT_MS } from './approval-policy.js';

/**
 * P1 的占位默认值，集中在这里，后续直接改常量（计划「占位默认值」）。
 */
export const P1_DEFAULTS = {
  /** 审批无人处理多久后自动拒绝。 */
  approvalTtlMs: 30 * 60 * 1000,
  /** 取消时最多等 turn/started 多久，之后直接结束进程树。 */
  cancelWaitForTurnMs: 10_000,
  /** 同时执行的 Run 上限（02「上限与护栏」：全局同时最多 10 个模型调用）。 */
  maxConcurrentRuns: 10,
  /** 同一任务同时执行的 Run 上限（ADR 0002：每任务最多 4 个并行子任务）。 */
  maxRunsPerTask: 4,
  /** 审阅助手自动退回重做的轮数上限，用完交给人（P3 计划 v2「返工的终止条件」）；人在桌面退回不限次数。 */
  maxAutoReworks: 2,
  /** 多久扫描一次过期审批。 */
  expiryScanMs: 15_000,
  /** 执行器断线后核对 turn 结果的次数与间隔。 */
  confirmAttempts: 3,
  confirmIntervalMs: 2_000,
  /** 流式输出合并为一条持久消息的检查点间隔。 */
  outputCheckpointMs: 5_000,
  /** 检查命令的超时与输出文件上限。 */
  checkTimeoutMs: 10 * 60 * 1000,
  checkOutputMaxBytes: 1024 * 1024,
  /** PalDock 生成的 worktree 分支前缀（统一小写）。 */
  branchPrefix: 'paldock/',
} as const;

/**
 * P2 外部渠道的占位默认值（计划「占位默认值」）。
 */
export const P2_DEFAULTS = {
  /** 桌面多久无人处理就把审批升级到外部单聊。 */
  escalationWaitMs: DEFAULT_ESCALATION_WAIT_MS,
  /** 多久扫描一次待升级的审批。 */
  escalationScanMs: 15_000,
  /** 系统空闲多久算「空闲」（升级条件之一）。 */
  idleThresholdSeconds: 5 * 60,
  /** 配对码有效期；全部渠道同时待确认的配对上限（每个账号只有一个，沿用未过期的）。 */
  pairingTtlMs: 60 * 60 * 1000,
  maxPendingPairings: 5,
  /** 每个渠道账号每分钟最多处理的入站消息，超出的丢弃并记审计。 */
  inboundPerMinute: 10,
  /** 入站事件的处理租约；进程崩溃后超时的事件被重新领取。 */
  inboxLeaseMs: 60_000,
  /** 出站重试：最多尝试次数、首次退避，以及两次发送之间的最小间隔（平台限速）。 */
  outboxMaxAttempts: 5,
  outboxRetryBaseMs: 2_000,
  outboxSpacingMs: 300,
  /** 单次发送或更新的超时；超时记为 unknown，不重发。 */
  sendTimeoutMs: 15_000,
  /** 渠道断线恢复后多久内提示「消息可能延迟」（飞书实测补投约 5 分钟）。 */
  recoveryNoticeMs: 6 * 60 * 1000,
  /** 卡片按钮的有效期：建任务确认、取消确认较短，待命中卡片上的继续、结束较长；审批按钮跟随审批本身的过期时间。 */
  confirmActionTtlMs: 10 * 60 * 1000,
  reviewActionTtlMs: 24 * 60 * 60 * 1000,
  /** /tasks 列出的任务数。 */
  taskListSize: 10,
} as const;

export type P2Limits = typeof P2_DEFAULTS;

/**
 * P3-07 协调助手唤醒循环的占位默认值（ADR 0002「自动推进护栏」与 02「唤醒与触发器」）。
 */
export const P3_DEFAULTS = {
  /** 任务事件触发的唤醒：同一会话两次之间至少隔多久、每天（滚动 24 小时）最多几次。你发的消息不受限。 */
  eventWakeMinIntervalMs: 2 * 60 * 1000,
  eventWakesPerDay: 20,
  /** 单次唤醒的请求上限：到软上限提醒收尾，超过硬上限强制停止。按协调助手的 MCP 工具调用计数（模型请求的近似）。 */
  wakeSoftRequests: 20,
  wakeHardRequests: 40,
  /** 每完成多少次唤醒写一次滚动摘要；新开原生会话时注入最近几条消息。 */
  summaryEveryWakes: 20,
  contextMessages: 10,
  /** 新开原生会话时附上的 FTS5 历史片段条数。 */
  historySnippets: 5,
} as const;

export type P3Limits = typeof P3_DEFAULTS;
