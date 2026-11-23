import { describe, expect, it } from 'vitest';
// @ts-expect-error 纯 JS 脚本，没有类型声明
import { isAllowed } from '../../scripts/check-licenses.mjs';

describe('SPDX 许可证判定', () => {
  it.each([
    ['MIT', true],
    ['(MIT OR GPL-3.0)', true],
    ['MIT AND Apache-2.0', true],
    ['MIT AND GPL-2.0', false],
    ['GPL-3.0 OR AGPL-3.0', false],
    ['LGPL-2.1', false],
    ['Apache-2.0 WITH LLVM-exception', true],
    ['GPL-2.0 WITH Classpath-exception-2.0', false],
    ['(MIT OR Apache-2.0) AND BSD-3-Clause', true],
    ['MIT OR Apache-2.0 AND GPL-3.0', true],
    ['Unknown', false],
  ])('%s → %s', (expression, expected) => {
    expect(isAllowed(expression)).toBe(expected);
  });

  it.each(['', '(MIT', 'MIT OR', 'MIT )', 'MIT WITH'])('无法解析「%s」时报错', (expression) => {
    expect(() => isAllowed(expression)).toThrow();
  });
});
