import { z } from 'zod';

/**
 * Electron 主进程与本地服务子进程之间的控制消息（经 utilityProcess 的 parentPort 传递）。
 * 令牌只走这条通道，不写盘、不进环境变量或命令行参数。
 */
export const ParentToService = z.discriminatedUnion('type', [
  z.object({ type: z.literal('init'), dataRoot: z.string().min(1), ipcPath: z.string().min(1), token: z.string().min(32) }),
  z.object({ type: z.literal('shutdown') }),
  /** 桌面状态（powerMonitor）：只在变化时发送；审批升级据此判断用户是否在电脑前。 */
  z.object({ type: z.literal('presence'), locked: z.boolean(), idle: z.boolean() }),
]);
export type ParentToService = z.infer<typeof ParentToService>;

export const ServiceToParent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), interruptedRuns: z.number().int().nonnegative() }),
  z.object({ type: z.literal('fatal'), reason: z.enum(['locked', 'error']), message: z.string() }),
]);
export type ServiceToParent = z.infer<typeof ServiceToParent>;

/** 服务退出码：看护程序据此判断是否重启。数据根被锁时重启也没用。 */
export const ServiceExitCode = {
  ok: 0,
  error: 1,
  locked: 75,
} as const;
