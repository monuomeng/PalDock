/**
 * P0-02 能力探测：`node packages/runtime-claude/dist/probe.js [--turn] [--interrupt] [--permission] [--resume]`
 *
 * 通过 Claude Code CLI 的 stream-json 双向流接入（`-p --input-format stream-json --output-format stream-json`）。
 * 默认只读 `--version` 与 `auth status`（零成本）；其余开关会发起真实对话、消耗用户的 Claude 额度。
 * 输出不含邮箱、令牌和回复正文。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ClaudeSession, cleanEnv, isResult, resolveClaude } from './session.js';

const flags = new Set(process.argv.slice(2));
const report: Record<string, unknown> = { probedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}` };

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
      const answer = session.waitFor(isResult, 180_000);
      const resumed = await turn(session, '我们第一轮让你回复的是哪两个字母？只回答这两个字母。');
      // 只记录是否答对，不记录回复正文
      report.resume = { ...resumed, rememberedContext: /OK/i.test(String((await answer).result ?? '')) };
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
