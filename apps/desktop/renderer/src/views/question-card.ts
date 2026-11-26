import type { GitOpRecord, QuestionRecord } from '@paldock/contracts';
import { call } from '../api.js';
import { h } from '../dom.js';
import type { Act } from './approval-card.js';

const STATUS: Record<QuestionRecord['status'], string> = { open: '等你决定', replaced: '已被新的问题取代', done: '已处理', void: '已在别处处理' };

/**
 * 协调助手在对话里问你的问题（0.3.8）：挂在问题那条消息下面的按钮。也可以直接在输入框里回复（追问、只批其中一项）。
 * 按钮和文字回复共用同一次决定（带版本，先到者为准）；问题结束后按钮失效。
 */
export function questionView(q: QuestionRecord, act: Act, gitOps: readonly GitOpRecord[] = []): HTMLElement {
  const open = q.status === 'open';
  // 提交卡片：直接列出这次要提交的文件和改动块（0.3.10），在原对话里就能看清再确认
  const commitHunks = q.items.flatMap((item) => {
    const op = gitOps.find((o) => o.id === item.ref);
    if (!op || op.request.kind !== 'commit' || !item.hunkIds) return [];
    return op.request.hunks.filter((h) => item.hunkIds!.includes(h.id));
  });
  const decide = (action: 'accept' | 'reject' | 'item', ref?: string) =>
    act(() => call('question.decide', { questionId: q.id, expectedVersion: q.version, action, ...(ref ? { ref } : {}) }));
  return h(
    'div',
    { class: 'question', 'aria-label': '等你决定的问题' },
    q.items.length > 1 ? h('ul', { class: 'hint' }, ...q.items.map((i) => h('li', {}, i.label))) : null,
    commitHunks.length > 0
      ? h(
          'div',
          {},
          h('p', { class: 'hint' }, `要提交的改动块（${commitHunks.length}）：`),
          ...commitHunks.map((hunk) => h('details', { open: true }, h('summary', {}, hunk.path), h('pre', { class: 'approval-detail' }, hunk.patch))),
        )
      : null,
    open
      ? h(
          'div',
          { class: 'actions' },
          h('button', { type: 'button', class: 'primary', onclick: decide('accept') }, q.author === 'host' ? '允许' : '按建议处理'),
          ...(q.items.length > 1 ? q.items.filter((i) => i.highImpact).map((i) => h('button', { type: 'button', onclick: decide('item', i.ref) }, `只处理：${i.target ?? i.label}`)) : []),
          h('button', { type: 'button', onclick: decide('reject') }, q.author === 'host' ? '拒绝' : '都不要'),
        )
      : h('p', { class: 'hint' }, `${STATUS[q.status]}${q.result ? `：${q.result}` : ''}`),
  );
}
