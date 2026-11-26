import type { ApprovalRecord, AttentionItem, RecoveryItem, RecoveryKind } from '@paldock/contracts';
import { call } from '../api.js';
import { h } from '../dom.js';
import { ATTENTION_LABEL, time } from '../format.js';
import { chatLink, navigate, taskLink } from '../router.js';
import { approvalGroupView, approvalView, type Act } from './approval-card.js';

/**
 * 首页「待我处理」：审批、待命中、阻塞、执行状态待确认，按时间排序。
 * 点开只记已读、不移除；处理完（审批决定、继续或结束、恢复）后由业务状态让条目消失。
 */
export async function attentionView(): Promise<HTMLElement> {
  const [items, recovered] = await Promise.all([call('attention.list', {}), call('recovery.report', {}).catch(() => [] as RecoveryItem[])]);
  const error = h('p', { class: 'error', role: 'alert' });
  // 处理完由事件重绘（审批决定后条目消失）；失败时把原因留在页面上
  const act: Act = (action) => async () => {
    error.textContent = '';
    try {
      await action();
    } catch (e) {
      error.textContent = (e as Error).message;
    }
  };
  return h(
    'section',
    { 'aria-labelledby': 'attention-title' },
    h('h2', { id: 'attention-title' }, `待我处理（${grouped(items).length}）`),
    error,
    recovered.length > 0 ? recoveryPanel(recovered) : null,
    items.length === 0
      ? h('p', { class: 'empty' }, '没有需要你处理的事项。')
      : h('ul', { class: 'attention-list' }, ...grouped(items).map(([item, group]) => row(item, act, group))),
  );
}

const RECOVERY_LABEL: Record<RecoveryKind, string> = { run: '执行', queued: '排队', review: '审阅', merge: '合并', wake: '协调助手', notice: '通知', schedule: '调度' };

/** 这次启动时恢复了什么（P3 的计划节点、审阅、合并、唤醒）；单子任务的恢复仍在下面的条目里由你选。 */
function recoveryPanel(items: RecoveryItem[]): HTMLElement {
  return h(
    'details',
    { class: 'panel' },
    h('summary', {}, `本次启动自动恢复了 ${items.length} 项`),
    ...items.map((i) => h('p', { class: 'hint' }, `${time(i.at)} · ${RECOVERY_LABEL[i.kind]} · ${i.outcome}${i.detail ? `：${i.detail}` : ''}`)),
  );
}

/**
 * 同一次 Run 短时间内的审批（同一组）合成一条：取组里第一条作为条目，带上整组。其余条目原样。
 */
export function grouped(items: readonly AttentionItem[]): [AttentionItem, ApprovalRecord[]][] {
  const groups = new Map<string, ApprovalRecord[]>();
  for (const item of items) {
    const g = item.approval?.groupId;
    if (!g || !item.approval) continue;
    const list = groups.get(g);
    if (list) list.push(item.approval);
    else groups.set(g, [item.approval]);
  }
  const seen = new Set<string>();
  const out: [AttentionItem, ApprovalRecord[]][] = [];
  for (const item of items) {
    const g = item.approval?.groupId;
    if (g && groups.get(g)!.length > 1) {
      if (seen.has(g)) continue;
      seen.add(g);
      out.push([item, groups.get(g)!]);
    } else out.push([item, []]);
  }
  return out;
}

function row(item: AttentionItem, act: Act, group: readonly ApprovalRecord[] = []): HTMLElement {
  const open = async () => {
    if (!item.read) await call('attention.markRead', { itemKind: item.kind, itemId: item.itemId }).catch(() => {});
    // 协调助手的通知在对话页看；其余打开对应任务（和那次 Run）
    navigate(item.kind === 'notice' ? chatLink({ taskId: item.taskId }) : taskLink(item.taskId, item.runId));
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
    // 审批直接在这里处理：P3 计划任务的详情页以前没有审批卡片，点进去找不到按钮（0.3.1 实测）
    group.length > 1 ? approvalGroupView(group, act) : item.approval ? approvalView(item.approval, act) : null,
  );
}
