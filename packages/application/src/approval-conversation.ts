import { createHash } from 'node:crypto';
import {
  CodedError,
  type ApprovalChannel,
  type ApprovalDecision,
  type ApprovalRecord,
  type ChannelProvider,
  type GitOpRecord,
  type MainSessionRecord,
  type PersistentEvent,
  type QuestionItem,
  type QuestionRecord,
  type StorePort,
} from '@paldock/contracts';
import { canApproveRemotely, notAConsent, P1_DEFAULTS } from '@paldock/domain';
import type { GitOpsService } from './git-ops.js';
import { nodeTitle } from './task-graph-scheduler.js';
import { errorText } from './util.js';

export interface ApprovalConversationDeps {
  store: StorePort;
  publish(events: PersistentEvent[]): void;
  log(message: string): void;
  supervisor: { forwardDecision(approval: ApprovalRecord, decision: ApprovalDecision): void };
  gitOps?: () => GitOpsService | undefined;
  /** 让协调助手的会话尽快处理排着的唤醒。 */
  poke(sessionId: string): void;
  limits?: Partial<{ askDebounceMs: number; hostFallbackMs: number }>;
}

/** 审批唤醒的摘要以这个开头：不受任务事件唤醒的频率限制（等你决定的事不能拖）。 */
export const ASK_WAKE_MARK = '【需要用户决定】';

type Pending = { kind: 'approval'; approval: ApprovalRecord } | { kind: 'gitop'; op: GitOpRecord };

/** 一项的说明、目标、是否高影响。 */
interface Described {
  ref: string;
  kind: 'approval' | 'gitop';
  version: number;
  matter: string;
  label: string;
  target: string | null;
  highImpact: boolean;
  sensitive: boolean;
  /** 提交卡片默认勾选的块。 */
  hunkIds?: string[];
  who: string;
}

/**
 * 协调助手在发起的对话里找你批（2026-11-26 你同意，0.3.8，plan.md 第 16 节）：
 * - 需要你决定的审批和 Git 卡片，按来源会话聚合（约 3 秒）成一次协调助手唤醒；它用 suggest_decision 登记问题，问题发在原对话里；
 * - 每个对话同一时刻只有一个问题，新事项排在后面；问题只能在回应你的回合里改写，而且只能缩小范围；
 * - 你回复后它用 resolve_approvals 把决定交给宿主：宿主核对你那条消息、原话、问题里的项、版本和渠道权限后执行；
 * - 问题下面的按钮直接由宿主执行；文字回复、按钮、外部渠道重投共用同一次决定（问题带版本，先到者为准）；
 * - 单人模式（发起请求的就是主会话自己）、协调助手 20 秒内没发出问题时，宿主自己在对话里发问题。
 */
export class ApprovalConversation {
  private readonly askTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private readonly askDebounceMs: number;
  private readonly hostFallbackMs: number;

  constructor(private readonly deps: ApprovalConversationDeps) {
    this.askDebounceMs = deps.limits?.askDebounceMs ?? P1_DEFAULTS.approvalGroupMs;
    this.hostFallbackMs = deps.limits?.hostFallbackMs ?? 20_000;
  }

  private get store() {
    return this.deps.store;
  }

  stop(): void {
    this.stopped = true;
    for (const t of [...this.askTimers.values(), ...this.fallbackTimers.values()]) clearTimeout(t);
    this.askTimers.clear();
    this.fallbackTimers.clear();
  }

  // ---- 事件 ----

  onEvents(events: readonly PersistentEvent[]): void {
    for (const event of events) {
      try {
        this.onEvent(event);
      } catch (error) {
        this.deps.log(`approval conversation ${event.type} failed: ${errorText(error)}`);
      }
    }
  }

  private onEvent(event: PersistentEvent): void {
    const { store } = this;
    switch (event.type) {
      case 'approval.requested':
      case 'approval.routed': {
        const approval = store.runs.getApproval(event.aggregateId);
        if (!approval || approval.status !== 'pending' || approval.routedTo) return;
        const session = this.sourceSession(approval);
        if (session) this.later(session.sessionId);
        return;
      }
      case 'git.proposed':
        if (event.payload.sessionId && event.payload.kind !== 'index') this.later(event.payload.sessionId);
        return;
      case 'approval.decided': {
        const approval = store.runs.getApproval(event.aggregateId);
        if (approval?.questionId) this.syncQuestion(approval.questionId);
        return;
      }
      case 'git.finished':
        for (const q of store.questions.allOpen()) if (q.items.some((i) => i.ref === event.aggregateId)) this.syncQuestion(q.id);
        return;
      case 'question.closed':
        this.later(event.payload.sessionId);
        return;
      default:
        return;
    }
  }

  /** 问题里的项都在别处处理完了（桌面审批卡、过期、Git 卡片作废）：问题作废，按钮失效。 */
  private syncQuestion(questionId: string): void {
    const q = this.store.questions.get(questionId);
    if (!q || q.status !== 'open') return;
    if (q.items.some((item) => this.isPending(item.ref, item.kind))) return;
    this.deps.publish(this.store.questions.close(q.id, q.version, 'void', '这些事项已经在别处处理了', q.items.map((i) => i.ref)).events);
  }

  // ---- 排队与唤醒 ----

  private later(sessionId: string): void {
    if (this.stopped || this.askTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.askTimers.delete(sessionId);
      try {
        this.review(sessionId);
      } catch (error) {
        this.deps.log(`approval review ${sessionId} failed: ${errorText(error)}`);
      }
    }, this.askDebounceMs);
    timer.unref();
    this.askTimers.set(sessionId, timer);
  }

  /** 这个会话里还没问过、等你决定的事项（审批按请求时间，Git 卡片按提出时间）。 */
  pendingOf(sessionId: string): Pending[] {
    const { store } = this;
    const session = store.coordinator.getMainSession(sessionId);
    if (!session) return [];
    const approvals = store.runs
      .pendingApprovalsOfWorkspace(session.workspaceId)
      .filter((a) => !a.routedTo && !a.questionId && this.sourceSession(a)?.sessionId === sessionId)
      .map((approval) => ({ kind: 'approval' as const, approval }));
    const asked = new Set(store.questions.allOpen().flatMap((q) => q.items.map((i) => i.ref)));
    const ops = store.git
      .openOps(session.workspaceId)
      .filter((op) => op.sessionId === sessionId && op.kind !== 'index' && !asked.has(op.id))
      .map((op) => ({ kind: 'gitop' as const, op }));
    return [...approvals, ...ops];
  }

  /** 会话空着（没有在问的问题）时，把排着的事项交给协调助手问；它问不了（单人模式里就是它在等）时宿主自己问。 */
  private review(sessionId: string): void {
    if (this.stopped) return;
    const { store } = this;
    if (store.questions.openOf(sessionId)) return;
    const session = store.coordinator.getMainSession(sessionId);
    const pending = this.pendingOf(sessionId);
    if (!session || pending.length === 0) return;
    const described = pending.map((p) => this.describe(p));
    // 单人模式（或协调助手自己的读取）：发起请求的就是主会话自己，它在等审批、没法开口
    const selfBlocked = pending.some((p) => p.kind === 'approval' && this.runSubtask(p.approval.runId) === session.subtaskId);
    if (selfBlocked) return void this.hostQuestion(session, firstMatter(described));
    const ids = described.map((d) => d.ref).sort().join(',');
    const key = `ask:${sessionId}:${createHash('sha1').update(ids).digest('hex').slice(0, 16)}`;
    const wake = store.coordinator.addWake({ sessionId, trigger: 'task_event', dedupeKey: key, summary: `${ASK_WAKE_MARK}${this.wakeText(described)}` });
    if (wake) {
      this.deps.publish(wake.events);
      this.deps.poke(sessionId);
    }
    // 协调助手在忙或不可用：20 秒内没发出问题，宿主自己问
    if (!this.fallbackTimers.has(sessionId)) {
      const timer = setTimeout(() => {
        this.fallbackTimers.delete(sessionId);
        if (this.stopped || store.questions.openOf(sessionId)) return;
        const still = this.pendingOf(sessionId).map((p) => this.describe(p));
        if (still.length > 0) this.hostQuestion(session, firstMatter(still));
      }, this.hostFallbackMs);
      timer.unref();
      this.fallbackTimers.set(sessionId, timer);
    }
  }

  /** 给协调助手的唤醒内容：每件事的各项（编号、发起者、目标、风险），只展开影响决定的差异（同一目录的归在一起）。 */
  private wakeText(items: Described[]): string {
    const matters = new Map<string, Described[]>();
    for (const d of items) {
      const list = matters.get(d.matter);
      if (list) list.push(d);
      else matters.set(d.matter, [d]);
    }
    const blocks = [...matters.values()].map((list, i) => {
      const head = `事项 ${i + 1}（${list[0]!.who}）：`;
      const lines = list.map((d) => `- ${d.ref}：${d.label}${d.highImpact ? `（高影响，问题里要写明目标：${d.target ?? d.label}）` : ''}${d.hunkIds ? `（默认提交的块：${d.hunkIds.join('、')}）` : ''}`);
      const dirs = groupDirs(list.map((d) => d.target ?? '').filter(Boolean));
      return [head, ...lines, ...(dirs ? [`差异：${dirs}`] : [])].join('\n');
    });
    return (
      `有 ${items.length} 项等用户决定。\n${blocks.join('\n')}\n` +
      '请用 suggest_decision 在这个对话里问用户，一次只问一件事：用一两句话说清哪个助手在做什么、为什么需要他决定、你建议怎么处理；' +
      '多项时先汇总，只展开影响决定的差异。推送、合并、敏感路径、项目外写入要在问题里写明目标。问完就结束这一轮，等他回复。' +
      '这一轮只能解释、登记问题，不要做别的。'
    );
  }

  /** 宿主自己发问题（单人模式、协调助手没发出问题）：在对话里发一条说明，带按钮。 */
  private hostQuestion(session: MainSessionRecord, items: Described[]): QuestionRecord | undefined {
    const { store } = this;
    if (items.length === 0 || store.questions.openOf(session.sessionId)) return undefined;
    const who = items[0]!.who;
    const text =
      `${who}在等你决定：${items.map((d) => d.label).join('；')}。` +
      (items.some((d) => d.sensitive) ? '其中有敏感路径（凭据、密钥之类），只能由你批。' : '') +
      '可以点下面的按钮，也可以直接回复。';
    return this.createQuestion(session, null, 'host', text, items.map((d) => toItem(d, d.kind === 'gitop' ? 'confirm' : 'allow')));
  }

  private createQuestion(session: MainSessionRecord, runId: string | null, author: 'coordinator' | 'host', text: string, items: QuestionItem[]): QuestionRecord {
    const { store } = this;
    const external = store.channels.conversationOfMainSession(session.sessionId);
    const { record, events } = store.transaction(() => {
      const message = store.messages.append(session.sessionId, author === 'host' ? 'system' : 'assistant', text, runId);
      const q = store.questions.create({ sessionId: session.sessionId, runId, messageId: message.record.id, author, text, items, delivery: external ? 'pending' : 'desktop' });
      return { record: q.record, events: [...message.events, ...q.events] };
    });
    this.deps.publish(events);
    return record;
  }

  // ---- 协调助手的工具 ----

  /** suggest_decision：登记问题。对话里已经有问题时，只能在回应你的回合里缩小它的范围；新事项排在后面。 */
  suggest(runId: string, text: string, input: { ref: string; decision: QuestionItem['decision']; hunkIds?: string[] | undefined }[]): { questionId: string; next: string } {
    const { store } = this;
    const { session, wake } = this.coordinatorTurn(runId);
    const open = store.questions.openOf(session.sessionId);
    if (open) {
      const inOpen = new Set(open.items.map((i) => i.ref));
      if (wake.trigger !== 'user_message' || !input.every((i) => inOpen.has(i.ref))) {
        throw new CodedError('bad_request', '这个对话里已经有一个问题在等用户回答；新的事项排在后面，等这个问题解决后再问。只有在回应用户的这一轮里，才能把当前问题改成范围更小的版本');
      }
    }
    if (input.length === 0) throw new CodedError('bad_request', '问题里至少要有一项');
    const described = input.map((i) => {
      const found = this.find(i.ref);
      if (!found || this.sourceSessionOf(found)?.sessionId !== session.sessionId) throw new CodedError('bad_request', `${i.ref} 不是这个对话里等用户决定的事项`);
      if (!this.isPending(i.ref, found.kind)) throw new CodedError('bad_request', `${i.ref} 已经处理过了`);
      return { input: i, d: this.describe(found) };
    });
    if (new Set(described.map((x) => x.d.matter)).size > 1) throw new CodedError('bad_request', '一个问题只能涉及一件事（同一类审批，或一张 Git 卡片）；不同的事请分开问');
    for (const { input: i, d } of described) {
      const okDecision = d.kind === 'approval' ? i.decision === 'allow' || i.decision === 'deny' : i.decision === 'confirm' || i.decision === 'cancel';
      if (!okDecision) throw new CodedError('bad_request', `${i.ref} 的建议只能是 ${d.kind === 'approval' ? 'allow / deny' : 'confirm / cancel'}`);
      // 敏感路径在外部会话里不写路径（卡片只说要到电脑上确认），所以只在桌面对话里要求写明
      const external = !!store.channels.conversationOfMainSession(session.sessionId);
      if (d.highImpact && d.target && !(d.sensitive && external) && !mentions(text, d.target)) throw new CodedError('bad_request', `问题里要写明目标：${d.target}`);
      if (i.hunkIds && !d.hunkIds) throw new CodedError('bad_request', `${i.ref} 不是提交卡片，不能指定改动块`);
    }
    if (open) this.deps.publish(store.questions.close(open.id, open.version, 'replaced', '协调助手按你的回复改写了问题', []).events);
    const items = described.map(({ input: i, d }) => toItem(d, i.decision, i.hunkIds ?? d.hunkIds));
    const q = this.createQuestion(session, runId, 'coordinator', text, items);
    return { questionId: q.id, next: '问题已经发在对话里（带按钮），等用户回复；不要再重复这段话，结束这一轮' };
  }

  /**
   * resolve_approvals：把你的决定交给宿主。宿主只在这一轮是你的新消息触发、消息在问题之后、原话核对上、
   * 各项都在问题里且还在等待、渠道有权限时执行；部分决定时问题照样结束，剩下的回到队列。
   */
  async resolve(
    runId: string,
    input: { questionId: string; items: { ref: string; decision: QuestionItem['decision']; hunkIds?: string[] | undefined }[]; userMessageId: number; decisionQuote: string },
  ): Promise<{ results: string[]; remaining: string[]; next: string }> {
    const { store } = this;
    const { session, wake } = this.coordinatorTurn(runId);
    if (wake.trigger !== 'user_message') throw new CodedError('bad_request', '只有在用户发来新消息的这一轮里才能交决定');
    const q = store.questions.get(input.questionId);
    if (!q || q.sessionId !== session.sessionId) throw new CodedError('not_found', '这个对话里没有这个问题');
    if (q.status !== 'open') throw new CodedError('conflict', `这个问题已经${q.status === 'replaced' ? '被改写' : '处理过'}了`);
    const message = store.messages.get(input.userMessageId);
    if (!message || message.sessionId !== session.sessionId || message.role !== 'user') throw new CodedError('bad_request', 'userMessageId 不是用户在这个对话里的消息');
    if (message.createdAt < q.createdAt) throw new CodedError('bad_request', '这条消息早于问题，不能当作对问题的回答');
    // 触发这一轮的消息在这一轮开始之前写入（和唤醒同一事务）；这一轮开始之后才来的消息属于下一轮
    if (message.createdAt > (wake.startedAt ?? wake.createdAt)) throw new CodedError('bad_request', '这条消息不是触发这一轮的那条');
    const quote = input.decisionQuote.trim();
    if (!quote || !squash(message.body).includes(squash(quote))) throw new CodedError('bad_request', 'decisionQuote 要原样引用用户那条消息里表示决定的话');
    if (input.items.length === 0) throw new CodedError('bad_request', '至少要有一项决定');
    const allows = input.items.some((i) => i.decision === 'allow' || i.decision === 'confirm');
    const refusal = allows ? notAConsent(message.body) : undefined;
    if (refusal) throw new CodedError('bad_request', `${refusal}，不能当作同意；请在原对话里追问一句，问题继续挂着`);
    const byRef = new Map(q.items.map((i) => [i.ref, i]));
    for (const i of input.items) {
      const item = byRef.get(i.ref);
      if (!item) throw new CodedError('bad_request', `${i.ref} 不在这个问题里（问题之外的事项排在后面，不能顺带处理）`);
      const okDecision = item.kind === 'approval' ? i.decision === 'allow' || i.decision === 'deny' : i.decision === 'confirm' || i.decision === 'cancel';
      if (!okDecision) throw new CodedError('bad_request', `${i.ref} 的决定只能是 ${item.kind === 'approval' ? 'allow / deny' : 'confirm / cancel'}`);
      if (i.hunkIds && !item.hunkIds) throw new CodedError('bad_request', `${i.ref} 不是提交卡片`);
    }
    const via = message.channel ?? 'desktop';
    // 先认领问题（带版本，先到者为准），再逐项执行
    const decided = input.items.map((i) => i.ref);
    this.deps.publish(store.questions.close(q.id, q.version, 'done', `按用户的回复处理：${quote.slice(0, 100)}`, decided).events);
    const results: string[] = [];
    for (const i of input.items) {
      const item = byRef.get(i.ref)!;
      results.push(await this.execute(item, i.decision, i.hunkIds ?? item.hunkIds, via, session.workspaceId));
      store.audit.append(`run:${runId}`, 'approval.conversation', item.label.slice(0, 200), JSON.stringify({ question: q.id, message: message.id, quote: quote.slice(0, 200), via, decision: i.decision }).slice(0, 500));
    }
    const remaining = q.items.filter((i) => !decided.includes(i.ref) && this.isPending(i.ref, i.kind)).map((i) => `${i.ref}：${i.label}`);
    return {
      results,
      remaining,
      next: remaining.length > 0 ? '把结果告诉用户；剩下的还在等，需要的话用 suggest_decision 重新问（只问剩下的）' : '把结果告诉用户（哪几项已放行、哪个助手继续了）',
    };
  }

  /** 问题下面的按钮（桌面或外部渠道）：按建议处理、都不要、只处理带目标的这一项。宿主直接执行，不经协调助手。 */
  async decideByButton(questionId: string, expectedVersion: number, action: 'accept' | 'reject' | 'item', ref: string | undefined, via: ApprovalChannel): Promise<QuestionRecord> {
    const { store } = this;
    const q = store.questions.get(questionId);
    if (!q) throw new CodedError('not_found', '问题不存在');
    if (q.status !== 'open' || q.version !== expectedVersion) throw new CodedError('conflict', '这个问题已经处理过了（按钮已失效）');
    const chosen = action === 'item' ? q.items.filter((i) => i.ref === ref) : q.items;
    if (chosen.length === 0) throw new CodedError('bad_request', '这一项不在问题里');
    const session = store.coordinator.getMainSession(q.sessionId)!;
    // 外部渠道：先核对权限，不够就不认领问题
    if (via !== 'desktop' && action !== 'reject') {
      for (const item of chosen) {
        const reason = this.remoteRefusal(item, via, session.workspaceId);
        if (reason) throw new CodedError('bad_request', reason);
      }
    }
    const decisions = chosen.map((i) => ({ item: i, decision: action === 'reject' ? (i.kind === 'gitop' ? ('cancel' as const) : ('deny' as const)) : i.decision }));
    const closed = store.questions.close(q.id, q.version, 'done', action === 'reject' ? '你点了「都不要」' : '你点了按钮', chosen.map((i) => i.ref));
    this.deps.publish(closed.events);
    const results: string[] = [];
    for (const { item, decision } of decisions) {
      results.push(await this.execute(item, decision, item.hunkIds, via, session.workspaceId));
      store.audit.append(via, 'approval.suggestion', item.label.slice(0, 200), JSON.stringify({ question: q.id, action, decision }).slice(0, 500));
    }
    // 结果写回对话（你能看到哪一步继续了）
    const remaining = q.items.filter((i) => !chosen.includes(i) && this.isPending(i.ref, i.kind));
    const note = `${results.join('；')}${remaining.length > 0 ? `。还在等你的：${remaining.map((i) => i.label).join('；')}` : ''}`;
    this.deps.publish(store.messages.append(q.sessionId, 'system', note, null).events);
    return closed.record;
  }

  // ---- 执行 ----

  private async execute(item: QuestionItem, decision: QuestionItem['decision'], hunkIds: string[] | undefined, via: ApprovalChannel, workspaceId: string): Promise<string> {
    const { store } = this;
    if (item.kind === 'approval') {
      const approval = store.runs.getApproval(item.ref);
      if (!approval || approval.status !== 'pending') return `${item.label}：已经处理过了`;
      if (via !== 'desktop' && decision === 'allow') {
        const reason = this.remoteRefusal(item, via, workspaceId);
        if (reason) return `${item.label}：${reason}`;
      }
      try {
        const change = store.runs.decideApproval(approval.id, approval.version, decision === 'allow' ? 'approved' : 'denied', via);
        this.deps.publish(change.events);
        this.deps.supervisor.forwardDecision(change.record, decision === 'allow' ? 'allow_once' : 'deny');
      } catch (error) {
        return `${item.label}：没有执行（${errorText(error, 200)}）`;
      }
      const run = store.runs.getRun(approval.runId);
      const subtask = run && store.tasks.getSubtask(run.subtaskId);
      const who = subtask?.planId ? `节点「${nodeTitle(store, subtask)}」` : '这个任务';
      return decision === 'allow' ? `${item.label}：已放行，${who}继续了` : `${item.label}：已拒绝，${who}会收到拒绝`;
    }
    const gitOps = this.deps.gitOps?.();
    const op = store.git.getOp(item.ref);
    if (!gitOps || !op) return `${item.label}：卡片不存在`;
    if (op.status !== 'proposed') return `${item.label}：已经处理过了`;
    if (op.request.kind === 'commit' && decision === 'confirm' && (!hunkIds || hunkIds.length === 0)) return `${item.label}：没有指定要提交的块，没有提交`;
    try {
      const done = await gitOps.decide(op.id, op.version, decision === 'confirm' ? 'confirm' : 'cancel', hunkIds ?? []);
      return `${item.label}：${done.result ?? done.status}`;
    } catch (error) {
      return `${item.label}：没有执行（${errorText(error, 200)}）`;
    }
  }

  /** 外部渠道能不能批这一项：敏感路径一律到电脑上；其余按远程审批等级（推送、合并、权限扩展是高风险，要 L2）。 */
  remoteRefusal(item: QuestionItem, via: ApprovalChannel, workspaceId: string): string | undefined {
    if (via === 'desktop') return undefined;
    if (item.sensitive) return '这项需要到电脑上确认';
    const level = this.store.tasks.getWorkspace(workspaceId)?.remoteApprovalLevel ?? 'L0';
    const riskLevel = item.kind === 'gitop' ? (item.highImpact ? 'high' : 'medium') : (this.store.runs.getApproval(item.ref)?.riskLevel ?? 'high');
    if (canApproveRemotely(level, { riskLevel, kind: 'command' })) return undefined;
    return `这个项目的远程审批等级是 ${level}，这项在这里只能拒绝；请到电脑上批，或把远程审批等级调到 ${riskLevel === 'high' ? 'L2' : 'L1 或 L2'}`;
  }

  // ---- 查询 ----

  /** 唤醒里附上的当前问题（你这条消息可能是在回答它）。 */
  openQuestionContext(sessionId: string): string | undefined {
    const q = this.store.questions.openOf(sessionId);
    if (!q) return undefined;
    return (
      `当前在等用户回答的问题 ${q.id}：「${q.text.slice(0, 300)}」\n` +
      q.items.map((i) => `- ${i.ref}：${i.label}（建议 ${i.decision}${i.hunkIds ? `，块 ${i.hunkIds.join('、')}` : ''}）`).join('\n') +
      '\n用户的话如果是在回答它：读懂整句再决定。明确同意或拒绝时用 resolve_approvals（带上用户消息编号和表示决定的原话，可以只处理其中几项）；' +
      '是在追问或意思不清楚时先回答 / 追问一句，问题继续挂着；他只说「继续」「可以」而对象不明确时问清楚，不要猜。问题之外的新事项排在后面。'
    );
  }

  private coordinatorTurn(runId: string): { session: MainSessionRecord; wake: NonNullable<ReturnType<StorePort['coordinator']['runningWake']>> } {
    const { store } = this;
    const sessionId = store.runs.getRun(runId)?.sessionId;
    const session = sessionId ? store.coordinator.getMainSession(sessionId) : undefined;
    if (!session) throw new CodedError('bad_request', '只有主会话里的协调助手能问用户');
    if (store.runs.getRun(runId)?.subtaskId !== session.subtaskId) throw new CodedError('bad_request', '只有主会话里的协调助手能问用户');
    const wake = store.coordinator.runningWake(session.sessionId);
    if (!wake) throw new CodedError('bad_request', '这一轮不是协调助手的唤醒');
    return { session, wake };
  }

  private find(ref: string): Pending | undefined {
    const approval = this.store.runs.getApproval(ref);
    if (approval) return { kind: 'approval', approval };
    const op = this.store.git.getOp(ref);
    return op ? { kind: 'gitop', op } : undefined;
  }

  private isPending(ref: string, kind: 'approval' | 'gitop'): boolean {
    return kind === 'approval' ? this.store.runs.getApproval(ref)?.status === 'pending' : this.store.git.getOp(ref)?.status === 'proposed';
  }

  private sourceSessionOf(p: Pending): MainSessionRecord | undefined {
    return p.kind === 'approval' ? this.sourceSession(p.approval) : p.op.sessionId ? this.store.coordinator.getMainSession(p.op.sessionId) : undefined;
  }

  /**
   * 审批的来源会话：发起请求的是主会话自己时就是它；否则是提出这个任务计划的那个主会话。没有（单独建的任务、会话不在了）时
   * 返回 undefined：回到项目的桌面入口（「待我处理」），不借用别的会话。
   */
  sourceSession(approval: ApprovalRecord): MainSessionRecord | undefined {
    const { store } = this;
    const run = store.runs.getRun(approval.runId);
    if (!run) return undefined;
    if (run.sessionId) {
      const own = store.coordinator.getMainSession(run.sessionId);
      if (own && own.subtaskId === run.subtaskId) return own;
    }
    const subtask = store.tasks.getSubtask(run.subtaskId);
    const plan = subtask && store.plans.latestPlan(subtask.taskId);
    const proposer = plan?.proposedByRunId ? store.runs.getRun(plan.proposedByRunId) : undefined;
    return proposer?.sessionId ? store.coordinator.getMainSession(proposer.sessionId) : undefined;
  }

  private runSubtask(runId: string): string | undefined {
    return this.store.runs.getRun(runId)?.subtaskId;
  }

  private describe(p: Pending): Described {
    const { store } = this;
    if (p.kind === 'approval') {
      const a = p.approval;
      const run = store.runs.getRun(a.runId);
      const subtask = run && store.tasks.getSubtask(run.subtaskId);
      const who = subtask?.planId ? `${ROLE_NAME[subtask.role] ?? subtask.role}（节点「${nodeTitle(store, subtask)}」）` : '协调助手';
      const target = a.access === 'read' ? (/：(.+)$/.exec(a.summary)?.[1] ?? null) : a.riskLevel === 'high' ? a.summary : null;
      return {
        ref: a.id,
        kind: 'approval',
        version: a.version,
        matter: `${run?.subtaskId ?? '?'}:${a.access === 'read' ? 'read' : a.kind}`,
        label: a.summary,
        target: a.sensitive || a.riskLevel === 'high' ? target : (target ?? null),
        highImpact: a.riskLevel === 'high' || !!a.sensitive,
        sensitive: !!a.sensitive,
        who,
      };
    }
    const op = p.op;
    const r = op.request;
    const base = { ref: op.id, kind: 'gitop' as const, version: op.version, matter: `git:${op.id}`, sensitive: false, who: '协调助手（Git 卡片）' };
    if (r.kind === 'push') {
      const target = `${r.head.slice(0, 7)} → ${r.remote}/${r.remoteBranch}`;
      return { ...base, label: `推送 ${target}（${r.targets.map((t) => t.url).join('、')}，${r.totalCommits} 个提交）`, target, highImpact: true };
    }
    if (r.kind === 'merge') {
      const target = `${r.source} → ${r.target}`;
      return { ...base, label: `本地合并 ${r.source}@${r.sourceSha.slice(0, 7)} 到 ${r.target}@${r.targetSha.slice(0, 7)}`, target, highImpact: true };
    }
    if (r.kind === 'commit') {
      const hunkIds = r.hunks.filter((h) => h.evidenced).map((h) => h.id);
      return { ...base, label: `提交「${r.message}」到 ${r.branch}（${r.scope.label}，${hunkIds.length} 个块）`, target: null, highImpact: false, hunkIds };
    }
    return { ...base, label: '暂存区卡片', target: null, highImpact: false };
  }
}

const ROLE_NAME: Record<string, string> = { developer: '开发助手', tester: '测试助手', reviewer: '审阅助手', docs: '文档助手', researcher: '调研助手', coordinator: '协调助手' };

function toItem(d: Described, decision: QuestionItem['decision'], hunkIds?: string[]): QuestionItem {
  return {
    ref: d.ref,
    kind: d.kind,
    version: d.version,
    decision,
    ...(hunkIds ? { hunkIds } : {}),
    label: d.label,
    target: d.target,
    highImpact: d.highImpact,
    sensitive: d.sensitive,
  };
}

/** 第一件事的全部项（宿主自己问时一次只问一件事）。 */
function firstMatter(items: Described[]): Described[] {
  const first = items[0]?.matter;
  return items.filter((d) => d.matter === first);
}

const squash = (s: string) => s.replace(/\s+/g, '');

/** 问题原文里有没有写明目标（推送 / 合并按提交和分支，路径按文件名）。 */
function mentions(text: string, target: string): boolean {
  const t = squash(text);
  const parts = target
    .split(/\s*(?:→|->)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts.every((p) => t.includes(squash(p.split('/').pop()!)) || t.includes(squash(p)));
  const name = target.split(/[\\/]/).pop() ?? target;
  return t.includes(squash(name));
}

/** 几条路径按目录归一下（同一目录的数一下），给协调助手说差异用。 */
function groupDirs(paths: string[]): string | undefined {
  if (paths.length < 2) return undefined;
  const dirs = new Map<string, number>();
  for (const p of paths) {
    const dir = p.replace(/[\\/][^\\/]*$/, '');
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }
  if (dirs.size < 2) return undefined;
  return [...dirs.entries()].map(([dir, n]) => `${n} 个在 ${dir}`).join('，');
}
