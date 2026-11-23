import { fileURLToPath } from 'node:url';
import { utilityProcess, type UtilityProcess } from 'electron';
import { ServiceToParent, type ParentToService } from '@paldock/contracts';
import { createIpcPath, createToken } from '@paldock/platform';
import { RestartPolicy, SHUTDOWN_GRACE_MS, type RestartDecision } from './restart-policy.js';

export type HostStatus =
  | { state: 'starting' }
  | { state: 'ready'; ipcPath: string; token: string; interruptedRuns: number }
  | { state: 'restarting'; inMs: number }
  | { state: 'stopped'; reason: Extract<RestartDecision, { action: 'stop' }>['reason'] | 'fatal'; message?: string };

const SERVICE_ENTRY = fileURLToPath(import.meta.resolve('@paldock/local-service'));

/**
 * 在 utilityProcess 中启动并看护本地服务。每次启动生成新的管道名和令牌，
 * 令牌只经 postMessage 下发；服务崩溃后按 RestartPolicy 重启。
 */
export class ServiceHost {
  private child: UtilityProcess | undefined;
  private readonly policy = new RestartPolicy();
  private stopping = false;
  private restartTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly dataRoot: string,
    private readonly onStatus: (status: HostStatus) => void,
  ) {}

  start(): void {
    if (this.stopping) return;
    const ipcPath = createIpcPath(this.dataRoot);
    const token = createToken();
    this.onStatus({ state: 'starting' });

    const child = utilityProcess.fork(SERVICE_ENTRY, [], { serviceName: 'PalDock Local Service', stdio: 'inherit' });
    this.child = child;
    child.on('spawn', () => this.post({ type: 'init', dataRoot: this.dataRoot, ipcPath, token }));
    child.on('message', (raw: unknown) => {
      const message = ServiceToParent.safeParse(raw);
      if (!message.success) return;
      if (message.data.type === 'ready') {
        this.onStatus({ state: 'ready', ipcPath, token, interruptedRuns: message.data.interruptedRuns });
      } else {
        this.onStatus({ state: 'stopped', reason: 'fatal', message: message.data.message });
      }
    });
    child.on('exit', (code) => this.onExit(code));
  }

  private onExit(code: number): void {
    this.child = undefined;
    const decision = this.policy.onExit(code, Date.now(), this.stopping);
    if (this.stopping) return;
    if (decision.action === 'stop') return this.onStatus({ state: 'stopped', reason: decision.reason });
    this.onStatus({ state: 'restarting', inMs: decision.delayMs });
    this.restartTimer = setTimeout(() => this.start(), decision.delayMs);
  }

  private post(message: ParentToService): void {
    this.child?.postMessage(message);
  }

  /** 正常退出：通知服务收尾（Run 置为 interrupted 并落库），最多等 35 秒后强制结束。 */
  stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => child.kill(), SHUTDOWN_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.post({ type: 'shutdown' });
    });
  }

  /** 仅供手动验证崩溃恢复：模拟服务崩溃。 */
  crashForTesting(): void {
    this.child?.kill();
  }
}
