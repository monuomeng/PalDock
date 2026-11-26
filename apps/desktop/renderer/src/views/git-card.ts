import type { GitOpRecord } from '@paldock/contracts';
import { call } from '../api.js';
import { h } from '../dom.js';
import { time } from '../format.js';
import type { Act } from './approval-card.js';

const STATUS_LABEL: Record<GitOpRecord['status'], string> = { proposed: '待你确认', done: '已完成', failed: '没成功', cancelled: '已取消', stale: '已作废' };
const KIND_LABEL: Record<GitOpRecord['kind'], string> = { commit: '提交', push: '推送', merge: '合并', index: '暂存区' };

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
  // 0.3.7 之前的卡片格式不同（升级时都已结束或作废）：只显示状态和结果
  const legacy = (request.kind === 'commit' && !request.scope) || (request.kind === 'push' && !request.targets) || (request.kind === 'merge' && !request.sourceSha);
  if (legacy) return h('section', { class: 'panel git-card', 'aria-label': `${KIND_LABEL[op.kind]}卡片` }, header, result);
  if (request.kind === 'commit') {
    const boxes = request.hunks.map((hunk) => {
      const box = h('input', { type: 'checkbox', checked: hunk.evidenced, disabled: !pending, 'aria-label': `提交 ${hunk.path} 的这一块` }) as HTMLInputElement;
      return { hunk, box };
    });
    return h(
      'section',
      { class: 'panel git-card', 'aria-label': '提交卡片' },
      header,
      h('p', {}, `范围：${request.scope.label} · 分支 ${request.branch}（HEAD ${request.head.slice(0, 10)}）· 提交说明：${request.message}`),
      h('p', { class: 'hint' }, '只列这个范围内的改动块；每一行都和助手的写入记录核对上的块默认勾选，其余默认不勾。要看整个项目的改动，请在对话里明确说。'),
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
              h('span', { class: 'hint' }, ` · ${hunk.note}`),
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
  if (request.kind === 'index') {
    return h(
      'section',
      { class: 'panel git-card', 'aria-label': '暂存区卡片' },
      header,
      h('p', {}, `这一轮里暂存区变了，项目已暂停。暂存状态变了的文件：${request.paths.join('、') || '（无）'}`),
      h('p', { class: 'hint' }, '「恢复」只把暂存区改回这一轮开始前的样子，工作区里的文件不动；弹卡之后你又改过暂存区的话，这张卡片作废、不会覆盖你的操作。'),
      result,
      pending
        ? h(
            'div',
            { class: 'actions' },
            h('button', { type: 'button', onclick: decide('cancel') }, '保留现在的暂存区'),
            h('button', { type: 'button', onclick: decide('confirm') }, '恢复到这一轮开始前'),
          )
        : null,
    );
  }
  const more = (shown: number, total: number) => (total > shown ? `（共 ${total} 个，下面列出最近 ${shown} 个）` : `（共 ${total} 个）`);
  const facts =
    request.kind === 'push'
      ? [
          `把 ${request.branch} 的提交 ${request.head.slice(0, 10)} 推到 ${request.remote} 的 ${request.remoteBranch}，不强推。确认时再核对一次，远端或本地变了就作废。`,
          `要推的提交${more(request.commits.length, request.totalCommits)}：`,
        ]
      : [
          `本地合并：把 ${request.source}@${request.sourceSha.slice(0, 10)} 合进 ${request.target}@${request.targetSha.slice(0, 10)}${request.fastForward ? '（可以快进）' : ''}。任一边变了就作废，冲突时不落地。`,
          `要合入的提交${more(request.commits.length, request.totalCommits)}：`,
        ];
  return h(
    'section',
    { class: 'panel git-card', 'aria-label': `${KIND_LABEL[op.kind]}卡片` },
    header,
    h('p', {}, facts[0]!),
    request.kind === 'push'
      ? h(
          'div',
          {},
          h('p', {}, request.targets.length > 1 ? `会写入这 ${request.targets.length} 个地址：` : '会写入的地址：'),
          h('ul', {}, ...request.targets.map((t) => h('li', {}, `${t.url}（${request.remoteBranch} 现在：${t.remoteSha ? t.remoteSha.slice(0, 10) : '还没有这个分支，会新建'}）`))),
        )
      : null,
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
