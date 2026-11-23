/**
 * P0-01 能力探测：`node packages/runtime-codex/dist/probe.js [--turn] [--interrupt]`
 *
 * 默认只做不消耗模型额度的步骤：版本、initialize、账号类型、模型数量、在临时目录新建 ephemeral thread。
 * `--turn` 发一条极短提示，验证流式与完成事件；`--interrupt` 发一条较长提示后立即 turn/interrupt。
 * 这两项会消耗账号额度，需用户同意后再运行。输出不含邮箱、令牌和回复正文。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexVersion, resolveCodexCommand } from './discover.js';
import { JsonRpcStdioClient } from './json-rpc.js';

interface Report {
  [key: string]: unknown;
}

const flags = new Set(process.argv.slice(2));
const report: Report = { probedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}` };
const notifications = new Map<string, number>();
const serverRequests: string[] = [];
const waiters = new Map<string, (params: unknown) => void>();

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
  const cmd = resolveCodexCommand(process.env.PALDOCK_CODEX_PATH);
  if (!cmd) {
    report.available = false;
    report.reason = '未找到 codex 可执行文件';
    return;
  }
  report.source = cmd.source;
  report.version = codexVersion(cmd);

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
  const cwd = mkdtempSync(join(tmpdir(), 'paldock-codex-probe-'));
  try {
    const init = await rpc.request<{ userAgent: string; platformOs: string }>('initialize', {
      clientInfo: { name: 'paldock_probe', title: 'PalDock P0 probe', version: '0.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    rpc.notify('initialized');
    report.initialize = { userAgent: init.userAgent, platformOs: init.platformOs };

    const account = await rpc.request<{ account: { type: string } | null; requiresOpenaiAuth: boolean }>('account/read', {});
    report.account = { type: account.account?.type ?? null, requiresOpenaiAuth: account.requiresOpenaiAuth };

    const models = await rpc.request<{ data?: unknown[] }>('model/list', {}).catch((e: Error) => ({ error: e.message }));
    report.models = 'data' in models ? { count: models.data?.length ?? 0 } : models;

    const started = await rpc.request<{ thread: { id: string }; sandbox: unknown; approvalPolicy: unknown }>('thread/start', {
      cwd,
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
    });
    report.threadStart = { ok: true, approvalPolicy: started.approvalPolicy, sandbox: started.sandbox };
    const threadId = started.thread.id;

    if (flags.has('--turn')) report.turn = await runTurn(rpc, threadId, '只回复 OK 两个字母，不要做其他事。');
    if (flags.has('--interrupt')) report.interrupt = await interruptTurn(rpc, threadId);
  } finally {
    report.notifications = Object.fromEntries(notifications);
    report.serverRequests = serverRequests;
    await rpc.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function runTurn(rpc: JsonRpcStdioClient, threadId: string, text: string) {
  const startedAt = Date.now();
  const completed = waitFor('turn/completed', 120_000);
  await rpc.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
  const done = (await completed) as { turn: { status: string } };
  return { status: done.turn.status, ms: Date.now() - startedAt, deltas: notifications.get('item/agentMessage/delta') ?? 0 };
}

async function interruptTurn(rpc: JsonRpcStdioClient, threadId: string) {
  const completed = waitFor('turn/completed', 60_000);
  const { turn } = await rpc.request<{ turn: { id: string } }>('turn/start', {
    threadId,
    input: [{ type: 'text', text: '从 1 数到 500，每行一个数字。', text_elements: [] }],
  });
  await rpc.request('turn/interrupt', { threadId, turnId: turn.id });
  const done = (await completed) as { turn: { status: string } };
  return { status: done.turn.status };
}

main()
  .catch((error: Error) => {
    report.error = error.message;
  })
  .finally(() => console.log(JSON.stringify(report, null, 2)));
