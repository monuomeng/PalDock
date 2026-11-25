import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { meetsMinimum, npmNativeBinary, resolveCodexCommand } from './discover.js';

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

describe('npm 安装的原生 Codex', () => {
  /** 按 npm 全局安装的布局造目录：<prefix>/node_modules/@openai/codex 及平台包。 */
  function layout(nativeAt: 'nested' | 'sibling' | 'self' | 'none') {
    const root = mkdtempSync(join(tmpdir(), 'paldock-codex-'));
    const pkg = join(root, 'node_modules', '@openai', 'codex');
    const vendor = {
      nested: join(pkg, 'node_modules', '@openai', 'codex-win32-x64', 'vendor'),
      sibling: join(root, 'node_modules', '@openai', 'codex-win32-x64', 'vendor'),
      self: join(pkg, 'vendor'),
      none: undefined,
    }[nativeAt];
    mkdirSync(pkg, { recursive: true });
    if (vendor) {
      const bin = join(vendor, 'x86_64-pc-windows-msvc', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'codex.exe'), '');
    }
    return { pkg, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it.each(['nested', 'sibling', 'self'] as const)('平台包在 %s 位置时找到 codex.exe', (where) => {
    const { pkg, cleanup } = layout(where);
    try {
      expect(npmNativeBinary(pkg, 'win32', 'x64')).toMatch(/x86_64-pc-windows-msvc[\\/]bin[\\/]codex\.exe$/);
    } finally {
      cleanup();
    }
  });

  it('没有原生程序或平台不认识时返回空', () => {
    const { pkg, cleanup } = layout('none');
    try {
      expect(npmNativeBinary(pkg, 'win32', 'x64')).toBeUndefined();
      expect(npmNativeBinary(pkg, 'sunos' as NodeJS.Platform, 'x64')).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('设置里填的是 codex.cmd 时也按 npm 布局解析，不直接起 .cmd（Node 不经 shell 起不了）', () => {
    const { pkg, cleanup } = layout('none');
    try {
      const root = join(pkg, '..', '..', '..');
      const shim = join(root, 'codex.cmd');
      writeFileSync(shim, '');
      mkdirSync(join(pkg, 'bin'), { recursive: true });
      writeFileSync(join(pkg, 'bin', 'codex.js'), '');
      expect(resolveCodexCommand(shim, 'node')).toMatchObject({ command: 'node', prefixArgs: [join(pkg, 'bin', 'codex.js')], source: 'npm-shim' });
      rmSync(join(pkg, 'bin'), { recursive: true });
      expect(resolveCodexCommand(shim, 'node')).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
