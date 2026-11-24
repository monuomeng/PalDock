import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { childEnv, nodeRuntimeEnv, resolveExecutable } from '@paldock/platform';

export interface CodexCommand {
  command: string;
  /** 放在 app-server 参数之前，例如 npm 安装时的 codex.js 入口。 */
  prefixArgs: string[];
  source: 'configured' | 'native' | 'npm-native' | 'npm-shim';
  /** 启动时额外带的环境变量（npm 安装时 codex.js 会设置的那几个）。 */
  env?: Record<string, string>;
}

const NPM_PACKAGE = join('node_modules', '@openai', 'codex');
const NPM_ENTRY = join(NPM_PACKAGE, 'bin', 'codex.js');
const TRIPLES: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
};

/**
 * 找到可直接 spawn 的 Codex 命令。Windows 上 npm 安装只提供 codex.cmd 外壳，
 * 而 Node 不允许不经 shell 启动 .cmd。npm 包里的 codex.js 只是再启动一个原生 codex.exe，
 * 而且启动时不隐藏窗口，所以优先直接运行这个原生程序（查找方式与 codex.js 相同）；
 * 找不到时才用 Node 运行 codex.js。
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
  const packageRoot = join(dirname(found), NPM_PACKAGE);
  const native = npmNativeBinary(packageRoot);
  if (native) return { command: native, prefixArgs: [], source: 'npm-native', env: { CODEX_MANAGED_PACKAGE_ROOT: packageRoot, CODEX_MANAGED_BY_NPM: '1' } };
  const entry = join(dirname(found), NPM_ENTRY);
  return existsSync(entry) ? { command: nodePath, prefixArgs: [entry], source: 'npm-shim' } : undefined;
}

/** npm 包里的原生程序：先找平台包（@openai/codex-<平台>-<架构>）的 vendor，再找包自身的 vendor。 */
export function npmNativeBinary(packageRoot: string, platform = process.platform, arch = process.arch): string | undefined {
  const target = `${platform}-${arch}`;
  const triple = TRIPLES[target];
  if (!triple) return undefined;
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const vendorRoots = [
    join(packageRoot, 'node_modules', '@openai', `codex-${target}`, 'vendor'),
    join(dirname(packageRoot), `codex-${target}`, 'vendor'),
    join(packageRoot, 'vendor'),
  ];
  return vendorRoots.map((root) => join(root, triple, 'bin', exe)).find((path) => existsSync(path));
}

export async function codexVersion(cmd: CodexCommand, extraEnv: Record<string, string> = {}): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)(cmd.command, [...cmd.prefixArgs, '--version'], {
      env: commandEnv(cmd, extraEnv),
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

/** 启动 Codex 子进程的环境变量：白名单 + Electron 跑 Node 所需 + 命令自带 + 调用方额外的。 */
export function commandEnv(cmd: CodexCommand, extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  return childEnv({ ...nodeRuntimeEnv(cmd.command), ...cmd.env, ...extraEnv });
}
