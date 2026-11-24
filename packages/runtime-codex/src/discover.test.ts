import { describe, expect, it } from 'vitest';
import { meetsMinimum } from './discover.js';

describe('Codex 最低版本', () => {
  it('按 major.minor.patch 比较，忽略后缀；解析不了的视为不满足', () => {
    expect(meetsMinimum('0.166.0')).toBe(true);
    expect(meetsMinimum('0.166.0-mock')).toBe(true);
    expect(meetsMinimum('0.170.2')).toBe(true);
    expect(meetsMinimum('1.0.0')).toBe(true);
    expect(meetsMinimum('0.165.9')).toBe(false);
    expect(meetsMinimum('0.99.0')).toBe(false);
    expect(meetsMinimum('dev')).toBe(false);
  });
});
