import type { WorkspaceRecord } from '@paldock/contracts';
import { call } from '../api.js';
import { h } from '../dom.js';
import type { Act } from './approval-card.js';

/** 切了分支暂停写入时的提示（2026-11-26 已定，分支保护）：在新分支上继续，或取消这个项目里还没结束的计划任务。 */
export function pausedBanner(workspace: WorkspaceRecord | undefined, act: Act): HTMLElement | null {
  if (!workspace?.pausedReason) return null;
  return h(
    'section',
    { class: 'panel review', role: 'alert', 'aria-label': '项目已暂停' },
    h('p', {}, h('strong', {}, '已暂停：'), workspace.pausedReason),
    h('p', { class: 'hint' }, '正在跑的执行已经中断。切换后已经写进工作区的文件无法撤销，变动的文件列在通知里。'),
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'primary', onclick: act(() => call('workspace.resume', { workspaceId: workspace.id, action: 'continue' })) }, '在新分支上继续'),
      h('button', { type: 'button', class: 'danger', onclick: act(() => call('workspace.resume', { workspaceId: workspace.id, action: 'cancel' })) }, '取消这个项目里还没结束的计划任务'),
    ),
  );
}
