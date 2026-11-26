import type {
  QuestionRecord,
  Card,
  CardButton,
  CardTone,
  EscalationCandidate,
  RiskLevel,
  RunResultRecord,
  SubtaskStatus,
  TaskDetail,
  TaskRecord,
  TaskSummary,
  WorkspaceRecord,
  NoticeRecord,
} from '@paldock/contracts';
import { noticeRef } from '@paldock/contracts';
import { taskRef } from '@paldock/domain';

/**
 * 发到外部渠道的卡片文案。内容一律当纯文本（适配器不解析标记）；任务目标、执行器回复等都会截断，
 * 不把检查输出、命令全文以外的执行细节发到手机上。
 */

export const SUBTASK_LABEL: Record<SubtaskStatus, string> = {
  draft: '草稿',
  queued: '排队中',
  running: '执行中',
  waiting_approval: '等待审批',
  waiting_dependency: '等待依赖',
  blocked: '阻塞',
  review: '待命中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const RISK_LABEL: Record<RiskLevel, string> = { low: '低风险', medium: '中风险', high: '高风险' };

/** 任务在渠道里显示的状态：单子任务用子任务的，按计划拆分的任务用任务自己的（渠道里的任务图入口随 P3-10）。 */
export const statusOf = ({ task, subtask }: TaskDetail): SubtaskStatus => subtask?.status ?? task.status;

export function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** 任务的短编号：taskKey 的前 6 位，命令里用 `#a1b2c3` 引用。 */
export { taskRef };

/** 改动统计的最后一行（「n files changed, …」）。 */
const diffSummary = (result: RunResultRecord | null | undefined, max: number) =>
  result?.diffStat ? clip(result.diffStat.split('\n').at(-1) ?? '', max) : undefined;

const card = (title: string, tone: CardTone, lines: string[], buttons: CardButton[] = []): Card => ({ title, tone, lines, buttons });

export const button = (label: string, token: string, style: CardButton['style'] = 'default'): CardButton => ({ label, token, style });

export const notice = (title: string, ...lines: string[]) => card(title, 'info', lines);
export const warning = (title: string, ...lines: string[]) => card(title, 'warning', lines);

export function pairingCard(code: string): Card {
  return card('请在电脑上确认绑定', 'warning', [
    '这个账号还没有绑定到 PalDock。',
    `配对码：${code.slice(0, 4)}-${code.slice(4)}`,
    '请在电脑上打开 PalDock「设置 → 待确认的配对」，核对配对码后确认。配对码 1 小时内有效。',
  ]);
}

export function pairedCard(): Card {
  return card('绑定成功', 'success', ['现在可以在这里查看任务、新建任务和处理审批。', '发送 /help 查看可用命令。']);
}

export function helpCard(group: boolean): Card {
  const shared = ['/new <目标> 新建任务', '/projects 列出项目，/use <编号> 设置默认项目', '/tasks 最近的任务，/status #编号 查看一个任务'];
  if (group) {
    return card('PalDock 可用命令', 'info', [
      '@我 说一句话：在默认项目里新建任务（会先让你确认）。',
      ...shared,
      '群里不能继续、结束、取消任务或审批，请到单聊或电脑上处理。',
    ]);
  }
  return card('PalDock 可用命令', 'info', [
    '直接发一句话：当前任务待命中时就是它的下一步指令；没有当前任务时新建任务（会先让你确认）。',
    '/continue 列出最近的任务，选一个作为当前任务；/continue #编号 <指令> 直接继续它',
    '/done 结束当前任务（改动提交到任务分支，不合并）',
    ...shared,
    '/cancel #编号 取消任务；不带编号的命令都指当前任务',
  ]);
}

export function projectsCard(workspaces: WorkspaceRecord[], defaultId: string | null): Card {
  if (workspaces.length === 0) return notice('还没有项目', '请先在电脑上的 PalDock 里新建一次任务，选择项目目录。');
  return card(
    '项目',
    'info',
    workspaces.map((w, i) => `${i + 1}. ${w.name}${w.id === defaultId ? '（默认）' : ''}`).concat('发送 /use <编号> 设置默认项目。'),
  );
}

export function confirmCreateCard(workspace: WorkspaceRecord, goal: string, confirm: string, dismiss: string): Card {
  return card(
    '新建任务？',
    'info',
    [`项目：${workspace.name}`, `目标：${clip(goal, 500)}`, '确认后会在电脑上新建任务并开始执行；10 分钟内有效。'],
    [button('新建并开始', confirm, 'primary'), button('不用了', dismiss)],
  );
}

/** 列表里的一行：编号（当前任务加标记）、状态、[多久之前]、目标摘要。 */
function taskLine({ task, subtaskStatus, lastActivityAt }: TaskSummary, currentId: string | null, now?: Date): string {
  const when = now ? ` · ${ago(lastActivityAt, now)}` : '';
  return `#${taskRef(task.id)}${task.id === currentId ? '（当前）' : ''} ${SUBTASK_LABEL[subtaskStatus]}${when} · ${clip(task.title, 40)}`;
}

export function tasksCard(tasks: TaskSummary[], currentId: string | null): Card {
  if (tasks.length === 0) return notice('还没有任务');
  return card('最近的任务', 'info', tasks.map((t) => taskLine(t, currentId)));
}

/** 相对时间，手机上不用换算时区。 */
function ago(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / (24 * 60))} 天前`;
}

/** /continue 的列表：按最近活动排序，每个任务一个按钮，点了设为当前任务并显示它做过什么。 */
export function recentTasksCard(tasks: TaskSummary[], currentId: string | null, now: Date, select: (taskId: string) => string): Card {
  if (tasks.length === 0) return notice('还没有任务', '直接发一句话就能新建任务。');
  const lines = tasks.map((t) => taskLine(t, currentId, now));
  lines.push('点编号查看这个任务做过什么，并把它设为当前任务。');
  return card('最近的任务', 'info', lines, tasks.map(({ task }) => button(`#${taskRef(task.id)}`, select(task.id))));
}

/** 每一轮收到的指令：第一轮是任务目标；之后是上一轮待命时用户给的下一步指令；中断后恢复、重新开始没有新指令。 */
function instructionOf(detail: TaskDetail, index: number): string {
  if (index === 0) return detail.task.goal;
  const previous = detail.runs[index - 1]!;
  const next = previous.reviews.find((r) => r.decision === 'rework')?.note;
  if (next) return next;
  return detail.runs[index]!.run.resumesRunId ? '（中断后恢复）' : '（重新开始）';
}

/** 下一步能做什么：按服务端给出的可用操作，与单聊里普通文字的处理一致。 */
function nextStep({ actions }: TaskDetail): string {
  if (actions.review) return '直接回复就是下一步指令；/done 结束任务。';
  if (actions.continueFrom) return '任务已结束。回复一句话会基于它新建任务接着做。';
  if (actions.restart) return '任务被阻塞，请到电脑上恢复、重新开始或放弃。';
  if (!actions.cancel) return '任务已结束。回复一句话会新建任务（会先让你确认）。';
  return '正在执行，停下后再发指令。';
}

/** 一个任务做过什么：每一轮的指令、AI 的说明和改动，只列最近几轮。 */
export function taskHistoryCard(detail: TaskDetail, now: Date, maxRounds = 5): Card {
  const { task, subtask, workspace, runs } = detail;
  const lines = [`项目：${workspace.name} · 状态：${SUBTASK_LABEL[statusOf(detail)]}`];
  if (subtask?.branch) lines.push(`分支：${subtask.branch}`);
  if (task.continuedFromTaskId) lines.push(`接续自 #${taskRef(task.continuedFromTaskId)}`);
  const first = Math.max(0, runs.length - maxRounds);
  if (first > 0) lines.push(`（共 ${runs.length} 轮，只显示最近 ${maxRounds} 轮）`);
  if (runs.length === 0) lines.push(`目标：${clip(task.goal, 300)}`, '还没有开始执行。');
  runs.forEach((run, index) => {
    if (index < first) return;
    lines.push('', `第 ${index + 1} 轮 · ${ago(run.run.startedAt, now)}`, `指令：${clip(instructionOf(detail, index), 200)}`);
    if (run.result?.finalMessage) lines.push(`说明：${clip(run.result.finalMessage, 300)}`);
    const diff = diffSummary(run.result, 120);
    if (diff) lines.push(`改动：${diff}`);
    if (run.run.failureReason) lines.push(`原因：${clip(run.run.failureReason, 120)}`);
  });
  lines.push('', nextStep(detail));
  return card(`#${taskRef(task.id)} ${clip(task.title, 60)}`, 'info', lines);
}

export function confirmDoneCard(task: TaskRecord, confirm: string, dismiss: string): Card {
  return card(`结束 #${taskRef(task.id)}？`, 'info', [clip(task.title, 200), '改动会提交到任务分支（不合并），任务结束。'], [
    button('结束任务', confirm, 'primary'),
    button('先不结束', dismiss),
  ]);
}

export function taskCard(task: TaskRecord, workspace: WorkspaceRecord, status: SubtaskStatus, reason: string | null): Card {
  const lines = [`项目：${workspace.name}`, `状态：${SUBTASK_LABEL[status]}${reason ? `（${clip(reason, 200)}）` : ''}`];
  return card(`#${taskRef(task.id)} ${clip(task.title, 60)}`, 'info', lines);
}

export function confirmCancelCard(task: TaskRecord, confirm: string, dismiss: string): Card {
  return card(`取消 #${taskRef(task.id)}？`, 'warning', [clip(task.title, 200), '执行中的 Codex 会被中断。'], [
    button('确认取消', confirm, 'danger'),
    button('不取消', dismiss),
  ]);
}

/** 从外部建的任务进入关键节点时发回来源会话；待命中时单聊里可以直接继续或结束。 */
export function taskProgressCard(
  task: TaskRecord,
  status: SubtaskStatus,
  reason: string | null,
  result: RunResultRecord | undefined,
  review?: { end: string; next: string },
  dm = review !== undefined,
): Card {
  const head = `#${taskRef(task.id)} ${clip(task.title, 60)}`;
  switch (status) {
    case 'running':
      return card(head, 'info', ['开始执行。']);
    case 'review': {
      const lines = ['这一轮做完了，待命中。'];
      const diff = diffSummary(result, 200);
      if (diff) lines.push(`改动：${diff}`);
      if (result?.finalMessage) lines.push(`说明：${clip(result.finalMessage, 600)}`);
      lines.push(review ? '直接回复就是下一步指令；/new 另起新任务。' : '请到单聊或电脑上继续或结束。');
      const buttons = review ? [button('继续', review.next), button('结束任务', review.end, 'primary')] : [];
      return card(head, 'success', lines, buttons);
    }
    case 'blocked':
      return card(head, 'warning', [`阻塞：${clip(reason ?? '原因未知', 200)}`, '请到电脑上选择恢复、重新开始或放弃。']);
    case 'failed':
      return card(head, 'danger', [`失败：${clip(reason ?? '原因未知', 200)}`]);
    case 'succeeded':
      return card(head, 'success', [
        '任务已结束，改动已提交到 PalDock 分支（未合并）。',
        dm ? `想接着做：/continue #${taskRef(task.id)} <指令>` : '想接着做请到单聊或电脑上。',
      ]);
    case 'cancelled':
      return card(head, 'info', ['已取消。']);
    default:
      return card(head, 'info', [`状态：${SUBTASK_LABEL[status]}`]);
  }
}

/**
 * 升级到外部单聊的审批。不允许远程批准（等级或类别不允许）时不放按钮，只提醒到桌面处理。
 */
/** 协调助手在主会话里的回复，发回这个外部会话。 */
export function coordinatorReplyCard(body: string): Card {
  return card('协调助手', 'info', [clip(body, 3000)]);
}

/**
 * 计划确认卡片（P3-10）：每个节点一行（角色、执行器、依赖），检查命令原样列出；
 * buttons 为空时只提醒（L1 遇到带检查命令的计划），why 说明原因。修改只能在电脑上做。
 */
export function planCard(
  title: string,
  revision: number,
  nodes: { title: string; role: string; executor: string; dependsOn: string[]; check: string | null }[],
  buttons: { confirm: string; reject: string } | undefined,
  why: string | null,
): Card {
  const lines = nodes.map((n) => `· ${clip(n.title, 60)}（${n.role} · ${n.executor}${n.dependsOn.length ? ` · 依赖 ${n.dependsOn.join('、')}` : ''}）`);
  const checks = nodes.filter((n) => n.check);
  if (checks.length > 0) lines.push('', '检查命令（以你的账户权限运行）：', ...checks.map((n) => `· ${clip(n.title, 40)}：${n.check}`));
  lines.push('', '改执行器、检查命令或删节点请到电脑上；这里只能确认或退回。');
  if (why) lines.push(why);
  return card(`计划待确认 · ${clip(title, 40)}（第 ${revision} 版）`, 'warning', lines, buttons ? [button('确认', buttons.confirm, 'primary'), button('退回', buttons.reject, 'danger')] : []);
}

export function planDecidedCard(title: string, status: 'confirmed' | 'rejected' | 'superseded', via: string | null): Card {
  const text = status === 'confirmed' ? '已确认' : status === 'rejected' ? '已退回' : '已被新一版取代';
  return card(`计划${text} · ${clip(title, 40)}`, 'info', [`${VIA_TEXT[via ?? ''] ?? ''}${text}`]);
}

/** 协调助手的通知或问题（桌面没人看时升级到单聊）；带编号，回复时带上它。 */
export function noticeCard(notice: NoticeRecord): Card {
  const ref = noticeRef(notice.id);
  const lines = [clip(notice.body, 1500)];
  if (notice.kind === 'question') lines.push('', `回复时请带上编号 ${ref}，或到电脑上的 PalDock 对话里回答。`);
  return card(notice.kind === 'question' ? `协调助手的问题 · ${ref}` : `协调助手 · ${ref}`, notice.kind === 'question' ? 'warning' : 'info', lines);
}

export function approvalCard(c: EscalationCandidate, buttons: { approve: string; deny: string } | undefined, why: string | null): Card {
  const { approval } = c;
  const lines = [
    `项目：${c.workspaceName}`,
    `任务：#${taskRef(c.taskId)} ${clip(c.taskTitle, 60)}`,
    `${RISK_LABEL[approval.riskLevel]}：${clip(approval.summary, 200)}`,
  ];
  if (approval.detail) lines.push(clip(approval.detail, 500));
  if (approval.cwd) lines.push(`目录：${clip(approval.cwd, 200)}`);
  lines.push(`过期时间：${approval.expiresAt.replace('T', ' ').slice(0, 16)}（UTC）`);
  if (why) lines.push(why);
  const actions = buttons ? [button('批准本次', buttons.approve, 'primary'), button('拒绝', buttons.deny, 'danger')] : [];
  return card('电脑上有一个审批等你处理', approval.riskLevel === 'high' ? 'danger' : 'warning', lines, actions);
}

/** 同一次 Run 短时间内的几个审批合成一条消息：逐项列出；按钮只在电脑上（全部允许 / 全部拒绝 / 逐项处理）。 */
export function approvalGroupCard(cs: readonly EscalationCandidate[]): Card {
  const first = cs[0]!;
  const lines = [
    `项目：${first.workspaceName}`,
    `任务：#${taskRef(first.taskId)} ${clip(first.taskTitle, 60)}`,
    ...cs.map((c, i) => `${i + 1}. ${RISK_LABEL[c.approval.riskLevel]}：${clip(c.approval.summary, 160)}`),
    `共 ${cs.length} 项，请到电脑上一起或逐项处理（各项独立过期，最早 ${cs.map((c) => c.approval.expiresAt).sort()[0]!.replace('T', ' ').slice(0, 16)} UTC）。`,
  ];
  return card(`电脑上有 ${cs.length} 个审批等你处理`, cs.some((c) => c.approval.riskLevel === 'high') ? 'danger' : 'warning', lines, []);
}

export function approvalGroupDecidedCard(c: EscalationCandidate, group: readonly { status: string }[]): Card {
  const count = (s: string) => group.filter((a) => a.status === s).length;
  return card('这组审批已处理', 'info', [
    `任务：#${taskRef(c.taskId)} ${clip(c.taskTitle, 60)}`,
    `共 ${group.length} 项：批准 ${count('approved')}、拒绝 ${count('denied')}、过期 ${count('expired')}、取消 ${count('cancelled')}`,
  ]);
}

const DECIDED_TEXT = { approved: '已批准', denied: '已拒绝', expired: '已过期（自动拒绝）', cancelled: '已取消' } as const;
const VIA_TEXT: Record<string, string> = { desktop: '在电脑上', feishu: '在飞书', telegram: '在 Telegram', policy: '', coordinator: '由协调助手' };

export function approvalDecidedCard(c: EscalationCandidate, status: keyof typeof DECIDED_TEXT, via: string | null): Card {
  return card(`审批${DECIDED_TEXT[status]}`, 'info', [
    `任务：#${taskRef(c.taskId)} ${clip(c.taskTitle, 60)}`,
    clip(c.approval.summary, 200),
    `${VIA_TEXT[via ?? ''] ?? ''}${DECIDED_TEXT[status]}`,
  ]);
}

/**
 * 协调助手在对话里问你的问题（0.3.8）：问题原文、各项；有敏感路径时不写原文和路径，只说要到电脑上确认。
 * 按钮：按建议处理、都不要、带目标的单项；渠道权限不够的项写明原因。
 */
export function questionCard(
  q: QuestionRecord,
  buttons: { accept: string | null; reject: string; items: { label: string; token: string }[] },
  blocked: readonly string[],
): Card {
  const sensitive = q.items.some((i) => i.sensitive);
  const lines = sensitive ? [`协调助手在等你决定 ${q.items.length} 项，其中有敏感路径。`] : [clip(q.text, 800)];
  if (!sensitive && q.items.length > 1) lines.push(...q.items.map((i, n) => `${n + 1}. ${clip(i.label, 160)}`));
  lines.push(...blocked);
  const actions = [
    ...(buttons.accept ? [button(q.author === 'host' ? '允许' : '按建议处理', buttons.accept, 'primary')] : []),
    ...buttons.items.map((b) => button(clip(b.label, 30), b.token, 'default')),
    button(q.author === 'host' ? '拒绝' : '都不要', buttons.reject, 'danger'),
  ];
  return card('协调助手在等你决定', q.items.some((i) => i.highImpact) ? 'danger' : 'warning', lines, actions);
}

export function questionClosedCard(q: QuestionRecord): Card {
  const text = q.items.some((i) => i.sensitive) ? `${q.items.length} 项（含敏感路径）` : clip(q.text, 300);
  const how = q.status === 'replaced' ? '已被新的问题取代' : q.status === 'void' ? '已在别处处理' : '已处理';
  return card(`问题${how}`, 'info', [text, ...(q.result ? [clip(q.result, 300)] : [])]);
}
