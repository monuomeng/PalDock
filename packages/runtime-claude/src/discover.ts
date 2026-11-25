import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { childEnv, nodeRuntimeEnv, resolveExecutable, versionAtLeast } from '@paldock/platform';

export interface ClaudeCommand {
  command: string;
  /** 放在 CLI 参数之前，例如 npm 安装时的 cli.js 入口。 */
  prefixArgs: string[];
  /** 从哪里找到的：设置里填的、PATH、独立安装的常见位置、Claude 桌面版自带。 */
  source: 'configured' | 'path' | 'npm-shim' | 'standalone' | 'desktop-bundled';
}

const NPM_ENTRY = join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
const EXE = process.platform === 'win32' ? 'claude.exe' : 'claude';
const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

/**
 * 找到可直接 spawn 的 Claude Code 命令，按顺序：设置里填的路径 → PATH → 独立安装的常见位置 → Claude 桌面版自带的那份。
 * 每次启动 Run 都重新查找，不缓存路径：桌面版自带的那份路径含版本号和构建号，升级后会变（P0-02）。
 * Windows 上 npm 安装只提供 claude.cmd 外壳，Node 不允许不经 shell 启动 .cmd，改用 Node 运行包里的 cli.js。
 */
export function resolveClaudeCommand(configured?: string, nodePath = process.execPath, env: NodeJS.ProcessEnv = process.env): ClaudeCommand | undefined {
  if (configured) {
    if (!existsSync(configured)) return undefined;
    // 配置为 .js / .mjs 入口时（npm 布局或离线模拟执行器）用 Node 运行
    return /\.m?js$/i.test(configured)
      ? { command: nodePath, prefixArgs: [configured], source: 'configured' }
      : { command: configured, prefixArgs: [], source: 'configured' };
  }
  const found = resolveExecutable('claude', env);
  if (found && !/\.(?:cmd|bat)$/i.test(found)) return { command: found, prefixArgs: [], source: 'path' };
  const entry = found && join(dirname(found), NPM_ENTRY);
  if (entry && existsSync(entry)) return { command: nodePath, prefixArgs: [entry], source: 'npm-shim' };
  const standalone = standaloneLocations(env).find(isFile);
  if (standalone) return { command: standalone, prefixArgs: [], source: 'standalone' };
  const bundled = desktopBundledClaude(env);
  return bundled ? { command: bundled, prefixArgs: [], source: 'desktop-bundled' } : undefined;
}

/** 独立安装的常见位置：原生安装器放在 ~/.local/bin（不一定在 PATH 上），旧版本地安装在 ~/.claude/local。 */
function standaloneLocations(env: NodeJS.ProcessEnv): string[] {
  const home = env.USERPROFILE ?? env.HOME;
  if (!home) return [];
  const own = [join(home, '.local', 'bin', EXE), join(home, '.claude', 'local', EXE)];
  return process.platform === 'win32' ? own : [...own, '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
}

/**
 * Claude 桌面版自带的 Claude Code：Windows 在 %LOCALAPPDATA%\Claude-Data\<配置>\claude-code\<版本>\<构建>\claude.exe（实测），
 * macOS 按 ~/Library/Application Support/Claude/claude-code/<版本>/… 查找（未实测）。多个版本时取版本号最大的。
 * 这份需要在 Claude Code 里单独登录（P0-02），未登录时由 discover 报告。
 */
export function desktopBundledClaude(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const roots: string[] = [];
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Claude-Data');
    if (base && existsSync(base)) roots.push(...subdirs(base).map((profile) => join(base, profile, 'claude-code')));
  } else if (env.HOME) {
    roots.push(join(env.HOME, 'Library', 'Application Support', 'Claude', 'claude-code'));
  }
  const candidates = roots.flatMap((root) =>
    subdirs(root).flatMap((version) => {
      const dir = join(root, version);
      const exe = [join(dir, EXE), ...subdirs(dir).map((build) => join(dir, build, EXE))].find(isFile);
      return exe ? [{ version, exe }] : [];
    }),
  );
  return candidates.sort((a, b) => compareVersions(b.version, a.version))[0]?.exe;
}

const subdirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

/** 按 major.minor.patch 数值比较（不按字符串：2.1.99 小于 2.1.100），解析不了的排最后。 */
const versionParts = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? [-1, -1, -1];
function compareVersions(a: string, b: string): number {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
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
