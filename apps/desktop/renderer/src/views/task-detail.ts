import type { ApprovalRecord, PlanDetail, PlanNodeView, RunDetail, SubtaskRecord, TaskDetail } from '@paldock/contracts';
import { call } from '../api.js';
import { h, type Child } from '../dom.js';
import { APPROVAL_LABEL, CHECK_LABEL, PLAN_LABEL, RISK_LABEL, RUN_LABEL, SUBTASK_LABEL, checkCommandText, duration, time } from '../format.js';
import { liveText } from '../live-output.js';
import { continueLink, navigate, taskLink } from '../router.js';

/** 操作失败时把错误显示在页面上（例如版本冲突：别处已处理）。 */
type Act = (action: () => Promise<unknown>) => () => Promise<void>;

/**
 * 任务详情：目标与 worktree、按时间列出的各次 Run（执行器、原生会话、状态、用时）、
 * 当前 Run 的流式输出、审批卡片、证据，以及取消 / 继续 / 结束 / 恢复 / 基于此任务继续操作。
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
  if (!subtask) return planTaskView(detail, error, act);
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
      ...(task.continuedFromTaskId ? fact('接续自', h('a', { href: taskLink(task.continuedFromTaskId) }, '上一个任务')) : []),
      ...(subtask.reworkCount > 0 ? fact('继续次数', subtask.reworkCount) : []),
    ),
    h('details', {}, h('summary', {}, '目标'), h('pre', { class: 'goal' }, task.goal)),
    error,
    actions(detail, subtask, act),
    h('h3', {}, `执行记录（${detail.runs.length} 次）`),
    ...[...detail.runs].reverse().map((run) => runView(run, run.run.id === focus, act)),
  );
  return { element, ids: scopeOf(detail, subtask) };
}

/**
 * 按计划拆分的任务：计划节点、依赖和各节点状态；计划待确认时可以确认或退回，确认后逐个验收待命中的节点。
 * 只列节点，不画图；各节点的执行记录随 P3-08。
 */
function planTaskView(detail: TaskDetail, error: HTMLElement, act: Act): RenderedDetail {
  const { task, workspace, plan } = detail;
  const cancel = detail.actions.cancel
    ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'danger', onclick: act(() => call('task.cancel', { taskId: task.id })) }, '取消任务'))
    : null;
  const element = h(
    'article',
    { class: 'task-detail', 'aria-labelledby': 'task-title' },
    h('h2', { id: 'task-title' }, task.title),
    h(
      'dl',
      { class: 'facts' },
      ...fact('状态', h('span', { class: `status status-${task.status}` }, SUBTASK_LABEL[task.status])),
      ...fact('项目', workspace.rootPath),
    ),
    h('details', {}, h('summary', {}, '目标'), h('pre', { class: 'goal' }, task.goal)),
    error,
    plan ? planView(plan, act) : null,
    cancel,
  );
  const ids = new Set([task.id, ...(plan ? [plan.plan.id, ...plan.nodes.flatMap((n) => (n.subtask ? [n.subtask.id] : []))] : [])]);
  return { element, ids };
}

function planView({ plan, nodes, actions: allowed }: PlanDetail, act: Act): HTMLElement {
  const note = h('textarea', { id: 'plan-note', rows: 2, 'data-keep': `plan-${plan.id}`, placeholder: '退回时可选：要协调助手怎么改' });
  const decide = allowed.confirm
    ? h(
        'section',
        { class: 'panel review', 'aria-label': '计划待确认' },
        h('p', {}, h('strong', {}, '计划待确认：'), '确认后按下面的节点建子任务并开始派单；没有依赖的先开始。'),
        h('label', { for: 'plan-note' }, '退回意见'),
        note,
        h(
          'div',
          { class: 'actions' },
          h('button', { type: 'button', class: 'primary', onclick: act(() => call('plan.confirm', { planId: plan.id, expectedVersion: plan.version })) }, '确认计划'),
          h(
            'button',
            {
              type: 'button',
              onclick: act(() => {
                const text = note.value.trim();
                return call('plan.reject', { planId: plan.id, expectedVersion: plan.version, ...(text ? { note: text } : {}) });
              }),
            },
            '退回',
          ),
        ),
      )
    : null;
  const titles = new Map(nodes.map((n) => [n.node.key, n.node.title]));
  return h(
    'section',
    { class: 'plan', 'aria-label': '计划' },
    h('h3', {}, `计划第 ${plan.revision} 版 · `, h('span', { class: `status plan-${plan.status}` }, PLAN_LABEL[plan.status])),
    plan.decisionNote ? h('p', { class: 'hint' }, `说明：${plan.decisionNote}`) : null,
    decide,
    h(
      'table',
      { class: 'tasks plan-nodes' },
      h('thead', {}, h('tr', {}, h('th', {}, '节点'), h('th', {}, '角色'), h('th', {}, '依赖'), h('th', {}, '状态'), h('th', {}, ''))),
      h('tbody', {}, ...nodes.map((n) => nodeRow(n, titles, act))),
    ),
  );
}

function nodeRow({ node, subtask, actions: allowed }: PlanNodeView, titles: Map<string, string>, act: Act): HTMLElement {
  const deps = node.dependsOn.map((k) => titles.get(k) ?? k).join('、') || '—';
  const status = subtask ? h('span', { class: `status status-${subtask.status}` }, SUBTASK_LABEL[subtask.status]) : '未开始';
  const accept =
    subtask && allowed?.review
      ? h('button', { type: 'button', onclick: act(() => call('review.decide', { subtaskId: subtask.id, expectedVersion: subtask.version, decision: 'accept' })) }, '通过')
      : null;
  const restart =
    subtask && allowed?.restart
      ? h('button', { type: 'button', onclick: act(() => call('run.recover', { subtaskId: subtask.id, expectedVersion: subtask.version, action: 'restart' })) }, '重新开始')
      : null;
  return h(
    'tr',
    {},
    h('td', {}, h('strong', {}, node.title), h('div', { class: 'hint' }, node.goal), node.paths.length ? h('div', { class: 'hint' }, `路径：${node.paths.join('，')}`) : null),
    h('td', {}, node.role),
    h('td', {}, deps),
    h('td', {}, status, subtask?.statusReason ? h('div', { class: 'hint' }, subtask.statusReason) : null),
    h('td', {}, accept, restart),
  );
}

export interface RenderedDetail {
  element: HTMLElement;
  /** 这个页面涉及的聚合 ID；只有这些对象的事件才需要重绘。 */
  ids: Set<string>;
}

function scopeOf({ task, runs }: TaskDetail, subtask: SubtaskRecord): Set<string> {
  return new Set([task.id, subtask.id, ...runs.flatMap((r) => [r.run.id, ...r.approvals.map((a) => a.id)])]);
}

function fact(label: string, value: Child): [HTMLElement, HTMLElement] {
  return [h('dt', {}, label), h('dd', {}, value)];
}

/** 按钮只按服务端给出的可用操作显示，规则不在界面里重复。 */
function actions({ task, actions: allowed }: TaskDetail, subtask: SubtaskRecord, act: Act): HTMLElement | null {
  const cancel = allowed.cancel
    ? h('button', { type: 'button', class: 'danger', onclick: act(() => call('task.cancel', { taskId: task.id })) }, '取消任务')
    : null;
  if (allowed.review) return reviewActions(subtask, act, cancel);
  if (allowed.continueFrom) {
    return h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: () => navigate(continueLink(task.id)) }, '基于此任务继续'));
  }
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

/** 待命中：写下一步指令继续（同一 worktree、同一执行器会话），或结束任务（提交到任务分支）。 */
function reviewActions(subtask: SubtaskRecord, act: Act, cancel: HTMLElement | null): HTMLElement {
  const note = h('textarea', { id: 'review-note', rows: 3, 'data-keep': `review-${subtask.id}`, placeholder: '继续时必填：下一步要做什么' });
  // 指令只随「继续」发出；「结束任务」不带它，避免写了指令却点错按钮被当成备注
  const decide = (decision: 'accept' | 'rework') =>
    act(() => {
      const text = decision === 'rework' ? note.value.trim() : '';
      return call('review.decide', { subtaskId: subtask.id, expectedVersion: subtask.version, decision, ...(text ? { note: text } : {}) });
    });
  return h(
    'section',
    { class: 'panel review', 'aria-label': '待命中' },
    h(
      'p',
      {},
      h('strong', {}, '待命中：'),
      '这一轮做完了，请查看下方最新一次执行的证据。「继续」在同一个工作目录里按你的指令接着做，旧证据保留；「结束任务」把改动提交到任务分支（不合并）。',
    ),
    h('label', { for: 'review-note' }, '下一步指令'),
    note,
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'primary', onclick: decide('rework') }, '继续'),
      h('button', { type: 'button', onclick: decide('accept') }, '结束任务'),
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
    h(
      'pre',
      { class: 'output', 'data-live-run': run.id, 'data-empty': output === '', tabindex: 0, 'aria-label': `第 ${run.attempt} 次执行的输出` },
      output || '（暂无输出）',
    ),
    result ? evidenceView(run.id, result) : null,
    ...reviews.map((r) => h('p', { class: `review-note review-${r.decision}` }, r.decision === 'accept' ? '结束任务' : '继续', ` · ${time(r.decidedAt)}`, r.note ? `：${r.note}` : '')),
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
