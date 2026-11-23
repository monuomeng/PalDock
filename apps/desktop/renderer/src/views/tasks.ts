import type { TaskSummary } from '@paldock/contracts';
import { call } from '../api.js';
import { h } from '../dom.js';
import { RUN_LABEL, SUBTASK_LABEL, time } from '../format.js';
import { navigate, taskLink } from '../router.js';

export async function tasksView(): Promise<HTMLElement> {
  const tasks = await call('task.list', { limit: 200 });
  const backupStatus = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  /** 备份数据库与证据文件到数据目录的 backups/ 下（不含 worktree 与执行器会话，见运维说明）。 */
  const backup = async () => {
    backupStatus.textContent = '正在备份…';
    backupStatus.textContent = await call('maintenance.backup', {}).then(
      (r) => `已备份到 ${r.path}`,
      (e: Error) => `备份失败：${e.message}`,
    );
  };
  return h(
    'section',
    { 'aria-labelledby': 'tasks-title' },
    h(
      'div',
      { class: 'section-head' },
      h('h2', { id: 'tasks-title' }, '任务'),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'primary', onclick: () => navigate('#/new') }, '新建任务'),
        h('button', { type: 'button', onclick: backup }, '备份数据'),
      ),
    ),
    backupStatus,
    tasks.length === 0
      ? h('p', { class: 'empty' }, '还没有任务。')
      : h(
          'table',
          { class: 'tasks' },
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, '任务'), h('th', { scope: 'col' }, '状态'), h('th', { scope: 'col' }, '最近执行'), h('th', { scope: 'col' }, '创建时间'))),
          h('tbody', {}, ...tasks.map(row)),
        ),
  );
}

function row({ task, subtaskStatus, latestRunStatus }: TaskSummary): HTMLElement {
  return h(
    'tr',
    {},
    h('td', {}, h('a', { href: taskLink(task.id) }, task.title)),
    h('td', {}, h('span', { class: `status status-${subtaskStatus}` }, SUBTASK_LABEL[subtaskStatus])),
    h('td', {}, latestRunStatus ? RUN_LABEL[latestRunStatus] : '—'),
    h('td', {}, time(task.createdAt)),
  );
}
