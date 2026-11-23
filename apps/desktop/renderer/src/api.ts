import type {
  AttentionItem,
  CommandArgsOf,
  CommandName,
  EphemeralEvent,
  PersistentEvent,
  TaskDetail,
  TaskSummary,
} from '@paldock/contracts';

/** preload 暴露的白名单方法（见 apps/desktop/src/preload.cts）。 */
interface Bridge {
  request(name: string, args: unknown): Promise<{ ok: true; value: unknown } | { ok: false; code: string; message: string }>;
  status(): Promise<HostStatus | undefined>;
  pickProject(): Promise<string | undefined>;
  onEvent(listener: (event: PersistentEvent) => void): () => void;
  onEphemeral(listener: (event: EphemeralEvent) => void): () => void;
  onStatus(listener: (status: HostStatus) => void): () => void;
  debugCrashService(): Promise<void>;
}

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

/** 各命令的返回类型；未列出的命令返回值不使用。 */
interface Results {
  'task.create': TaskDetail;
  'task.list': TaskSummary[];
  'task.get': TaskDetail;
  'task.cancel': TaskDetail;
  'attention.list': AttentionItem[];
  'run.checkOutput': string;
  'maintenance.backup': { path: string };
}
type ResultOf<N extends CommandName> = N extends keyof Results ? Results[N] : unknown;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function call<N extends CommandName>(name: N, args: CommandArgsOf<N>): Promise<ResultOf<N>> {
  const result = await window.paldock.request(name, args);
  if (!result.ok) throw new ApiError(result.code, result.message);
  return result.value as ResultOf<N>;
}

export const bridge = (): Bridge => window.paldock;
