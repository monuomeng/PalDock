import { randomBytes } from 'node:crypto';
import {
  CodedError,
  type Card,
  type ChannelActionRecord,
  type ConversationRecord,
  type PersistentEvent,
  type StorePort,
  type TaskRecord,
  type WorkspaceRecord,
} from '@paldock/contracts';
import { canApproveRemotely, type P2Limits } from '@paldock/domain';
import type { TaskService } from '../task-service.js';
import {
  confirmCancelCard,
  confirmCreateCard,
  helpCard,
  notice,
  projectsCard,
  taskCard,
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
  limits: P2Limits;
}

/** 群里只能看状态和建任务；取消、审批、验收只在单聊（计划 P2-08）。 */
const GROUP_ACTIONS = new Set<ChannelActionRecord['kind']>(['create_task', 'dismiss']);

/** 一张确认卡片的编号：卡片上各按钮的共同目标，也是更新这张卡片的主题。 */
const newProposalId = () => `prop_${randomBytes(9).toString('base64url')}`;

const errorText = (error: unknown) => (error instanceof CodedError ? error.message : '处理失败，请到电脑上查看');

/**
 * 已绑定账号在外部渠道能做的事：确定性命令（不经模型）、「消息即任务目标」（先发确认卡片）、
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
    if (ctx.conversation.awaitingToken) return this.completeRework(ctx, trimmed);
    return this.proposeTask(ctx, trimmed);
  }

  private command(ctx: InboundContext, text: string): InboundOutcome {
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
        return this.say(ctx, tasksCard(this.deps.store.tasks.listTasks(this.limits.taskListSize)));
      case 'status':
        return this.withTask(ctx, arg, (task) => {
          const detail = this.deps.tasks.getTask(task.id);
          return this.say(ctx, taskCard(detail.task, detail.workspace, detail.subtask.status, detail.subtask.statusReason));
        });
      case 'cancel':
        if (group) return this.say(ctx, warning('群里不能取消任务', '请到单聊或电脑上操作。'));
        return this.withTask(ctx, arg, (task) => this.confirmCancel(ctx, task));
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

  /** `#a1b2c3` 或 `a1b2c3`，在最近的任务里按短编号前缀匹配。 */
  private withTask(ctx: InboundContext, arg: string, fn: (task: TaskRecord) => InboundOutcome): InboundOutcome {
    const ref = arg.replace(/^#/, '').toLowerCase();
    if (!ref) return this.say(ctx, notice('请带上任务编号', '例如 /status #a1b2c3；发送 /tasks 查看编号。'));
    const matches = this.deps.store.tasks.listTasks(50).filter(({ task }) => taskRef(task.id).startsWith(ref));
    if (matches.length !== 1) return this.say(ctx, notice(matches.length === 0 ? '没有找到这个任务' : '编号不唯一，请多写几位'));
    return fn(matches[0]!.task);
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
      case 'accept_review':
        await tasks.decideReview(action.targetId, action.targetVersion!, 'accept');
        return;
      case 'rework_review': {
        // 等用户回一段文字作为退回意见；令牌放在会话上，下一条非命令文字消耗它
        const note = this.channels.createAction({
          conversationId: ctx.conversation.id,
          kind: 'rework_note',
          targetId: action.targetId,
          targetVersion: action.targetVersion,
          ttlMs: this.limits.confirmActionTtlMs,
        });
        this.channels.setAwaiting(ctx.conversation.id, note.token);
        this.say(ctx, notice('请直接回复退回原因', '下一条消息会作为退回意见发给执行器（10 分钟内有效）。'));
        return;
      }
      case 'rework_note':
        // 只能经 completeRework 消耗，不会出现在按钮上
        throw new CodedError('bad_request', '这个按钮已失效');
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

  /** 「退回重做」之后的下一条文字：作为退回意见。令牌过期或子任务已变化时如实告知。 */
  private async completeRework(ctx: InboundContext, note: string): Promise<InboundOutcome> {
    const token = ctx.conversation.awaitingToken!;
    this.channels.setAwaiting(ctx.conversation.id, null);
    const action = this.channels.useAction(token, ctx.conversation.id);
    if (!action) return this.say(ctx, warning('退回意见没有用上', '这次验收已经在别处处理，或者等待意见的时间已过。这条消息没有建任务，需要的话请重新发送。'));
    try {
      await this.deps.tasks.decideReview(action.targetId, action.targetVersion!, 'rework', note);
      return this.say(ctx, notice('已退回重做', '执行器会按你的意见修改，完成后再通知你。'));
    } catch (error) {
      return this.say(ctx, warning('没有完成', errorText(error)));
    }
  }
}
