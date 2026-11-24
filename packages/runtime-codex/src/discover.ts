import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { childEnv, nodeRuntimeEnv, resolveExecutable } from '@paldock/platform';

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

/** 环境变量与启动 app-server 时一致；在 Electron 里用 Electron 跑 codex.js 必须带 ELECTRON_RUN_AS_NODE，否则会启动一个新窗口。 */
export async function codexVersion(cmd: CodexCommand, extraEnv: Record<string, string> = {}): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)(cmd.command, [...cmd.prefixArgs, '--version'], {
      env: childEnv({ ...nodeRuntimeEnv(cmd.command), ...extraEnv }),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    return stdout.trim().replace(/^codex-cli\s+/, '');
  } catch {
    return undefined;
  }
}

/** P2 起锁定的最低版本：更低的版本没有测过 app-server 协议，拒绝启动。 */
export const MIN_CODEX_VERSION = '0.166.0';

/** 比较 major.minor.patch，忽略预发布后缀；解析不了的版本视为不满足。 */
export function meetsMinimum(version: string, minimum = MIN_CODEX_VERSION): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
  const [have, need] = [parse(version), parse(minimum)];
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i]! > need[i]!;
  return true;
}
