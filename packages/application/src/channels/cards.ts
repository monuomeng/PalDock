import type {
  Card,
  CardButton,
  CardTone,
  EscalationCandidate,
  RiskLevel,
  RunResultRecord,
  SubtaskStatus,
  TaskRecord,
  TaskSummary,
  WorkspaceRecord,
} from '@paldock/contracts';

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
  review: '待验收',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const RISK_LABEL: Record<RiskLevel, string> = { low: '低风险', medium: '中风险', high: '高风险' };

export function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** 任务的短编号：ID 里 UUID 的前 6 位，命令里用 `#a1b2c3` 引用。 */
export const taskRef = (taskId: string) => taskId.replace(/^task_/, '').slice(0, 6);

const card = (title: string, tone: CardTone, lines: string[], buttons: CardButton[] = []): Card => ({ title, tone, lines, buttons });

export const button = (label: string, token: string, style: CardButton['style'] = 'default'): CardButton => ({ label, token, style });

export const notice = (title: string, ...lines: string[]) => card(title, 'info', lines);
export const warning = (title: string, ...lines: string[]) => card(title, 'warning', lines);

export function pairingCard(code: string): Card {
  return card('请在电脑上确认绑定', 'warning', [
    '这个账号还没有绑定到 PalDock。',
    `配对码：${code.slice(0, 4)}-${code.slice(4)}`,
    '请在电脑上打开 PalDock「设置 → 渠道 → 待绑定」，核对配对码后确认。配对码 1 小时内有效。',
  ]);
}

export function pairedCard(): Card {
  return card('绑定成功', 'success', ['现在可以在这里查看任务、新建任务和处理审批。', '发送 /help 查看可用命令。']);
}

export function helpCard(group: boolean): Card {
  const lines = [
    '直接发一句话：在默认项目里新建任务（会先让你确认）。',
    '/projects 列出项目，/use <编号> 设置默认项目',
    '/tasks 最近的任务',
    '/status #编号 查看一个任务',
  ];
  if (!group) lines.push('/cancel #编号 取消任务');
  else lines.push('群里不能取消任务或审批，请到单聊或电脑上处理。');
  return card('PalDock 可用命令', 'info', lines);
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

export function tasksCard(tasks: TaskSummary[]): Card {
  if (tasks.length === 0) return notice('还没有任务');
  return card(
    '最近的任务',
    'info',
    tasks.map(({ task, subtaskStatus }) => `#${taskRef(task.id)} ${SUBTASK_LABEL[subtaskStatus]} · ${clip(task.title, 40)}`),
  );
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

/** 从外部建的任务进入关键节点时发回来源会话；待验收可在单聊里直接验收或退回。 */
export function taskProgressCard(
  task: TaskRecord,
  status: SubtaskStatus,
  reason: string | null,
  result: RunResultRecord | undefined,
  review?: { accept: string; rework: string },
): Card {
  const head = `#${taskRef(task.id)} ${clip(task.title, 60)}`;
  switch (status) {
    case 'running':
      return card(head, 'info', ['开始执行。']);
    case 'review': {
      const lines = ['已完成，等待验收。'];
      if (result?.diffStat) lines.push(`改动：${clip(result.diffStat.split('\n').at(-1) ?? '', 200)}`);
      if (result?.finalMessage) lines.push(`说明：${clip(result.finalMessage, 600)}`);
      if (!review) lines.push('请到单聊或电脑上验收。');
      const buttons = review ? [button('验收通过', review.accept, 'primary'), button('退回重做', review.rework)] : [];
      return card(head, 'success', lines, buttons);
    }
    case 'blocked':
      return card(head, 'warning', [`阻塞：${clip(reason ?? '原因未知', 200)}`, '请到电脑上选择恢复、重新开始或放弃。']);
    case 'failed':
      return card(head, 'danger', [`失败：${clip(reason ?? '原因未知', 200)}`]);
    case 'succeeded':
      return card(head, 'success', ['已验收，改动已提交到 PalDock 分支（未合并）。']);
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
