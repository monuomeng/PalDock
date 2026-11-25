import type { ApprovalRecord, PlanDetail, PlanNodeView, RunDetail, SubtaskRecord, TaskDetail } from '@paldock/contracts';
import { call } from '../api.js';
import { h, type Child } from '../dom.js';
import { APPROVAL_LABEL, CHECK_LABEL, GATE_LABEL, PLAN_LABEL, RISK_LABEL, RUN_LABEL, SUBTASK_LABEL, checkCommandText, duration, time } from '../format.js';
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
      ...(task.integrationBranch ? fact('集成分支', task.integrationBranch) : []),
      ...(task.integrationWorktree ? fact('集成 worktree', task.integrationWorktree) : []),
    ),
    h('details', {}, h('summary', {}, '目标'), h('pre', { class: 'goal' }, task.goal)),
    error,
    // 全部节点通过：合进你自己的分支由你用 git 做，PalDock 不碰它
    task.status === 'succeeded' && task.integrationBranch
      ? h(
          'section',
          { class: 'panel review', 'aria-label': '待合并' },
          h('p', {}, h('strong', {}, '待合并：'), `全部子任务已合进集成分支 ${task.integrationBranch}。请用 git 把它合进你自己的分支（PalDock 不推送、不改你的分支）。`),
        )
      : null,
    plan ? planView(plan, act) : null,
    cancel,
  );
  const ids = new Set([task.id, ...(plan ? [plan.plan.id, ...plan.nodes.flatMap((n) => (n.subtask ? [n.subtask.id] : []))] : [])]);
  return { element, ids };
}

function planView({ plan, nodes, actions: allowed, confirmedRevision }: PlanDetail, act: Act): HTMLElement {
  const note = h('textarea', { id: 'plan-note', rows: 2, 'data-keep': `plan-${plan.id}`, placeholder: '可选：给协调助手的意见（确认或退回都会交给它）' }) as HTMLTextAreaElement;
  const running = confirmedRevision !== null && confirmedRevision !== plan.revision;
  const decide = allowed.confirm
    ? h(
        'section',
        { class: 'panel review', 'aria-label': '计划待确认' },
        h(
          'p',
          {},
          h('strong', {}, '计划待确认：'),
          running
            ? `正在执行的是第 ${confirmedRevision} 版。确认这一版后，没变的节点沿用原结论，改了的节点（和它的下游）重新执行，删掉的节点取消。`
            : '确认后按下面的节点建子任务并开始派单；没有依赖的先开始。确认前可以改每个节点的执行器和检查命令，或删掉节点。',
        ),
        h('p', { class: 'hint' }, '检查命令以你的账户权限运行、可以联网；确认计划即确认这些命令。'),
        h('label', { for: 'plan-note' }, '意见'),
        note,
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            {
              type: 'button',
              class: 'primary',
              onclick: act(() => {
                const text = note.value.trim();
                return call('plan.confirm', { planId: plan.id, expectedVersion: plan.version, ...(text ? { note: text } : {}) });
              }),
            },
            '确认计划',
          ),
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
      h('thead', {}, h('tr', {}, h('th', {}, '节点'), h('th', {}, '角色 / 执行器'), h('th', {}, '依赖'), h('th', {}, '状态'), h('th', {}, ''))),
      h('tbody', {}, ...orderByDeps(nodes).flatMap(({ view, depth }) => [nodeRow(view, titles, act, depth, allowed.edit ? plan : null), runsRow(view)])),
    ),
  );
}

/** 按依赖缩进：根节点在前，每个节点排在它最后一个依赖之后，缩进层数是最长依赖链的长度。 */
function orderByDeps(nodes: PlanNodeView[]): { view: PlanNodeView; depth: number }[] {
  const depth = new Map<string, number>();
  const byKey = new Map(nodes.map((n) => [n.node.key, n]));
  const level = (key: string, seen = new Set<string>()): number => {
    if (depth.has(key)) return depth.get(key)!;
    if (seen.has(key)) return 0;
    seen.add(key);
    const deps = byKey.get(key)?.node.dependsOn ?? [];
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((k) => level(k, seen)));
    depth.set(key, d);
    return d;
  };
  return nodes.map((view) => ({ view, depth: level(view.node.key) })).sort((a, b) => a.depth - b.depth || a.view.node.position - b.view.node.position);
}

/** 节点的各次 Run：工作 / 审阅、执行器、状态、用时、检查结果。 */
function runsRow({ node, runs }: PlanNodeView): HTMLElement {
  return h(
    'tr',
    { class: 'node-runs' },
    h(
      'td',
      { colspan: 5 },
      runs.length === 0
        ? null
        : h(
            'details',
            {},
            h('summary', {}, `「${node.title}」的执行记录（${runs.length} 次）`),
            ...runs.map(({ run, result }) =>
              h(
                'p',
                { class: 'hint' },
                `第 ${run.attempt} 次 · ${run.purpose === 'review' ? '审阅' : '工作'} · ${run.runtime} · `,
                h('span', { class: `status status-${run.status}` }, RUN_LABEL[run.status]),
                ` · ${time(run.startedAt)} · 用时 ${duration(run.startedAt, run.endedAt)}`,
                result ? ` · 检查 ${CHECK_LABEL[result.checkStatus]}` : '',
                run.failureReason ? ` · ${run.failureReason}` : '',
              ),
            ),
          ),
    ),
  );
}

/** 确认前修改：执行器、检查命令（可执行文件 + 每行一个参数）、删节点。 */
function editControls(view: PlanNodeView, plan: PlanDetail['plan'], act: Act): HTMLElement[] {
  const { node } = view;
  const edit = (change: Parameters<typeof call<'plan.editNode'>>[1]['edit']) => act(() => call('plan.editNode', { planId: plan.id, expectedVersion: plan.version, edit: change }));
  const executor = h(
    'select',
    { 'aria-label': `${node.title} 的执行器` },
    h('option', { value: '', selected: node.executor === null }, `按角色设置（${view.executor}）`),
    ...(['codex', 'claude'] as const).map((e) => h('option', { value: e, selected: node.executor === e }, e)),
  ) as HTMLSelectElement;
  executor.addEventListener('change', () => void edit({ kind: 'executor', nodeKey: node.key, executor: (executor.value || null) as 'codex' | 'claude' | null })());
  const exe = h('input', { type: 'text', value: node.checkCommand?.executable ?? '', placeholder: '检查命令，例如 pnpm', 'aria-label': `${node.title} 的检查命令` }) as HTMLInputElement;
  const args = h('textarea', { rows: 2, placeholder: '参数，每行一个', 'aria-label': `${node.title} 的检查命令参数` }, (node.checkCommand?.args ?? []).join('\n')) as HTMLTextAreaElement;
  const saveCheck = () => {
    const executable = exe.value.trim();
    return edit({ kind: 'check', nodeKey: node.key, check: executable ? { executable, args: args.value.split(/\r?\n/).filter((l) => l !== '') } : null })();
  };
  return [
    h('div', {}, executor),
    h('div', {}, exe, args, h('button', { type: 'button', onclick: () => void saveCheck() }, '保存检查命令')),
    h('button', { type: 'button', class: 'danger', onclick: edit({ kind: 'remove', nodeKey: node.key }) }, '删掉这个节点'),
  ];
}

/** 节点的一行：目标、路径、检查命令、依赖、状态与闸门（检查结果、越界文件、审阅结论），以及人工通过 / 退回 / 重新开始。 */
function nodeRow(view: PlanNodeView, titles: Map<string, string>, act: Act, depth: number, editable: PlanDetail['plan'] | null): HTMLElement {
  const { node, subtask, actions: allowed, gate, merge } = view;
  const deps = node.dependsOn.map((k) => titles.get(k) ?? k).join('、') || '—';
  const stage = subtask?.gateStage ? `（${GATE_LABEL[subtask.gateStage]}）` : '';
  const status = subtask ? h('span', { class: `status status-${subtask.status}` }, SUBTASK_LABEL[subtask.status], stage) : '未开始';
  const decide = (decision: 'accept' | 'rework', note?: string) =>
    act(() => call('review.decide', { subtaskId: subtask!.id, expectedVersion: subtask!.version, decision, ...(note ? { note } : {}) }));
  const note = h('input', { type: 'text', 'data-keep': `rework-${subtask?.id ?? node.key}`, placeholder: '退回理由', 'aria-label': `${node.title} 的退回理由` }) as HTMLInputElement;
  // 合进集成分支失败（冲突或集成检查没过）：交回开发助手在集成分支最新提交上重做，或你自己改好后重试合并
  const mergeFailed = subtask && allowed?.review && merge && (merge.phase === 'conflict' || merge.phase === 'check_failed');
  const review = mergeFailed
    ? [
        h('button', { type: 'button', class: 'primary', onclick: act(() => call('merge.redo', { subtaskId: subtask.id, expectedVersion: subtask.version })) }, '交回开发助手重做'),
        h('button', { type: 'button', onclick: decide('accept') }, '我已处理，重试合并'),
        h('div', { class: 'hint' }, `节点 worktree：${subtask.worktreePath ?? '—'}`),
      ]
    : subtask && allowed?.review
      ? [
          h('button', { type: 'button', class: 'primary', onclick: decide('accept') }, '通过'),
          note,
          h('button', { type: 'button', onclick: () => void (note.value.trim() ? decide('rework', note.value.trim())() : (note.focus(), undefined)) }, '退回'),
        ]
      : [];
  const restart =
    subtask && allowed?.restart
      ? h('button', { type: 'button', onclick: act(() => call('run.recover', { subtaskId: subtask.id, expectedVersion: subtask.version, action: 'restart' })) }, '重新开始')
      : null;
  return h(
    'tr',
    {},
    h(
      'td',
      { style: `padding-left: ${8 + depth * 20}px` },
      depth > 0 ? h('span', { class: 'hint', 'aria-hidden': 'true' }, '└ ') : null,
      h('strong', {}, node.title),
      h('div', { class: 'hint' }, node.goal),
      node.paths.length ? h('div', { class: 'hint' }, `路径：${node.paths.join('，')}`) : null,
      node.checkCommand ? h('div', { class: 'hint' }, `检查：${[node.checkCommand.executable, ...node.checkCommand.args].join(' ')}`) : null,
    ),
    h('td', {}, node.role, h('div', { class: 'hint' }, `执行器：${view.executor}${node.executor ? '（已指定）' : ''}`), ...(editable ? editControls(view, editable, act) : [])),
    h('td', {}, deps),
    h(
      'td',
      {},
      status,
      subtask?.statusReason ? h('div', { class: 'hint' }, subtask.statusReason) : null,
      gate ? gateView(gate) : null,
      merge?.phase === 'done' && merge.candidateSha ? h('div', { class: 'hint' }, `已合进集成分支：${merge.candidateSha.slice(0, 10)}`) : null,
    ),
    h('td', {}, ...review, restart),
  );
}

/** 最近一次交付的闸门：提交、检查、越界文件，以及审阅助手和你的结论。 */
function gateView({ result, reviews }: NonNullable<PlanNodeView['gate']>): HTMLElement {
  return h(
    'div',
    { class: 'hint gate' },
    result?.commitSha ? h('div', {}, `提交 ${result.commitSha.slice(0, 10)} · 检查 `, h('span', { class: `check check-${result.checkStatus}` }, CHECK_LABEL[result.checkStatus])) : null,
    result?.outOfScope?.length ? h('div', { class: 'error' }, `越出交付范围：${result.outOfScope.join('，')}`) : null,
    ...reviews.map((r) =>
      h('div', { class: `review-note review-${r.decision}` }, `${r.reviewerRunId ? '审阅助手' : '你'}${r.decision === 'accept' ? '通过' : '退回'}`, r.note ? `：${r.note}` : ''),
    ),
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
