import { spawn } from 'node:child_process';
import type { CheckCommand, CheckStatus } from '@paldock/contracts';
import { childEnv, killProcessTree, resolveExecutable } from '@paldock/platform';

/**
 * 受控运行用户填写的检查命令（例如 `pnpm test`）。它由服务直接启动、不经执行器沙箱，所以：
 * - 只接受结构化的「可执行文件 + 参数数组」，不经 shell 拼接、不按空白拆分；
 * - 工作目录由调用方传入（已校验在 worktree 内），环境变量走白名单并加 CI=1；
 * - 超时或取消时结束整个进程树。
 * P1 没有操作系统级沙箱：命令以当前用户身份运行、可以联网，这一点在建任务时提示用户。
 */

export interface CheckOutcome {
  status: Extract<CheckStatus, 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'error'>;
  exitCode: number | null;
  durationMs: number;
  /** stdout 与 stderr 按到达顺序合并，未脱敏；超过上限时截断。 */
  output: string;
  truncated: boolean;
}

export interface CheckOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

/** cmd 无法安全转义这些字符（变量展开、延迟展开、引号、换行），含有时直接拒绝。 */
const CMD_UNSAFE = /[%!"\r\n]/;

export class CheckCommandError extends Error {
  override readonly name = 'CheckCommandError';
}

/** cmd 的引号规则：每个参数整体加引号；在引号内 & | < > ^ ( ) 都是字面字符。 */
const cmdQuote = (value: string) => `"${value}"`;

export interface SpawnPlan {
  file: string;
  args: string[];
  /** 仅 cmd 外壳时为 true：命令行已手工转义，Node 不得再加引号。 */
  verbatim: boolean;
}

/**
 * 把结构化命令变成 spawn 参数。`.exe` 与 posix 可执行文件直接启动、参数原样传入；
 * Windows 上的 `.cmd` / `.bat`（pnpm、npm 都是）Node 不允许直接启动，经 `cmd.exe /d /s /c` 并逐个参数加引号。
 */
export function planSpawn(command: CheckCommand, env: NodeJS.ProcessEnv): SpawnPlan {
  const resolved = resolveExecutable(command.executable, env);
  if (!resolved) throw new CheckCommandError(`找不到可执行文件：${command.executable}`);
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(resolved)) {
    return { file: resolved, args: [...command.args], verbatim: false };
  }
  const unsafe = [resolved, ...command.args].find((part) => CMD_UNSAFE.test(part));
  if (unsafe !== undefined) {
    throw new CheckCommandError(`「${unsafe}」含有 cmd 无法安全转义的字符（% ! " 或换行），请改写成项目里的脚本`);
  }
  const line = [resolved, ...command.args].map(cmdQuote).join(' ');
  const comspec = env.COMSPEC ?? env.ComSpec ?? 'cmd.exe';
  // /d 不执行 AutoRun，/s 去掉最外层引号后原样执行
  return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

export function runCheck(command: CheckCommand, options: CheckOptions): Promise<CheckOutcome> {
  const startedAt = Date.now();
  const env = childEnv({ CI: '1' });
  let plan: SpawnPlan;
  try {
    plan = planSpawn(command, env);
  } catch (error) {
    return Promise.resolve({ status: 'error', exitCode: null, durationMs: 0, output: (error as Error).message, truncated: false });
  }

  return new Promise((resolve) => {
    const child = spawn(plan.file, plan.args, {
      cwd: options.cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const collect = (chunk: Buffer) => {
      if (size >= options.maxOutputBytes) return void (truncated = true);
      const room = options.maxOutputBytes - size;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      size += Math.min(chunk.length, room);
      if (chunk.length > room) truncated = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let stopped: CheckOutcome['status'] | undefined;
    const stop = (status: 'timed_out' | 'cancelled') => {
      stopped ??= status;
      void killProcessTree(child);
    };
    const timer = setTimeout(() => stop('timed_out'), options.timeoutMs);
    const onAbort = () => stop('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    const done = (status: CheckOutcome['status'], exitCode: number | null, extra = '') => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const output = Buffer.concat(chunks).toString('utf8') + extra;
      resolve({ status, exitCode, durationMs: Date.now() - startedAt, output, truncated });
    };
    child.on('error', (error) => done('error', null, `\n启动失败：${error.message}`));
    child.on('close', (code) => done(stopped ?? (code === 0 ? 'passed' : 'failed'), code));
  });
}
