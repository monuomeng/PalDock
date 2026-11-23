/**
 * P0-02 能力探测：`node packages/runtime-claude/dist/probe.js [--turn] [--interrupt] [--permission] [--resume]`
 *
 * 通过 Claude Code CLI 的 stream-json 双向流接入（`-p --input-format stream-json --output-format stream-json`）。
 * 默认只读 `--version` 与 `auth status`（零成本）；其余开关会发起真实对话、消耗用户的 Claude 额度。
 * 子进程使用干净的环境变量：在 Claude 桌面版或另一个 Claude Code 会话里启动时，继承的 CLAUDE_* 变量
 * 会让子进程挂到宿主会话上（实测会带出宿主的工具列表），PalDock 的 Run 不能这样。
 * 输出不含邮箱、令牌和回复正文。
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { killProcessTree, readFrames, writeFrame } from '@paldock/platform';

type Message = Record<string, unknown> & { type: string; subtype?: string };

const flags = new Set(process.argv.slice(2));
const report: Record<string, unknown> = { probedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}` };

/** 只传运行所需的系统变量，不继承宿主会话的 CLAUDE_* / ANTHROPIC_*。 */
const CLEAN_ENV_KEYS = ['PATH', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'COMSPEC'];
const cleanEnv = Object.fromEntries(CLEAN_ENV_KEYS.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])));

/** PATH 上的 claude；否则找 Claude 桌面版自带的最新一份（路径随版本变化，仅供 P0 探测）。 */
function resolveClaude(): string | undefined {
  if (process.env.PALDOCK_CLAUDE_PATH) return process.env.PALDOCK_CLAUDE_PATH;
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    const candidate = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (dir && existsSync(candidate)) return candidate;
  }
  const root = join(process.env.LOCALAPPDATA ?? '', 'Claude-Data');
  if (!existsSync(root)) return undefined;
  for (const profile of readdirSync(root)) {
    const versions = join(root, profile, 'claude-code');
    if (!existsSync(versions)) continue;
    const latest = readdirSync(versions).sort().at(-1);
    const build = latest && readdirSync(join(versions, latest)).at(0);
    const exe = build && join(versions, latest, build, 'claude.exe');
    if (exe && existsSync(exe)) return exe;
  }
  return undefined;
}

class ClaudeSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(m: Message) => void>();
  readonly seen = new Map<string, number>();
  readonly permissionRequests: string[] = [];
  private nextRequest = 0;

  constructor(exe: string, cwd: string, extraArgs: string[] = []) {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--strict-mcp-config',
      '--setting-sources', '',
      ...extraArgs,
    ];
    this.child = spawn(exe, args, { cwd, env: cleanEnv, stdio: 'pipe', windowsHide: true });
    this.child.stdin.on('error', () => {});
    readFrames(this.child.stdout, (frame) => this.onMessage(frame as Message), () => {});
  }

  private onMessage(message: Message): void {
    const key = message.subtype ? `${message.type}/${message.subtype}` : message.type;
    this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
    const request = message.request as { subtype?: string; tool_name?: string } | undefined;
    if (message.type === 'control_request' && request?.subtype === 'can_use_tool') {
      // 探测一律拒绝，只记录被请求的工具名
      this.permissionRequests.push(request.tool_name ?? 'unknown');
      writeFrame(this.child.stdin, {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: { behavior: 'deny', message: 'PalDock 探测不批准任何操作' },
        },
      });
    }
    for (const listener of this.listeners) listener(message);
  }

  waitFor(predicate: (m: Message) => boolean, timeoutMs: number): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error('等待 Claude 消息超时'));
      }, timeoutMs);
      const listener = (m: Message) => {
        if (!predicate(m)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(m);
      };
      this.listeners.add(listener);
    });
  }

  send(text: string): void {
    writeFrame(this.child.stdin, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: '',
    });
  }

  interrupt(): void {
    writeFrame(this.child.stdin, {
      type: 'control_request',
      request_id: `paldock_${++this.nextRequest}`,
      request: { subtype: 'interrupt' },
    });
  }

  dispose(): Promise<void> {
    this.child.stdin.end();
    return killProcessTree(this.child);
  }
}

const isResult = (m: Message) => m.type === 'result';
const deltaCount = (s: ClaudeSession) => s.seen.get('stream_event') ?? 0;

async function turn(session: ClaudeSession, text: string) {
  const before = deltaCount(session);
  const startedAt = Date.now();
  const result = session.waitFor(isResult, 180_000);
  session.send(text);
  const done = await result;
  return {
    subtype: done.subtype,
    isError: done.is_error,
    ms: Date.now() - startedAt,
    streamEvents: deltaCount(session) - before,
    sessionId: typeof done.session_id === 'string',
  };
}

async function main(): Promise<void> {
  const exe = resolveClaude();
  if (!exe) {
    report.available = false;
    return;
  }
  const run = promisify(execFile);
  const opts = { env: cleanEnv, windowsHide: true, timeout: 30_000 } as const;
  report.version = (await run(exe, ['--version'], opts)).stdout.trim();
  // 未登录时 auth status 以非零码退出，但 stdout 仍是 JSON
  const authOut = await run(exe, ['auth', 'status'], opts).then(
    (r) => r.stdout,
    (e: { stdout?: string }) => e.stdout ?? '{}',
  );
  const auth = JSON.parse(authOut) as { loggedIn?: boolean; authMethod?: string };
  report.auth = { loggedIn: auth.loggedIn, authMethod: auth.authMethod };
  if (!auth.loggedIn || ![...flags].length) return;

  const cwd = mkdtempSync(join(tmpdir(), 'paldock-claude-probe-'));
  let session = new ClaudeSession(exe, cwd);
  let sessionId: string | undefined;
  try {
    const init = session.waitFor((m) => m.type === 'system' && m.subtype === 'init', 60_000);
    const first = await turn(session, '只回复 OK 两个字母，不要做其他事。');
    const initMessage = await init;
    sessionId = initMessage.session_id as string;
    report.init = { model: initMessage.model, permissionMode: initMessage.permissionMode, tools: (initMessage.tools as unknown[]).length };
    report.turn = first;

    if (flags.has('--interrupt')) {
      const firstDelta = session.waitFor((m) => m.type === 'stream_event', 120_000);
      const result = session.waitFor(isResult, 120_000);
      session.send('从 1 数到 500，每行一个数字。');
      await firstDelta;
      const requestedAt = Date.now();
      session.interrupt();
      const done = await result;
      report.interrupt = { subtype: done.subtype, msToStop: Date.now() - requestedAt };
    }

    if (flags.has('--permission')) {
      report.permission = {
        ...(await turn(session, '请用 Write 工具在当前目录创建 hello.txt，内容为 hi。')),
        requestedTools: [...session.permissionRequests],
        fileWritten: existsSync(join(cwd, 'hello.txt')),
      };
    }

    if (flags.has('--resume') && sessionId) {
      await session.dispose();
      session = new ClaudeSession(exe, cwd, ['--resume', sessionId]);
      const resumed = await turn(session, '我们上一轮让你回复的是哪两个字母？只回答这两个字母。');
      report.resume = resumed;
    }
  } finally {
    report.messageTypes = Object.fromEntries(session.seen);
    await session.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}

main()
  .catch((error: Error) => {
    report.error = error.message;
  })
  .finally(() => console.log(JSON.stringify(report, null, 2)));
