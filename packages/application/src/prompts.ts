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

export function reworkPrompt(goal: string, note: string): string {
  return `用户验收后要求修改：\n${note}\n\n原始目标：\n${goal}\n\n${FRAME}`;
}

export function resumePrompt(goal: string): string {
  return `上一轮执行被中断（PalDock 服务重启或执行器断线）。请先检查工作目录的当前状态，再继续完成目标：\n${goal}\n\n${FRAME}`;
}

/** 任务标题取目标的第一行，过长时截断。 */
export function titleOf(goal: string): string {
  const line = goal.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
