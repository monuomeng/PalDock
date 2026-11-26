import type { GitOpRecord } from '@paldock/contracts';
import { call } from '../api.js';
import { h } from '../dom.js';
import { time } from '../format.js';
import type { Act } from './approval-card.js';

const STATUS_LABEL: Record<GitOpRecord['status'], string> = { proposed: '待你确认', done: '已完成', failed: '没成功', cancelled: '已取消', stale: '已作废' };
const KIND_LABEL: Record<GitOpRecord['kind'], string> = { commit: '提交', push: '推送', merge: '合并' };

/**
 * 提交 / 推送 / 合并卡片（默认在当前仓库协作，2026-11-26 已定）：助手只提出，你在这里确认后才由 PalDock 执行。
 * 提交卡片逐块列出改动：有写入证据的（能和助手的写入记录核对上）默认勾选，其余标为「本轮期间发生的改动」，默认不勾。
 */
export function gitCard(op: GitOpRecord, act: Act): HTMLElement {
  const pending = op.status === 'proposed';
  const header = h('p', {}, h('strong', {}, `${KIND_LABEL[op.kind]}卡片 · `), h('span', { class: `status git-${op.status}` }, STATUS_LABEL[op.status]), h('span', { class: 'hint' }, ` ${time(op.createdAt)}`));
  const result = op.result ? h('p', { class: op.status === 'done' ? 'hint' : 'error' }, op.result) : null;
  const decide = (decision: 'confirm' | 'cancel', hunkIds?: string[]) =>
    act(() => call('gitop.decide', { opId: op.id, expectedVersion: op.version, decision, ...(hunkIds ? { hunkIds } : {}) }));
  const request = op.request;
  if (request.kind === 'commit') {
    const boxes = request.hunks.map((hunk) => {
      const box = h('input', { type: 'checkbox', checked: hunk.evidenced, disabled: !pending, 'aria-label': `提交 ${hunk.path} 的这一块` }) as HTMLInputElement;
      return { hunk, box };
    });
    return h(
      'section',
      { class: 'panel git-card', 'aria-label': '提交卡片' },
      header,
      h('p', {}, `分支 ${request.branch}（HEAD ${request.head.slice(0, 10)}）· 提交说明：${request.message}`),
      request.staged.length > 0 ? h('p', { class: 'hint' }, `你已暂存的文件（提交后仍保持暂存）：${request.staged.join('、')}`) : null,
      h(
        'div',
        {},
        ...boxes.map(({ hunk, box }) =>
          h(
            'details',
            {},
            h(
              'summary',
              {},
              box,
              ` ${hunk.path}`,
              h('span', { class: 'hint' }, hunk.evidenced ? ' · 助手写的' : ' · 本轮期间发生的改动（不确定是谁改的）'),
              hunk.stagedByUser ? h('span', { class: 'hint' }, ' · 这个文件你也暂存过') : null,
            ),
            h('pre', { class: 'approval-detail' }, hunk.patch),
          ),
        ),
      ),
      result,
      pending
        ? h(
            'div',
            { class: 'actions' },
            h(
              'button',
              { type: 'button', class: 'primary', onclick: () => void decide('confirm', boxes.filter((b) => b.box.checked).map((b) => b.hunk.id))() },
              '提交勾选的改动',
            ),
            h('button', { type: 'button', onclick: decide('cancel') }, '取消'),
          )
        : null,
    );
  }
  const facts =
    request.kind === 'push'
      ? [`把 ${request.branch} 推到 ${request.remote}/${request.remoteBranch}（${request.remoteUrl}），不强推。`, `要推的提交（${request.commits.length}）：`]
      : [`本地合并：把 ${request.source} 合进 ${request.target}${request.fastForward ? '（可以快进）' : ''}。冲突时不落地。`, `要合入的提交（${request.commits.length}）：`];
  return h(
    'section',
    { class: 'panel git-card', 'aria-label': `${KIND_LABEL[op.kind]}卡片` },
    header,
    h('p', {}, facts[0]!),
    h('details', {}, h('summary', {}, facts[1]!), h('pre', { class: 'approval-detail' }, request.commits.join('\n') || '（没有）')),
    request.kind === 'push' ? h('p', { class: 'hint' }, '推送是高风险操作，只能在桌面确认；用你本机已有的 git 凭据。') : null,
    result,
    pending
      ? h(
          'div',
          { class: 'actions' },
          h('button', { type: 'button', class: 'primary', onclick: decide('confirm') }, request.kind === 'push' ? '确认推送' : '确认合并'),
          h('button', { type: 'button', onclick: decide('cancel') }, '取消'),
        )
      : null,
  );
}
