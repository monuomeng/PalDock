/**
 * P0-07 Claude 子代理探测：`node packages/runtime-claude/dist/subagent-probe.js`（会消耗少量额度）
 *
 * 要求主会话用原生子代理（Task / Agent 工具）读取临时目录里的文件，记录宿主能观察到的内容：
 * 子代理工具调用、带 parent_tool_use_id 的子代理消息、子代理内的权限请求、结果里的用量与费用字段。
 * 输出不含回复正文。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSession, isResult, resolveClaude, type Message } from './session.js';

interface ContentBlock {
  type: string;
  name?: string;
}

const report: Record<string, unknown> = { probedAt: new Date().toISOString() };

async function main(): Promise<void> {
  const exe = resolveClaude();
  if (!exe) throw new Error('未找到 claude');
  const cwd = mkdtempSync(join(tmpdir(), 'paldock-claude-subagent-'));
  writeFileSync(join(cwd, 'note.txt'), 'PalDock 子代理探测文件');
  const session = new ClaudeSession(exe, cwd, ['--forward-subagent-text']);

  const toolUses = new Map<string, number>();
  let subagentMessages = 0;
  const subagentMessageTypes = new Set<string>();
  session.subscribe((m: Message) => {
    const parent = m.parent_tool_use_id;
    if (typeof parent === 'string' && parent) {
      subagentMessages++;
      subagentMessageTypes.add(m.type);
    }
    if (m.type !== 'assistant') return;
    const content = (m.message as { content?: ContentBlock[] } | undefined)?.content ?? [];
    for (const block of content) {
      if (block.type === 'tool_use') toolUses.set(block.name ?? '?', (toolUses.get(block.name ?? '?') ?? 0) + 1);
    }
  });

  try {
    const begin = Date.now();
    const result = session.waitFor(isResult, 300_000);
    session.send('请务必使用子代理（Task / Agent 工具）完成：让一个子代理读取当前目录的 note.txt 并把内容告诉你，然后你用一句话汇报。不要自己直接读文件。');
    const done = await result;
    Object.assign(report, {
      subtype: done.subtype,
      ms: Date.now() - begin,
      toolUses: Object.fromEntries(toolUses),
      subagentMessages,
      subagentMessageTypes: [...subagentMessageTypes],
      permissionRequests: session.permissionRequests,
      resultHasUsage: typeof done.usage === 'object',
      resultHasCost: typeof done.total_cost_usd === 'number',
      resultHasModelUsage: typeof done.modelUsage === 'object',
      numTurns: done.num_turns,
    });
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
