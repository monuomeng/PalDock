import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveExecutable } from '@paldock/platform';

export interface CodexCommand {
  command: string;
  /** 放在 app-server 参数之前，例如 npm 安装时的 codex.js 入口。 */
  prefixArgs: string[];
  source: 'configured' | 'native' | 'npm-shim';
}

const NPM_ENTRY = join('node_modules', '@openai', 'codex', 'bin', 'codex.js');
/**
 * 找到可直接 spawn 的 Codex 命令。Windows 上 npm 安装只提供 codex.cmd 外壳，
 * 而 Node 不允许不经 shell 启动 .cmd，所以改为用 Node 运行旁边的 codex.js 入口。
 * 只认识 npm 全局安装的布局；其他包管理器请在设置里填写可执行文件路径（configured）。
 * `nodePath` 在 Electron 内应传 Electron 可执行文件，并设置 ELECTRON_RUN_AS_NODE=1。
 */
export function resolveCodexCommand(configured?: string, nodePath = process.execPath): CodexCommand | undefined {
  if (configured) {
    if (!existsSync(configured)) return undefined;
    // 配置为 .js / .mjs 入口时（npm 布局或离线模拟执行器）用 Node 运行
    return /\.m?js$/i.test(configured)
      ? { command: nodePath, prefixArgs: [configured], source: 'configured' }
      : { command: configured, prefixArgs: [], source: 'configured' };
  }
  const found = resolveExecutable('codex');
  if (!found?.toLowerCase().endsWith('.cmd')) return found ? { command: found, prefixArgs: [], source: 'native' } : undefined;
  const entry = join(dirname(found), NPM_ENTRY);
  return existsSync(entry) ? { command: nodePath, prefixArgs: [entry], source: 'npm-shim' } : undefined;
}

export async function codexVersion(cmd: CodexCommand): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)(cmd.command, [...cmd.prefixArgs, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    return stdout.trim().replace(/^codex-cli\s+/, '');
  } catch {
    return undefined;
  }
}
