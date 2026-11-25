import { noticeRef, type ConversationDetail, type MainSessionRecord, type WakeRecord, type WorkspaceRecord } from '@paldock/contracts';
import { call } from '../api.js';
import { h } from '../dom.js';
import { time } from '../format.js';
import { liveText } from '../live-output.js';
import { chatLink, navigate } from '../router.js';

const WAKE_LABEL: Record<WakeRecord['status'], string> = { pending: '排队', running: '进行中', done: '完成', failed: '失败', dropped: '已跳过' };
const TRIGGER_LABEL: Record<WakeRecord['trigger'], string> = { user_message: '你的消息', task_event: '任务事件' };

export interface RenderedChat {
  element: HTMLElement;
  /** 这个页面关心的会话 ID（事件的聚合 ID 或 message.created 的 sessionId）。 */
  sessionId: string | null;
}

/**
 * 对话：和协调助手的长期会话，每个项目一个或多个。你在这里说需求，它读项目和任务，经 propose_plan 提计划；
 * 它的通知（带编号）也在这里。打开这一页即把通知标为已读（桌面已看过，不再外发到手机）。
 */
export async function chatView(route: { workspaceId: string | undefined; sessionId: string | undefined; taskId: string | undefined }, refresh: () => void): Promise<RenderedChat> {
  const error = h('p', { class: 'error', role: 'alert' });
  const workspaces = await call('workspace.list', {});
  if (workspaces.length === 0) {
    return { element: h('article', {}, h('h2', {}, '对话'), h('p', { class: 'empty' }, '还没有项目。先在「新建任务」里选一个项目目录。')), sessionId: null };
  }
  let detail: ConversationDetail;
  if (route.sessionId || route.taskId) {
    detail = await call('chat.get', route.sessionId ? { sessionId: route.sessionId } : { taskId: route.taskId! });
  } else {
    const workspace = workspaces.find((w) => w.id === route.workspaceId) ?? workspaces[0]!;
    const [first] = await call('chat.sessions', { workspaceId: workspace.id });
    detail = await call('chat.get', { sessionId: first!.sessionId });
  }
  const { session } = detail;
  const sessions = await call('chat.sessions', { workspaceId: session.workspaceId });
  if (detail.notices.some((n) => n.status === 'open')) void call('notice.ack', { sessionId: session.sessionId }).catch(() => {});

  const input = h('textarea', { id: 'chat-input', rows: 3, 'data-keep': `chat-${session.sessionId}`, placeholder: '告诉协调助手你想做什么，例如：给登录页加「记住我」并补测试' }) as HTMLTextAreaElement;
  const send = async () => {
    const text = input.value.trim();
    if (!text) return input.focus();
    error.textContent = '';
    try {
      await call('chat.send', { sessionId: session.sessionId, text, idempotencyKey: `chat-${crypto.randomUUID()}` });
      input.value = '';
    } catch (e) {
      error.textContent = (e as Error).message;
    }
    refresh();
  };
  const running = detail.wakes.find((w) => w.status === 'running');
  const live = running?.runId ? liveText(running.runId) : '';

  const element = h(
    'article',
    { class: 'chat', 'aria-labelledby': 'chat-title' },
    h('h2', { id: 'chat-title' }, '对话'),
    header(workspaces, sessions, session),
    error,
    h(
      'section',
      { class: 'messages', 'aria-label': '消息' },
      detail.messages.length === 0 ? h('p', { class: 'empty' }, '还没有消息。') : null,
      ...detail.messages.map((m) => h('div', { class: `message message-${m.role}` }, h('span', { class: 'hint' }, `${m.role === 'user' ? '你' : '协调助手'} · ${time(m.createdAt)}`), h('pre', {}, m.body))),
      live ? h('div', { class: 'message message-assistant live' }, h('span', { class: 'hint' }, '协调助手 · 正在回复'), h('pre', { 'data-live-run': running!.runId! }, live)) : null,
    ),
    h('label', { for: 'chat-input' }, '你的消息'),
    input,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: () => void send() }, '发送')),
    detail.notices.length > 0
      ? h(
          'section',
          { class: 'panel', 'aria-label': '协调助手的通知' },
          h('h3', {}, '通知'),
          ...detail.notices.map((n) =>
            h('p', {}, h('strong', {}, `${noticeRef(n.id)}${n.kind === 'question' ? ' · 问题' : ''}：`), n.body, h('span', { class: 'hint' }, ` ${time(n.createdAt)}${n.escalatedAt ? ' · 已发到手机' : ''}`)),
          ),
        )
      : null,
    h(
      'details',
      {},
      h('summary', {}, `最近的唤醒（${detail.wakes.length}）`),
      ...detail.wakes.map((w) => h('p', { class: 'hint' }, `${time(w.createdAt)} · ${TRIGGER_LABEL[w.trigger]} · ${WAKE_LABEL[w.status]} · 请求 ${w.requests} 次 · ${w.summary.slice(0, 120)}${w.note ? `（${w.note}）` : ''}`)),
      detail.summary ? h('p', { class: 'hint' }, `滚动摘要第 ${detail.summary.version} 版：${detail.summary.body.slice(0, 300)}`) : null,
    ),
  );
  return { element, sessionId: session.sessionId };
}

/** 选项目、选会话、新建会话。 */
function header(workspaces: WorkspaceRecord[], sessions: MainSessionRecord[], session: MainSessionRecord): HTMLElement {
  const project = h(
    'select',
    { 'aria-label': '项目' },
    ...workspaces.map((w) => h('option', { value: w.id, selected: w.id === session.workspaceId }, w.name)),
  ) as HTMLSelectElement;
  project.addEventListener('change', () => navigate(chatLink({ workspaceId: project.value })));
  const picker = h(
    'select',
    { 'aria-label': '会话' },
    ...sessions.map((s) => h('option', { value: s.sessionId, selected: s.sessionId === session.sessionId }, s.title)),
  ) as HTMLSelectElement;
  picker.addEventListener('change', () => navigate(chatLink({ sessionId: picker.value })));
  const create = async () => {
    const created = await call('chat.newSession', { workspaceId: session.workspaceId });
    navigate(chatLink({ sessionId: created.sessionId }));
  };
  return h('div', { class: 'row' }, project, picker, h('button', { type: 'button', onclick: () => void create() }, '新会话'));
}
