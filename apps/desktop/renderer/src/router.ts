/**
 * 基于 hash 的路由：#/attention、#/tasks、#/new、#/settings、#/task/<id>?run=<runId>。
 * 重启或刷新后同一个地址仍能定位到同一对象（对象都在服务端持久化）。
 */
export type Route =
  | { view: 'attention' }
  | { view: 'tasks' }
  | { view: 'new' }
  | { view: 'settings' }
  | { view: 'task'; taskId: string; runId: string | undefined };

export function currentRoute(): Route {
  const [path = '', query = ''] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'task' && parts[1]) {
    return { view: 'task', taskId: decodeURIComponent(parts[1]), runId: new URLSearchParams(query).get('run') ?? undefined };
  }
  if (parts[0] === 'tasks' || parts[0] === 'new' || parts[0] === 'settings') return { view: parts[0] };
  return { view: 'attention' };
}

export function taskLink(taskId: string, runId?: string | null): string {
  return `#/task/${encodeURIComponent(taskId)}${runId ? `?run=${encodeURIComponent(runId)}` : ''}`;
}

export function navigate(hash: string): void {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}
