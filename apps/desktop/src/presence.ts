import type { PowerMonitor } from 'electron';

export interface Presence {
  locked: boolean;
  idle: boolean;
}

type PresenceSource = Pick<PowerMonitor, 'on' | 'getSystemIdleState'>;

const POLL_MS = 15_000;

/**
 * 桌面是否有人：锁屏事件 + 定时查询系统空闲状态，只在变化时回调。
 * 锁屏以事件为准（Windows 上 lock-screen 可能连发两次，去重后无影响），getSystemIdleState 返回 locked 时也算；
 * 空闲阈值内无键鼠操作算空闲。休眠时服务随系统暂停，唤醒后重新查询一次。
 */
export function watchPresence(monitor: PresenceSource, idleThresholdSeconds: number, onChange: (presence: Presence) => void): () => void {
  let lockedByEvent = false;
  let last: Presence | undefined;
  const check = () => {
    const state = monitor.getSystemIdleState(idleThresholdSeconds);
    const next = { locked: lockedByEvent || state === 'locked', idle: state === 'idle' };
    if (last?.locked === next.locked && last.idle === next.idle) return;
    last = next;
    onChange(next);
  };
  monitor.on('lock-screen', () => {
    lockedByEvent = true;
    check();
  });
  monitor.on('unlock-screen', () => {
    lockedByEvent = false;
    check();
  });
  monitor.on('resume', check);
  check();
  const timer = setInterval(check, POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
