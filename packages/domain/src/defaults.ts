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
  /** 配对码有效期与每个渠道账号同时待处理的上限。 */
  pairingTtlMs: 60 * 60 * 1000,
  maxPendingPairings: 3,
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
  /** 卡片按钮的有效期：建任务确认、取消确认与退回意见较短，验收较长；审批按钮跟随审批本身的过期时间。 */
  confirmActionTtlMs: 10 * 60 * 1000,
  reviewActionTtlMs: 24 * 60 * 60 * 1000,
  /** /tasks 列出的任务数。 */
  taskListSize: 10,
} as const;

export type P2Limits = typeof P2_DEFAULTS;
