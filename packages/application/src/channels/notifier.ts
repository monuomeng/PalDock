import type { Card, ChannelProvider, ConversationRecord, EscalationCandidate, PersistentEvent, StorePort, SubtaskStatus } from '@paldock/contracts';
import { canApproveRemotely, P2_DEFAULTS, shouldEscalateApproval, type DesktopPresence, type P2Limits } from '@paldock/domain';
import { approvalCard, approvalDecidedCard, taskProgressCard } from './cards.js';

export interface NotifierDeps {
  store: StorePort;
  publish(events: PersistentEvent[]): void;
  /** 写 outbox 并唤醒投递。 */
  send(conversation: ConversationRecord, card: Card, subject?: string): void;
  presence(): DesktopPresence;
  now?: () => Date;
  limits?: Partial<P2Limits>;
}

/** 从外部建的任务在这些节点通知来源会话。 */
const NOTIFY_STATUSES = new Set<SubtaskStatus>(['running', 'review', 'blocked', 'failed', 'succeeded', 'cancelled']);

/** 升级审批卡片的主题：同一审批在同一会话里只有一张卡片，处理后更新它。 */
const approvalSubject = (approvalId: string) => `approval:${approvalId}`;

/**
 * 业务事件 → 外部渠道：
 * - 从外部建的任务，关键节点发回来源会话（桌面建的任务不往外推，普通通知桌面优先）；
 * - 审批先在桌面，满足升级条件（3 分钟无人处理、锁屏、空闲）时发到所有已绑定的单聊；
 * - 审批在任何一端处理后，作废外部卡片上的按钮并更新卡片。
 */
export class ChannelNotifier {
  private readonly limits: P2Limits;
  private readonly now: () => Date;

  constructor(private readonly deps: NotifierDeps) {
    this.limits = { ...P2_DEFAULTS, ...deps.limits };
    this.now = deps.now ?? (() => new Date());
  }

  private get channels() {
    return this.deps.store.channels;
  }

  onEvents(events: PersistentEvent[]): void {
    for (const event of events) {
      if (event.type === 'subtask.status_changed') this.onSubtask(event.aggregateId, event.payload.from, event.payload.to);
      else if (event.type === 'approval.decided') this.onApprovalDecided(event.aggregateId);
    }
  }

  private onSubtask(subtaskId: string, from: SubtaskStatus, to: SubtaskStatus): void {
    // 离开待验收后，卡片上的验收按钮作废
    if (from === 'review') this.channels.voidActions(subtaskId);
    if (!NOTIFY_STATUSES.has(to)) return;
    const { tasks, runs } = this.deps.store;
    const subtask = tasks.getSubtask(subtaskId);
    const task = subtask && tasks.getTask(subtask.taskId);
    const conversation = task?.originConversationId ? this.channels.getConversation(task.originConversationId) : undefined;
    if (!subtask || !task || !conversation) return;
    const latest = runs.latestRun(subtask.id);
    const result = latest && runs.getResult(latest.id);
    // 验收按钮只发到单聊；群里只通知
    const review =
      to === 'review' && conversation.kind === 'dm'
        ? {
            accept: this.action(conversation, 'accept_review', subtask.id, subtask.version, this.limits.reviewActionTtlMs),
            rework: this.action(conversation, 'rework_review', subtask.id, subtask.version, this.limits.reviewActionTtlMs),
          }
        : undefined;
    this.deps.send(conversation, taskProgressCard(task, to, subtask.statusReason, result, review));
  }

  private action(conversation: ConversationRecord, kind: 'accept_review' | 'rework_review' | 'approve' | 'deny', targetId: string, version: number, ttlMs: number) {
    return this.channels.createAction({ conversationId: conversation.id, kind, targetId, targetVersion: version, ttlMs }).token;
  }

  /** 已升级的审批被处理（桌面、外部或过期）：作废按钮，并更新每个单聊里的那张卡片。 */
  private onApprovalDecided(approvalId: string): void {
    this.channels.voidActions(approvalId);
    const context = this.channels.approvalContext(approvalId);
    if (!context?.approval.escalatedAt || context.approval.status === 'pending') return;
    const card = approvalDecidedCard(context, context.approval.status, context.approval.decidedVia);
    for (const conversation of this.channels.activeDirectConversations()) {
      this.deps.send(conversation, card, approvalSubject(approvalId));
    }
  }

  /** 定时调用：把满足升级条件的待审批发到所有已绑定的单聊；没有可发的单聊时不标记，绑定后再升级。 */
  escalate(): void {
    const presence = this.deps.presence();
    const nowMs = this.now().getTime();
    const candidates = this.channels
      .escalationCandidates()
      .filter((c) => shouldEscalateApproval(Date.parse(c.approval.requestedAt), nowMs, presence, this.limits.escalationWaitMs));
    if (candidates.length === 0) return;
    const targets = this.channels.activeDirectConversations();
    if (targets.length === 0) return;
    const providers = [...new Set(targets.map((t) => t.provider))] as ChannelProvider[];
    for (const candidate of candidates) {
      this.deps.store.transaction(() => {
        const event = this.channels.markEscalated(candidate.approval.id, providers);
        if (!event) return; // 期间已被处理或已升级
        for (const conversation of targets) this.sendApproval(conversation, candidate, nowMs);
        this.deps.publish([event]);
      });
    }
  }

  private sendApproval(conversation: ConversationRecord, c: EscalationCandidate, nowMs: number): void {
    const { approval } = c;
    const remote = canApproveRemotely(c.remoteApprovalLevel, approval.riskLevel) && approval.kind !== 'permissions';
    const ttlMs = Math.max(0, Date.parse(approval.expiresAt) - nowMs);
    // 拒绝总是允许；不能远程批准时只发提醒，不放按钮（避免只有「拒绝」一个按钮引起误会）
    const buttons = remote
      ? {
          approve: this.action(conversation, 'approve', approval.id, approval.version, ttlMs),
          deny: this.action(conversation, 'deny', approval.id, approval.version, ttlMs),
        }
      : undefined;
    const why = remote
      ? null
      : approval.kind === 'permissions'
        ? '权限扩展只能在电脑上处理。'
        : `这个项目的远程审批等级是 ${c.remoteApprovalLevel}，${approval.riskLevel === 'high' ? '高风险' : '这类'}审批请到电脑上处理。`;
    this.deps.send(conversation, approvalCard(c, buttons, why), approvalSubject(approval.id));
  }
}
