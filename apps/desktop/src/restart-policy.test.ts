import { describe, expect, it } from 'vitest';
import { CRASH_WINDOW_MS, RestartPolicy } from './restart-policy.js';

describe('服务重启策略', () => {
  it('主动关闭与数据根被锁不重启；意外的退出码 0 仍重启', () => {
    const policy = new RestartPolicy();
    expect(policy.onExit(0, 0, true)).toEqual({ action: 'stop', reason: 'normal_exit' });
    expect(policy.onExit(75, 0, false)).toEqual({ action: 'stop', reason: 'data_root_locked' });
    expect(policy.onExit(0, 0, false)).toEqual({ action: 'restart', delayMs: 3000 });
  });

  it('5 分钟内第 6 次崩溃时停止；窗口外的崩溃不计', () => {
    const policy = new RestartPolicy();
    for (let i = 0; i < 5; i++) expect(policy.onExit(1, i * 1000, false).action).toBe('restart');
    expect(policy.onExit(1, 5000, false)).toEqual({ action: 'stop', reason: 'too_many_crashes' });

    const later = new RestartPolicy();
    for (let i = 0; i < 5; i++) later.onExit(1, i * 1000, false);
    expect(later.onExit(null, CRASH_WINDOW_MS + 1000, false)).toEqual({ action: 'restart', delayMs: 3000 });
  });
});
