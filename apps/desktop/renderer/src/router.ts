/**
 * 基于 hash 的路由：#/attention、#/chat[?ws=|session=|task=]、#/tasks、#/new[?from=<taskId>]、#/settings、#/task/<id>?run=<runId>。
 * 重启或刷新后同一个地址仍能定位到同一对象（对象都在服务端持久化）。
 */
export type Route =
  | { view: 'attention' }
  | { view: 'chat'; workspaceId: string | undefined; sessionId: string | undefined; taskId: string | undefined }
  | { view: 'tasks' }
  | { view: 'new'; fromTaskId: string | undefined }
  | { view: 'settings' }
  | { view: 'task'; taskId: string; runId: string | undefined };

export function currentRoute(): Route {
  const [path = '', query = ''] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'task' && parts[1]) {
    return { view: 'task', taskId: decodeURIComponent(parts[1]), runId: new URLSearchParams(query).get('run') ?? undefined };
  }
  if (parts[0] === 'chat') {
    const q = new URLSearchParams(query);
    return { view: 'chat', workspaceId: q.get('ws') ?? undefined, sessionId: q.get('session') ?? undefined, taskId: q.get('task') ?? undefined };
  }
  if (parts[0] === 'new') return { view: 'new', fromTaskId: new URLSearchParams(query).get('from') ?? undefined };
  if (parts[0] === 'tasks' || parts[0] === 'settings') return { view: parts[0] };
  return { view: 'attention' };
}

export function taskLink(taskId: string, runId?: string | null): string {
  return `#/task/${encodeURIComponent(taskId)}${runId ? `?run=${encodeURIComponent(runId)}` : ''}`;
}

/** 对话页：指定项目（取它的第一个会话）、会话，或对话任务（「待我处理」里的通知）。 */
export function chatLink(target: { workspaceId?: string; sessionId?: string; taskId?: string } = {}): string {
  const q = new URLSearchParams();
  if (target.workspaceId) q.set('ws', target.workspaceId);
  if (target.sessionId) q.set('session', target.sessionId);
  if (target.taskId) q.set('task', target.taskId);
  const s = q.toString();
  return `#/chat${s ? `?${s}` : ''}`;
}

/** 基于一个已结束的任务新建任务。 */
export const continueLink = (taskId: string) => `#/new?from=${encodeURIComponent(taskId)}`;

export function navigate(hash: string): void {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}
