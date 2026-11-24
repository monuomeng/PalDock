import type { PersistentEvent } from '@paldock/contracts';
import { bridge, call, type HostStatus } from './api.js';
import { h } from './dom.js';
import { appendLive, clearLive } from './live-output.js';
import { currentRoute, type Route } from './router.js';
import { attentionView } from './views/attention.js';
import { newTaskView } from './views/new-task.js';
import { settingsView } from './views/settings.js';
import { taskDetailView } from './views/task-detail.js';
import { tasksView } from './views/tasks.js';

const $ = (id: string) => document.getElementById(id)!;
let connected = false;
/** 任务详情页涉及的聚合 ID；为空表示当前页不是详情页。 */
let detailScope = new Set<string>();

function statusText(status: HostStatus): string {
  switch (status.state) {
    case 'starting':
      return '本地服务启动中…';
    case 'ready':
      return '本地服务已就绪，连接中…';
    case 'connected':
      return '已连接';
    case 'restarting':
      return `本地服务已退出，${Math.round(status.inMs / 1000)} 秒后重启`;
    case 'stopped':
      return `本地服务已停止（${status.message ?? status.reason}），请重启应用`;
  }
}

/** 页头常驻的连接状态，用 aria-live 播报。 */
function showStatus(status: HostStatus): void {
  connected = status.state === 'connected';
  const banner = $('connection');
  banner.textContent = statusText(status);
  banner.className = connected ? 'ok' : 'down';
  if (connected) scheduleRender();
}

async function updateAttentionCount(): Promise<void> {
  const items = await call('attention.list', {}).catch(() => undefined);
  if (!items) return;
  $('attention-count').textContent = items.length > 0 ? String(items.length) : '';
  $('executor-warning').hidden = !items.some((i) => i.kind === 'unconfirmed_run');
}

/** 重新渲染时保留正在输入的内容和焦点（标了 data-keep 的控件）。 */
function preserveInputs(target: HTMLElement, next: HTMLElement): void {
  const kept = new Map<string, string>();
  const isBox = (el: HTMLInputElement | HTMLTextAreaElement): el is HTMLInputElement => el.type === 'checkbox';
  for (const el of target.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-keep]')) kept.set(el.dataset.keep!, isBox(el) ? String(el.checked) : el.value);
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.keep;
  for (const el of next.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-keep]')) {
    const value = kept.get(el.dataset.keep!);
    if (value === undefined) continue;
    if (isBox(el)) el.checked = value === 'true';
    else el.value = value;
  }
  target.replaceChildren(next);
  if (focused) next.querySelector<HTMLElement>(`[data-keep="${CSS.escape(focused)}"]`)?.focus();
}

async function buildView(route: Route): Promise<HTMLElement> {
  detailScope = new Set();
  switch (route.view) {
    case 'attention':
      return attentionView();
    case 'tasks':
      return tasksView();
    case 'new':
      return newTaskView(route.fromTaskId);
    case 'settings':
      return settingsView(scheduleRender);
    case 'task': {
      const { element, ids } = await taskDetailView(route.taskId, route.runId, scheduleRender);
      detailScope = ids;
      return element;
    }
  }
}

let renderSeq = 0;
async function renderRoute(route: Route): Promise<void> {
  const seq = ++renderSeq;
  const main = $('content');
  for (const link of document.querySelectorAll<HTMLAnchorElement>('nav a')) {
    link.toggleAttribute('aria-current', link.dataset.view === route.view);
  }
  if (!connected && route.view !== 'new') return main.replaceChildren(h('p', { class: 'empty' }, '等待本地服务连接…'));
  try {
    const view = await buildView(route);
    if (seq === renderSeq) preserveInputs(main, view); // 期间有更新的渲染时丢弃这次结果
  } catch (error) {
    if (seq === renderSeq) main.replaceChildren(h('p', { class: 'error', role: 'alert' }, (error as Error).message));
  }
}

// 同一轮内的多个事件合并为一次渲染；新建任务表单不随事件重绘
let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    const route = currentRoute();
    if (route.view !== 'new') void renderRoute(route);
    void updateAttentionCount();
  });
}

/** 这些事件会改变「待我处理」或任务列表；其余（消息、证据、提示）只影响详情页。 */
const LIST_EVENTS = new Set<PersistentEvent['type']>([
  'task.created',
  'task.status_changed',
  'subtask.status_changed',
  'run.created',
  'run.status_changed',
  'approval.requested',
  'approval.decided',
  'review.decided',
]);

/** 设置页关心的事件：渠道设置、配对、账号、群白名单、项目远程审批等级。 */
const isSettingsEvent = (event: PersistentEvent) =>
  (event.type.startsWith('channel.') && event.type !== 'channel.inbound_rejected') || event.type === 'workspace.settings_changed';

/** 只在事件涉及当前页面时重绘；流式输出的检查点只清空临时缓冲（文字已在屏幕上）。 */
function isRelevant(event: PersistentEvent): boolean {
  if (event.type === 'message.created') return false;
  const route = currentRoute();
  if (route.view === 'settings') return isSettingsEvent(event);
  if (route.view !== 'task') return LIST_EVENTS.has(event.type);
  return (
    detailScope.has(event.aggregateId) ||
    (event.type === 'run.created' && detailScope.has(event.payload.subtaskId)) ||
    (event.type === 'approval.requested' && detailScope.has(event.payload.runId))
  );
}

function onEvent(event: PersistentEvent): void {
  if (event.type === 'message.created' && event.payload.runId) clearLive(event.payload.runId);
  if (isRelevant(event)) scheduleRender();
  else if (LIST_EVENTS.has(event.type)) void updateAttentionCount();
}

window.addEventListener('hashchange', () => void renderRoute(currentRoute()));
bridge().onStatus(showStatus);
bridge().onEvent(onEvent);
bridge().onEphemeral((event) => {
  if (event.type === 'run.output_delta') appendLive(event.runId, event.text);
  else if (event.type === 'channel.status' && currentRoute().view === 'settings') scheduleRender();
});
void bridge().status().then((status) => status && showStatus(status));
void renderRoute(currentRoute());
