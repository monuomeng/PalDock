import {
  CodedError,
  noticeRef,
  type ApprovalDecision,
  type ApprovalRecord,
  type ChannelProvider,
  type ConversationRecord,
  type ConversationDetail,
  type MainSessionRecord,
  type PersistentEvent,
  type StorePort,
  type TaskRecord,
  type WakeRecord,
} from '@paldock/contracts';
import { P3_DEFAULTS, runMachine, taskRef, type P3Limits } from '@paldock/domain';
import { coordinatorInstructions, soloInstructions, soloReviewPrompt, wakePrompt } from './prompts.js';
import { executorOfRole } from './agent-service.js';
import { dirtyFiles } from './git.js';
import { nodeTitle } from './task-graph-scheduler.js';
import { errorText, MicroBatch } from './util.js';
import type { RunPlan } from './run-supervisor.js';

export interface CoordinatorDeps {
  store: StorePort;
  supervisor: { enqueue(subtaskId: string, plan: RunPlan): void; isActive(subtaskId: string): boolean; cancel(subtaskId: string): boolean; forwardDecision(approval: ApprovalRecord, decision: ApprovalDecision): void };
  publish(events: PersistentEvent[]): void;
  log(message: string): void;
  now?: () => number;
  limits?: Partial<P3Limits>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CHANNEL_NAME: Record<ChannelProvider, string> = { feishu: '飞书', telegram: 'Telegram' };
const RESUME_FAILED = '续做失败';

/**
 * 协调助手主会话与最小唤醒循环：你在对话里说的话、它提出的任务里的关键事件，各变成一次唤醒（wakes 带去重键）；
 * 同一会话串行，每次唤醒一次 Run，沿用上一次的原生会话。任务事件唤醒有频率限制，每次唤醒有请求上限。
 * 规则都在这里和 domain 的默认值里，模型只决定这一轮说什么、提什么计划。
 */
export class CoordinatorService {
  private readonly limits: P3Limits;
  private readonly now: () => number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** 每个主会话上次发给协调助手的任务板（续用会话时没变就不重发）。 */
  private readonly lastBoard = new Map<string, string>();
  /** 每个主会话上次用的工作模式（团队 / 单人和隔离方式）；变了就新开会话，换一套角色说明。 */
  private readonly lastMode = new Map<string, string>();
  private readonly batch: MicroBatch<string>;
  /** 当天已就「自动唤醒达到上限」通知过的会话（不重复通知）。 */
  private readonly capNoticeDay = new Map<string, number>();

  constructor(private readonly deps: CoordinatorDeps) {
    this.limits = { ...P3_DEFAULTS, ...deps.limits };
    this.now = deps.now ?? Date.now;
    this.batch = new MicroBatch((sessionId) => this.pump(sessionId), deps.log, 'wake');
  }

  private get store() {
    return this.deps.store;
  }

  /**
   * 服务启动：上次没跑完的唤醒（Run 已被中断）放回队列，沿用原生会话重新处理；频率计数按库里的开始时间照旧。
   * 返回放回队列的唤醒（重启恢复记事件用）。
   */
  start(): WakeRecord[] {
    const { record, events } = this.store.coordinator.requeueRunningWakes('服务重启，重新处理');
    this.deps.publish(events);
    for (const sessionId of this.store.coordinator.sessionsWithPendingWakes()) this.schedule(sessionId);
    return record;
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  // ---- 会话 ----

  /** 项目的主会话；还没有时建一个默认的。 */
  sessions(workspaceId: string): MainSessionRecord[] {
    if (!this.store.tasks.getWorkspace(workspaceId)) throw new CodedError('not_found', '项目不存在');
    const existing = this.store.coordinator.mainSessions(workspaceId);
    return existing.length > 0 ? existing : [this.newSession(workspaceId)];
  }

  newSession(workspaceId: string, title?: string): MainSessionRecord {
    if (!this.store.tasks.getWorkspace(workspaceId)) throw new CodedError('not_found', '项目不存在');
    const count = this.store.coordinator.mainSessions(workspaceId).length;
    const { record, events } = this.store.coordinator.createMainSession(workspaceId, title ?? (count === 0 ? '默认会话' : `会话 ${count + 1}`));
    this.deps.publish(events);
    return record;
  }

  private session(sessionId: string): MainSessionRecord {
    const session = this.store.coordinator.getMainSession(sessionId);
    if (!session) throw new CodedError('not_found', '会话不存在');
    return session;
  }

  /** 对话任务对应的主会话 ID。 */
  sessionOfConversation(taskId: string): string {
    const subtask = this.store.tasks.getSubtaskOfTask(taskId);
    const session = subtask && this.store.tasks.getSessionOfSubtask(subtask.id);
    if (!session || session.kind !== 'main') throw new CodedError('not_found', '会话不存在');
    return session.id;
  }

  /** 会话详情（计划卡片由 TaskService.sessionPlans 补上）。 */
  detail(sessionId: string, limit: number): Omit<ConversationDetail, 'plans' | 'gitOps'> {
    const session = this.session(sessionId);
    const { coordinator } = this.store;
    return {
      session,
      messages: coordinator.recentMessages(sessionId, limit),
      notices: coordinator.notices(sessionId, 20),
      wakes: coordinator.listWakes(sessionId, 10),
      summary: coordinator.latestSummary(sessionId) ?? null,
    };
  }

  /** 你在对话里说的话：存为消息，同一事务记一次唤醒；同一幂等键重复提交只算一次。 */
  send(sessionId: string, text: string, idempotencyKey: string): void {
    this.ingest(sessionId, text, `msg:${idempotencyKey}`, text, null);
  }

  /** 一句用户的话进主会话：消息和唤醒同一事务，去重键已有时什么都不写。 */
  private ingest(sessionId: string, text: string, dedupeKey: string, summary: string, channel: ChannelProvider | null): void {
    this.session(sessionId);
    const events = this.store.transaction(() => {
      const wake = this.store.coordinator.addWake({ sessionId, trigger: 'user_message', dedupeKey, summary });
      return wake ? [...this.store.messages.append(sessionId, 'user', text, null, channel).events, ...wake.events] : [];
    });
    this.deps.publish(events);
    this.schedule(sessionId);
  }

  /** 外部会话对应的主会话：第一次说话时在它的项目里新建（不和桌面的会话合并），之后沿用。 */
  externalSession(conversation: ConversationRecord, workspaceId: string): string {
    if (conversation.mainSessionId) return conversation.mainSessionId;
    const title = `${CHANNEL_NAME[conversation.provider]} · ${conversation.title || (conversation.kind === 'dm' ? '单聊' : '群聊')}`;
    const session = this.newSession(workspaceId, title);
    return this.store.channels.setMainSession(conversation.id, session.sessionId)?.mainSessionId ?? session.sessionId;
  }

  /**
   * 外部渠道里的一句话进主会话：存为消息（标明渠道），同一事务记一次唤醒；同一入站事件只算一次。
   * summary 是交给协调助手的说明（拿不准是在答哪个问题时附上候选问题），缺省就是原话。
   */
  receiveExternal(sessionId: string, text: string, channel: ChannelProvider, eventKey: string, summary = text): void {
    this.ingest(sessionId, text, `ext:${eventKey}`, summary, channel);
  }

  /** 对编号问题的答复：记在提问的那个主会话里，问题标为已答（不再外发），唤醒提问的协调助手。 */
  answerQuestion(noticeId: number, text: string, channel: ChannelProvider, eventKey: string): boolean {
    const notice = this.store.coordinator.getNotice(noticeId);
    if (!notice || notice.kind !== 'question' || notice.answeredAt) return false;
    const events = this.store.transaction(() => {
      const summary = `用户在${CHANNEL_NAME[channel]}回复了你的问题 ${noticeRef(notice.id)}（${notice.body.slice(0, 200)}）：\n${text}`;
      const wake = this.store.coordinator.addWake({ sessionId: notice.sessionId, trigger: 'user_message', dedupeKey: `ext:${eventKey}`, summary });
      if (!wake) return [];
      const message = this.store.messages.append(notice.sessionId, 'user', `回复 ${noticeRef(notice.id)}：${text}`, null, channel);
      const answered = this.store.coordinator.answerNotice(notice.id, message.record.id, channel);
      return [...message.events, ...(answered?.events ?? []), ...wake.events];
    });
    this.deps.publish(events);
    this.schedule(notice.sessionId);
    return true;
  }

  /** 会话里的通知在桌面看过了：不再外发。 */
  ack(sessionId: string): void {
    this.session(sessionId);
    this.deps.publish(this.store.coordinator.ackNotices(sessionId).events);
  }

  // ---- 事件 → 唤醒 ----

  onEvents(events: readonly PersistentEvent[]): void {
    for (const event of events) {
      try {
        this.onEvent(event);
      } catch (error) {
        this.deps.log(`coordinator event ${event.type} failed: ${errorText(error)}`);
      }
    }
  }

  private onEvent(event: PersistentEvent): void {
    const { store } = this;
    if (event.type === 'run.created' || (event.type === 'run.status_changed' && runMachine.isTerminal(event.payload.to))) {
      const run = store.runs.getRun(event.aggregateId);
      const session = run && this.mainSessionOfRun(run.id);
      if (!run || !session) return;
      const wake = store.coordinator.runningWake(session.sessionId);
      if (event.type === 'run.created') {
        if (wake && !wake.runId) this.deps.publish(store.coordinator.setWake(wake.id, 'running', { runId: run.id }).events);
        return;
      }
      if (wake) this.wakeEnded(wake, run.status, run.failureReason);
      // 单人模式「改完让审阅助手看一遍」：这一轮成功、工作目录里有未提交的改动，先审再处理下一条消息
      if (wake && run.status === 'succeeded' && run.purpose === 'work') {
        const settings = store.projectSettings.get(session.workspaceId);
        if (settings.mode === 'solo' && settings.soloReview && settings.soloIsolation !== 'readonly') {
          void this.soloReview(session).finally(() => this.schedule(session.sessionId));
          return;
        }
      }
      return this.schedule(session.sessionId);
    }
    const found = this.taskEvent(event);
    if (!found) return;
    const wake = store.coordinator.addWake({ sessionId: found.sessionId, trigger: 'task_event', dedupeKey: `evt:${event.seq}`, summary: found.summary });
    if (!wake) return;
    this.deps.publish(wake.events);
    this.schedule(found.sessionId);
  }

  /** 这个会话提出的任务（计划的提出者 Run 所在的主会话）。 */
  private sessionOfTask(taskId: string): string | undefined {
    const plan = this.store.plans.latestPlan(taskId);
    const run = plan?.proposedByRunId ? this.store.runs.getRun(plan.proposedByRunId) : undefined;
    return run?.sessionId && this.store.coordinator.getMainSession(run.sessionId) ? run.sessionId : undefined;
  }

  private nodeTitle(subtaskId: string): { taskId: string; title: string } | undefined {
    const subtask = this.store.tasks.getSubtask(subtaskId);
    return subtask?.planId ? { taskId: subtask.taskId, title: nodeTitle(this.store, subtask) } : undefined;
  }

  /** 要唤醒协调助手的任务事件，以及一行摘要；其余事件返回 undefined。 */
  private taskEvent(event: PersistentEvent): { sessionId: string; summary: string } | undefined {
    const { store } = this;
    const at = (taskId: string, summary: string) => {
      const sessionId = this.sessionOfTask(taskId);
      const task = store.tasks.getTask(taskId);
      return sessionId && task ? { sessionId, summary: `任务 #${taskRef(task.id)}「${task.title}」：${summary}` } : undefined;
    };
    switch (event.type) {
      case 'approval.requested':
      case 'approval.routed': {
        // 交给协调助手判断的项目外只读：唤醒提出这个任务的主会话（没有就用项目的第一个主会话）
        if (event.type === 'approval.routed' && event.payload.to !== 'coordinator') return undefined;
        const approval = store.runs.getApproval(event.aggregateId);
        if (approval?.routedTo !== 'coordinator' || approval.status !== 'pending') return undefined;
        const run = approval && store.runs.getRun(approval.runId);
        const subtask = run && store.tasks.getSubtask(run.subtaskId);
        const task = subtask && store.tasks.getTask(subtask.taskId);
        if (!approval || !subtask || !task) return undefined;
        const sessionId = this.sessionOfTask(task.id) ?? store.coordinator.mainSessions(task.workspaceId)[0]?.sessionId;
        if (!sessionId) return undefined;
        const who = subtask.planId ? `节点「${nodeTitle(store, subtask)}」的${subtask.role}` : `任务「${task.title}」的助手`;
        return {
          sessionId,
          summary:
            `审批 ${approval.id} 交给你判断：${who}要${approval.summary}。${approval.detail ? `请求内容：${approval.detail.slice(0, 800)}。` : ''}` +
            '只读、不含 shell；请用 decide_approval 回复 allow / deny / unsure（拿不准就 unsure，交给用户）。',
        };
      }
      case 'subtask.status_changed': {
        if (event.payload.to !== 'blocked') return undefined;
        const node = this.nodeTitle(event.aggregateId);
        return node && at(node.taskId, `节点「${node.title}」阻塞${event.payload.reason ? `：${event.payload.reason}` : ''}`);
      }
      case 'gate.decided': {
        if (event.payload.outcome !== 'human') return undefined;
        const node = this.nodeTitle(event.aggregateId);
        return node && at(node.taskId, `节点「${node.title}」交给用户处理${event.payload.reason ? `：${event.payload.reason}` : ''}`);
      }
      case 'task.status_changed': {
        const task = store.tasks.getTask(event.aggregateId);
        if (event.payload.to !== 'succeeded' || !task?.integrationBranch) return undefined;
        return at(task.id, `全部节点已通过，已合进集成分支 ${task.integrationBranch}，等用户自己合进他的分支`);
      }
      case 'plan.status_changed': {
        const plan = store.plans.getPlan(event.aggregateId);
        if (!plan) return undefined;
        if (event.payload.to === 'rejected') return at(plan.taskId, `计划第 ${plan.revision} 版被用户退回${event.payload.reason ? `，意见：${event.payload.reason}` : ''}`);
        // 确认时带了意见才唤醒：把意见交给协调助手
        if (event.payload.to === 'confirmed' && event.payload.reason) return at(plan.taskId, `计划第 ${plan.revision} 版已确认，用户的意见：${event.payload.reason}`);
        return undefined;
      }
      case 'approval.decided': {
        if (event.payload.status !== 'denied' && event.payload.status !== 'expired') return undefined;
        const approval = store.runs.getApproval(event.aggregateId);
        const run = approval && store.runs.getRun(approval.runId);
        const node = run && this.nodeTitle(run.subtaskId);
        return node && at(node.taskId, `节点「${node.title}」的审批${event.payload.status === 'denied' ? '被拒绝' : '过期（自动拒绝）'}：${approval!.summary}`);
      }
      default:
        return undefined;
    }
  }

  // ---- 唤醒循环 ----

  /** 下一个微任务里推进会话（不在产生事件的事务里写库）。 */
  private schedule(sessionId: string): void {
    this.batch.add(sessionId);
  }

  /** 会话空闲时取下一条唤醒；任务事件唤醒先过频率限制。 */
  private pump(sessionId: string): void {
    const { coordinator } = this.store;
    const session = coordinator.getMainSession(sessionId);
    if (!session || coordinator.runningWake(sessionId) || this.deps.supervisor.isActive(session.subtaskId)) return;
    for (let wake = coordinator.nextPendingWake(sessionId); wake; wake = coordinator.nextPendingWake(sessionId)) {
      if (wake.trigger === 'task_event') {
        const gate = this.eventGate(session);
        if (gate === 'drop') {
          const note = `今天的自动唤醒已达 ${this.limits.eventWakesPerDay} 次`;
          this.deps.publish(coordinator.setWake(wake.id, 'dropped', { note }).events);
          this.recordDecision(session, 'wake_dropped', `${note}，跳过：${wake.summary}`);
          continue;
        }
        if (typeof gate === 'number') {
          // 任务事件唤醒在等频率间隔：不挡你的消息，先处理排在后面的用户消息
          this.retryAt(sessionId, gate);
          const message = coordinator.nextPendingWake(sessionId, 'user_message');
          return message ? this.startWake(session, message) : undefined;
        }
      }
      return this.startWake(session, wake);
    }
  }

  /** 任务事件唤醒能不能现在跑：可以返回 'go'，今天已满返回 'drop'（并通知你一次），太快返回要等的毫秒数。 */
  private eventGate(session: MainSessionRecord): 'go' | 'drop' | number {
    const now = this.now();
    const { count, lastStartedAt } = this.store.coordinator.eventWakesSince(session.sessionId, new Date(now - DAY_MS).toISOString());
    if (count >= this.limits.eventWakesPerDay) {
      const day = Math.floor(now / DAY_MS);
      if (this.capNoticeDay.get(session.sessionId) !== day) {
        this.capNoticeDay.set(session.sessionId, day);
        this.notifyUser(session.sessionId, null, `今天任务事件已经自动唤醒协调助手 ${count} 次，达到上限；之后的任务事件不再自动唤醒，请到桌面查看任务，或直接在对话里说。`, false);
      }
      return 'drop';
    }
    const wait = lastStartedAt ? Date.parse(lastStartedAt) + this.limits.eventWakeMinIntervalMs - now : 0;
    return wait > 0 ? wait : 'go';
  }

  private retryAt(sessionId: string, delayMs: number): void {
    if (this.timers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.schedule(sessionId);
    }, delayMs);
    timer.unref();
    this.timers.set(sessionId, timer);
  }

  private startWake(session: MainSessionRecord, wake: WakeRecord): void {
    const { store } = this;
    this.deps.publish(store.coordinator.setWake(wake.id, 'running').events);
    const latest = store.runs.latestRun(session.subtaskId);
    // 工作模式（2026-11-26 已定，项目级助手设置）：单人模式的主会话换一套说明和执行器；模式或执行器变了就新开会话
    const settings = store.projectSettings.get(session.workspaceId);
    const solo = settings.mode === 'solo';
    const modeKey = solo ? `solo:${settings.soloIsolation}` : 'team';
    const executor = (solo ? settings.soloExecutor : null) ?? executorOfRole(store, session.workspaceId, 'coordinator');
    const modeChanged = this.lastMode.has(session.sessionId) && this.lastMode.get(session.sessionId) !== modeKey;
    this.lastMode.set(session.sessionId, modeKey);
    // 沿用上一次的原生会话；上次续做失败、从没有过、或者换了模式 / 执行器，就新开并注入摘要和最近的消息
    const reusable = latest?.nativeThreadId && !latest.failureReason?.startsWith(RESUME_FAILED) && !modeChanged && latest.runtime === executor;
    const threadId = reusable ? latest.nativeThreadId! : undefined;
    const done = store.coordinator.doneWakes(session.sessionId);
    const summary = store.coordinator.latestSummary(session.sessionId);
    const askSummary = (!threadId && done > 0) || done - (summary?.wakesDone ?? 0) >= this.limits.summaryEveryWakes;
    const project = store.tasks.getWorkspace(session.workspaceId)!;
    // 续用会话时任务板没变就不重发（同一个服务进程里记着上次发的；重启后第一次照发）
    const board = this.board(session.workspaceId);
    const boardText = board.join('\n');
    const boardChanged = !threadId || this.lastBoard.get(session.sessionId) !== boardText;
    this.lastBoard.set(session.sessionId, boardText);
    const prompt = wakePrompt({
      project,
      wake: { trigger: wake.trigger, summary: wake.summary },
      board: boardChanged ? board : null,
      ...(threadId ? {} : { fresh: this.freshContext(session.sessionId, wake) }),
      askSummary,
    });
    // 角色说明只在新开会话时给；续用时会话里已经有了
    const instructions = solo ? soloInstructions(project, settings.soloIsolation) : coordinatorInstructions(project);
    this.deps.supervisor.enqueue(session.subtaskId, threadId ? { prompt, threadId } : { prompt, instructions });
  }

  /** 单人模式改完后：工作目录（独立 worktree 或项目目录）有未提交的改动时，审阅助手在只读会话里看一遍，结论作为一条消息。 */
  private async soloReview(session: MainSessionRecord): Promise<void> {
    const { store } = this;
    const cwd = store.tasks.getSubtask(session.subtaskId)?.worktreePath ?? store.tasks.getWorkspace(session.workspaceId)!.rootPath;
    const changed = await dirtyFiles(cwd).catch(() => []);
    if (changed.length === 0) return;
    this.deps.supervisor.enqueue(session.subtaskId, { prompt: soloReviewPrompt(cwd), review: { sessionId: session.sessionId, role: 'reviewer' } });
  }

  /** 本项目任务板：本项目最近的 10 个任务（不含对话任务），每行一个。 */
  private board(workspaceId: string): string[] {
    return this.store.tasks
      .listTasksOfWorkspace(workspaceId, 10)
      .map(({ task, subtaskStatus }: { task: TaskRecord; subtaskStatus: string }) => `- #${taskRef(task.id)} ${task.title}（${subtaskStatus}）`);
  }

  /** 新开原生会话时的上下文：最新摘要、最近的消息（不含这次的）、FTS5 检索到的这个会话的历史片段。 */
  private freshContext(sessionId: string, wake: WakeRecord) {
    const { coordinator, messages } = this.store;
    const recent = coordinator.recentMessages(sessionId, this.limits.contextMessages + 1);
    const shown = (wake.trigger === 'user_message' ? recent.slice(0, -1) : recent).slice(-this.limits.contextMessages);
    const shownIds = new Set(recent.map((m) => m.id));
    const history =
      wake.trigger === 'user_message'
        ? messages
            .search(wake.summary.slice(0, 50), 20)
            .filter((m) => m.sessionId === sessionId && !shownIds.has(m.id))
            .slice(0, this.limits.historySnippets)
            .map((m) => m.body)
        : [];
    return { summary: coordinator.latestSummary(sessionId)?.body ?? null, messages: shown.map((m) => ({ role: m.role, body: m.body })), history };
  }

  /** 唤醒的 Run 结束：成功记 done；原生会话续不上时放回队列（下次新开）；其余记 failed。 */
  private wakeEnded(wake: WakeRecord, status: string, reason: string | null): void {
    const { coordinator } = this.store;
    if (status === 'succeeded') return this.deps.publish(coordinator.setWake(wake.id, 'done').events);
    if (reason?.startsWith(RESUME_FAILED)) return this.deps.publish(coordinator.setWake(wake.id, 'pending', { note: '原生会话续不上，新开会话重试' }).events);
    this.deps.publish(coordinator.setWake(wake.id, 'failed', { note: reason ?? status }).events);
  }

  // ---- MCP 工具的后端 ----

  /** 这次 Run 所在的主会话（不是主会话的 Run 返回 undefined）。 */
  private mainSessionOfRun(runId: string): MainSessionRecord | undefined {
    const sessionId = this.store.runs.getRun(runId)?.sessionId;
    return sessionId ? this.store.coordinator.getMainSession(sessionId) : undefined;
  }

  /** 这次 Run 所在主会话正在跑的唤醒（不是主会话的 Run 返回 undefined）。 */
  private wakeOfRun(runId: string): { session: MainSessionRecord; wake: WakeRecord } | undefined {
    const session = this.mainSessionOfRun(runId);
    const wake = session && this.store.coordinator.runningWake(session.sessionId);
    return session && wake ? { session, wake } : undefined;
  }

  /**
   * 协调助手每调用一次工具计一次（模型请求次数的近似）：到软上限返回提醒；超过硬上限拒绝这次调用、中断这次 Run 并通知你。
   */
  onToolCall(runId: string): string | undefined {
    const found = this.wakeOfRun(runId);
    if (!found) return undefined;
    const count = this.store.coordinator.countRequest(found.wake.id);
    if (count > this.limits.wakeHardRequests) {
      if (count === this.limits.wakeHardRequests + 1) {
        this.deps.supervisor.cancel(found.session.subtaskId);
        this.recordDecision(found.session, 'wake_aborted', `这次唤醒的请求超过 ${this.limits.wakeHardRequests} 次上限，已中断：${found.wake.summary}`);
        this.notifyUser(found.session.sessionId, runId, `这次唤醒的请求超过 ${this.limits.wakeHardRequests} 次上限，已强制停止。需要的话请在对话里告诉它接着做什么。`, false);
      }
      throw new CodedError('bad_request', `这次唤醒的请求已超过 ${this.limits.wakeHardRequests} 次上限，已停止`);
    }
    return count >= this.limits.wakeSoftRequests ? `这次唤醒已用 ${count} 次请求（上限 ${this.limits.wakeHardRequests}），请尽快收尾` : undefined;
  }

  /** 没经过用户的决定记进自动处理记录单（挂在会话的对话任务上）。 */
  private recordDecision(session: MainSessionRecord, kind: 'wake_dropped' | 'wake_aborted', reason: string): void {
    this.deps.publish(
      this.store.autoDecisions.record({ workspaceId: session.workspaceId, taskId: session.taskId, planId: null, subtaskId: null, kind, reason }).events,
    );
  }

  /** notify_user：先在桌面，没人看时由渠道按审批升级规则外发。返回编号。 */
  notify(runId: string, message: string, question: boolean): { noticeId: number; ref: string } {
    const session = this.mainSessionOfRun(runId);
    if (!session) throw new CodedError('bad_request', '只有主会话里的协调助手能通知用户');
    const id = this.notifyUser(session.sessionId, runId, message, question);
    return { noticeId: id, ref: noticeRef(id) };
  }

  private notifyUser(sessionId: string, runId: string | null, body: string, question: boolean): number {
    const { record, events } = this.store.coordinator.addNotice({ sessionId, runId, kind: question ? 'question' : 'info', body });
    this.deps.publish(events);
    return record.id;
  }

  /**
   * decide_approval（审批分层，2026-11-26 已定）：只处理交给协调助手判断的项目外只读（不含敏感路径）；
   * 必须是同一个项目的主会话，发起读取的 Run 不能自己批。allow / deny 记审计 approval.coordinator，unsure 回到用户那里。
   */
  decideApproval(runId: string, approvalId: string, decision: 'allow' | 'deny' | 'unsure', reason: string): { status: string; next: string } {
    const { store } = this;
    const session = this.mainSessionOfRun(runId);
    if (!session) throw new CodedError('bad_request', '只有主会话里的协调助手能处理审批');
    const approval = store.runs.getApproval(approvalId);
    if (!approval) throw new CodedError('not_found', '审批不存在');
    if (approval.runId === runId) throw new CodedError('bad_request', '不能批自己发起的请求');
    const run = store.runs.getRun(approval.runId);
    const task = run && store.tasks.getTask(store.tasks.getSubtask(run.subtaskId)!.taskId);
    if (!task || task.workspaceId !== session.workspaceId) throw new CodedError('bad_request', '这条审批不在这个项目里');
    if (approval.status !== 'pending') return { status: approval.status, next: '这条审批已经处理过了' };
    if (approval.routedTo !== 'coordinator' || approval.access !== 'read' || approval.sensitive) {
      throw new CodedError('bad_request', '这条审批没有交给你判断（敏感路径、写入类的只能由用户批）');
    }
    const actor = `run:${runId}`;
    if (decision === 'unsure') {
      const change = store.runs.routeApproval(approvalId, null, `协调助手拿不准：${reason}`);
      if (change) this.deps.publish(change.events);
      store.audit.append(actor, 'approval.coordinator', approval.summary.slice(0, 200), `unsure: ${reason.slice(0, 200)}`);
      return { status: 'pending', next: '已交给用户处理' };
    }
    const change = store.runs.decideApproval(approval.id, approval.version, decision === 'allow' ? 'approved' : 'denied', 'coordinator');
    store.audit.append(actor, 'approval.coordinator', approval.summary.slice(0, 200), `${decision}: ${reason.slice(0, 200)}`);
    this.deps.publish(change.events);
    this.deps.supervisor.forwardDecision(change.record, decision === 'allow' ? 'allow_once' : 'deny');
    return { status: change.record.status, next: decision === 'allow' ? '已允许这一次' : '已拒绝' };
  }

  /** write_summary：滚动摘要带版本号存库；记下当时已完成的唤醒数，用来判断下一次。 */
  writeSummary(runId: string, body: string): { version: number } {
    const session = this.mainSessionOfRun(runId);
    if (!session) throw new CodedError('bad_request', '只有主会话里的协调助手能写摘要');
    const { record, events } = this.store.coordinator.writeSummary({ sessionId: session.sessionId, body, runId, wakesDone: this.store.coordinator.doneWakes(session.sessionId) });
    this.deps.publish(events);
    return { version: record.version };
  }
}
