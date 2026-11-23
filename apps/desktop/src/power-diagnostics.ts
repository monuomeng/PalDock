import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { powerMonitor } from 'electron';

const EVENTS = ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'user-did-become-active', 'user-did-resign-active'] as const;
const IDLE_THRESHOLD_SECONDS = 60;
const IDLE_POLL_MS = 15_000;

/**
 * P0-04 电源与空闲事件验证：设置 PALDOCK_DIAGNOSTICS=1 时，把 powerMonitor 事件和空闲状态变化
 * 追加到数据根下的 diagnostics.log（每行一个 JSON，只有事件名和时间，不含用户数据）。
 * 审批升级和推送积压将来依赖这些事件，先确认两个平台上实际能收到哪些。
 */
export function startPowerDiagnostics(dataRoot: string): void {
  const file = join(dataRoot, 'diagnostics.log');
  const write = (event: string, extra: Record<string, unknown> = {}) =>
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, platform: process.platform, ...extra })}\n`);

  write('diagnostics-started', { idleThresholdSeconds: IDLE_THRESHOLD_SECONDS });
  for (const name of EVENTS) powerMonitor.on(name as 'suspend', () => write(name));

  let lastIdle = powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SECONDS);
  setInterval(() => {
    const idle = powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SECONDS);
    if (idle !== lastIdle) write('idle-state', { from: lastIdle, to: idle, idleSeconds: powerMonitor.getSystemIdleTime() });
    lastIdle = idle;
  }, IDLE_POLL_MS).unref();
}
