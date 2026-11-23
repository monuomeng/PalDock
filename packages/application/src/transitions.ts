import { CodedError, type Change, type PersistentEvent, type StorePort, type SubtaskRecord, type SubtaskStatus, type TaskStatus } from '@paldock/contracts';

/**
 * 内部状态推进：按当前版本迁移（本地服务是唯一写者，同步执行，不会与自己冲突），已在目标状态时不写。
 * 用户发起的操作带客户端看到的版本号，由调用方直接调用仓储的 transition。
 * P1 的任务状态只跟随子任务做粗粒度变化：queued → running → blocked / succeeded / failed / cancelled。
 */

export function moveTask(store: StorePort, taskId: string, to: TaskStatus, reason?: string): PersistentEvent[] {
  const task = store.tasks.getTask(taskId);
  if (!task) throw new CodedError('not_found', `任务不存在：${taskId}`);
  return task.status === to ? [] : store.tasks.transitionTask(task.id, task.version, to, reason).events;
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
