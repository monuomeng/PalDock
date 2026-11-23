import type { AttentionItem } from '@paldock/contracts';
import { call } from '../api.js';
import { h } from '../dom.js';
import { ATTENTION_LABEL, time } from '../format.js';
import { navigate, taskLink } from '../router.js';

/**
 * 首页「待我处理」：审批、待验收、阻塞、执行状态待确认，按时间排序。
 * 点开只记已读、不移除；处理完（审批决定、验收或退回、恢复）后由业务状态让条目消失。
 */
export async function attentionView(): Promise<HTMLElement> {
  const items = await call('attention.list', {});
  return h(
    'section',
    { 'aria-labelledby': 'attention-title' },
    h('h2', { id: 'attention-title' }, `待我处理（${items.length}）`),
    items.length === 0
      ? h('p', { class: 'empty' }, '没有需要你处理的事项。')
      : h('ul', { class: 'attention-list' }, ...items.map(row)),
  );
}

function row(item: AttentionItem): HTMLElement {
  const open = async () => {
    if (!item.read) await call('attention.markRead', { itemKind: item.kind, itemId: item.itemId }).catch(() => {});
    navigate(taskLink(item.taskId, item.runId));
  };
  return h(
    'li',
    { class: item.read ? 'read' : 'unread' },
    h(
      'button',
      { type: 'button', class: 'attention-item', onclick: open },
      h('span', { class: `kind kind-${item.kind}` }, ATTENTION_LABEL[item.kind]),
      h('span', { class: 'title' }, item.title),
      item.reason ? h('span', { class: 'reason' }, item.reason) : null,
      h('span', { class: 'meta' }, time(item.since), item.read ? '' : ' · 未读'),
    ),
  );
}
