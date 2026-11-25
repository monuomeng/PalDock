/**
 * P3-01 实机验证：`node packages/runtime-claude/dist/adapter-probe.js`
 *
 * 用真实 Claude Code 跑 ClaudeAdapter：短对话、写文件审批（拒绝）、中断、恢复、按会话记录核对 turn。
 * 会发起 4 次短对话，消耗用户的 Claude 额度。输出不含回复正文，只记录事件类型、状态和会话记录的结构。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeApprovalDecision, RuntimeEvent } from '@paldock/contracts';
import { ClaudeAdapter } from './claude-adapter.js';

const report: Record<string, unknown> = { probedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}` };
const claude = new ClaudeAdapter(process.env.PALDOCK_CLAUDE_PATH ? { configuredPath: process.env.PALDOCK_CLAUDE_PATH } : {});
const terminal = new Set(['completed', 'failed', 'interrupted', 'disconnected']);

async function turn(cwd: string, prompt: string, options: { approve?: RuntimeApprovalDecision; resumeThreadId?: string; cancelOnFirstDelta?: boolean } = {}) {
  const events: RuntimeEvent[] = [];
  const startedAt = Date.now();
  let done!: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));
  let cancelled = false;
  const started = claude.start({ runId: 'probe', cwd, prompt, ...(options.resumeThreadId ? { resumeThreadId: options.resumeThreadId } : {}) }, (event) => {
    events.push(event);
    if (event.type === 'approval_request' && options.approve) void started.then((r) => r.respondApproval(event.request.nativeRequestId, options.approve!));
    if (event.type === 'output_delta' && options.cancelOnFirstDelta && !cancelled) {
      cancelled = true;
      void started.then((r) => r.cancel());
    }
    if (terminal.has(event.type)) done();
  });
  const run = await started;
  await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 180_000))]);
  await run.dispose();
  const last = events.at(-1);
  return {
    ms: Date.now() - startedAt,
    eventTypes: [...new Set(events.map((e) => e.type))],
    terminal: last?.type,
    ...(last?.type === 'failed' ? { message: last.message.slice(0, 200) } : {}),
    ...(last?.type === 'completed' ? { hasFinalMessage: !!last.finalMessage, usage: last.usage } : {}),
    approvals: events.flatMap((e) => (e.type === 'approval_request' ? [{ kind: e.request.kind, summary: e.request.summary.replace(cwd, '<cwd>') }] : [])),
    threadId: (events.find((e) => e.type === 'thread') as { threadId: string } | undefined)?.threadId,
    turnId: (events.find((e) => e.type === 'turn') as { turnId: string } | undefined)?.turnId,
  };
}

/** 会话记录的结构：每行的类型、是否带我们的 turn ID、stop_reason、内容块类型；不含正文。 */
function transcriptShape(threadId: string, turnId: string) {
  const projects = join(homedir(), '.claude', 'projects');
  const file = readdirSync(projects).map((d) => join(projects, d, `${threadId}.jsonl`)).find((p) => existsSync(p));
  if (!file) return { found: false };
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return {
    found: true,
    turnIdPresent: lines.some((l) => l.includes(turnId)),
    entries: lines.map((l) => {
      const e = JSON.parse(l) as { type?: string; uuid?: string; isMeta?: boolean; message?: { content?: unknown; stop_reason?: unknown } };
      const content = e.message?.content;
      return {
        type: e.type,
        ours: e.uuid === turnId,
        ...(e.isMeta ? { isMeta: true } : {}),
        ...(e.message?.stop_reason !== undefined ? { stop: e.message.stop_reason } : {}),
        blocks: typeof content === 'string' ? 'string' : Array.isArray(content) ? content.map((b: { type?: string; text?: string }) => (b.type === 'text' && b.text?.startsWith('[Request interrupted') ? 'text:interrupt-marker' : b.type)) : undefined,
      };
    }),
  };
}

async function main(): Promise<void> {
  report.discover = await claude.discover();
  if (!(report.discover as { available: boolean }).available) return;
  const cwd = mkdtempSync(join(tmpdir(), 'paldock-claude-adapter-probe-'));
  try {
    const first = await turn(cwd, '只回复 OK 两个字母，不要做其他事。');
    report.turn = first;
    if (first.threadId && first.turnId) {
      report.checkTurn = await claude.checkTurn(first.threadId, first.turnId).then((c) => ({ status: c.status }));
      report.transcript = transcriptShape(first.threadId, first.turnId);
    }
    const permission = await turn(cwd, '请用 Write 工具在当前目录创建 hello.txt，内容为 hi。', { approve: 'deny' });
    report.permission = { ...permission, fileWritten: existsSync(join(cwd, 'hello.txt')) };
    const interrupt = await turn(cwd, '从 1 数到 500，每行一个数字。', { cancelOnFirstDelta: true });
    report.interrupt = interrupt;
    if (interrupt.threadId && interrupt.turnId) {
      report.interruptCheck = await claude.checkTurn(interrupt.threadId, interrupt.turnId).then((c) => ({ status: c.status }));
      report.interruptTranscript = transcriptShape(interrupt.threadId, interrupt.turnId);
    }
    if (first.threadId) {
      const resumed = await turn(cwd, '我们第一轮让你回复的是哪两个字母？只回答这两个字母。', { resumeThreadId: first.threadId });
      report.resume = { ...resumed, sameThread: resumed.threadId === first.threadId };
    }
    report.missingResume = await claude
      .start({ runId: 'probe', cwd, prompt: 'x', resumeThreadId: '00000000-0000-4000-8000-000000000000' }, () => {})
      .then(
        async (r) => (await r.dispose(), { rejected: false }),
        (e: Error) => ({ rejected: true, message: e.message.slice(0, 200) }),
      );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

main()
  .catch((error: Error) => {
    report.error = error.stack ?? error.message;
  })
  .finally(() => {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  });
