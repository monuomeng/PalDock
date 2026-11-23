import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export interface CodexCommand {
  command: string;
  /** 放在 app-server 参数之前，例如 npm 安装时的 codex.js 入口。 */
  prefixArgs: string[];
  source: 'configured' | 'native' | 'npm-shim';
}

const NPM_ENTRY = join('node_modules', '@openai', 'codex', 'bin', 'codex.js');

function findOnPath(names: readonly string[]): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (dir && existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * 找到可直接 spawn 的 Codex 命令。Windows 上 npm 安装只提供 codex.cmd 外壳，
 * 而 Node 不允许不经 shell 启动 .cmd，所以改为用 Node 运行 codex.js 入口。
 * `nodePath` 在 Electron 内应传 Electron 可执行文件，并设置 ELECTRON_RUN_AS_NODE=1。
 */
export function resolveCodexCommand(configured?: string, nodePath = process.execPath): CodexCommand | undefined {
  if (configured) return existsSync(configured) ? { command: configured, prefixArgs: [], source: 'configured' } : undefined;
  // posix 上 npm 全局安装的 codex 是指向 codex.js 的可执行链接，可直接 spawn
  const native = findOnPath(process.platform === 'win32' ? ['codex.exe'] : ['codex']);
  if (native) return { command: native, prefixArgs: [], source: 'native' };
  const shim = findOnPath(['codex.cmd']);
  const entry = shim && join(dirname(shim), NPM_ENTRY);
  return entry && existsSync(entry) ? { command: nodePath, prefixArgs: [entry], source: 'npm-shim' } : undefined;
}

export function codexVersion(cmd: CodexCommand): string | undefined {
  try {
    return execFileSync(cmd.command, [...cmd.prefixArgs, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
      .trim()
      .replace(/^codex-cli\s+/, '');
  } catch {
    return undefined;
  }
}
