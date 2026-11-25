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
    parts.push(`上游子任务已经完成（它们的改动不在你的工作目录里，等任务集成分支上线后才会合到一起）：\n${lines.join('\n')}`);
  }
  parts.push(`整个任务的目标（背景）：\n${task.goal}`);
  return `${parts.join('\n\n')}\n\n${FRAME}`;
}

/** 审阅助手看的交付：被审的提交、基线、改动统计和开发助手的交接。 */
export interface ReviewSubject {
  commitSha: string;
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
    `被审的提交：${subject.commitSha}（基线 ${subject.baseCommit}），用 git diff ${subject.baseCommit} ${subject.commitSha} 查看改动。`,
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

export function resumePrompt(goal: string): string {
  return `上一轮执行被中断（PalDock 服务重启或执行器断线）。请先检查工作目录的当前状态，再继续完成目标：\n${goal}\n\n${FRAME}`;
}

/** 任务标题取目标的第一行，过长时截断。 */
export function titleOf(goal: string): string {
  const line = goal.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
