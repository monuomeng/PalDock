import type { CommandArgs, CommandName, PersistentEvent } from '@paldock/contracts';
import type { Change, Store } from '@paldock/storage-sqlite';
import type { z } from 'zod';

export interface CommandOutcome {
  value: unknown;
  /** 同事务写入的持久事件，由服务广播给所有已认证客户端；只读命令为空。 */
  events: PersistentEvent[];
}

export type Handlers = { [N in CommandName]: (args: z.output<(typeof CommandArgs)[N]>) => CommandOutcome };

export interface ServiceInfo {
  version: string;
  startedAt: string;
  interruptedRuns: number;
}

const read = (value: unknown): CommandOutcome => ({ value, events: [] });
const write = <T>({ record, events }: Change<T>): CommandOutcome => ({ value: record, events });

/** 命令 → 用例的映射。每个处理函数只做参数到仓储调用的转换，不含业务规则。 */
export function createHandlers(store: Store, info: ServiceInfo): Handlers {
  return {
    'service.status': () => read(info),
    'workspace.create': ({ name, rootPath }) => read(store.tasks.createWorkspace(name, rootPath)),
    'task.create': ({ workspaceId, title }) => write(store.tasks.createTask(workspaceId, title)),
    'task.transition': ({ taskId, expectedVersion, to, reason }) =>
      write(store.tasks.transitionTask(taskId, expectedVersion, to, reason)),
    'events.since': ({ afterSeq, limit }) => read(store.events.since(afterSeq, limit)),
    'attention.list': () => read(store.attention.list()),
    'attention.markRead': ({ itemKind, itemId }) => {
      store.attention.markRead(itemKind, itemId);
      return read(null);
    },
    'messages.search': ({ query, limit }) => read(store.messages.search(query, limit)),
  };
}
