import type { AgentService, ChannelService, CoordinatorService, IntegrationService, PlanService, RecoveryService, TaskService } from '@paldock/application';
import type { CommandArgs, CommandName, CommandResultOf } from '@paldock/contracts';
import type { Store } from '@paldock/storage-sqlite';
import type { z } from 'zod';

/** 处理函数的返回类型由 contracts 的 CommandResults 约束；写入产生的事件由用例层直接广播。 */
export type Handlers = {
  [N in CommandName]: (args: z.output<(typeof CommandArgs)[N]>) => CommandResultOf<N> | Promise<CommandResultOf<N>>;
};

export type ServiceInfo = CommandResultOf<'service.status'>;

/** 命令 → 用例的映射。每个处理函数只做参数到用例调用的转换，不含业务规则。 */
export function createHandlers(
  store: Store,
  tasks: TaskService,
  plans: PlanService,
  integration: IntegrationService,
  coordinator: CoordinatorService,
  recovery: RecoveryService,
  channels: ChannelService, agents: AgentService, info: ServiceInfo): Handlers {
  return {
    'service.status': () => info,
    'recovery.report': () => recovery.report(),
    'task.create': ({ rootPath, goal, check, checkConfirmed, idempotencyKey, continuedFromTaskId }) =>
      tasks.createTask({ rootPath, goal, check, checkConfirmed, idempotencyKey, continuedFromTaskId }),
    'task.list': ({ limit }) => tasks.listTasks(limit),
    'task.get': ({ taskId }) => tasks.getTask(taskId),
    'task.cancel': ({ taskId }) => tasks.cancelTask(taskId),
    'approval.decide': ({ approvalId, expectedVersion, decision }) => tasks.decideApproval(approvalId, expectedVersion, decision),
    'review.decide': ({ subtaskId, expectedVersion, decision, note }) => tasks.decideReview(subtaskId, expectedVersion, decision, note),
    'run.recover': ({ subtaskId, expectedVersion, action }) => tasks.recover(subtaskId, expectedVersion, action),
    'run.checkOutput': ({ runId }) => tasks.checkOutput(runId),
    'chat.sessions': ({ workspaceId }) => coordinator.sessions(workspaceId),
    'chat.newSession': ({ workspaceId, title }) => coordinator.newSession(workspaceId, title),
    'chat.get': ({ sessionId, taskId, limit }) => coordinator.detail(sessionId ?? coordinator.sessionOfConversation(taskId!), limit),
    'chat.send': ({ sessionId, text, idempotencyKey }) => coordinator.send(sessionId, text, idempotencyKey),
    'notice.ack': ({ sessionId }) => coordinator.ack(sessionId),
    'merge.redo': ({ subtaskId, expectedVersion }) => integration.redo(subtaskId, expectedVersion),
    'plan.confirm': ({ planId, expectedVersion, note }) => plans.confirm(planId, expectedVersion, note),
    'plan.editNode': ({ planId, expectedVersion, edit }) => plans.editNode(planId, expectedVersion, edit),
    'workspace.setAutoPolicy': ({ workspaceId, expectedVersion, policy }) => tasks.setAutoPolicy(workspaceId, expectedVersion, policy),
    'auto.list': ({ workspaceId, limit }) => store.autoDecisions.list(workspaceId ?? null, limit),
    'plan.reject': ({ planId, expectedVersion, note }) => plans.reject(planId, expectedVersion, note),
    'events.since': ({ afterSeq, limit }) => store.events.since(afterSeq, limit),
    'attention.list': () => store.attention.list(),
    'attention.markRead': ({ itemKind, itemId }) => store.attention.markRead(itemKind, itemId),
    'messages.search': ({ query, limit }) => store.messages.search(query, limit),
    'maintenance.backup': () => store.backup(),
    'workspace.list': () => store.tasks.listWorkspaces(),
    'workspace.add': ({ rootPath }) => tasks.addWorkspace(rootPath),
    'workspace.setRemoteApprovalLevel': ({ workspaceId, expectedVersion, level }) => tasks.setRemoteApprovalLevel(workspaceId, expectedVersion, level),
    'workspace.setPrepareCommand': ({ workspaceId, expectedVersion, command }) => tasks.setPrepareCommand(workspaceId, expectedVersion, command),
    'channel.overview': () => channels.overview(),
    'channel.configure': ({ provider, expectedVersion, enabled, proxyUrl, appId, secret, forgetCredential }) =>
      channels.configure({
        provider,
        expectedVersion,
        enabled,
        proxyUrl,
        forgetCredential,
        ...(secret ? { credential: { user: provider === 'feishu' ? appId! : 'bot', secret } } : {}),
      }),
    'channel.pairings': () => channels.listPairings(),
    'channel.decidePairing': ({ code, approve }) => channels.decidePairing(code, approve),
    'channel.accounts': () => channels.listAccounts(),
    'channel.setAccountStatus': ({ accountId, expectedVersion, status }) => channels.setAccountStatus(accountId, expectedVersion, status),
    'channel.groups': () => channels.listGroups(),
    'channel.setGroupAllowed': ({ conversationId, expectedVersion, allowed }) => channels.setGroupAllowed(conversationId, expectedVersion, allowed),
    'agent.settings': () => agents.settings(),
    'agent.setExecutor': ({ role, expectedVersion, executor }) => agents.setExecutor(role, expectedVersion, executor),
    'agent.overrides': ({ workspaceId }) => agents.overrides(workspaceId),
    'agent.setOverride': ({ workspaceId, role, executor }) => agents.setOverride(workspaceId, role, executor),
  };
}
