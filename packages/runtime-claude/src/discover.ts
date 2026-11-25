import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { childEnv, nodeRuntimeEnv, resolveExecutable, versionAtLeast } from '@paldock/platform';

export interface ClaudeCommand {
  command: string;
  /** 放在 CLI 参数之前，例如 npm 安装时的 cli.js 入口。 */
  prefixArgs: string[];
  source: 'configured' | 'path' | 'npm-shim';
}

const NPM_ENTRY = join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js');

/**
 * 找到可直接 spawn 的 Claude Code 命令：设置里填的路径优先，否则在 PATH 上找 `claude`。
 * Windows 上 npm 安装只提供 claude.cmd 外壳，Node 不允许不经 shell 启动 .cmd，改用 Node 运行包里的 cli.js；
 * 找不到时请用户在设置里填写可执行文件路径。
 * Claude 桌面版自带的那份路径含版本号和构建号，升级后会变（P0-02），不自动使用。
 */
export function resolveClaudeCommand(configured?: string, nodePath = process.execPath): ClaudeCommand | undefined {
  if (configured) {
    if (!existsSync(configured)) return undefined;
    // 配置为 .js / .mjs 入口时（npm 布局或离线模拟执行器）用 Node 运行
    return /\.m?js$/i.test(configured)
      ? { command: nodePath, prefixArgs: [configured], source: 'configured' }
      : { command: configured, prefixArgs: [], source: 'configured' };
  }
  const found = resolveExecutable('claude');
  if (!found) return undefined;
  if (!/\.(?:cmd|bat)$/i.test(found)) return { command: found, prefixArgs: [], source: 'path' };
  const entry = join(dirname(found), NPM_ENTRY);
  return existsSync(entry) ? { command: nodePath, prefixArgs: [entry], source: 'npm-shim' } : undefined;
}

/** 只在 2.1.325 上实测过 stream-json、宿主审批与按会话注入 MCP（P3-00），更低的版本拒绝启动。 */
export const MIN_CLAUDE_VERSION = '2.1.325';

/**
 * 启动 Claude Code 子进程的环境变量：白名单 + Electron 跑 Node 所需 + 调用方额外的。
 * 不继承宿主的 CLAUDE_* / ANTHROPIC_*：在 Claude 桌面版或另一个 Claude Code 会话里启动时，
 * 子进程会挂到宿主会话上（P0-02）。需要指定配置目录时由适配器显式传 CLAUDE_CONFIG_DIR。
 */
export function commandEnv(cmd: ClaudeCommand, extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  return childEnv({ ...nodeRuntimeEnv(cmd.command), ...extraEnv });
}

async function run(cmd: ClaudeCommand, args: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const options = { env, encoding: 'utf8', windowsHide: true, timeout: 15_000 } as const;
    return (await promisify(execFile)(cmd.command, [...cmd.prefixArgs, ...args], options)).stdout;
  } catch (error) {
    // 未登录时 auth status 以非零码退出，但 stdout 仍是 JSON
    return (error as { stdout?: string }).stdout || undefined;
  }
}

/** `claude --version` 输出形如「2.1.325 (Claude Code)」。 */
export async function claudeVersion(cmd: ClaudeCommand, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return /^\s*(\d+\.\d+\.\d+\S*)/.exec((await run(cmd, ['--version'], env)) ?? '')?.[1];
}

/** 是否已登录；只读 loggedIn，不读邮箱等账号信息。无法判断时返回 undefined，不阻止启动。 */
export async function claudeLoggedIn(cmd: ClaudeCommand, env: NodeJS.ProcessEnv): Promise<boolean | undefined> {
  try {
    const status = JSON.parse((await run(cmd, ['auth', 'status'], env)) ?? '') as { loggedIn?: unknown };
    return typeof status.loggedIn === 'boolean' ? status.loggedIn : undefined;
  } catch {
    return undefined;
  }
}

export const meetsMinimum = (version: string, minimum = MIN_CLAUDE_VERSION) => versionAtLeast(version, minimum);
