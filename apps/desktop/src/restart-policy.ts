import { ServiceExitCode } from '@paldock/contracts';

/** 初始值来自参考项目（ADR 0002），均可配置。 */
export const RESTART_DELAY_MS = 3_000;
export const CRASH_WINDOW_MS = 5 * 60 * 1000;
export const MAX_CRASHES_IN_WINDOW = 5;
export const SHUTDOWN_GRACE_MS = 35_000;

export type RestartDecision =
  | { action: 'restart'; delayMs: number }
  | { action: 'stop'; reason: 'normal_exit' | 'data_root_locked' | 'too_many_crashes' };

/**
 * 服务退出后的处理：只有主进程主动要求的退出算正常；数据根被锁不重启；
 * 其余固定等待 3 秒重启，5 分钟内崩溃超过 5 次则停止并提示用户。
 * 退出码 0 不能当作正常：Windows 上被外部结束的 utilityProcess 退出码也是 0（P0-04 实测）。
 */
export class RestartPolicy {
  private crashes: number[] = [];

  onExit(code: number | null, nowMs: number, requested: boolean): RestartDecision {
    if (requested) return { action: 'stop', reason: 'normal_exit' };
    if (code === ServiceExitCode.locked) return { action: 'stop', reason: 'data_root_locked' };
    this.crashes = [...this.crashes.filter((t) => nowMs - t < CRASH_WINDOW_MS), nowMs];
    return this.crashes.length > MAX_CRASHES_IN_WINDOW
      ? { action: 'stop', reason: 'too_many_crashes' }
      : { action: 'restart', delayMs: RESTART_DELAY_MS };
  }
}
