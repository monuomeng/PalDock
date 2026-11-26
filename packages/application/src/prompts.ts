/**
 * 发给执行器的提示词模板。只传目标、下一步指令和工作目录说明，不传整段聊天记录（02「助手间编排」）。
 */

const FRAME = [
  '你在一个独立的 git worktree 里工作，只修改这个目录下的文件。',
  '不要提交、推送或合并分支；PalDock 会收集改动供用户验收。',
  '完成后用几句话说明做了什么、如何验证。',
].join('\n');

export function firstRunPrompt(goal: string): string {
  return `${goal}\n\n${FRAME}`;
}

/** 待命中的任务收到下一步指令：同一个 worktree、同一个执行器会话里接着做。 */
export function nextStepPrompt(goal: string, instruction: string): string {
  return `用户的下一步指令：\n${instruction}\n\n这个任务最初的目标：\n${goal}\n\n${FRAME}`;
}

/** 接着一个已结束的任务新开的任务：工作目录从那个任务的分支出发，已经包含它提交的改动。 */
export function continuationPrompt(previous: { goal: string; finalMessage: string | null }, instruction: string): string {
  const summary = previous.finalMessage ? `\n上个任务结束时的说明：\n${previous.finalMessage.slice(0, 2000)}\n` : '';
  return `这个任务接着上一个已结束的任务做，工作目录里已经有上个任务提交的改动。\n上个任务的目标：\n${previous.goal}\n${summary}\n现在要做的：\n${instruction}\n\n${FRAME}`;
}

/** 上游子任务的交接：标题 + 交接摘要（没有时用最终回复），只取开头。 */
export interface UpstreamHandoff {
  title: string;
  summary: string | null;
}

/**
 * 计划节点的第一次 Run：整个任务的目标只作背景，主要是这个节点的目标、相关路径和上游的交接。
 * 不传整段聊天（02「助手间编排」）。上游的改动在 P3-06 之前不在这个 worktree 里，提示里说清楚。
 */
export function planNodePrompt(task: { goal: string }, node: { title: string; goal: string; paths: readonly string[] }, upstream: readonly UpstreamHandoff[]): string {
  const parts = [`你负责的子任务：${node.title}\n${node.goal}`];
  if (node.paths.length > 0) parts.push(`相关路径：\n${node.paths.map((p) => `- ${p}`).join('\n')}`);
  if (upstream.length > 0) {
    const lines = upstream.map((u) => `- ${u.title}：${u.summary ? u.summary.slice(0, 2000) : '（没有交接说明）'}`);
    parts.push(`上游子任务已经完成，它们的改动已合进任务集成分支，你的工作目录从那里出发：\n${lines.join('\n')}`);
  }
  parts.push(`整个任务的目标（背景）：\n${task.goal}`);
  return `${parts.join('\n\n')}\n\n${FRAME}`;
}

/** 审阅助手看的交付：被审的提交、基线、改动统计和开发助手的交接。 */
export interface ReviewSubject {
  /** 被审的提交；直接在项目目录里改的节点没有提交（null），审工作区里还没提交的改动。 */
  commitSha: string | null;
  baseCommit: string;
  diffStat: string | null;
  handoff: string | null;
}

/**
 * 审阅 Run 的提示词：独立会话，只读。目标和验收标准来自计划节点，不带开发助手的对话。
 * 结论只能经 submit_review 交，说「通过」不算。
 */
export function reviewPrompt(node: { title: string; goal: string; paths: readonly string[] }, subject: ReviewSubject): string {
  const parts = [
    `请审阅子任务「${node.title}」的交付。子任务的目标：\n${node.goal}`,
    subject.commitSha
      ? `被审的提交：${subject.commitSha}（基线 ${subject.baseCommit}），用 git diff ${subject.baseCommit} ${subject.commitSha} 查看改动。`
      : '这个子任务直接在项目目录里改，改动还没提交：用 git status 和 git diff 查看工作区里的改动（开始前就有的改动不算这次的交付）。',
  ];
  if (subject.diffStat) parts.push(`改动统计：\n${subject.diffStat}`);
  if (node.paths.length > 0) parts.push(`相关路径：\n${node.paths.map((p) => `- ${p}`).join('\n')}`);
  if (subject.handoff) parts.push(`开发助手的交接：\n${subject.handoff.slice(0, 4000)}`);
  parts.push(
    [
      '你是只读的审阅助手：不要修改、提交或删除任何文件。',
      '看完后必须调用 PalDock 的 submit_review 工具交结论：达到目标就 accept；否则 rework，并写清楚要改什么。',
    ].join('\n'),
  );
  return parts.join('\n\n');
}

/** 审阅助手退回：回到开发助手同一个会话、同一个 worktree，按审阅意见接着改。 */
export function reviewReworkPrompt(goal: string, reason: string): string {
  return `审阅助手退回了你的交付，意见：\n${reason}\n\n子任务的目标：\n${goal}\n\n${FRAME}`;
}

/** 合入集成分支失败交回重做：工作目录里已经合进集成分支的最新提交，冲突文件带冲突标记。 */
export function mergeRedoPrompt(goal: string, conflicts: readonly string[], detail: string | null): string {
  const what =
    conflicts.length > 0
      ? `你的交付和任务集成分支上其他子任务的改动冲突。工作目录里已经合入集成分支的最新提交，下面这些文件带着冲突标记，请解决冲突并保留双方的意图：\n${conflicts.map((f) => `- ${f}`).join('\n')}`
      : `你的交付合进任务集成分支后检查没通过${detail ? `（${detail}）` : ''}。工作目录里已经合入集成分支的最新提交，请修好。`;
  return `${what}\n\n子任务的目标：\n${goal}\n\n${FRAME}`;
}

/** 一次唤醒的上下文：按顺序拼，越靠前越重要；超预算时截断后面的层。 */
export interface WakeContext {
  project: { name: string; rootPath: string };
  /** 本次唤醒：你的消息或一行任务事件摘要。 */
  wake: { trigger: 'user_message' | 'task_event'; summary: string };
  /** 本项目任务板（每行一个任务）；续用会话时和上次发的一样就是 null，不再重发。 */
  board: string[] | null;
  /** 新开原生会话时才有：最新滚动摘要、最近的消息、检索到的历史片段。 */
  fresh?: { summary: string | null; messages: { role: string; body: string }[]; history: string[] };
  /** 这次结束前要写滚动摘要。 */
  askSummary: boolean;
}

const COORDINATOR_RULES = [
  '你是 PalDock 的协调助手，和用户在这个项目里协作。',
  '- 你只读：可以看项目里的代码和文档，不修改、不提交任何文件。',
  '- 要动手的事用 propose_plan 拆成子任务（开发、测试、文档、调研……），用户确认后由专业助手执行；简单的问题直接回答。',
  '- get_status 看任务板；需要用户决定或要向用户汇报时用 notify_user（会先出现在桌面，用户不在电脑前时发到手机）。',
  '- 你在这里写的回复就是对话里的消息，简洁、说清楚下一步。',
  '- 用户说「提交」「推送」「合并」时，分别用 propose_commit / propose_push / propose_merge 提出卡片，用户在桌面上确认后由 PalDock 执行；不要自己运行 git commit / push / merge。',
  '- 专业助手要读项目外的文件时，PalDock 会把审批交给你判断：用 decide_approval 回复 allow / deny / unsure，拿不准就 unsure 交给用户。',
].join('\n');

/** 协调助手的角色说明：只在新开原生会话时发一次（RunPlan.instructions），续用时不再重发。 */
export function coordinatorInstructions(project: { name: string; rootPath: string }): string {
  return `${COORDINATOR_RULES}\n项目：${project.name}（${project.rootPath}）`;
}

/**
 * 协调助手每次唤醒的提示词：这次的消息或事件，加上任务板（变了才发）。角色说明不在这里，见 coordinatorInstructions。
 * 新开会话时再附摘要、最近的对话和历史片段。原生会话的压缩只在单次 Run 内使用，事实以这里给的为准。
 */
export function wakePrompt(ctx: WakeContext, budget = 24_000): string {
  const layers: string[] = [];
  layers.push(ctx.wake.trigger === 'user_message' ? `用户说：\n${ctx.wake.summary}` : `任务事件（不是用户的消息）：\n${ctx.wake.summary}\n请决定下一步：需要时提一个新计划（例如解决冲突的子任务），或用 notify_user 向用户汇报。`);
  if (ctx.askSummary) layers.push('这次结束前请调用 write_summary，写这个会话到目前为止的滚动摘要：目标、已定的事、进行中的任务、待用户决定的问题。');
  if (ctx.fresh?.summary) layers.push(`这个会话之前的摘要：\n${ctx.fresh.summary}`);
  if (ctx.fresh?.messages.length) layers.push(`最近的对话：\n${ctx.fresh.messages.map((m) => `${m.role === 'user' ? '用户' : '你'}：${m.body.slice(0, 1000)}`).join('\n')}`);
  if (ctx.board) layers.push(`${ctx.fresh ? '任务板' : '任务板（有变化，最新）'}：\n${ctx.board.length > 0 ? ctx.board.join('\n') : '（还没有任务）'}`);
  if (ctx.fresh?.history.length) layers.push(`可能相关的历史片段：\n${ctx.fresh.history.map((h) => `- ${h.slice(0, 300)}`).join('\n')}`);
  let out = '';
  for (const layer of layers) {
    const next = out ? `${out}\n\n${layer}` : layer;
    if (next.length > budget) break;
    out = next;
  }
  return out;
}

export function resumePrompt(goal: string): string {
  return `上一轮执行被中断（PalDock 服务重启或执行器断线）。请先检查工作目录的当前状态，再继续完成目标：\n${goal}\n\n${FRAME}`;
}

/** 任务标题取目标的第一行，过长时截断。 */
export function titleOf(goal: string): string {
  const line = goal.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/**
 * 角色会话的说明（2026-11-26 已定，按项目、按角色复用原生会话）：只在新建会话时发一次。
 * 每一轮另给这次子任务的任务包；工作目录每轮可能不同，以任务包里写的为准。
 */
export function roleInstructions(role: { name: string; displayName: string }, project: { name: string; rootPath: string }): string {
  const review = role.name === 'reviewer';
  return [
    `你是 PalDock 的${role.displayName}，在项目 ${project.name}（${project.rootPath}）里长期负责这一类工作。`,
    '- 每一轮 PalDock 会给你一个新的任务包（目标、这一轮的工作目录、相关路径、上游交接）。之前轮次的任务已经结束，不要再动它们的目录。',
    '- 每个任务有自己独立的 git worktree，工作目录每一轮可能不同；只在这一轮指定的工作目录里操作。',
    review
      ? '- 你只读：不修改、不提交、不删除任何文件；看完必须用 submit_review 交结论。'
      : '- 开始前可以用 get_task 读当前任务；做完用 submit_result 交接。不要提交、推送或合并分支。',
    '- 之前轮次学到的项目约定、常用命令和踩过的坑可以沿用。',
    '- 不要运行 git commit / push / merge / reset / checkout 之类改仓库状态的命令：提交和推送由用户在对话里指挥。',
  ].join('\n');
}

/** 角色会话的这一轮：工作目录放最前面，接着是调用方给的任务包；新会话附上前一个会话留下的角色摘要；要轮换时要求先写摘要。 */
export function roleTurnPrompt(turn: { worktree: string; packet: string; inheritedSummary: string | null; writeSummary: boolean }): string {
  const parts = [`这一轮的工作目录（只在这里操作）：${turn.worktree}`];
  if (turn.inheritedSummary) parts.push(`你接手了这个角色之前的会话，它留下的摘要：\n${turn.inheritedSummary.slice(0, 6000)}`);
  parts.push(turn.packet);
  if (turn.writeSummary) {
    parts.push('这个会话用得比较久了，之后会换新会话。这一轮结束前请调用 write_summary，写一份角色摘要：这个项目的约定、常用命令、踩过的坑、还要注意的事（不写具体任务的细节）。');
  }
  return parts.join('\n\n');
}

const SOLO_WORKDIR: Record<'direct' | 'worktree' | 'readonly', string> = {
  direct: '工作目录就是项目目录本身：你的改动直接出现在用户当前分支的工作区里。不要提交、推送或切换分支，改完告诉用户改了哪些文件。',
  worktree: '工作目录是这个项目专门给你的独立 worktree（分支 paldock/solo-…）：可以提交到这个分支，不要推送；用户会自己合并。',
  readonly: '这个项目把你设成只读：只能看代码、跑不改文件的命令，不能修改文件。',
};

/** 单人模式（2026-11-26 已定）：一个助手全权接管，主会话直接读代码、改代码、跑测试，不拆计划。只在新开会话时发一次。 */
export function soloInstructions(project: { name: string; rootPath: string }, isolation: 'direct' | 'worktree' | 'readonly'): string {
  return [
    `你是 PalDock 在项目 ${project.name}（${project.rootPath}）里的单人助手，全权负责这个项目：直接读代码、改代码、跑测试，不需要拆成计划，也不要用 propose_plan。`,
    `- ${SOLO_WORKDIR[isolation]}`,
    '- 需要用户决定、或要在用户不在电脑前时告诉他的事，用 notify_user。',
    '- 你在这里写的回复就是对话里的消息：说清楚改了什么、怎么验证的、还剩什么。',
    '- 不要自己运行 git commit / push / merge / reset 之类改仓库状态的命令；用户说「提交」「推送」「合并」时用 propose_commit / propose_push / propose_merge 提出卡片，由用户确认。',
  ].join('\n');
}

/** 单人模式改完后的审阅：只读，看工作目录里还没提交的改动，结论写在回复里（作为一条消息出现在对话里，不卡流程）。 */
export function soloReviewPrompt(cwd: string): string {
  return [
    `请审阅单人助手刚才在 ${cwd} 里做的改动：用 git status 和 git diff 查看还没提交的改动（独立 worktree 时也看最近的提交）。`,
    '你只读：不要修改、提交或删除任何文件。',
    '最后用一段话给出结论：通过，或者列出需要改的地方和原因。',
  ].join('\n');
}
