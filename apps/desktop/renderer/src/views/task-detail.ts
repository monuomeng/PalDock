import type { ApprovalRecord, RunDetail, SubtaskRecord, TaskDetail } from '@paldock/contracts';
import { call } from '../api.js';
import { h, type Child } from '../dom.js';
import { APPROVAL_LABEL, CHECK_LABEL, RISK_LABEL, RUN_LABEL, SUBTASK_LABEL, checkCommandText, duration, time } from '../format.js';
import { liveText } from '../live-output.js';

/** 操作失败时把错误显示在页面上（例如版本冲突：别处已处理）。 */
type Act = (action: () => Promise<unknown>) => () => Promise<void>;

/**
 * 任务详情：目标与 worktree、按时间列出的各次 Run（执行器、原生会话、状态、用时）、
 * 当前 Run 的流式输出、审批卡片、证据，以及取消 / 验收 / 退回 / 恢复操作。
 */
export async function taskDetailView(taskId: string, focusRunId: string | undefined, refresh: () => void): Promise<RenderedDetail> {
  const detail = await call('task.get', { taskId });
  const error = h('p', { class: 'error', role: 'alert' });
  const act: Act = (action) => async () => {
    error.textContent = '';
    try {
      await action();
    } catch (e) {
      error.textContent = (e as Error).message;
    }
    refresh();
  };
  const { task, subtask, workspace } = detail;
  const focus = focusRunId ?? detail.runs.at(-1)?.run.id;

  const element = h(
    'article',
    { class: 'task-detail', 'aria-labelledby': 'task-title' },
    h('h2', { id: 'task-title' }, task.title),
    h(
      'dl',
      { class: 'facts' },
      ...fact('状态', h('span', { class: `status status-${subtask.status}` }, SUBTASK_LABEL[subtask.status])),
      ...fact('项目', workspace.rootPath),
      ...fact('分支', subtask.branch ?? '（尚未创建）'),
      ...fact('worktree', subtask.worktreePath ?? '（尚未创建）'),
      ...fact('检查命令', checkCommandText(task)),
      ...(subtask.reworkCount > 0 ? fact('退回次数', subtask.reworkCount) : []),
    ),
    h('details', {}, h('summary', {}, '目标'), h('pre', { class: 'goal' }, task.goal)),
    error,
    actions(detail, act),
    h('h3', {}, `执行记录（${detail.runs.length} 次）`),
    ...[...detail.runs].reverse().map((run) => runView(run, run.run.id === focus, act)),
  );
  return { element, ids: scopeOf(detail) };
}

export interface RenderedDetail {
  element: HTMLElement;
  /** 这个页面涉及的聚合 ID；只有这些对象的事件才需要重绘。 */
  ids: Set<string>;
}

function scopeOf({ task, subtask, runs }: TaskDetail): Set<string> {
  return new Set([task.id, subtask.id, ...runs.flatMap((r) => [r.run.id, ...r.approvals.map((a) => a.id)])]);
}

function fact(label: string, value: Child): [HTMLElement, HTMLElement] {
  return [h('dt', {}, label), h('dd', {}, value)];
}

/** 按钮只按服务端给出的可用操作显示，规则不在界面里重复。 */
function actions({ task, subtask, actions: allowed }: TaskDetail, act: Act): HTMLElement | null {
  const cancel = allowed.cancel
    ? h('button', { type: 'button', class: 'danger', onclick: act(() => call('task.cancel', { taskId: task.id })) }, '取消任务')
    : null;
  if (allowed.review) return reviewActions(subtask, act, cancel);
  if (!allowed.restart) return cancel && h('div', { class: 'actions' }, cancel);
  const recover = (action: 'resume' | 'restart' | 'abandon') =>
    act(() => call('run.recover', { subtaskId: subtask.id, expectedVersion: subtask.version, action }));
  return h(
    'section',
    { class: 'panel blocked', 'aria-label': '阻塞处理' },
    h('p', {}, h('strong', {}, '已阻塞：'), subtask.statusReason ?? '原因未知'),
    h(
      'p',
      { class: 'hint' },
      allowed.resume
        ? '「恢复」在同一个执行器会话里继续；「重新开始」开一个新会话从头做；两者都会保留这次的记录。'
        : '这次执行无法续做，可以重新开始（新会话），或放弃这个任务。',
    ),
    h(
      'div',
      { class: 'actions' },
      allowed.resume ? h('button', { type: 'button', class: 'primary', onclick: recover('resume') }, '恢复') : null,
      h('button', { type: 'button', onclick: recover('restart') }, '重新开始'),
      allowed.abandon ? h('button', { type: 'button', class: 'danger', onclick: recover('abandon') }, '放弃') : null,
    ),
  );
}

function reviewActions(subtask: SubtaskRecord, act: Act, cancel: HTMLElement | null): HTMLElement {
  const note = h('textarea', { id: 'review-note', rows: 3, 'data-keep': `review-${subtask.id}`, placeholder: '退回时必填：哪里不对、要怎么改' });
  const decide = (decision: 'accept' | 'rework') =>
    act(() => {
      const text = note.value.trim();
      return call('review.decide', { subtaskId: subtask.id, expectedVersion: subtask.version, decision, ...(text ? { note: text } : {}) });
    });
  return h(
    'section',
    { class: 'panel review', 'aria-label': '验收' },
    h('p', {}, h('strong', {}, '待验收：'), '请查看下方最新一次执行的证据。通过后改动会提交到任务分支（不合并）；退回会带着你的意见重新执行，旧证据保留。'),
    h('label', { for: 'review-note' }, '意见'),
    note,
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'primary', onclick: decide('accept') }, '验收通过'),
      h('button', { type: 'button', onclick: decide('rework') }, '退回重做'),
      cancel,
    ),
  );
}

function runView({ run, result, reviews, approvals, messages }: RunDetail, open: boolean, act: Act): HTMLElement {
  const output = messages.map((m) => m.body).join('') + liveText(run.id);
  return h(
    'details',
    { class: `run run-${run.status}`, open, id: `run-${run.id}` },
    h(
      'summary',
      {},
      `第 ${run.attempt} 次 · `,
      h('span', { class: `status status-${run.status}` }, RUN_LABEL[run.status]),
      ` · ${time(run.startedAt)} · 用时 ${duration(run.startedAt, run.endedAt)}`,
    ),
    h('dl', { class: 'facts small' }, ...runFacts(run)),
    run.status === 'unconfirmed' ? h('p', { class: 'warning', role: 'status' }, '与执行器的连接断开，正在核对这一轮的结果，暂不判定成功或失败。') : null,
    ...approvals.map((a) => approvalView(a, act)),
    h('h4', {}, '输出'),
    h('pre', { class: 'output', 'data-live-run': run.id, tabindex: 0, 'aria-label': `第 ${run.attempt} 次执行的输出` }, output || '（暂无输出）'),
    result ? evidenceView(run.id, result) : null,
    ...reviews.map((r) => h('p', { class: `review-note review-${r.decision}` }, r.decision === 'accept' ? '验收通过' : '退回重做', ` · ${time(r.decidedAt)}`, r.note ? `：${r.note}` : '')),
  );
}

function runFacts(run: RunDetail['run']): HTMLElement[] {
  return [
    ...fact('执行器', run.runtime),
    ...fact('原生会话', run.nativeThreadId ?? '—'),
    ...fact('turn', run.nativeTurnId ?? '—'),
    ...(run.resumesRunId ? fact('续做自', run.resumesRunId) : []),
    ...(run.failureReason ? fact('原因', run.failureReason) : []),
  ];
}

function approvalView(approval: ApprovalRecord, act: Act): HTMLElement {
  const pending = approval.status === 'pending';
  const decide = (decision: 'allow_once' | 'deny') =>
    act(() => call('approval.decide', { approvalId: approval.id, expectedVersion: approval.version, decision }));
  const permissions = approval.kind === 'permissions';
  return h(
    'section',
    { class: `approval risk-${approval.riskLevel} ${pending ? 'pending' : 'decided'}`, 'aria-label': `审批：${approval.summary}` },
    h('p', {}, h('strong', {}, pending ? '等待审批：' : `${APPROVAL_LABEL[approval.status]}：`), approval.summary, ` （${RISK_LABEL[approval.riskLevel]}）`),
    approval.detail ? h('pre', { class: 'approval-detail' }, approval.detail) : null,
    approval.cwd ? h('p', { class: 'hint' }, `目录：${approval.cwd}`) : null,
    pending ? h('p', { class: 'hint' }, `过期时间：${time(approval.expiresAt)}（过期即自动拒绝）`) : null,
    pending && permissions ? h('p', { class: 'hint' }, '权限扩展在当前版本只能拒绝。') : null,
    pending
      ? h(
          'div',
          { class: 'actions' },
          h('button', { type: 'button', class: 'primary', disabled: permissions, onclick: decide('allow_once') }, '允许一次'),
          h('button', { type: 'button', onclick: decide('deny') }, '拒绝'),
        )
      : null,
  );
}

function evidenceView(runId: string, result: NonNullable<RunDetail['result']>): HTMLElement {
  const checkOutput = h('pre', { class: 'check-output', hidden: true });
  const showOutput = async () => {
    checkOutput.hidden = !checkOutput.hidden;
    if (!checkOutput.hidden && checkOutput.textContent === '') {
      checkOutput.textContent = await call('run.checkOutput', { runId }).catch((e: Error) => e.message);
    }
  };
  return h(
    'section',
    { class: 'evidence', 'aria-label': '证据' },
    h('h4', {}, '证据'),
    h('p', {}, h('strong', {}, '最终回复：'), result.finalMessage ?? '（无）'),
    h('p', {}, h('strong', {}, '改动：')),
    h('pre', { class: 'diffstat' }, result.diffStat || '（没有改动）'),
    h(
      'p',
      {},
      h('strong', {}, '检查：'),
      h('span', { class: `check check-${result.checkStatus}` }, CHECK_LABEL[result.checkStatus]),
      result.checkExitCode !== null ? ` · 退出码 ${result.checkExitCode}` : '',
      result.checkDurationMs !== null ? ` · ${Math.round(result.checkDurationMs / 100) / 10} 秒` : '',
      ' ',
      result.checkOutputRef ? h('button', { type: 'button', class: 'link', onclick: showOutput }, '查看输出（已脱敏）') : null,
    ),
    checkOutput,
  );
}
