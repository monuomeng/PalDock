import type {
  CommandArgsOf,
  CommandName,
  CommandResultOf,
  EphemeralEvent,
  PersistentEvent,
  RendererResult,
} from '@paldock/contracts';

/** preload 暴露的白名单方法（见 apps/desktop/src/preload.cts）。 */
interface Bridge {
  request(name: string, args: unknown): Promise<RendererResult>;
  status(): Promise<HostStatus | undefined>;
  pickProject(): Promise<string | undefined>;
  onEvent(listener: (event: PersistentEvent) => void): () => void;
  onEphemeral(listener: (event: EphemeralEvent) => void): () => void;
  onStatus(listener: (status: HostStatus) => void): () => void;
  debugCrashService(): Promise<void>;
}

/** 主进程推送的连接状态（apps/desktop/src/main.ts 的 publishStatus）。 */
export type HostStatus =
  | { state: 'starting' | 'ready' }
  | { state: 'connected'; interruptedRuns: number; dataRoot?: string }
  | { state: 'restarting'; inMs: number }
  | { state: 'stopped'; reason: string; message?: string };

declare global {
  interface Window {
    paldock: Bridge;
  }
}

/** 调用本地服务命令；失败时抛出带 code 的错误（code 取自 contracts 的 ErrorCode）。 */
export async function call<N extends CommandName>(name: N, args: CommandArgsOf<N>): Promise<CommandResultOf<N>> {
  const result = await window.paldock.request(name, args);
  if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
  return result.value as CommandResultOf<N>;
}

export const bridge = (): Bridge => window.paldock;
