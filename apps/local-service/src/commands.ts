import type { TaskService } from '@paldock/application';
import type { CommandArgs, CommandName } from '@paldock/contracts';
import type { Store } from '@paldock/storage-sqlite';
import type { z } from 'zod';

/** 处理函数返回可序列化的结果；写入产生的事件由用例层直接广播。 */
export type Handlers = { [N in CommandName]: (args: z.output<(typeof CommandArgs)[N]>) => unknown };

export interface ServiceInfo {
  version: string;
  startedAt: string;
  interruptedRuns: number;
  runtime: string;
}

/** 命令 → 用例的映射。每个处理函数只做参数到用例调用的转换，不含业务规则。 */
export function createHandlers(store: Store, tasks: TaskService, info: ServiceInfo): Handlers {
  return {
    'service.status': () => info,
    'task.create': ({ rootPath, goal, check, checkConfirmed, idempotencyKey }) =>
      tasks.createTask({ rootPath, goal, check, checkConfirmed, idempotencyKey }),
    'task.list': ({ limit }) => tasks.listTasks(limit),
    'task.get': ({ taskId }) => tasks.getTask(taskId),
    'task.cancel': ({ taskId }) => tasks.cancelTask(taskId),
    'approval.decide': ({ approvalId, expectedVersion, decision }) => tasks.decideApproval(approvalId, expectedVersion, decision),
    'review.decide': ({ subtaskId, expectedVersion, decision, note }) => tasks.decideReview(subtaskId, expectedVersion, decision, note),
    'run.recover': ({ subtaskId, expectedVersion, action }) => tasks.recover(subtaskId, expectedVersion, action),
    'run.checkOutput': ({ runId }) => tasks.checkOutput(runId),
    'events.since': ({ afterSeq, limit }) => store.events.since(afterSeq, limit),
    'attention.list': () => store.attention.list(),
    'attention.markRead': ({ itemKind, itemId }) => store.attention.markRead(itemKind, itemId),
    'messages.search': ({ query, limit }) => store.messages.search(query, limit),
    'maintenance.backup': () => store.backup(),
  };
}
