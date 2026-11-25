import { CodedError, type Change, type PersistentEvent, type StorePort, type SubtaskRecord, type SubtaskStatus } from '@paldock/contracts';
import { taskMachine, taskPath, taskStatusOf } from '@paldock/domain';

/**
 * 内部状态推进：按当前版本迁移（本地服务是唯一写者，同步执行，不会与自己冲突），已在目标状态时不写。
 * 用户发起的操作带客户端看到的版本号，由调用方直接调用仓储的 transition。
 * 任务状态不单独决定，由它的子任务推导（settleTask）；单子任务和任务图同一条规则。
 */

/**
 * 按子任务推导任务状态并写入（必要时按状态机走中间状态）。子任务变化后调用，reason 记在最后一步。
 * 任务已结束、或推导结果从当前状态走不到时不写。
 */
export function settleTask(store: StorePort, taskId: string, reason?: string): PersistentEvent[] {
  let task = store.tasks.getTask(taskId);
  if (!task) throw new CodedError('not_found', `任务不存在：${taskId}`);
  if (taskMachine.isTerminal(task.status)) return [];
  const steps = taskPath(task.status, taskStatusOf(task.status, store.tasks.listSubtasks(taskId).map((s) => s.status))) ?? [];
  const events: PersistentEvent[] = [];
  steps.forEach((to, i) => {
    const change = store.tasks.transitionTask(task!.id, task!.version, to, i === steps.length - 1 ? reason : undefined);
    task = change.record;
    events.push(...change.events);
  });
  return events;
}

export function moveSubtask(store: StorePort, subtaskId: string, to: SubtaskStatus, reason?: string): Change<SubtaskRecord> {
  const subtask = store.tasks.getSubtask(subtaskId);
  if (!subtask) throw new CodedError('not_found', `子任务不存在：${subtaskId}`);
  if (subtask.status === to) return { record: subtask, events: [] };
  return store.tasks.transitionSubtask(subtask.id, subtask.version, to, reason);
}

/** 用户操作的前置校验：子任务存在、处于期望状态、版本与客户端看到的一致（先到者为准）。 */
export function requireSubtask(store: StorePort, subtaskId: string, status: SubtaskStatus, expectedVersion: number): SubtaskRecord {
  const subtask = store.tasks.getSubtask(subtaskId);
  if (!subtask) throw new CodedError('not_found', '子任务不存在');
  if (subtask.status !== status || subtask.version !== expectedVersion) throw new CodedError('conflict', '子任务状态已变化，请刷新');
  return subtask;
}
