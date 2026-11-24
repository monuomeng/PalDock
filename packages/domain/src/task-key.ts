/**
 * 任务 ID 的紧凑写法：去掉 `task_` 前缀和连字符、统一小写。
 * worktree 目录与分支名取前 12 位，外部渠道里的短编号（#a1b2c3）取前 6 位；按编号或分支名查任务都用它做前缀匹配。
 */
export const taskKey = (taskId: string) => taskId.replace(/^task_/, '').replaceAll('-', '').toLowerCase();
