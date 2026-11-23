import type { Change, PersistentEvent, StorePort, SubtaskRecord, SubtaskStatus, TaskStatus } from '@paldock/contracts';
import { CodedError } from '@paldock/contracts';

/**
 * 内部状态推进：读当前版本后迁移（本地服务是唯一写者，同步执行，不会与自己冲突）。
 * 用户发起的操作仍带客户端看到的版本号，由调用方先校验。
 */

/** P1 的任务状态只跟随子任务做粗粒度变化；blocked → running 需经 queued。 */
const TASK_PATHS: Partial<Record<TaskStatus, Partial<Record<TaskStatus, TaskStatus[]>>>> = {
  blocked: { running: ['queued', 'running'] },
};

export function moveTask(store: StorePort, taskId: string, to: TaskStatus, reason?: string): PersistentEvent[] {
  let task = store.tasks.getTask(taskId);
  if (!task) throw new CodedError('not_found', `任务不存在：${taskId}`);
  if (task.status === to) return [];
  const events: PersistentEvent[] = [];
  for (const step of TASK_PATHS[task.status]?.[to] ?? [to]) {
    const change = store.tasks.transitionTask(task.id, task.version, step, reason);
    task = change.record;
    events.push(...change.events);
  }
  return events;
}

export function moveSubtask(store: StorePort, subtaskId: string, to: SubtaskStatus, reason?: string): Change<SubtaskRecord> {
  const subtask = store.tasks.getSubtask(subtaskId);
  if (!subtask) throw new CodedError('not_found', `子任务不存在：${subtaskId}`);
  if (subtask.status === to) return { record: subtask, events: [] };
  return store.tasks.transitionSubtask(subtask.id, subtask.version, to, reason);
}
