import type {
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
} from '@paldock/contracts';
import { taskKey } from '@paldock/domain';

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

export function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** 任务的短编号：taskKey 的前 6 位，命令里用 `#a1b2c3` 引用。 */
export const taskRef = (taskId: string) => taskKey(taskId).slice(0, 6);

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
  const lines = [`项目：${workspace.name} · 状态：${SUBTASK_LABEL[subtask.status]}`];
  if (subtask.branch) lines.push(`分支：${subtask.branch}`);
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

const DECIDED_TEXT = { approved: '已批准', denied: '已拒绝', expired: '已过期（自动拒绝）', cancelled: '已取消' } as const;
const VIA_TEXT: Record<string, string> = { desktop: '在电脑上', feishu: '在飞书', telegram: '在 Telegram', policy: '' };

export function approvalDecidedCard(c: EscalationCandidate, status: keyof typeof DECIDED_TEXT, via: string | null): Card {
  return card(`审批${DECIDED_TEXT[status]}`, 'info', [
    `任务：#${taskRef(c.taskId)} ${clip(c.taskTitle, 60)}`,
    clip(c.approval.summary, 200),
    `${VIA_TEXT[via ?? ''] ?? ''}${DECIDED_TEXT[status]}`,
  ]);
}
