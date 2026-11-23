import type { CommandArgs, CommandName, PersistentEvent } from '@paldock/contracts';
import type { Store } from '@paldock/storage-sqlite';
import type { z } from 'zod';

export interface CommandOutcome {
  value: unknown;
  /** 同事务写入的持久事件，由服务广播给所有已认证客户端。 */
  events?: PersistentEvent[];
}

type Handlers = { [N in CommandName]: (args: z.output<(typeof CommandArgs)[N]>) => CommandOutcome };

export interface ServiceInfo {
  version: string;
  startedAt: string;
  interruptedRuns: number;
}

/** 命令 → 用例的映射。每个处理函数只做参数到仓储调用的转换，不含业务规则。 */
export function createHandlers(store: Store, info: ServiceInfo): Handlers {
  const change = <T>({ record, events }: { record: T; events: PersistentEvent[] }) => ({ value: record, events });
  return {
    'service.status': () => ({ value: info }),
    'workspace.create': ({ name, rootPath }) => ({ value: store.tasks.createWorkspace(name, rootPath) }),
    'task.create': ({ workspaceId, title }) => change(store.tasks.createTask(workspaceId, title)),
    'task.transition': ({ taskId, expectedVersion, to, reason }) =>
      change(store.tasks.transitionTask(taskId, expectedVersion, to, reason)),
    'events.since': ({ afterSeq, limit }) => ({ value: store.events.since(afterSeq, limit) }),
    'attention.list': () => ({ value: store.attention.list() }),
    'attention.markRead': ({ itemKind, itemId }) => {
      store.attention.markRead(itemKind, itemId);
      return { value: null };
    },
    'messages.search': ({ query, limit }) => ({ value: store.messages.search(query, limit) }),
  };
}
