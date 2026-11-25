/**
 * 任务 ID 的紧凑写法：去掉 `task_` 前缀和连字符、统一小写。
 * worktree 目录与分支名取前 12 位，外部渠道里的短编号（#a1b2c3）取前 6 位；按编号或分支名查任务都用它做前缀匹配。
 */
export const taskKey = (taskId: string) => taskId.replace(/^task_/, '').replaceAll('-', '').toLowerCase();

/** 任务的短编号（#a1b2c3 里的 6 位）：外部渠道、协调助手的任务板和提示词共用。 */
export const taskRef = (taskId: string) => taskKey(taskId).slice(0, 6);

/**
 * taskKey 的前缀（短编号、分支名里的编号）还原成任务 ID 的前缀，用于按主键范围查找。
 * ID 是 `task_` + 小写 UUID，第 8 位之后才有连字符；不是十六进制时返回 undefined。
 */
export function taskIdPrefix(key: string): string | undefined {
  if (!/^[0-9a-f]{1,32}$/.test(key)) return undefined;
  const groups = [8, 4, 4, 4, 12];
  const parts: string[] = [];
  let rest = key;
  for (const size of groups) {
    if (rest.length === 0) break;
    parts.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  return `task_${parts.join('-')}`;
}
