/**
 * P0-07 Codex 子代理探测：`node packages/runtime-codex/dist/subagent-probe.js`（会消耗少量额度）
 *
 * 要求主 thread 用原生子代理读取临时目录里的一个文件，记录宿主能观察到的内容：
 * collabAgentToolCall / subAgentActivity 条目、子代理 thread ID、通知里出现的 thread 数量、
 * 审批请求是否来自子代理、token 用量是否分开上报。输出不含回复正文。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexCommand } from './discover.js';
import { JsonRpcStdioClient } from './json-rpc.js';

interface Item {
  type: string;
  id: string;
  tool?: string;
  status?: string;
  kind?: string;
  agentThreadId?: string;
  receiverThreadIds?: string[];
  agentsStates?: Record<string, { status: string }>;
}

const report: Record<string, unknown> = { probedAt: new Date().toISOString() };
const itemTypes = new Map<string, number>();
const collabCalls: { tool: string | undefined; status: string | undefined; receivers: number; agentStatuses: string[] }[] = [];
const activities: { kind: string | undefined; hasAgentThreadId: boolean }[] = [];
const threadIds = new Set<string>();
const tokenUsageThreads = new Set<string>();
const approvals: { threadId: string | undefined }[] = [];

async function main(): Promise<void> {
  const cmd = resolveCodexCommand(process.env.PALDOCK_CODEX_PATH);
  if (!cmd) throw new Error('未找到 codex');
  let mainThread = '';
  let finish: (status: string) => void = () => {};
  const finished = new Promise<string>((resolve) => (finish = resolve));

  const rpc = new JsonRpcStdioClient(cmd.command, [...cmd.prefixArgs, 'app-server', '--listen', 'stdio://'], {
    onNotification: (method, raw) => {
      const params = raw as { threadId?: string; item?: Item; turn?: { status: string } };
      if (params.threadId) threadIds.add(params.threadId);
      if (method === 'thread/tokenUsage/updated' && params.threadId) tokenUsageThreads.add(params.threadId);
      if (method === 'item/completed' && params.item) {
        const item = params.item;
        itemTypes.set(item.type, (itemTypes.get(item.type) ?? 0) + 1);
        if (item.type === 'collabAgentToolCall') {
          collabCalls.push({
            tool: item.tool,
            status: item.status,
            receivers: item.receiverThreadIds?.length ?? 0,
            agentStatuses: Object.values(item.agentsStates ?? {}).map((s) => s.status),
          });
        }
        if (item.type === 'subAgentActivity') activities.push({ kind: item.kind, hasAgentThreadId: !!item.agentThreadId });
      }
      if (method === 'turn/completed' && params.threadId === mainThread) finish(params.turn?.status ?? 'unknown');
    },
    onServerRequest: async (_method, raw) => {
      approvals.push({ threadId: (raw as { threadId?: string }).threadId });
      return { decision: 'decline' };
    },
  });

  const cwd = mkdtempSync(join(tmpdir(), 'paldock-codex-subagent-'));
  writeFileSync(join(cwd, 'note.txt'), 'PalDock 子代理探测文件');
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'paldock_probe', title: 'PalDock P0 probe', version: '0.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    rpc.notify('initialized');
    const started = await rpc.request<{ thread: { id: string } }>('thread/start', {
      cwd,
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
    });
    mainThread = started.thread.id;
    const begin = Date.now();
    await rpc.request('turn/start', {
      threadId: mainThread,
      input: [
        {
          type: 'text',
          text: '请务必使用子代理（spawn agent）完成：让一个子代理读取当前目录的 note.txt 并把内容告诉你，等它完成后你用一句话汇报。不要自己直接读文件。',
          text_elements: [],
        },
      ],
    });
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 300_000));
    report.turnStatus = await Promise.race([finished, timeout]);
    report.ms = Date.now() - begin;
  } finally {
    await rpc.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
  Object.assign(report, {
    itemTypes: Object.fromEntries(itemTypes),
    collabCalls,
    activities,
    threadsInNotifications: threadIds.size,
    tokenUsageReportedForThreads: tokenUsageThreads.size,
    approvalsFromSubagent: approvals.filter((a) => a.threadId && a.threadId !== mainThread).length,
    approvalsTotal: approvals.length,
  });
}

main()
  .catch((error: Error) => {
    report.error = error.message;
  })
  .finally(() => console.log(JSON.stringify(report, null, 2)));
