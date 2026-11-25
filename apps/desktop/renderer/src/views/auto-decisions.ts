import type { AutoDecisionKind } from '@paldock/contracts';
import { call } from '../api.js';
import { h } from '../dom.js';
import { time } from '../format.js';
import { autoLink, navigate, taskLink } from '../router.js';

const KIND_LABEL: Record<AutoDecisionKind, string> = {
  skip_review: '跳过审阅',
  review_passed: '审阅助手放行',
  review_rework: '审阅助手退回',
  wake_dropped: '唤醒被跳过',
  wake_aborted: '唤醒被中断',
  auto_approve: '自动批准',
};

/** 自动处理记录：没经过你的决定，按项目筛选，只读（补审和撤销以后再做）。 */
export async function autoDecisionsView(workspaceId: string | undefined): Promise<HTMLElement> {
  const [workspaces, decisions] = await Promise.all([call('workspace.list', {}), call('auto.list', workspaceId ? { workspaceId } : {})]);
  const names = new Map(workspaces.map((w) => [w.id, w.name]));
  const filter = h(
    'select',
    { 'aria-label': '按项目筛选' },
    h('option', { value: '', selected: !workspaceId }, '全部项目'),
    ...workspaces.map((w) => h('option', { value: w.id, selected: w.id === workspaceId }, w.name)),
  ) as HTMLSelectElement;
  filter.addEventListener('change', () => navigate(autoLink(filter.value || undefined)));
  return h(
    'article',
    { 'aria-labelledby': 'auto-title' },
    h('h2', { id: 'auto-title' }, '自动处理记录'),
    h('p', { class: 'hint' }, 'PalDock 和助手们没经过你做的决定都记在这里：跳过审阅、审阅助手放行或退回、协调助手的唤醒被跳过或中断。计划始终要你确认，不会自动跳过。'),
    h('div', { class: 'row' }, filter),
    decisions.length === 0
      ? h('p', { class: 'empty' }, '还没有记录。')
      : h(
          'table',
          { class: 'tasks' },
          h('thead', {}, h('tr', {}, h('th', {}, '时间'), h('th', {}, '项目'), h('th', {}, '类别'), h('th', {}, '原因'), h('th', {}, ''))),
          h(
            'tbody',
            {},
            ...decisions.map((d) =>
              h(
                'tr',
                {},
                h('td', {}, time(d.createdAt)),
                h('td', {}, names.get(d.workspaceId) ?? d.workspaceId),
                h('td', {}, KIND_LABEL[d.kind]),
                h('td', {}, d.reason),
                h('td', {}, h('a', { href: taskLink(d.taskId) }, '查看')),
              ),
            ),
          ),
        ),
  );
}
