import { randomBytes } from 'node:crypto';
import {
  CodedError,
  noticeRef,
  type NoticeRecord,
  type Card,
  type ChannelActionRecord,
  type ConversationRecord,
  type PersistentEvent,
  type StorePort,
  type TaskDetail,
  type TaskRecord,
  type WorkspaceRecord,
} from '@paldock/contracts';
import { canApproveRemotely, canConfirmPlanRemotely, taskIdPrefix, type P2Limits } from '@paldock/domain';
import type { CoordinatorService } from '../coordinator.js';
import type { PlanService } from '../plan-service.js';
import type { CreateTaskInput, TaskService } from '../task-service.js';
import {
  clip,
  confirmCancelCard,
  confirmCreateCard,
  confirmDoneCard,
  helpCard,
  notice,
  projectsCard,
  recentTasksCard,
  statusOf,
  SUBTASK_LABEL,
  taskCard,
  taskHistoryCard,
  taskRef,
  tasksCard,
  warning,
} from './cards.js';
import type { InboundOutcome } from './channel-hub.js';
import type { InboundContext, InboundHandler } from './inbound-processor.js';

export interface RemoteCommandsDeps {
  store: StorePort;
  tasks: TaskService;
  /**
   * 协调助手主会话（P3-10）：普通文字和对编号问题的答复交给它。缺省时（P2 的测试与单独使用渠道时）
   * 普通文字仍按 P2 的规则直接提议新建任务。
   */
  coordinator?: CoordinatorService;
  /** 计划确认卡片上的确认 / 退回。 */
  plans?: PlanService;
  publish(events: PersistentEvent[]): void;
  /** 回复卡片；subject 非空时更新本会话里同主题的那张卡片。 */
  reply(conversation: ConversationRecord, card: Card, subject?: string): void;
  now: () => Date;
  limits: P2Limits;
}

/** 命令里的任务编号（#a1b2c3）或分支名（paldock/<12 位>，前缀可配置，取最后一段）统一成 taskKey 的前缀。 */
const refOf = (arg: string) => arg.replace(/^#/, '').toLowerCase().split('/').at(-1) ?? '';

/** 群里只能看状态和建任务；继续、结束、取消、审批只在单聊（计划 P2-08、P2-10）。 */
const GROUP_ACTIONS = new Set<ChannelActionRecord['kind']>(['create_task', 'dismiss']);
const DM_ONLY_COMMANDS = new Set(['cancel', 'continue', 'done']);

/** 一张确认卡片的编号：卡片上各按钮的共同目标，也是更新这张卡片的主题。 */
const newProposalId = () => `prop_${randomBytes(9).toString('base64url')}`;

type Outcome = InboundOutcome | Promise<InboundOutcome>;

const errorText = (error: unknown) => (error instanceof CodedError ? error.message : '处理失败，请到电脑上查看');

/**
 * 已绑定账号在外部渠道能做的事：确定性命令（不经模型）、普通文字（单聊按当前任务续做，否则作为新任务目标、先发确认卡片），
 * 以及卡片按钮背后的一次性动作。所有改变状态的操作都调用与桌面相同的用例（TaskService）。
 */
export class RemoteCommands implements InboundHandler {
  constructor(private readonly deps: RemoteCommandsDeps) {}

  private get limits(): P2Limits {
    return this.deps.limits;
  }

  private get channels() {
    return this.deps.store.channels;
  }

  private say(ctx: InboundContext, card: Card, subject?: string): InboundOutcome {
    this.deps.reply(ctx.conversation, card, subject);
    return 'done';
  }

  /**
   * 普通文字：确定性命令照旧；单聊里用 /continue 选中、正在待命或可接续的当前任务，仍当作它的下一步（你用命令明确选的）；
   * 其余交给协调助手：先看是不是在回答它的编号问题（引用回复、以 Q 编号开头、本会话只有一个待答问题），
   * 认不出来又有多个待答问题时附上候选问题让它判断，不猜。
   */
  async text(ctx: InboundContext, text: string, replyTo?: string): Promise<InboundOutcome> {
    const trimmed = text.trim();
    if (trimmed.startsWith('/')) return this.command(ctx, trimmed);
    // 图片、文件等非文字消息由适配器转成空文本
    if (trimmed.length === 0) return this.say(ctx, notice('暂时只支持文字消息'));
    const current = ctx.conversation.kind === 'dm' ? this.detailOf(ctx.conversation.currentTaskId) : undefined;
    if (!this.deps.coordinator) return current ? this.instruct(ctx, current, trimmed) : this.proposeTask(ctx, trimmed);
    if (current && (current.actions.review || current.actions.continueFrom)) return this.instruct(ctx, current, trimmed);
    return this.toCoordinator(ctx, this.deps.coordinator, trimmed, replyTo);
  }

  /** 这句话在回答哪个编号问题：确定的返回问题编号（和去掉编号前缀后的答复），拿不准时返回候选问题。 */
  private questionOf(ctx: InboundContext, text: string, replyTo: string | undefined): { noticeId: number; text: string } | { candidates: NoticeRecord[] } | undefined {
    const { coordinator } = this.deps.store;
    const open = (id: number) => {
      const n = coordinator.getNotice(id);
      return n?.kind === 'question' && !n.answeredAt ? n : undefined;
    };
    const quoted = replyTo ? /^notice:(\d+)$/.exec(this.channels.subjectOfMessage(ctx.conversation.id, replyTo) ?? '') : null;
    if (quoted && open(Number(quoted[1]))) return { noticeId: Number(quoted[1]), text };
    const prefixed = /^Q(\d+)(?:[\s:：,，.。、]+|$)([\s\S]*)$/i.exec(text);
    if (prefixed && open(Number(prefixed[1]))) return { noticeId: Number(prefixed[1]), text: prefixed[2]!.trim() || text };
    const pending = coordinator.openQuestionsSentTo(ctx.conversation.id);
    if (pending.length === 1) return { noticeId: pending[0]!.id, text };
    return pending.length > 1 ? { candidates: pending } : undefined;
  }

  private toCoordinator(ctx: InboundContext, coordinator: CoordinatorService, text: string, replyTo: string | undefined): InboundOutcome {
    const { provider } = ctx.conversation;
    const question = this.questionOf(ctx, text, replyTo);
    if (question && 'noticeId' in question && coordinator.answerQuestion(question.noticeId, question.text, provider, ctx.eventId)) {
      return this.say(ctx, notice(`已把你的回复交给协调助手（${noticeRef(question.noticeId)}）`, '它看完会在这里回复你。'));
    }
    const workspace = this.defaultWorkspace(ctx.conversation);
    if (!workspace) return this.say(ctx, projectsCard(this.deps.store.tasks.listWorkspaces(), null));
    const sessionId = coordinator.externalSession(ctx.conversation, workspace.id);
    const summary =
      question && 'candidates' in question
        ? `${text}\n\n（这条消息可能是在回答你之前的问题：${question.candidates.map((n) => `${noticeRef(n.id)}「${n.body.slice(0, 80)}」`).join('；')}。请判断是哪一个；拿不准就问用户，不要猜。）`
        : text;
    coordinator.receiveExternal(sessionId, text, provider, ctx.eventId, summary);
    return this.say(ctx, notice('收到，已交给协调助手', `项目：${workspace.name}。它会在这里回复你；直接建任务请发 /new 内容。`));
  }

  /** 当前任务的详情；任务已不存在时当作没有当前任务。 */
  private detailOf(taskId: string | null): TaskDetail | undefined {
    if (!taskId) return undefined;
    try {
      return this.deps.tasks.getTask(taskId);
    } catch {
      return undefined;
    }
  }

  /**
   * 单聊里给当前任务的一句话，按服务端给出的可用操作（与桌面同一套规则）：待命中就是下一步指令（同一 worktree、同一会话）；
   * 已结束且可接续就基于它新建任务；阻塞时请到电脑上处理；其余已结束的当作新任务目标；执行中不建任务。继续不发确认卡片（P2-10）。
   */
  private async instruct(ctx: InboundContext, { task, subtask, actions }: TaskDetail, instruction: string): Promise<InboundOutcome> {
    const ref = `#${taskRef(task.id)}`;
    try {
      if (actions.review && subtask) {
        await this.deps.tasks.decideReview(subtask.id, subtask.version, 'rework', instruction);
        return this.say(ctx, notice(`${ref} 继续执行`, clip(instruction, 200), '完成后会在这里通知你；想另起新任务请发 /new 内容。'));
      }
      if (actions.continueFrom) {
        const input = { continuedFromTaskId: task.id, goal: instruction, idempotencyKey: `channel:${ctx.conversation.id}:${ctx.eventId}` };
        await this.startTask(ctx, input, (created) => `已新建任务 #${created}，接着 ${ref} 做`);
        return 'done';
      }
      if (actions.restart) return this.say(ctx, warning(`${ref} 被阻塞`, '请到电脑上恢复、重新开始或放弃；想另起新任务请发 /new 内容。'));
      if (!actions.cancel) return this.proposeTask(ctx, instruction);
      return this.say(ctx, notice(`${ref} 还在执行`, '这句话没有发出去，等它停下后再发；想另起新任务请发 /new 内容。', `/cancel ${ref} 可以取消。`));
    } catch (error) {
      return this.say(ctx, warning('没有完成', errorText(error)));
    }
  }

  /** 建任务（确认卡片上点了确认，或接续已结束的任务）：结果回发本会话；单聊里成为当前任务。 */
  private async startTask(
    ctx: InboundContext,
    input: Pick<CreateTaskInput, 'rootPath' | 'continuedFromTaskId' | 'goal' | 'idempotencyKey'>,
    head: (ref: string) => string,
    subject?: string,
  ): Promise<void> {
    const detail = await this.deps.tasks.createTask({ ...input, checkConfirmed: false, originConversationId: ctx.conversation.id });
    if (ctx.conversation.kind === 'dm') this.channels.setCurrentTask(ctx.conversation.id, detail.task.id);
    this.say(ctx, notice(head(taskRef(detail.task.id)), detail.task.title, '完成或需要处理时会在这里通知你。'), subject);
  }

  private command(ctx: InboundContext, text: string): Outcome {
    const [head = '', ...rest] = text.split(/\s+/);
    const name = head.slice(1).toLowerCase();
    const arg = rest.join(' ').trim();
    const group = ctx.conversation.kind === 'group';
    if (group && DM_ONLY_COMMANDS.has(name)) return this.say(ctx, warning('群里不能做这个操作', '继续、结束、取消任务请到单聊或电脑上操作。'));
    switch (name) {
      case 'start':
      case 'help':
        return this.say(ctx, helpCard(group));
      case 'projects':
        return this.say(ctx, projectsCard(this.deps.store.tasks.listWorkspaces(), ctx.conversation.defaultWorkspaceId));
      case 'use':
        return this.useWorkspace(ctx, arg);
      case 'tasks':
        return this.say(ctx, tasksCard(this.deps.store.tasks.listTasks(this.limits.taskListSize), ctx.conversation.currentTaskId));
      case 'status':
        return this.withTask(ctx, arg, (task) => {
          const detail = this.deps.tasks.getTask(task.id);
          return this.say(ctx, taskCard(detail.task, detail.workspace, statusOf(detail), detail.subtask?.statusReason ?? null));
        });
      case 'new':
        if (!arg) return this.say(ctx, notice('请带上新任务的目标', '例如：/new 给登录页加一个「记住我」'));
        return this.proposeTask(ctx, arg);
      case 'cancel':
        return this.withTask(ctx, arg, (task) => this.confirmCancel(ctx, task));
      case 'continue':
        return this.continueCommand(ctx, arg);
      case 'done':
        return this.withTask(ctx, arg, (task) => this.confirmDone(ctx, task));
      default:
        return this.say(ctx, notice('不认识这个命令', '发送 /help 查看可用命令。'));
    }
  }

  private useWorkspace(ctx: InboundContext, arg: string): InboundOutcome {
    const workspaces = this.deps.store.tasks.listWorkspaces();
    const index = Number(arg);
    const chosen = Number.isInteger(index) && index >= 1 ? workspaces[index - 1] : workspaces.find((w) => w.name === arg);
    if (!chosen) return this.say(ctx, projectsCard(workspaces, ctx.conversation.defaultWorkspaceId));
    const { conversation } = ctx;
    const change = this.channels.setConversation(conversation.id, conversation.version, {
      groupAllowed: conversation.groupAllowed,
      defaultWorkspaceId: chosen.id,
    });
    this.deps.publish(change.events);
    return this.say(ctx, notice(`默认项目：${chosen.name}`, '直接发一句话即可在这个项目里新建任务。'));
  }

  /**
   * 命令的目标任务：`#a1b2c3`、`a1b2c3` 或分支名 `paldock/<12 位>`，在最近的任务里按编号前缀匹配；
   * 单聊里不带编号时用当前任务。
   */
  private withTask(ctx: InboundContext, arg: string, fn: (task: TaskRecord) => Outcome): Outcome {
    const ref = refOf(arg);
    if (!ref) {
      const current = ctx.conversation.kind === 'dm' && ctx.conversation.currentTaskId ? this.deps.store.tasks.getTask(ctx.conversation.currentTaskId) : undefined;
      return current ? fn(current) : this.say(ctx, notice('请带上任务编号', '例如 /status #a1b2c3；发送 /tasks 查看编号。'));
    }
    const prefix = taskIdPrefix(ref);
    const matches = prefix ? this.deps.store.tasks.findTasksByIdPrefix(prefix, 2) : [];
    if (matches.length !== 1) return this.say(ctx, notice(matches.length === 0 ? '没有找到这个任务' : '编号不唯一，请多写几位'));
    return fn(matches[0]!);
  }

  /** /continue：不带参数列出最近的任务；带编号时设为当前任务，再带指令就直接继续。 */
  private async continueCommand(ctx: InboundContext, arg: string): Promise<InboundOutcome> {
    if (!arg) {
      const recent = this.deps.store.tasks.recentTasks(this.limits.taskListSize);
      // 列表卡片上的按钮共用一个目标：选了一个，其余作废（要看别的再发 /continue）
      const proposal = newProposalId();
      const select = (taskId: string) =>
        this.channels.createAction({ conversationId: ctx.conversation.id, kind: 'select_task', targetId: proposal, payload: taskId, ttlMs: this.limits.confirmActionTtlMs })
          .token;
      return this.say(ctx, recentTasksCard(recent, ctx.conversation.currentTaskId, this.deps.now(), select));
    }
    const [ref = '', ...rest] = arg.split(/\s+/);
    const instruction = rest.join(' ').trim();
    return this.withTask(ctx, ref, (task) => {
      const detail = this.select(ctx, task.id);
      return instruction ? this.instruct(ctx, detail, instruction) : this.say(ctx, taskHistoryCard(detail, this.deps.now()));
    });
  }

  /** 设为当前任务（之后这个单聊也会收到它的进度），返回它的详情。 */
  private select(ctx: InboundContext, taskId: string): TaskDetail {
    this.channels.setCurrentTask(ctx.conversation.id, taskId);
    return this.deps.tasks.getTask(taskId);
  }

  /** /done：只有待命中的任务能结束；先确认，点「结束任务」才提交。 */
  private confirmDone(ctx: InboundContext, task: TaskRecord): InboundOutcome {
    const detail = this.deps.tasks.getTask(task.id);
    const { subtask, actions } = detail;
    if (!actions.review || !subtask) {
      return this.say(ctx, notice(`#${taskRef(task.id)} 现在${SUBTASK_LABEL[statusOf(detail)]}`, '只有待命中的任务能结束。'));
    }
    // 以这张卡片为目标（不影响进度卡片上的「结束任务」）；子任务 ID 放在 payload，版本号核对先到者
    const proposal = newProposalId();
    const base = { conversationId: ctx.conversation.id, targetId: proposal, ttlMs: this.limits.confirmActionTtlMs };
    const confirm = this.channels.createAction({ ...base, kind: 'accept_review', targetVersion: subtask.version, payload: subtask.id });
    const dismiss = this.channels.createAction({ ...base, kind: 'dismiss', payload: '好的，任务继续待命。' });
    return this.say(ctx, confirmDoneCard(task, confirm.token, dismiss.token), proposal);
  }

  private confirmCancel(ctx: InboundContext, task: TaskRecord): InboundOutcome {
    const proposal = newProposalId();
    const base = { conversationId: ctx.conversation.id, targetId: proposal, ttlMs: this.limits.confirmActionTtlMs };
    const confirm = this.channels.createAction({ ...base, kind: 'cancel_task', payload: task.id });
    const dismiss = this.channels.createAction({ ...base, kind: 'dismiss', payload: '好的，不取消。' });
    return this.say(ctx, confirmCancelCard(task, confirm.token, dismiss.token), proposal);
  }

  /** 不以 / 开头的文字：在默认项目里新建任务，先发确认卡片（只有一个项目时直接用它）。 */
  private proposeTask(ctx: InboundContext, goal: string): InboundOutcome {
    const workspace = this.defaultWorkspace(ctx.conversation);
    if (!workspace) {
      return this.say(ctx, projectsCard(this.deps.store.tasks.listWorkspaces(), null));
    }
    const proposal = newProposalId();
    const base = { conversationId: ctx.conversation.id, targetId: proposal, ttlMs: this.limits.confirmActionTtlMs };
    const confirm = this.channels.createAction({ ...base, kind: 'create_task', payload: JSON.stringify({ workspaceId: workspace.id, goal }) });
    const dismiss = this.channels.createAction({ ...base, kind: 'dismiss', payload: '好的，不新建任务。' });
    return this.say(ctx, confirmCreateCard(workspace, goal, confirm.token, dismiss.token), proposal);
  }

  private defaultWorkspace(conversation: ConversationRecord): WorkspaceRecord | undefined {
    if (conversation.defaultWorkspaceId) return this.deps.store.tasks.getWorkspace(conversation.defaultWorkspaceId);
    const all = this.deps.store.tasks.listWorkspaces();
    return all.length === 1 ? all[0] : undefined;
  }

  /** 卡片按钮：令牌必须属于本会话、未过期、未用过；用掉后同一张卡片上的其他按钮一并作废。 */
  async action(ctx: InboundContext, token: string): Promise<InboundOutcome> {
    const action = this.channels.useAction(token, ctx.conversation.id);
    if (!action) {
      this.deps.publish([this.channels.audit(ctx.conversation.id, ctx.conversation.provider, 'invalid_action')]);
      this.say(ctx, notice('这个按钮已失效', '已经处理过、已过期，或者不属于这个会话。'));
      return 'rejected';
    }
    this.channels.voidActions(action.targetId);
    if (ctx.conversation.kind === 'group' && !GROUP_ACTIONS.has(action.kind)) {
      this.deps.publish([this.channels.audit(ctx.conversation.id, ctx.conversation.provider, 'not_allowed_here')]);
      this.say(ctx, warning('群里不能做这个操作', '请到单聊或电脑上处理。'));
      return 'rejected';
    }
    try {
      await this.perform(ctx, action);
    } catch (error) {
      this.say(ctx, warning('没有完成', errorText(error)));
    }
    return 'done';
  }

  private async perform(ctx: InboundContext, action: ChannelActionRecord): Promise<void> {
    const { tasks } = this.deps;
    switch (action.kind) {
      case 'dismiss':
        this.say(ctx, notice(action.payload ?? '好的。'), action.targetId);
        return;
      case 'create_task': {
        const { workspaceId, goal } = JSON.parse(action.payload!) as { workspaceId: string; goal: string };
        const workspace = this.deps.store.tasks.getWorkspace(workspaceId);
        if (!workspace) throw new CodedError('not_found', '项目已不存在');
        const input = { rootPath: workspace.rootPath, goal, idempotencyKey: `channel:${action.token}` };
        return this.startTask(ctx, input, (ref) => `已新建任务 #${ref}`, action.targetId);
      }
      case 'cancel_task': {
        const task = this.deps.store.tasks.getTask(action.payload!);
        tasks.cancelTask(action.payload!);
        // 来源就是本会话的任务，结果通知会发「已取消」，不再重复回复
        const head = task && task.originConversationId !== ctx.conversation.id ? `已取消 #${taskRef(task.id)}` : '正在取消…';
        this.say(ctx, notice(head), action.targetId);
        return;
      }
      case 'approve':
      case 'deny':
        return this.decideApproval(ctx, action);
      case 'accept_review':
        // 进度卡片上的按钮以子任务为目标；/done 确认卡片以卡片为目标，子任务在 payload
        await tasks.decideReview(action.payload ?? action.targetId, action.targetVersion!, 'accept');
        return;
      case 'continue_task': {
        const detail = this.select(ctx, action.targetId);
        const ref = `#${taskRef(action.targetId)}`;
        if (!detail.actions.review) this.say(ctx, notice(`已切换到 ${ref}`, `它现在${SUBTASK_LABEL[statusOf(detail)]}。`));
        else this.say(ctx, notice(`请直接回复 ${ref} 的下一步`, '你的下一句话会作为指令，在同一个工作目录里接着做。'));
        return;
      }
      case 'select_task':
        this.say(ctx, taskHistoryCard(this.select(ctx, action.payload!), this.deps.now()));
        return;
      case 'confirm_plan':
      case 'reject_plan':
        return this.decidePlan(ctx, action);
    }
  }

  /**
   * 计划确认卡片：确认受项目的远程审批等级约束（L1 只能确认不带检查命令的计划，L2 都能），在点的时候按当前等级重新判断；
   * 退回总是允许。先到者为准（计划版本号）；结果由计划状态事件统一更新卡片。
   */
  private async decidePlan(ctx: InboundContext, action: ChannelActionRecord): Promise<void> {
    const { store } = this.deps;
    const plans = this.deps.plans;
    const plan = store.plans.getPlan(action.targetId);
    const task = plan && store.tasks.getTask(plan.taskId);
    const workspace = task && store.tasks.getWorkspace(task.workspaceId);
    if (!plans || !plan || !workspace) throw new CodedError('not_found', '计划不存在');
    if (plan.status !== 'proposed' || plan.version !== action.targetVersion) throw new CodedError('conflict', '这个计划已经处理过了');
    if (action.kind === 'reject_plan') return plans.reject(plan.id, plan.version, '在手机上退回', ctx.conversation.provider);
    const hasChecks = store.plans.nodes(plan.id).some((n) => n.checkCommand !== null);
    if (!canConfirmPlanRemotely(workspace.remoteApprovalLevel, hasChecks)) {
      throw new CodedError('bad_request', hasChecks ? '这个计划带检查命令，按项目的远程审批等级只能在电脑上确认' : '这个项目的计划只能在电脑上确认');
    }
    await plans.confirm(plan.id, plan.version, undefined, ctx.conversation.provider);
  }

  /** 远程审批：只在已绑定的单聊里；项目的远程审批等级与审批类别都允许时才能批准，拒绝总是允许。 */
  private decideApproval(ctx: InboundContext, action: ChannelActionRecord): void {
    const context = this.channels.approvalContext(action.targetId);
    if (!context || context.approval.status !== 'pending') throw new CodedError('conflict', '这个审批已经处理过了');
    const approve = action.kind === 'approve';
    if (approve && !canApproveRemotely(context.remoteApprovalLevel, context.approval)) {
      throw new CodedError('bad_request', '这个审批只能在电脑上批准');
    }
    // 成功后卡片由审批决定事件统一更新（桌面、各渠道一致），这里不另外回复
    this.deps.tasks.decideApproval(context.approval.id, action.targetVersion!, approve ? 'allow_once' : 'deny', ctx.conversation.provider);
  }
}
