import type { PlanDetail, PlanNodeView, PlanRecord } from '@paldock/contracts';
import { call } from '../api.js';
import { h } from '../dom.js';
import { CHECK_LABEL, GATE_LABEL, PLAN_LABEL, RUN_LABEL, SUBTASK_LABEL, duration, time } from '../format.js';
import { taskLink } from '../router.js';
import { approvalView, type Act } from './approval-card.js';

export type { Act } from './approval-card.js';

/** 自动确认的计划：确认时没有经过任何一端（decidedVia 为空），且排定过自动确认。 */
const isAutoConfirmed = (plan: PlanRecord) => plan.status === 'confirmed' && plan.decidedVia === null && plan.autoConfirmAt !== null;

/** 简单计划排定了自动确认：显示时间和「撤回」（撤回后留在待确认，等你确认）。 */
function autoConfirmView(plan: PlanRecord, act: Act): HTMLElement | null {
  if (!plan.autoConfirmAt) return null;
  return h(
    'p',
    { class: 'hint' },
    `简单计划（只有 1 个节点、不带检查命令）：${time(plan.autoConfirmAt)} 自动确认。`,
    h('button', { type: 'button', onclick: act(() => call('plan.withdrawAuto', { planId: plan.id, expectedVersion: plan.version })) }, '撤回自动确认'),
  );
}

/**
 * 一版计划：节点、依赖、状态，待确认时的确认 / 退回（可带意见）、简单计划的自动确认与撤回。
 * 任务详情页和对话页的计划卡片共用；对话页（inChat）不在卡片里改节点，给「在任务页修改」的链接。
 */
export function planView({ plan, nodes, actions: allowed, confirmedRevision }: PlanDetail, act: Act, options: { inChat?: boolean } = {}): HTMLElement {
  const noteId = `plan-note-${plan.id}`;
  const note = h('textarea', { id: noteId, rows: 2, 'data-keep': `plan-${plan.id}`, placeholder: '可选：给协调助手的意见（确认或退回都会交给它）' }) as HTMLTextAreaElement;
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
        autoConfirmView(plan, act),
        h('label', { for: noteId }, '意见'),
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
          options.inChat ? h('a', { href: taskLink(plan.taskId) }, '在任务页修改') : null,
        ),
      )
    : null;
  const titles = new Map(nodes.map((n) => [n.node.key, n.node.title]));
  return h(
    'section',
    { class: 'plan', 'aria-label': '计划' },
    h('h3', {}, `计划第 ${plan.revision} 版 · `, h('span', { class: `status plan-${plan.status}` }, PLAN_LABEL[plan.status])),
    plan.decisionNote ? h('p', { class: 'hint' }, `说明：${plan.decisionNote}`) : null,
    plan.decidedVia && plan.decidedVia !== 'desktop' ? h('p', { class: 'hint' }, `在${plan.decidedVia === 'feishu' ? '飞书' : 'Telegram'}上${plan.status === 'rejected' ? '退回' : '确认'}`) : null,
    isAutoConfirmed(plan) ? h('p', { class: 'hint' }, `简单计划，已自动确认（${time(plan.decidedAt)}）`) : null,
    options.inChat && !allowed.confirm ? h('p', {}, h('a', { href: taskLink(plan.taskId) }, '查看任务')) : null,
    decide,
    h(
      'table',
      { class: 'tasks plan-nodes' },
      h('thead', {}, h('tr', {}, h('th', {}, '节点'), h('th', {}, '角色 / 执行器'), h('th', {}, '依赖'), h('th', {}, '状态'), h('th', {}, ''))),
      h('tbody', {}, ...orderByDeps(nodes).flatMap(({ view, depth }) => [nodeRow(view, titles, act, depth, allowed.edit && !options.inChat ? plan : null), runsRow(view, act)])),
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
function runsRow({ node, runs }: PlanNodeView, act: Act): HTMLElement {
  // 等待审批的那次 Run：直接显示审批内容和「允许一次 / 拒绝」，不用再找别的页面
  const pending = runs.flatMap((r) => r.approvals.filter((a) => a.status === 'pending'));
  return h(
    'tr',
    { class: 'node-runs' },
    h(
      'td',
      { colspan: 5 },
      ...pending.map((a) => approvalView(a, act)),
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
