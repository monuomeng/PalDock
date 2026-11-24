import { ParentToService, ServiceExitCode, type ServiceToParent } from '@paldock/contracts';
import { DataRootLockedError, LocalService } from './service.js';

/**
 * 子进程入口。优先用 Electron utilityProcess 的 parentPort，
 * 退化到 child_process.fork（ELECTRON_RUN_AS_NODE）时用 process.send。
 */
interface ParentPort {
  on(event: 'message', listener: (message: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

function post(message: ServiceToParent): void {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
}

function onParentMessage(listener: (message: unknown) => void): void {
  if (parentPort) parentPort.on('message', (event) => listener(event.data));
  else process.on('message', listener);
}

// 日志只写事件类型与结果，不含令牌、路径以外的用户数据
const log = (message: string) => console.log(`[local-service] ${message}`);

let service: LocalService | undefined;

onParentMessage(async (raw) => {
  const parsed = ParentToService.safeParse(raw);
  if (!parsed.success) return log('ignored invalid parent message');
  const message = parsed.data;

  if (message.type === 'presence') return service?.setPresence(message);
  if (message.type === 'shutdown') {
    await service?.stop();
    process.exit(ServiceExitCode.ok);
  }
  if (message.type === 'init' && !service) {
    try {
      service = await LocalService.start({ ...message, log });
      post({ type: 'ready', interruptedRuns: service.interruptedRuns });
    } catch (error) {
      const locked = error instanceof DataRootLockedError;
      post({ type: 'fatal', reason: locked ? 'locked' : 'error', message: (error as Error).message });
      process.exit(locked ? ServiceExitCode.locked : ServiceExitCode.error);
    }
  }
});
