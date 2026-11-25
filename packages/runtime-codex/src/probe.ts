/**
 * P0-01 能力探测：`node packages/runtime-codex/dist/probe.js [--turn] [--interrupt]`
 *
 * 默认只做不消耗模型额度的步骤：版本、initialize、账号类型、模型数量、在临时目录新建 ephemeral thread。
 * `--turn` 发一条极短提示，验证流式与完成事件；`--interrupt` 发一条较长提示后立即 turn/interrupt；
 * `--approval` 在只读沙箱里要求写文件，验证审批请求（探测一律拒绝）；
 * `--resume` 改用非 ephemeral thread，结束 app-server 后在新进程里 thread/resume（会在 Codex 历史里留下一条会话）。
 * 这些会消耗账号额度，需用户同意后再运行。输出不含邮箱、令牌和回复正文。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexVersion, resolveCodexCommand, type CodexCommand } from './discover.js';
import { JsonRpcStdioClient } from './json-rpc.js';

interface Report {
  [key: string]: unknown;
}

const flags = new Set(process.argv.slice(2));
const report: Report = { probedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}` };
const notifications = new Map<string, number>();
let cmd: CodexCommand;
const serverRequests: string[] = [];
const waiters = new Map<string, (params: unknown) => void>();
let stderrTail = '';

function waitFor(method: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${method} 超时`)), timeoutMs);
    waiters.set(method, (params) => {
      clearTimeout(timer);
      resolve(params);
    });
  });
}
async function main(): Promise<void> {
  const found = resolveCodexCommand(process.env.PALDOCK_CODEX_PATH);
  if (!found) {
    report.available = false;
    report.reason = '未找到 codex 可执行文件';
    return;
  }
  cmd = found;
  report.source = cmd.source;
  report.version = await codexVersion(cmd);

  const cwd = mkdtempSync(join(tmpdir(), 'paldock-codex-probe-'));
  let rpc = await openAppServer();
  try {
    const account = await rpc.request<{ account: { type: string } | null; requiresOpenaiAuth: boolean }>('account/read', {});
    report.account = { type: account.account?.type ?? null, requiresOpenaiAuth: account.requiresOpenaiAuth };

    const models = await rpc.request<{ data?: unknown[] }>('model/list', {}).catch((e: Error) => ({ error: e.message }));
    report.models = 'data' in models ? { count: models.data?.length ?? 0 } : models;

    const started = await rpc.request<{ thread: { id: string }; sandbox: unknown; approvalPolicy: unknown }>('thread/start', {
      cwd,
      ephemeral: !flags.has('--resume'),
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
    });
    report.threadStart = { ok: true, approvalPolicy: started.approvalPolicy, sandbox: started.sandbox };
    const threadId = started.thread.id;

    if (flags.has('--turn') || flags.has('--resume')) report.turn = await runTurn(rpc, threadId, '只回复 OK 两个字母，不要做其他事。');
    if (flags.has('--interrupt')) report.interrupt = await interruptTurn(rpc, threadId);
    if (flags.has('--approval')) {
      report.approval = await runTurn(rpc, threadId, '请在当前目录创建文件 hello.txt，内容为 hi。必须实际执行写入。');
    }
    if (flags.has('--resume')) {
      await rpc.dispose();
      rpc = await openAppServer();
      const resumed = await rpc.request<{ thread: { id: string; turns?: unknown[] } }>('thread/resume', { threadId, cwd });
      report.resume = { sameThread: resumed.thread.id === threadId, turnsLoaded: resumed.thread.turns?.length ?? null };
      report.resumeTurn = await runTurn(rpc, threadId, '再回复一次 OK。');
    }
  } finally {
    report.notifications = Object.fromEntries(notifications);
    report.serverRequests = serverRequests;
    await rpc.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function openAppServer(): Promise<JsonRpcStdioClient> {
  const rpc = new JsonRpcStdioClient(cmd.command, [...cmd.prefixArgs, 'app-server', '--listen', 'stdio://'], {
    onNotification: (method, params) => {
      notifications.set(method, (notifications.get(method) ?? 0) + 1);
      waiters.get(method)?.(params);
    },
    // 探测不批准任何操作：一律拒绝，只记录请求类型
    onServerRequest: async (method) => {
      serverRequests.push(method);
      return { decision: 'decline' };
    },
  });
  // app-server 启动失败时只有退出码；保留 stderr 末尾，便于判断是否为版本不兼容（Mac 上 0.138 实测退出 1）
  rpc.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-600);
  });
  const init = await rpc.request<{ userAgent: string; platformOs: string }>('initialize', {
    clientInfo: { name: 'paldock_probe', title: 'PalDock P0 probe', version: '0.0.0' },
    capabilities: { experimentalApi: false, requestAttestation: false },
  });
  rpc.notify('initialized');
  report.initialize = { userAgent: init.userAgent, platformOs: init.platformOs };
  return rpc;
}

async function runTurn(rpc: JsonRpcStdioClient, threadId: string, text: string) {
  const startedAt = Date.now();
  const deltasBefore = notifications.get('item/agentMessage/delta') ?? 0;
  const requestsBefore = serverRequests.length;
  const completed = waitFor('turn/completed', 180_000);
  await rpc.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
  const done = (await completed) as { turn: { status: string } };
  return {
    status: done.turn.status,
    ms: Date.now() - startedAt,
    deltas: (notifications.get('item/agentMessage/delta') ?? 0) - deltasBefore,
    serverRequests: serverRequests.slice(requestsBefore),
  };
}

/** 等 turn/started 之后再中断：turn/start 返回时 turn 可能还没真正开始（实测会报 no active turn）。 */
async function interruptTurn(rpc: JsonRpcStdioClient, threadId: string) {
  const started = waitFor('turn/started', 60_000);
  const completed = waitFor('turn/completed', 60_000);
  completed.catch(() => {}); // 中断请求失败时不留下未处理的拒绝
  const { turn } = await rpc.request<{ turn: { id: string } }>('turn/start', {
    threadId,
    input: [{ type: 'text', text: '从 1 数到 500，每行一个数字。', text_elements: [] }],
  });
  await started;
  const requestedAt = Date.now();
  await rpc.request('turn/interrupt', { threadId, turnId: turn.id });
  const done = (await completed) as { turn: { status: string } };
  return { status: done.turn.status, msToStop: Date.now() - requestedAt };
}

main()
  .catch((error: Error) => {
    report.error = error.message;
    if (stderrTail) report.stderrTail = stderrTail.trim();
  })
  .finally(() => console.log(JSON.stringify(report, null, 2)));
