/**
 * 发给执行器的提示词模板。只传目标、验收意见和工作目录说明，不传整段聊天记录（02「助手间编排」）。
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

export function resumePrompt(goal: string): string {
  return `上一轮执行被中断（PalDock 服务重启或执行器断线）。请先检查工作目录的当前状态，再继续完成目标：\n${goal}\n\n${FRAME}`;
}

/** 任务标题取目标的第一行，过长时截断。 */
export function titleOf(goal: string): string {
  const line = goal.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
