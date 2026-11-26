import type { ApprovalRecord } from '@paldock/contracts';
import { call } from '../api.js';
import { h } from '../dom.js';
import { APPROVAL_LABEL, RISK_LABEL, time } from '../format.js';

/** 操作失败时把错误显示在页面上（例如版本冲突：别处已处理）。 */
export type Act = (action: () => Promise<unknown>) => () => Promise<void>;

/** 超过这么长的命令 / 详情先收起，点开看全文。 */
const LONG_DETAIL = 300;

/**
 * 一条审批：请求内容（长命令可展开）、目录、风险、过期时间，待处理时「允许一次 / 拒绝」（带版本，先到者为准）。
 * 任务详情（单子任务的各次 Run、计划节点的执行记录）和「待我处理」共用，所以哪里都能直接处理。
 */
export function approvalView(approval: ApprovalRecord, act: Act): HTMLElement {
  const pending = approval.status === 'pending';
  const decide = (decision: 'allow_once' | 'deny') => act(() => call('approval.decide', { approvalId: approval.id, expectedVersion: approval.version, decision }));
  const detail = approval.detail
    ? approval.detail.length > LONG_DETAIL
      ? h('details', {}, h('summary', {}, `展开全文（${approval.detail.length} 字）`), h('pre', { class: 'approval-detail' }, approval.detail))
      : h('pre', { class: 'approval-detail' }, approval.detail)
    : null;
  return h(
    'section',
    { class: `approval risk-${approval.riskLevel} ${pending ? 'pending' : 'decided'}`, 'aria-label': `审批：${approval.summary}` },
    h('p', {}, h('strong', {}, pending ? '等待审批：' : `${APPROVAL_LABEL[approval.status]}：`), approval.summary, ` （${RISK_LABEL[approval.riskLevel]}）`),
    detail,
    approval.cwd ? h('p', { class: 'hint' }, `目录：${approval.cwd}`) : null,
    pending ? h('p', { class: 'hint' }, `过期时间：${time(approval.expiresAt)}（过期即自动拒绝）`) : null,
    pending && approval.sensitive ? h('p', { class: 'hint' }, '敏感路径（凭据、密钥、.env 之类）：只能由你批准，协调助手不能批。') : null,
    pending && approval.routedTo === 'coordinator'
      ? h('p', { class: 'hint' }, '项目外只读、不含 shell：协调助手正在判断，它拿不准或超时会交给你；你也可以现在直接处理。')
      : null,
    pending
      ? h(
          'div',
          { class: 'actions' },
          h('button', { type: 'button', class: 'primary', onclick: decide('allow_once') }, '允许一次'),
          h('button', { type: 'button', onclick: decide('deny') }, '拒绝'),
        )
      : null,
  );
}

/**
 * 同一次 Run 短时间内的几个审批合成一张卡（2026-11-26 已定）：逐项列出，可以「全部允许一次」「全部拒绝」，也可以逐项处理；
 * 各项仍独立审计、独立过期。
 */
export function approvalGroupView(approvals: readonly ApprovalRecord[], act: Act): HTMLElement {
  const pending = approvals.filter((a) => a.status === 'pending');
  const all = (decision: 'allow_once' | 'deny') =>
    act(async () => {
      for (const a of pending) await call('approval.decide', { approvalId: a.id, expectedVersion: a.version, decision });
    });
  return h(
    'section',
    { class: 'approval-group', 'aria-label': `${approvals.length} 个审批` },
    h('p', {}, h('strong', {}, `这次执行有 ${approvals.length} 个审批`), pending.length < approvals.length ? `（还有 ${pending.length} 个待处理）` : ''),
    pending.length > 1
      ? h(
          'div',
          { class: 'actions' },
          h('button', { type: 'button', class: 'primary', onclick: all('allow_once') }, `全部允许一次（${pending.length}）`),
          h('button', { type: 'button', onclick: all('deny') }, `全部拒绝（${pending.length}）`),
        )
      : null,
    ...approvals.map((a) => approvalView(a, act)),
  );
}
