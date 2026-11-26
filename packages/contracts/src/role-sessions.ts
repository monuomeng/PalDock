/**
 * 角色会话（2026-11-26 已定）：每个（项目，角色，执行器）维护长期的原生会话，新的子任务和新一轮审阅在里面开新 turn，
 * 不再每次新建原生会话。并行用同角色的会话池（大小为角色的 maxConcurrency）。用久了轮换：先写角色摘要，再换新会话。
 */
export const ROLE_SESSION_STATUSES = ['idle', 'busy', 'retired'] as const;
export type RoleSessionStatus = (typeof ROLE_SESSION_STATUSES)[number];

export interface RoleSessionRecord {
  id: string;
  workspaceId: string;
  role: string;
  executor: string;
  /** 原生会话 ID；新建后第一轮拿到。 */
  nativeThreadId: string | null;
  status: RoleSessionStatus;
  /** 在这个会话里跑过的 turn 数和累计 token（输入 + 输出 + 缓存），用于轮换。 */
  turns: number;
  tokens: number;
  /** 换下这个会话前写的角色摘要（项目约定、常用命令、踩过的坑）；新会话首轮注入。 */
  summary: string | null;
  /** 达到轮换阈值：下一轮要求先写摘要，结束后换掉。 */
  retireRequested: boolean;
  /** 换下后已在执行器里归档（Codex thread/archive）。 */
  archived: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  retiredAt: string | null;
}

export interface RoleSessionKey {
  workspaceId: string;
  role: string;
  executor: string;
}

export interface RoleSessionStorePort {
  /** 没换下的会话（空闲或在用）。 */
  open(key: RoleSessionKey): RoleSessionRecord[];
  get(id: string): RoleSessionRecord | undefined;
  /** 新建并直接占用。 */
  create(key: RoleSessionKey): RoleSessionRecord;
  /** 占用一个空闲会话；已被占用或已换下时返回 undefined。 */
  lease(id: string): RoleSessionRecord | undefined;
  /** 用完放回：累计 turn 和 token；已换下的保持换下。 */
  release(id: string, tokens: number): RoleSessionRecord | undefined;
  setThread(id: string, threadId: string): void;
  requestRetire(id: string): void;
  retire(id: string): void;
  setSummary(id: string, summary: string): void;
  markArchived(id: string): void;
  /** 同一组合最近写下的角色摘要（新会话首轮注入）。 */
  latestSummary(key: RoleSessionKey): string | null;
  /** 服务启动：上次没放回的（服务被关掉时在用的）全部放回空闲。 */
  releaseAll(): void;
}
