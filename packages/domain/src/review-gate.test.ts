import { describe, expect, it } from 'vitest';
import { gateAfterReview, gateAfterWork, outOfScope } from './review-gate.js';

describe('outOfScope', () => {
  const files = ['src/a.ts', 'src/deep/b.ts', 'tests/a.test.ts', 'docs/guide.md', 'README.md', 'package.json'];

  it('范围为空时整个 worktree 都可以改', () => {
    expect(outOfScope(files, [])).toEqual([]);
  });

  it('目录与文件前缀', () => {
    expect(outOfScope(files, ['src'])).toEqual(['tests/a.test.ts', 'docs/guide.md', 'README.md', 'package.json']);
    expect(outOfScope(files, ['src/', 'README.md'])).toEqual(['tests/a.test.ts', 'docs/guide.md', 'package.json']);
    // 前缀按整段目录算，不把 src2 当成 src
    expect(outOfScope(['src2/x.ts'], ['src'])).toEqual(['src2/x.ts']);
  });

  it('glob：** 跨目录，* 不跨', () => {
    expect(outOfScope(files, ['**/*.test.*', 'docs/**', '**/*.md'])).toEqual(['src/a.ts', 'src/deep/b.ts', 'package.json']);
    expect(outOfScope(files, ['src/*.ts'])).toEqual(['src/deep/b.ts', 'tests/a.test.ts', 'docs/guide.md', 'README.md', 'package.json']);
    expect(outOfScope(['a.test.ts', 'x/y/z.spec.js'], ['**/*.test.*', '**/*.spec.*'])).toEqual([]);
    expect(outOfScope(['file.txt'], ['file?txt'])).toEqual([]);
  });

  it('反斜杠和 ./ 统一成 git 路径', () => {
    expect(outOfScope(['src\\a.ts', './docs/x.md'], ['.\\src', 'docs/'])).toEqual([]);
  });

  it('模式里的正则字符按字面匹配', () => {
    expect(outOfScope(['a+b/c.ts', 'aab/c.ts'], ['a+b/**'])).toEqual(['aab/c.ts']);
  });
});

describe('gateAfterWork', () => {
  it('越界或检查没通过交给人，原因列出问题', () => {
    expect(gateAfterWork({ outOfScope: ['package.json'], checkStatus: 'passed', writable: true })).toEqual({ outcome: 'human', reason: '越出交付范围：package.json' });
    expect(gateAfterWork({ outOfScope: [], checkStatus: 'failed', writable: true })).toEqual({ outcome: 'human', reason: '检查命令没通过' });
    const many = Array.from({ length: 7 }, (_, i) => `f${i}`);
    expect(gateAfterWork({ outOfScope: many, checkStatus: 'timed_out', writable: true })).toEqual({
      outcome: 'human',
      reason: '越出交付范围：f0、f1、f2、f3、f4 等 7 个文件；检查命令超时',
    });
  });

  it('准备命令失败时只报准备命令（检查没有跑）', () => {
    expect(gateAfterWork({ outOfScope: [], checkStatus: 'error', prepareStatus: 'failed', writable: true })).toEqual({ outcome: 'human', reason: '准备命令失败' });
    expect(gateAfterWork({ outOfScope: [], checkStatus: 'passed', prepareStatus: 'passed', writable: true })).toEqual({ outcome: 'review' });
  });

  it('通过后：可写角色交给审阅，只读角色直接通过；没配置检查命令不算失败', () => {
    expect(gateAfterWork({ outOfScope: [], checkStatus: 'not_configured', writable: true })).toEqual({ outcome: 'review' });
    expect(gateAfterWork({ outOfScope: [], checkStatus: 'passed', writable: false })).toEqual({ outcome: 'passed' });
  });
});

describe('gateAfterReview', () => {
  const base = { failure: undefined, previousReworks: 0, maxAutoReworks: 2 };

  it('通过放行；退回在轮数内回去重做', () => {
    expect(gateAfterReview({ ...base, verdict: { decision: 'accept', note: null } })).toEqual({ outcome: 'passed' });
    expect(gateAfterReview({ ...base, verdict: { decision: 'rework', note: '缺测试' } })).toEqual({ outcome: 'rework', reason: '缺测试' });
    expect(gateAfterReview({ ...base, previousReworks: 1, verdict: { decision: 'rework', note: '还缺' } })).toEqual({ outcome: 'rework', reason: '还缺' });
  });

  it('自动退回满两轮后第三次交给人', () => {
    expect(gateAfterReview({ ...base, previousReworks: 2, verdict: { decision: 'rework', note: '还是不行' } })).toEqual({
      outcome: 'human',
      reason: '审阅助手已自动退回 2 轮，这次仍退回：还是不行',
    });
  });

  it('审阅失败或没交结论交给人', () => {
    expect(gateAfterReview({ ...base, verdict: undefined })).toEqual({ outcome: 'human', reason: '审阅助手没有给出结论' });
    expect(gateAfterReview({ ...base, verdict: undefined, failure: '执行失败：额度用完' })).toEqual({ outcome: 'human', reason: '审阅没有完成：执行失败：额度用完' });
  });
});
