import { isAbsolute, resolve } from 'node:path';
import type { RuntimeWrite, RuntimeApprovalDecision, RuntimeApprovalRequest, RuntimeEvent, RuntimeUsage, TurnCheck } from '@paldock/contracts';

/**
 * Claude Code CLI stream-json → PalDock 运行时契约的纯函数映射（Claude Code 2.1.325）。
 * 审批是按工具名的 `can_use_tool`，这里按工具归到与 Codex 相同的三类请求，风险分级沿用 risk.ts。
 */

export type ClaudeMessage = Record<string, unknown> & { type: string; subtype?: string };

/** 摘要和细节只用于展示，截断防止超长命令撑爆界面与数据库。 */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const str = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : undefined);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** 写文件的工具 → 参数里的路径字段。 */
const FILE_TOOLS: Readonly<Record<string, string>> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

/**
 * `can_use_tool` → 审批请求。Shell 工具按命令，写文件工具按路径（相对路径以 Run 的工作目录解析），
 * 其他工具（联网、MCP 等）一律按「扩展权限」处理，由策略引擎归为高风险。
 * 命令不带 cwd：Claude 的 Shell 会在多次调用之间保留 cd 后的目录，宿主并不知道当前目录。
 */
export function toApprovalRequest(toolName: string, input: Record<string, unknown>, nativeRequestId: string, cwd: string): RuntimeApprovalRequest {
  if (SHELL_TOOLS.has(toolName)) {
    const command = str(input.command) ?? '（未提供命令）';
    const reason = str(input.description);
    return { nativeRequestId, kind: 'command', summary: clip(command, 200), detail: clip(command, 4000), command, ...(reason ? { reason } : {}) };
  }
  const pathKey = FILE_TOOLS[toolName];
  if (pathKey) {
    const raw = str(input[pathKey]);
    const paths = raw ? [isAbsolute(raw) ? raw : resolve(cwd, raw)] : [];
    const writes = paths.length > 0 ? writesOf(toolName, input, paths[0]!) : [];
    return {
      nativeRequestId,
      kind: 'file_change',
      summary: paths.length > 0 ? `${toolName}：${clip(paths[0]!, 180)}` : `${toolName}：路径未知`,
      detail: clip(paths.join('\n'), 4000),
      paths,
      ...(writes.length > 0 ? { writes } : {}),
    };
  }
  return { nativeRequestId, kind: 'permissions', summary: clip(`使用工具 ${toolName}`, 200), detail: clip(JSON.stringify(input), 4000) };
}

/** 写文件请求的具体内容：Edit / MultiEdit 是替换前后的文本，Write 是全文（批准后作为写入证据）。 */
function writesOf(toolName: string, input: Record<string, unknown>, path: string): RuntimeWrite[] {
  if (toolName === 'Write') {
    const content = str(input.content);
    return content === undefined ? [] : [{ path, kind: 'content', detail: content }];
  }
  if (toolName === 'Edit') {
    const old = str(input.old_string);
    const next = str(input.new_string);
    return old === undefined || next === undefined ? [] : [{ path, kind: 'replace', detail: JSON.stringify({ old, new: next }) }];
  }
  if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    return (input.edits as Record<string, unknown>[]).flatMap((e) => {
      const old = str(e.old_string);
      const next = str(e.new_string);
      return old === undefined || next === undefined ? [] : [{ path, kind: 'replace' as const, detail: JSON.stringify({ old, new: next }) }];
    });
  }
  return [];
}

/** 审批决定 → `can_use_tool` 的响应体。批准时原样带回参数，不让执行器换成别的输入。 */
export function permissionResponse(decision: RuntimeApprovalDecision, input: Record<string, unknown>): unknown {
  if (decision === 'allow_once') return { behavior: 'allow', updatedInput: input };
  return { behavior: 'deny', message: decision === 'cancel' ? 'PalDock 已取消这次操作' : 'PalDock 拒绝了这次操作' };
}

interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** `result` 里的用量：优先按模型合计 `modelUsage`（含子代理），没有时退回主会话的 `usage`。 */
export function usageOf(result: ClaudeMessage): RuntimeUsage | undefined {
  const byModel = result.modelUsage as Record<string, ModelUsage> | undefined;
  const usage = result.usage as Record<string, unknown> | undefined;
  const models = byModel ? Object.values(byModel) : [];
  if (models.length === 0 && !usage) return undefined;
  const totals =
    models.length > 0
      ? models.reduce<Omit<RuntimeUsage, 'costUsd'>>(
          (sum, m) => ({
            inputTokens: sum.inputTokens + num(m.inputTokens),
            outputTokens: sum.outputTokens + num(m.outputTokens),
            cacheReadTokens: sum.cacheReadTokens + num(m.cacheReadInputTokens),
            cacheWriteTokens: sum.cacheWriteTokens + num(m.cacheCreationInputTokens),
          }),
          { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        )
      : {
          inputTokens: num(usage?.input_tokens),
          outputTokens: num(usage?.output_tokens),
          cacheReadTokens: num(usage?.cache_read_input_tokens),
          cacheWriteTokens: num(usage?.cache_creation_input_tokens),
        };
  return typeof result.total_cost_usd === 'number' ? { ...totals, costUsd: result.total_cost_usd } : totals;
}

/**
 * `result` → 终态事件。中断后 CLI 以 `error_during_execution` 结束（P0-02 实测），只有宿主确实发过中断时才算「已中断」；
 * `is_error` 为真时即使 subtype 是 success（例如 API 报错）也按失败处理。
 */
export function resultEvent(result: ClaudeMessage, interruptRequested: boolean): RuntimeEvent {
  const usage = usageOf(result);
  const withUsage = usage ? { usage } : {};
  if (result.subtype === 'success' && result.is_error !== true) {
    return { type: 'completed', finalMessage: str(result.result) ?? null, ...withUsage };
  }
  if (interruptRequested && result.subtype === 'error_during_execution') return { type: 'interrupted' };
  const errors = Array.isArray(result.errors) ? result.errors.filter((e): e is string => typeof e === 'string') : [];
  const message = str(result.result) ?? (errors.length > 0 ? errors.join('；') : `Claude Code 以 ${result.subtype ?? '未知状态'} 结束`);
  return { type: 'failed', message: clip(message, 2000), ...withUsage };
}

/** 中断后 CLI 写进会话记录的那条用户消息。 */
const INTERRUPT_MARKER = '[Request interrupted';

interface TranscriptEntry {
  type?: string;
  uuid?: string;
  isMeta?: boolean;
  message?: { content?: unknown; stop_reason?: unknown };
}

type Block = { type?: string; text?: unknown };
const blocks = (entry: TranscriptEntry): Block[] => {
  const content = entry.message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
};
const textOf = (entry: TranscriptEntry) =>
  blocks(entry)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
const isInterrupt = (entry: TranscriptEntry) => entry.type === 'user' && textOf(entry).startsWith(INTERRUPT_MARKER);
/** 用户新发的一句话（不是工具结果、不是中断标记），标志着上一个 turn 已经过去。 */
const isPrompt = (entry: TranscriptEntry) =>
  entry.type === 'user' && !entry.isMeta && !isInterrupt(entry) && blocks(entry).every((b) => b.type !== 'tool_result');

/**
 * 从会话记录（`<配置目录>/projects/<目录>/<session_id>.jsonl`）核对某个 turn：turn ID 是宿主发出的那条用户消息的 uuid。
 * 只看这条消息之后、下一句用户消息之前的记录；最后一条是没有工具调用的助手回复才算完成，
 * 其余情况（还在调工具、只写到一半）返回 in_progress，交给应用层多次核对后再定。
 * 会话记录里没有 result，所以「失败」核对不出来，只能落到 in_progress。
 */
export function turnCheckFromTranscript(lines: readonly string[], turnId: string): TurnCheck {
  const entries = lines.flatMap((line): TranscriptEntry[] => {
    try {
      const entry = JSON.parse(line) as unknown;
      return typeof entry === 'object' && entry !== null ? [entry as TranscriptEntry] : [];
    } catch {
      return [];
    }
  });
  const start = entries.findIndex((e) => e.uuid === turnId);
  if (start < 0) return { status: 'not_found' };
  const rest = entries.slice(start + 1).filter((e) => e.type === 'user' || e.type === 'assistant');
  const end = rest.findIndex(isPrompt);
  const turn = end < 0 ? rest : rest.slice(0, end);
  if (turn.some(isInterrupt)) return { status: 'interrupted' };
  const last = turn.at(-1);
  if (last?.type === 'assistant' && last.message?.stop_reason !== 'tool_use' && blocks(last).every((b) => b.type !== 'tool_use')) {
    return { status: 'completed', finalMessage: textOf(last) || null };
  }
  return { status: 'in_progress' };
}
