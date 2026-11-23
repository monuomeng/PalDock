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
