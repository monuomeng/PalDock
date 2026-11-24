import { describe, expect, it } from 'vitest';
import { watchPresence, type Presence } from './presence.js';

describe('桌面状态', () => {
  it('锁屏事件与空闲查询合并，只在变化时上报', () => {
    const listeners = new Map<string, () => void>();
    let idleState: 'active' | 'idle' | 'locked' | 'unknown' = 'active';
    const monitor = {
      on: (event: string, listener: () => void) => listeners.set(event, listener),
      getSystemIdleState: () => idleState,
    };
    const seen: Presence[] = [];
    const stop = watchPresence(monitor as never, 300, (p) => seen.push(p));
    listeners.get('lock-screen')!();
    listeners.get('lock-screen')!(); // Windows 上可能重复
    listeners.get('unlock-screen')!();
    idleState = 'idle';
    listeners.get('resume')!();
    idleState = 'locked';
    listeners.get('resume')!();
    stop();
    expect(seen).toEqual([
      { locked: false, idle: false },
      { locked: true, idle: false },
      { locked: false, idle: false },
      { locked: false, idle: true },
      { locked: true, idle: false },
    ]);
  });
});
