import { executorOfRole } from '../agent-service.js';
import type {
  Card,
  ChannelProvider,
  ConversationRecord,
  EscalationCandidate,
  PersistentEvent,
  RunResultRecord,
  StorePort,
  SubtaskRecord,
  SubtaskStatus,
  TaskRecord,
} from '@paldock/contracts';
import { canApproveRemotely, canConfirmPlanRemotely, shouldEscalateApproval, subtaskMachine, type DesktopPresence, type P2Limits } from '@paldock/domain';
import { approvalCard, approvalDecidedCard, approvalGroupCard, approvalGroupDecidedCard, coordinatorReplyCard, noticeCard, planCard, planDecidedCard, taskProgressCard } from './cards.js';
import { P1_DEFAULTS } from '@paldock/domain';

export interface NotifierDeps {
  store: StorePort;
  publish(events: PersistentEvent[]): void;
  /** 写 outbox 并唤醒投递。 */
  send(conversation: ConversationRecord, card: Card, subject?: string): void;
  presence(): DesktopPresence;
  /** 已连接（适配器在运行）的渠道；停用或出错的渠道不作为升级目标。 */
  attached(provider: ChannelProvider): boolean;
  now: () => Date;
  limits: P2Limits;
  /** 同一次 Run 多久之内的审批合并成一条消息（缺省 P1_DEFAULTS.approvalGroupMs）。 */
  approvalGroupMs?: number;
}

/** 从外部建的任务在这些节点通知来源会话。 */
const NOTIFY_STATUSES = new Set<SubtaskStatus>(['running', 'review', 'blocked', 'failed', 'succeeded', 'cancelled']);

/** 升级审批卡片的主题：同一审批在同一会话里只有一张卡片，处理后更新它。 */
const approvalSubject = (approvalId: string) => `approval:${approvalId}`;
/** 合并成一组的审批：一条消息，处理完后更新它。 */
const groupSubject = (groupId: string) => `approval-group:${groupId}`;

/**
 * 业务事件 → 外部渠道：
 * - 任务的关键节点发回来源会话和把它设为当前任务的单聊（其余桌面建的任务不往外推，普通通知桌面优先）；
 * - 审批先在桌面，满足升级条件（3 分钟无人处理、锁屏、空闲）时发到所有已绑定的单聊；
 * - 审批在任何一端处理后，作废外部卡片上的按钮并更新卡片。
 */
export class ChannelNotifier {
  constructor(private readonly deps: NotifierDeps) {}

  private get limits(): P2Limits {
    return this.deps.limits;
  }

  private get channels() {
    return this.deps.store.channels;
  }

  onEvents(events: PersistentEvent[]): void {
    for (const event of events) {
      if (event.type === 'subtask.status_changed') this.onSubtask(event.aggregateId, event.payload.from, event.payload.to);
      else if (event.type === 'approval.decided') this.onApprovalDecided(event.aggregateId);
      else if (event.type === 'message.created' && event.payload.role === 'assistant') this.onAssistantMessage(event.payload.sessionId, Number(event.aggregateId));
      else if (event.type === 'plan.status_changed') this.onPlanDecided(event.aggregateId);
    }
  }

  private onSubtask(subtaskId: string, from: SubtaskStatus, to: SubtaskStatus): void {
    // 离开待命后，卡片上的「结束任务」按钮作废
    if (from === 'review') this.channels.voidActions(subtaskId);
    if (!NOTIFY_STATUSES.has(to)) return;
    const { tasks, runs } = this.deps.store;
    const subtask = tasks.getSubtask(subtaskId);
    const task = subtask && tasks.getTask(subtask.taskId);
    const subscribers = task ? this.subscribers(task) : [];
    // 任务结束（不管在哪一端结束）后不再是任何单聊的当前任务：下一句话是新任务；想接着做要 /continue 选它
    if (task && subtaskMachine.isTerminal(to)) this.channels.clearCurrentTask(task.id);
    if (!subtask || !task || subscribers.length === 0) return;
    // 证据只有待命中卡片要用
    const latest = to === 'review' ? runs.latestRun(subtask.id) : undefined;
    const result = latest && runs.getResult(latest.id);
    for (const conversation of subscribers) this.notifyProgress(conversation, task, subtask, to, result);
  }

  /** 来源会话，加上把它设为当前任务的单聊（桌面建的任务在手机上继续后也能收到进度）。 */
  private subscribers(task: TaskRecord): ConversationRecord[] {
    const origin = task.originConversationId ? this.channels.getConversation(task.originConversationId) : undefined;
    const focused = this.channels.conversationsFocusedOn(task.id).filter((c) => c.id !== origin?.id);
    return [...(origin ? [origin] : []), ...focused].filter((c) => this.reachable(c));
  }

  private notifyProgress(conversation: ConversationRecord, task: TaskRecord, subtask: SubtaskRecord, to: SubtaskStatus, result: RunResultRecord | undefined): void {
    // 继续、结束按钮只发到单聊；群里只通知。「继续」以任务为目标，点了不会作废同一张卡片上的「结束任务」
    const review =
      to === 'review' && conversation.kind === 'dm'
        ? {
            end: this.action(conversation, 'accept_review', subtask.id, subtask.version, this.limits.reviewActionTtlMs),
            next: this.action(conversation, 'continue_task', task.id, null, this.limits.reviewActionTtlMs),
          }
        : undefined;
    this.deps.send(conversation, taskProgressCard(task, to, subtask.statusReason, result, review, conversation.kind === 'dm'));
  }

  /** 会话仍然可以收通知：单聊的账号没被解绑，群仍在白名单里。 */
  private reachable(conversation: ConversationRecord): boolean {
    if (conversation.kind === 'group') return conversation.groupAllowed;
    return conversation.ownerAccountId !== null && this.channels.getAccount(conversation.ownerAccountId)?.status === 'active';
  }

  /** 升级目标：已绑定账号的单聊里，渠道正在运行的那些。 */
  private escalationTargets(): ConversationRecord[] {
    return this.channels.activeDirectConversations().filter((c) => this.deps.attached(c.provider));
  }

  private action(conversation: ConversationRecord, kind: 'accept_review' | 'continue_task' | 'approve' | 'deny', targetId: string, version: number | null, ttlMs: number) {
    return this.channels.createAction({ conversationId: conversation.id, kind, targetId, targetVersion: version, ttlMs }).token;
  }

  /** 外部会话对应的主会话里，协调助手的回复发回那个会话（外部发起的任务做完后的汇总也走这里）。 */
  private onAssistantMessage(sessionId: string, messageId: number): void {
    const conversation = this.channels.conversationOfMainSession(sessionId);
    const message = conversation && this.deps.store.messages.get(messageId);
    if (!conversation || !message || !this.reachable(conversation)) return;
    this.deps.send(conversation, coordinatorReplyCard(message.body));
  }

  /** 计划在任何一端确认或退回后：作废卡片上的按钮，更新收到过卡片的会话。 */
  private onPlanDecided(planId: string): void {
    this.channels.voidActions(planId);
    const plan = this.deps.store.plans.getPlan(planId);
    if (!plan?.escalatedAt || plan.status === 'proposed') return;
    const task = this.deps.store.tasks.getTask(plan.taskId);
    const subject = `plan:${planId}`;
    for (const conversation of this.channels.activeDirectConversations()) {
      if (this.deps.store.outbox.hasSubject(conversation.id, subject)) this.deps.send(conversation, planDecidedCard(task?.title ?? '', plan.status, plan.decidedVia), subject);
    }
  }

  /** 计划确认卡片：和审批同一套升级规则；L0 不发，L1 遇到带检查命令的计划只提醒、不放确认按钮。 */
  private escalatePlans(targets: ConversationRecord[], providers: ChannelProvider[], presence: DesktopPresence, nowMs: number): void {
    const { store } = this.deps;
    for (const c of this.channels.planEscalationCandidates()) {
      if (c.remoteApprovalLevel === 'L0') continue;
      if (!shouldEscalateApproval(Date.parse(c.plan.createdAt), nowMs, presence, this.limits.escalationWaitMs)) continue;
      const task = store.tasks.getTask(c.plan.taskId)!;
      const nodes = store.plans.nodes(c.plan.id);
      const hasChecks = nodes.some((n) => n.checkCommand !== null);
      const remote = canConfirmPlanRemotely(c.remoteApprovalLevel, hasChecks);
      const lines = nodes.map((n) => ({
        title: n.title,
        role: n.role,
        executor: n.executor ?? executorOfRole(store, task.workspaceId, n.role),
        dependsOn: n.dependsOn.map((k) => nodes.find((x) => x.key === k)?.title ?? k),
        check: n.checkCommand ? [n.checkCommand.executable, ...n.checkCommand.args].join(' ') : null,
      }));
      store.transaction(() => {
        const event = this.channels.markPlanEscalated(c.plan.id, providers);
        if (!event) return;
        for (const conversation of targets) {
          const ttlMs = this.limits.reviewActionTtlMs;
          const buttons = remote
            ? {
                confirm: this.channels.createAction({ conversationId: conversation.id, kind: 'confirm_plan', targetId: c.plan.id, targetVersion: c.plan.version, ttlMs }).token,
                reject: this.channels.createAction({ conversationId: conversation.id, kind: 'reject_plan', targetId: c.plan.id, targetVersion: c.plan.version, ttlMs }).token,
              }
            : undefined;
          const why = remote ? null : `这个计划带检查命令，项目「${c.workspaceName}」的远程审批等级是 ${c.remoteApprovalLevel}，请到电脑上确认。`;
          this.deps.send(conversation, planCard(c.taskTitle, c.plan.revision, lines, buttons, why), `plan:${c.plan.id}`);
        }
        this.deps.publish([event]);
      });
    }
  }

  /** 已升级的审批被处理（桌面、外部或过期）：作废按钮，并更新每个单聊里的那张卡片。 */
  private onApprovalDecided(approvalId: string): void {
    this.channels.voidActions(approvalId);
    const context = this.channels.approvalContext(approvalId);
    if (!context?.approval.escalatedAt || context.approval.status === 'pending') return;
    // 合并外发的一组：全部处理完才更新那一条消息
    const group = context.approval.groupId ? this.deps.store.runs.approvalsOfGroup(context.approval.groupId).filter((a) => a.escalatedAt) : [];
    if (group.length > 1) {
      if (group.some((a) => a.status === 'pending')) return;
      const subject = groupSubject(context.approval.groupId!);
      const card = approvalGroupDecidedCard(context, group);
      for (const conversation of this.channels.activeDirectConversations()) {
        if (this.deps.store.outbox.hasSubject(conversation.id, subject)) this.deps.send(conversation, card, subject);
      }
      return;
    }
    const card = approvalDecidedCard(context, context.approval.status, context.approval.decidedVia);
    const subject = approvalSubject(approvalId);
    // 只更新收到过（或正排队要收）审批卡片的会话
    for (const conversation of this.channels.activeDirectConversations()) {
      if (this.deps.store.outbox.hasSubject(conversation.id, subject)) this.deps.send(conversation, card, subject);
    }
  }

  /** 定时调用：把满足升级条件的待审批发到所有已绑定的单聊；没有可发的单聊时不标记，绑定后再升级。 */
  escalate(): void {
    // 先看有没有可发的单聊（便宜的查询），没有时不做联表扫描
    const targets = this.escalationTargets();
    if (targets.length === 0) return;
    const presence = this.deps.presence();
    const nowMs = this.deps.now().getTime();
    const candidates = this.channels
      .escalationCandidates()
      .filter((c) => shouldEscalateApproval(Date.parse(c.approval.requestedAt), nowMs, presence, this.limits.escalationWaitMs));
    const providers = [...new Set(targets.map((t) => t.provider))] as ChannelProvider[];
    this.escalateNotices(targets, providers, presence, nowMs);
    this.escalatePlans(targets, providers, presence, nowMs);
    // 同一组的审批合在一起发一条；组还在收（第一条到达后不到 approvalGroupMs）时先不发，免得拆成几条
    const groupMs = this.deps.approvalGroupMs ?? P1_DEFAULTS.approvalGroupMs;
    const groups = new Map<string, EscalationCandidate[]>();
    for (const c of candidates) {
      const key = c.approval.groupId ?? c.approval.id;
      const list = groups.get(key);
      if (list) list.push(c);
      else groups.set(key, [c]);
    }
    for (const group of groups.values()) {
      if (group[0]!.approval.groupId && nowMs - Date.parse(group[0]!.approval.requestedAt) < groupMs) continue;
      this.deps.store.transaction(() => {
        const marked = group.map((c) => ({ c, event: this.channels.markEscalated(c.approval.id, providers) })).filter((m) => m.event);
        if (marked.length === 0) return; // 期间已被处理或已升级
        for (const conversation of targets) {
          if (marked.length === 1) this.sendApproval(conversation, marked[0]!.c, nowMs);
          else this.deps.send(conversation, approvalGroupCard(marked.map((m) => m.c)), groupSubject(marked[0]!.c.approval.groupId!));
        }
        this.deps.publish(marked.map((m) => m.event!));
      });
    }
  }

  /** 协调助手的通知：和审批同一套升级规则（桌面没人看、锁屏、空闲）；在桌面看过的不再外发。每条只外发一次。 */
  private escalateNotices(targets: ConversationRecord[], providers: ChannelProvider[], presence: DesktopPresence, nowMs: number): void {
    const { coordinator } = this.deps.store;
    for (const notice of coordinator.unescalatedNotices()) {
      if (!shouldEscalateApproval(Date.parse(notice.createdAt), nowMs, presence, this.limits.escalationWaitMs)) continue;
      this.deps.store.transaction(() => {
        const event = coordinator.markNoticeEscalated(notice.id, providers);
        if (!event) return;
        for (const conversation of targets) this.deps.send(conversation, noticeCard(notice), `notice:${notice.id}`);
        this.deps.publish([event]);
      });
    }
  }

  private sendApproval(conversation: ConversationRecord, c: EscalationCandidate, nowMs: number): void {
    const { approval } = c;
    const remote = canApproveRemotely(c.remoteApprovalLevel, approval);
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
      : `这个项目的远程审批等级是 ${c.remoteApprovalLevel}，${approval.riskLevel === 'high' ? '高风险（含权限扩展、敏感路径的读取）' : '这类'}审批在这里只能拒绝；请到电脑上批，或把项目的远程审批等级调到 ${approval.riskLevel === 'high' ? 'L2' : 'L1 或 L2'}。`;
    this.deps.send(conversation, approvalCard(c, buttons, why), approvalSubject(approval.id));
  }
}
