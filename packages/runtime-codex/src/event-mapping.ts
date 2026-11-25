import type { RuntimeApprovalDecision, RuntimeApprovalRequest, RuntimeEvent, RuntimeUsage, TurnCheck } from '@paldock/contracts';

/**
 * Codex app-server 协议 → PalDock 运行时契约的纯函数映射（codex-cli 0.166 的 v2 协议，
 * 字段以 `codex app-server generate-ts` 生成的类型为准）。
 */

export interface CodexTurn {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  items?: { type: string; text?: string }[];
  error?: { message: string } | null;
}

/** 摘要和细节只用于展示，截断防止超长命令撑爆界面与数据库。 */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

interface CommandParams {
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
}
interface FileChangeParams {
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}
interface PermissionsParams {
  cwd?: string;
  reason?: string | null;
  permissions?: { network?: unknown; fileSystem?: unknown };
}

const optional = <K extends string, V>(key: K, value: V | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

/**
 * 把执行器的服务端请求转成审批请求；不是审批类的请求返回 undefined，由调用方回错误。
 * fileChanges 是此前 item/started 里记录的 fileChange 条目路径（审批请求本身不带路径）。
 */
export function toApprovalRequest(
  method: string,
  raw: unknown,
  nativeRequestId: string,
  fileChanges: ReadonlyMap<string, string[]>,
): RuntimeApprovalRequest | undefined {
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const p = raw as CommandParams;
      const command = p.command ?? '（未提供命令）';
      return {
        nativeRequestId,
        kind: 'command',
        summary: clip(command, 200),
        detail: clip(command, 4000),
        command,
        ...optional('cwd', p.cwd),
        ...optional('reason', p.reason),
      };
    }
    case 'item/fileChange/requestApproval': {
      const p = raw as FileChangeParams;
      const paths = fileChanges.get(p.itemId) ?? [];
      // grantRoot 表示要求放开整个目录的写权限，路径不明确时一律按目录外处理
      const all = p.grantRoot ? [...paths, p.grantRoot] : paths;
      return {
        nativeRequestId,
        kind: 'file_change',
        summary: all.length > 0 ? `修改 ${all.length} 个文件` : '修改文件（路径未知）',
        detail: clip(all.join('\n'), 4000),
        paths: all,
        ...optional('reason', p.reason),
      };
    }
    case 'item/permissions/requestApproval': {
      const p = raw as PermissionsParams;
      const wanted = [p.permissions?.network ? '联网' : null, p.permissions?.fileSystem ? '额外的文件系统访问' : null].filter(Boolean);
      return {
        nativeRequestId,
        kind: 'permissions',
        summary: `请求扩展权限：${wanted.join('、') || '未说明'}`,
        detail: clip(JSON.stringify(p.permissions ?? {}), 4000),
        ...optional('cwd', p.cwd),
        ...optional('reason', p.reason),
      };
    }
    default:
      return undefined;
  }
}

/**
 * 审批决定 → 协议响应。权限扩展请求的响应没有「拒绝」字段，拒绝即授予空权限、只限本 turn；
 * P1 不开放权限扩展，即使收到 allow_once 也按拒绝处理。
 */
export function approvalResponse(kind: RuntimeApprovalRequest['kind'], decision: RuntimeApprovalDecision): unknown {
  if (kind === 'permissions') return { permissions: {}, scope: 'turn' };
  return { decision: decision === 'allow_once' ? 'accept' : decision === 'cancel' ? 'cancel' : 'decline' };
}

const agentText = (turn: CodexTurn) =>
  turn.items?.filter((i) => i.type === 'agentMessage' && typeof i.text === 'string').at(-1)?.text ?? null;

/** turn/completed → 终态事件；与核对共用一套状态映射，流式期间记下的最后一条回复优先。 */
export function finalTurnEvent(turn: CodexTurn, lastAgentMessage: string | null, usage?: RuntimeUsage): RuntimeEvent {
  const check = toTurnCheck(turn);
  const withUsage = usage ? { usage } : {};
  switch (check.status) {
    case 'completed':
      return { type: 'completed', finalMessage: lastAgentMessage ?? check.finalMessage, ...withUsage };
    case 'failed':
      return { type: 'failed', message: check.message, ...withUsage };
    case 'interrupted':
      return { type: 'interrupted' };
    default:
      return { type: 'disconnected', message: `turn 以未知状态结束：${turn.status}` };
  }
}

/** thread/read 里找到的 turn → 核对结果；找不到就是 not_found，不拿别的 turn 顶替。 */
export function toTurnCheck(turn: CodexTurn | undefined): TurnCheck {
  if (!turn) return { status: 'not_found' };
  switch (turn.status) {
    case 'completed':
      return { status: 'completed', finalMessage: agentText(turn) };
    case 'interrupted':
      return { status: 'interrupted' };
    case 'failed':
      return { status: 'failed', message: turn.error?.message ?? 'turn 失败' };
    default:
      return { status: 'in_progress' };
  }
}

/** `thread/tokenUsage/updated` 里的一组计数（app-server v2 的 TokenUsageBreakdown）。 */
export interface CodexTokenBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
}

/**
 * 一次 Run 的 Codex 用量。`total` 是整个 thread 的累计（续做的 thread 含以前各次 Run），
 * 同一份累计也可能重复上报，所以按 thread 记「本次第一次见到之前的基数」和最新累计，取差值；
 * 同一连接上的子代理 thread 一并合计（P0 已确认按 thread 分开上报）。
 * 口径与 Claude 对齐：`inputTokens` 不含缓存命中部分，缓存命中记到 `cacheReadTokens`。
 */
export class CodexUsageMeter {
  private readonly threads = new Map<string, { base: CodexTokenBreakdown; latest: CodexTokenBreakdown }>();

  update(threadId: string, tokenUsage: { total?: CodexTokenBreakdown; last?: CodexTokenBreakdown } | undefined): void {
    const total = tokenUsage?.total;
    if (!total) return;
    const known = this.threads.get(threadId);
    if (known) known.latest = total;
    else this.threads.set(threadId, { base: minus(total, tokenUsage.last), latest: total });
  }

  usage(): RuntimeUsage | undefined {
    if (this.threads.size === 0) return undefined;
    const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const { base, latest } of this.threads.values()) {
      const d = minus(latest, base);
      sum.inputTokens += Math.max(0, d.inputTokens - d.cachedInputTokens);
      sum.cacheReadTokens += d.cachedInputTokens;
      sum.cacheWriteTokens += d.cacheWriteInputTokens ?? 0;
      sum.outputTokens += d.outputTokens;
    }
    return sum;
  }
}

function minus(a: CodexTokenBreakdown, b: CodexTokenBreakdown | undefined): CodexTokenBreakdown {
  const n = (x: number | undefined) => (Number.isFinite(x) ? (x as number) : 0);
  return {
    inputTokens: Math.max(0, n(a.inputTokens) - n(b?.inputTokens)),
    cachedInputTokens: Math.max(0, n(a.cachedInputTokens) - n(b?.cachedInputTokens)),
    cacheWriteInputTokens: Math.max(0, n(a.cacheWriteInputTokens) - n(b?.cacheWriteInputTokens)),
    outputTokens: Math.max(0, n(a.outputTokens) - n(b?.outputTokens)),
  };
}
