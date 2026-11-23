// 管理窗口样机：只通过 preload 暴露的 window.paldock 与主进程通信。
const $ = (id) => document.getElementById(id);
let workspaceId;
let latestTask;

function setStatus(status) {
  const text = {
    starting: '启动中',
    ready: '已就绪，连接中',
    connected: '已连接',
    restarting: `服务已退出，${(status.inMs ?? 0) / 1000} 秒后重启`,
    stopped: `已停止（${status.reason}）`,
  }[status.state];
  $('status').textContent = text ?? status.state;
  if (status.state === 'connected') scheduleRefresh();
}

// 只有这些事件会改变「待我处理」；同一轮内的多个事件合并为一次刷新
const ATTENTION_EVENTS = /^(approval\.|subtask\.status_changed|run\.status_changed)/;
let refreshQueued = false;

function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(() => {
    refreshQueued = false;
    void refreshAttention();
  });
}

function appendEvent(event) {
  const li = document.createElement('li');
  li.textContent = `#${event.seq} ${event.type} ${event.aggregateId}`;
  $('events').prepend(li);
  if (ATTENTION_EVENTS.test(event.type)) scheduleRefresh();
}

async function refreshAttention() {
  const items = await window.paldock.request('attention.list', {}).catch(() => []);
  $('attention').replaceChildren(
    ...(items.length === 0
      ? [Object.assign(document.createElement('li'), { textContent: '暂无' })]
      : items.map((item) => Object.assign(document.createElement('li'), { textContent: `[${item.kind}] ${item.title}${item.read ? '（已读）' : ''}` }))),
  );
}

$('create-task').addEventListener('click', async () => {
  workspaceId ??= (await window.paldock.request('workspace.create', { name: '示例项目', rootPath: `demo-${Date.now()}` })).id;
  latestTask = await window.paldock.request('task.create', { workspaceId, title: `示例任务 ${new Date().toLocaleTimeString()}` });
  $('queue-task').disabled = false;
});

$('queue-task').addEventListener('click', async () => {
  try {
    latestTask = await window.paldock.request('task.transition', { taskId: latestTask.id, expectedVersion: latestTask.version, to: 'queued' });
  } catch (error) {
    alert(error.message);
  }
});

$('crash').addEventListener('click', () => void window.paldock.debugCrashService());

window.paldock.onStatus(setStatus);
window.paldock.onEvent(appendEvent);
