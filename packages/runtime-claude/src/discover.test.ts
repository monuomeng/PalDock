import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { desktopBundledClaude, resolveClaudeCommand } from './discover.js';

const EXE = process.platform === 'win32' ? 'claude.exe' : 'claude';
let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 造一个只有空 PATH 的用户目录，按需放入独立安装和桌面版自带的 claude。 */
function layout(files: string[]) {
  root = mkdtempSync(join(tmpdir(), 'paldock-claude-discover-'));
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '');
  }
  const local = join(root, 'AppData', 'Local');
  return { PATH: '', USERPROFILE: root, HOME: root, LOCALAPPDATA: local };
}

const bundled = (version: string, build = 'b1') =>
  process.platform === 'win32'
    ? join('AppData', 'Local', 'Claude-Data', 'claude_x', 'claude-code', version, build, EXE)
    : join('Library', 'Application Support', 'Claude', 'claude-code', version, build, EXE);

describe('查找 Claude Code', () => {
  it('PATH 上没有时找独立安装的 ~/.local/bin，优先于桌面版自带', () => {
    const env = layout([join('.local', 'bin', EXE), bundled('2.1.325')]);
    expect(resolveClaudeCommand(undefined, process.execPath, env)).toEqual({ command: join(root, '.local', 'bin', EXE), prefixArgs: [], source: 'standalone' });
  });

  it('只有桌面版自带时取版本号最大的一份（按数值比较）', () => {
    const env = layout([bundled('2.1.99'), bundled('2.1.325', 'abc'), bundled('2.1.100')]);
    expect(desktopBundledClaude(env)).toBe(join(root, bundled('2.1.325', 'abc')));
    expect(resolveClaudeCommand(undefined, process.execPath, env)).toMatchObject({ source: 'desktop-bundled' });
  });

  it('都没有时返回 undefined', () => {
    expect(resolveClaudeCommand(undefined, process.execPath, layout([]))).toBeUndefined();
  });

  it('设置里填的路径不存在时不回退到自动查找', () => {
    const env = layout([bundled('2.1.325')]);
    expect(resolveClaudeCommand(join(root, 'missing.exe'), process.execPath, env)).toBeUndefined();
  });
});
