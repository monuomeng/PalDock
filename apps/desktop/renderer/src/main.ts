import type { PersistentEvent } from '@paldock/contracts';
import { bridge, call, type HostStatus } from './api.js';
import { h } from './dom.js';
import { appendLive, clearLive } from './live-output.js';
import { currentRoute, type Route } from './router.js';
import { attentionView } from './views/attention.js';
import { newTaskView } from './views/new-task.js';
import { taskDetailView } from './views/task-detail.js';
import { tasksView } from './views/tasks.js';

const $ = (id: string) => document.getElementById(id)!;
let connected = false;

/** 页头常驻的连接状态，用 aria-live 播报。 */
function showStatus(status: HostStatus): void {
  connected = status.state === 'connected';
  const text: Record<HostStatus['state'], string> = {
    starting: '本地服务启动中…',
    ready: '本地服务已就绪，连接中…',
    connected: '已连接',
    restarting: status.state === 'restarting' ? `本地服务已退出，${Math.round(status.inMs / 1000)} 秒后重启` : '',
    stopped: status.state === 'stopped' ? `本地服务已停止（${status.message ?? status.reason}），请重启应用` : '',
  };
  const banner = $('connection');
  banner.textContent = text[status.state];
  banner.className = connected ? 'ok' : 'down';
  if (connected) scheduleRender();
}

async function updateAttentionCount(): Promise<void> {
  const items = await call('attention.list', {}).catch(() => undefined);
  if (!items) return;
  $('attention-count').textContent = items.length > 0 ? String(items.length) : '';
  const unconfirmed = items.some((i) => i.kind === 'unconfirmed_run');
  $('executor-warning').hidden = !unconfirmed;
}

/** 重新渲染时保留正在输入的内容和焦点（标了 data-keep 的控件）。 */
function preserveInputs(target: HTMLElement, next: HTMLElement): void {
  const kept = new Map<string, string>();
  for (const el of target.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-keep]')) kept.set(el.dataset.keep!, el.value);
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.keep;
  for (const el of next.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-keep]')) {
    const value = kept.get(el.dataset.keep!);
    if (value !== undefined) el.value = value;
  }
  target.replaceChildren(next);
  if (focused) next.querySelector<HTMLElement>(`[data-keep="${CSS.escape(focused)}"]`)?.focus();
}

let renderSeq = 0;
async function renderRoute(route: Route): Promise<void> {
  const seq = ++renderSeq;
  const main = $('content');
  for (const link of document.querySelectorAll<HTMLAnchorElement>('nav a')) {
    link.toggleAttribute('aria-current', link.dataset.view === route.view);
  }
  if (!connected) {
    if (route.view !== 'new') return main.replaceChildren(h('p', { class: 'empty' }, '等待本地服务连接…'));
  }
  try {
    const view =
      route.view === 'attention'
        ? await attentionView()
        : route.view === 'tasks'
          ? await tasksView()
          : route.view === 'new'
            ? newTaskView()
            : await taskDetailView(route.taskId, route.runId, scheduleRender);
    if (seq !== renderSeq) return; // 已有更新的渲染
    preserveInputs(main, view);
  } catch (error) {
    if (seq === renderSeq) main.replaceChildren(h('p', { class: 'error', role: 'alert' }, (error as Error).message));
  }
  void updateAttentionCount();
}

// 同一轮内的多个事件合并为一次渲染；新建任务表单不随事件重绘
let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    const route = currentRoute();
    if (route.view === 'new') return void updateAttentionCount();
    void renderRoute(route);
  });
}

function onEvent(event: PersistentEvent): void {
  if (event.type === 'message.created' && event.payload.runId) clearLive(event.payload.runId);
  scheduleRender();
}

window.addEventListener('hashchange', () => void renderRoute(currentRoute()));
bridge().onStatus(showStatus);
bridge().onEvent(onEvent);
bridge().onEphemeral((event) => {
  if (event.type === 'run.output_delta') appendLive(event.runId, event.text);
});
void bridge().status().then((status) => status && showStatus(status));
void renderRoute(currentRoute());
