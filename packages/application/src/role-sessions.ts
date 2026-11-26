import type { RoleSessionKey, RoleSessionRecord, StorePort } from '@paldock/contracts';
import { P3_DEFAULTS } from '@paldock/domain';
import { errorText } from './util.js';

export interface RoleSessionPoolDeps {
  store: StorePort;
  /** 换下的会话在执行器里归档（Codex thread/archive）；执行器不支持时为空。 */
  archive?: (executor: string, threadId: string) => Promise<void> | undefined;
  log: (message: string) => void;
  limits?: { roleSessionMaxTurns: number; roleSessionMaxTokens: number };
}

/** 一次占用：会话本身，以及这一轮是不是换下前写摘要的那一轮。 */
export interface RoleSessionLease {
  session: RoleSessionRecord;
  /** 这一轮结束后换下会话（这一轮要求先写角色摘要）。 */
  summaryTurn: boolean;
}

/**
 * 角色会话池（2026-11-26 已定）：每个（项目，角色，执行器）一组长期原生会话，计划节点的工作 Run 和审阅 Run 在里面开新 turn。
 * 同一会话同一时刻只跑一个 turn；并行时按需新建，池大小不超过角色的 maxConcurrency（满了由监管器排队）。
 * 开发和审阅是不同角色，天然在不同的池里。跑满 turn 数或 token 阈值后，下一轮先写摘要，结束后换下并归档；
 * 新会话首轮注入最近的角色摘要。续用失败（会话没了、执行器换了）直接换下，由调用方开新会话重试。
 */
export class RoleSessionPool {
  private readonly limits: { roleSessionMaxTurns: number; roleSessionMaxTokens: number };

  constructor(private readonly deps: RoleSessionPoolDeps) {
    this.limits = deps.limits ?? P3_DEFAULTS;
  }

  /** 服务启动：上次没放回的会话放回空闲（那些 Run 已被中断）。 */
  start(): void {
    this.deps.store.roleSessions.releaseAll();
  }

  /** 有空闲会话，或者还能新建。 */
  hasRoom(key: RoleSessionKey, max: number): boolean {
    const open = this.deps.store.roleSessions.open(key);
    return open.some((s) => s.status === 'idle') || open.length < Math.max(1, max);
  }

  /** 占用一个会话：优先上次用过的那个原生会话（返工、续做），其次最近用过的空闲会话，都没有就新建。 */
  acquire(key: RoleSessionKey, preferThreadId?: string): RoleSessionLease {
    const { roleSessions } = this.deps.store;
    const idle = roleSessions.open(key).filter((s) => s.status === 'idle');
    const ordered = [...idle.filter((s) => preferThreadId && s.nativeThreadId === preferThreadId), ...idle];
    for (const candidate of ordered) {
      const session = roleSessions.lease(candidate.id);
      if (session) return { session, summaryTurn: session.retireRequested };
    }
    return { session: roleSessions.create(key), summaryTurn: false };
  }

  /** 新会话首轮注入的摘要（同一组合最近换下的会话写的）。 */
  inheritedSummary(key: RoleSessionKey): string | null {
    return this.deps.store.roleSessions.latestSummary(key);
  }

  recordThread(lease: RoleSessionLease, threadId: string): void {
    if (lease.session.nativeThreadId === threadId) return;
    this.deps.store.roleSessions.setThread(lease.session.id, threadId);
    lease.session = { ...lease.session, nativeThreadId: threadId };
  }

  /** 这一轮结束：累计用量；写摘要的那一轮结束后换下，否则到了阈值就标记下一轮写摘要。 */
  release(lease: RoleSessionLease, tokens: number): void {
    const { roleSessions } = this.deps.store;
    const session = roleSessions.release(lease.session.id, tokens);
    if (!session || session.status === 'retired') return;
    if (lease.summaryTurn) return this.retire(session);
    if (session.turns >= this.limits.roleSessionMaxTurns || session.tokens >= this.limits.roleSessionMaxTokens) roleSessions.requestRetire(session.id);
  }

  /** 续用失败：这个会话换下（不再续用），调用方开新会话。 */
  abandon(lease: RoleSessionLease): void {
    this.retire(lease.session);
  }

  /** 角色摘要：写在当前会话上，换新会话时注入。 */
  writeSummary(sessionId: string, summary: string): void {
    this.deps.store.roleSessions.setSummary(sessionId, summary);
  }

  private retire(session: RoleSessionRecord): void {
    this.deps.store.roleSessions.retire(session.id);
    const threadId = session.nativeThreadId;
    if (!threadId) return;
    const archived = this.deps.archive?.(session.executor, threadId);
    // 不支持归档的执行器（Claude）只留记录
    archived
      ?.then(() => this.deps.store.roleSessions.markArchived(session.id))
      .catch((error) => this.deps.log(`archive ${session.executor} thread failed: ${errorText(error)}`));
  }
}
