import { randomBytes } from 'node:crypto';
import {
  CodedError,
  type Card,
  type ChannelActionRecord,
  type ConversationRecord,
  type PersistentEvent,
  type StorePort,
  type SubtaskRecord,
  type TaskRecord,
  type WorkspaceRecord,
} from '@paldock/contracts';
import { canApproveRemotely, type P2Limits } from '@paldock/domain';
import type { TaskService } from '../task-service.js';
import {
  clip,
  confirmCancelCard,
  confirmCreateCard,
  confirmDoneCard,
  helpCard,
  notice,
  projectsCard,
  recentTasksCard,
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
  publish(events: PersistentEvent[]): void;
  /** 回复卡片；subject 非空时更新本会话里同主题的那张卡片。 */
  reply(conversation: ConversationRecord, card: Card, subject?: string): void;
  now: () => Date;
  limits: P2Limits;
}

/** 单聊里的当前任务及其子任务。 */
interface Focus {
  task: TaskRecord;
  subtask: SubtaskRecord;
}

/** 任务的短编号或分支名（paldock/<12 位>）统一成去掉连字符的 ID 前缀。 */
const refOf = (arg: string) => arg.replace(/^#/, '').replace(/^paldock\//i, '').toLowerCase();
const idKey = (taskId: string) => taskId.replace(/^task_/, '').replaceAll('-', '');

/** 群里只能看状态和建任务；继续、结束、取消、审批只在单聊（计划 P2-08、P2-10）。 */
const GROUP_ACTIONS = new Set<ChannelActionRecord['kind']>(['create_task', 'dismiss']);

/** 一张确认卡片的编号：卡片上各按钮的共同目标，也是更新这张卡片的主题。 */
const newProposalId = () => `prop_${randomBytes(9).toString('base64url')}`;

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

  async text(ctx: InboundContext, text: string): Promise<InboundOutcome> {
    const trimmed = text.trim();
    if (trimmed.startsWith('/')) return this.command(ctx, trimmed);
    // 图片、文件等非文字消息由适配器转成空文本
    if (trimmed.length === 0) return this.say(ctx, notice('暂时只支持文字消息'));
    if (ctx.conversation.kind === 'group') return this.proposeTask(ctx, trimmed);
    const focus = this.focusOf(ctx.conversation.currentTaskId);
    return focus ? this.instruct(ctx, focus, trimmed) : this.proposeTask(ctx, trimmed);
  }

  private focusOf(taskId: string | null): Focus | undefined {
    const task = taskId ? this.deps.store.tasks.getTask(taskId) : undefined;
    const subtask = task && this.deps.store.tasks.getSubtaskOfTask(task.id);
    return task && subtask ? { task, subtask } : undefined;
  }

  /**
   * 单聊里给当前任务的一句话：待命中就是下一步指令（同一 worktree、同一会话）；已结束就基于它新建任务接着做；
   * 执行中、阻塞时不建任务，说明原因；失败、取消的任务没法接着做，当作新任务目标。继续不发确认卡片（P2-10）。
   */
  private async instruct(ctx: InboundContext, { task, subtask }: Focus, instruction: string): Promise<InboundOutcome> {
    const ref = `#${taskRef(task.id)}`;
    try {
      switch (subtask.status) {
        case 'review':
          await this.deps.tasks.decideReview(subtask.id, subtask.version, 'rework', instruction);
          return this.say(ctx, notice(`${ref} 继续执行`, clip(instruction, 200), '完成后会在这里通知你；想另起新任务请发 /new 内容。'));
        case 'succeeded':
          return await this.continueFrom(ctx, task, instruction);
        case 'blocked':
          return this.say(ctx, warning(`${ref} 被阻塞`, '请到电脑上恢复、重新开始或放弃；想另起新任务请发 /new 内容。'));
        case 'failed':
        case 'cancelled':
          return this.proposeTask(ctx, instruction);
        default:
          return this.say(ctx, notice(`${ref} 还在执行`, '这句话没有发出去，等它停下后再发；想另起新任务请发 /new 内容。', `/cancel ${ref} 可以取消。`));
      }
    } catch (error) {
      return this.say(ctx, warning('没有完成', errorText(error)));
    }
  }

  /** 基于已结束的任务新建任务：同一项目，worktree 从它的分支出发，成为当前任务。 */
  private async continueFrom(ctx: InboundContext, source: TaskRecord, goal: string): Promise<InboundOutcome> {
    const workspace = this.deps.store.tasks.getWorkspace(source.workspaceId);
    if (!workspace) throw new CodedError('not_found', '项目已不存在');
    const detail = await this.deps.tasks.createTask({
      rootPath: workspace.rootPath,
      goal,
      checkConfirmed: false,
      idempotencyKey: `channel:${ctx.conversation.id}:${ctx.eventId}`,
      originConversationId: ctx.conversation.id,
      continuedFromTaskId: source.id,
    });
    this.channels.setCurrentTask(ctx.conversation.id, detail.task.id);
    const head = `已新建任务 #${taskRef(detail.task.id)}，接着 #${taskRef(source.id)} 做`;
    return this.say(ctx, notice(head, detail.task.title, '完成或需要处理时会在这里通知你。'));
  }

  private command(ctx: InboundContext, text: string): InboundOutcome | Promise<InboundOutcome> {
    const [head = '', ...rest] = text.split(/\s+/);
    const name = head.slice(1).toLowerCase();
    const arg = rest.join(' ').trim();
    const group = ctx.conversation.kind === 'group';
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
          return this.say(ctx, taskCard(detail.task, detail.workspace, detail.subtask.status, detail.subtask.statusReason));
        });
      case 'new':
        if (!arg) return this.say(ctx, notice('请带上新任务的目标', '例如：/new 给登录页加一个「记住我」'));
        return this.proposeTask(ctx, arg);
      case 'cancel':
      case 'continue':
      case 'done':
        if (group) return this.say(ctx, warning('群里不能做这个操作', '继续、结束、取消任务请到单聊或电脑上操作。'));
        if (name === 'cancel') return this.withTask(ctx, arg, (task) => this.confirmCancel(ctx, task));
        return name === 'continue' ? this.continueCommand(ctx, arg) : this.withTask(ctx, arg, (task) => this.confirmDone(ctx, task));
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
  private withTask<T extends InboundOutcome | Promise<InboundOutcome>>(ctx: InboundContext, arg: string, fn: (task: TaskRecord) => T): T | InboundOutcome {
    const ref = refOf(arg);
    if (!ref) {
      const current = ctx.conversation.kind === 'dm' ? this.focusOf(ctx.conversation.currentTaskId) : undefined;
      return current ? fn(current.task) : this.say(ctx, notice('请带上任务编号', '例如 /status #a1b2c3；发送 /tasks 查看编号。'));
    }
    const matches = this.deps.store.tasks.listTasks(50).filter(({ task }) => idKey(task.id).startsWith(ref));
    if (matches.length !== 1) return this.say(ctx, notice(matches.length === 0 ? '没有找到这个任务' : '编号不唯一，请多写几位'));
    return fn(matches[0]!.task);
  }

  /** /continue：不带参数列出最近的任务；带编号时设为当前任务，再带指令就直接继续。 */
  private async continueCommand(ctx: InboundContext, arg: string): Promise<InboundOutcome> {
    if (!arg) {
      const recent = this.deps.store.tasks.recentTasks(this.limits.taskListSize);
      const select = (taskId: string) =>
        this.channels.createAction({ conversationId: ctx.conversation.id, kind: 'select_task', targetId: taskId, ttlMs: this.limits.confirmActionTtlMs }).token;
      return this.say(ctx, recentTasksCard(recent, ctx.conversation.currentTaskId, this.deps.now(), select));
    }
    const [ref = '', ...rest] = arg.split(/\s+/);
    const instruction = rest.join(' ').trim();
    return this.withTask(ctx, ref, (task) => {
      const focus = this.select(ctx, task.id);
      return instruction && focus ? this.instruct(ctx, focus, instruction) : this.showHistory(ctx, task.id);
    });
  }

  /** 设为当前任务；之后这个单聊也会收到它的进度。 */
  private select(ctx: InboundContext, taskId: string): Focus | undefined {
    this.channels.setCurrentTask(ctx.conversation.id, taskId);
    return this.focusOf(taskId);
  }

  private showHistory(ctx: InboundContext, taskId: string): InboundOutcome {
    return this.say(ctx, taskHistoryCard(this.deps.tasks.getTask(taskId), this.deps.now()));
  }

  /** /done：只有待命中的任务能结束；先确认，点「结束任务」才提交。 */
  private confirmDone(ctx: InboundContext, task: TaskRecord): InboundOutcome {
    const subtask = this.deps.store.tasks.getSubtaskOfTask(task.id)!;
    if (subtask.status !== 'review') {
      return this.say(ctx, notice(`#${taskRef(task.id)} 现在${SUBTASK_LABEL[subtask.status]}`, '只有待命中的任务能结束。'));
    }
    // 两个按钮都以子任务为目标：点了其一另一个作废；任务离开待命时一并作废
    const base = { conversationId: ctx.conversation.id, targetId: subtask.id, ttlMs: this.limits.confirmActionTtlMs };
    const confirm = this.channels.createAction({ ...base, kind: 'accept_review', targetVersion: subtask.version });
    const dismiss = this.channels.createAction({ ...base, kind: 'dismiss', payload: '好的，任务继续待命。' });
    return this.say(ctx, confirmDoneCard(task, confirm.token, dismiss.token), subtask.id);
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
        const detail = await tasks.createTask({
          rootPath: workspace.rootPath,
          goal,
          checkConfirmed: false,
          idempotencyKey: `channel:${action.token}`,
          originConversationId: ctx.conversation.id,
        });
        if (ctx.conversation.kind === 'dm') this.channels.setCurrentTask(ctx.conversation.id, detail.task.id);
        this.say(ctx, notice(`已新建任务 #${taskRef(detail.task.id)}`, detail.task.title, '完成或需要处理时会在这里通知你。'), action.targetId);
        return;
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
      case 'accept_review': {
        // 结束任务：提交到分支；结束的是当前任务时清掉，下一句话不再接着它做
        await tasks.decideReview(action.targetId, action.targetVersion!, 'accept');
        const taskId = this.deps.store.tasks.getSubtask(action.targetId)?.taskId;
        if (taskId && ctx.conversation.currentTaskId === taskId) this.channels.setCurrentTask(ctx.conversation.id, null);
        return;
      }
      case 'continue_task': {
        const focus = this.select(ctx, action.targetId);
        const ref = `#${taskRef(action.targetId)}`;
        if (focus?.subtask.status !== 'review') {
          this.say(ctx, notice(`已切换到 ${ref}`, `它现在${focus ? SUBTASK_LABEL[focus.subtask.status] : '不存在'}。`));
          return;
        }
        this.say(ctx, notice(`请直接回复 ${ref} 的下一步`, '你的下一句话会作为指令，在同一个工作目录里接着做。'));
        return;
      }
      case 'select_task':
        this.select(ctx, action.targetId);
        this.showHistory(ctx, action.targetId);
        return;
    }
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
