import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PendingRequests, killProcessTree, readFrames, writeFrame } from '@paldock/platform';

type RequestId = number | string;

export interface RpcMessage {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 错误码是数字，与 PalDock 的 ErrorCode 不是一套，单独保留。 */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface RpcHandlers {
  /** 服务端通知（无 id），例如 turn/started、item/agentMessage/delta。 */
  onNotification?: (method: string, params: unknown) => void;
  /** 服务端请求（有 id），例如审批；返回值作为 result 回复。 */
  onServerRequest?: (method: string, params: unknown, id: RequestId) => Promise<unknown>;
  onExit?: (code: number | null) => void;
}

/**
 * 按行分隔的 JSON-RPC over stdio，与本机 IPC 共用帧读写（含单帧上限）。
 * Codex app-server 的消息不一定带 `jsonrpc: "2.0"`，这里收发两种都接受；参数以数组传给 spawn，不经过 shell。
 */
export class JsonRpcStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new PendingRequests();

  constructor(command: string, args: readonly string[], private readonly handlers: RpcHandlers = {}, env?: NodeJS.ProcessEnv) {
    // posix 下 detached 让子进程成为进程组组长，便于整树结束
    this.child = spawn(command, args, {
      stdio: 'pipe',
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: env ?? process.env,
    });
    // 非 JSON 行（例如调试输出）跳过；单行超限说明输出失控，结束进程
    readFrames(this.child.stdout, (frame) => this.onMessage(frame), (error) => {
      if (error.kind === 'too_large') void this.dispose();
    });
    // 启动失败（EACCES 等）可能只有 error 没有 exit；进程退出后写 stdin 会得到 EPIPE
    this.child.on('error', (error) => this.pending.rejectAll(error));
    this.child.stdin.on('error', () => {});
    this.child.on('exit', (code) => {
      this.pending.rejectAll(new Error(`进程已退出（${code}）`));
      handlers.onExit?.(code);
    });
  }

  get stderr(): NodeJS.ReadableStream {
    return this.child.stderr;
  }

  /** timeoutMs 到期仍无响应时拒绝（进程可能已卡死）；缺省不限时，适用于 turn 这类长请求。 */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const response = this.pending.add((id) => writeFrame(this.child.stdin, { id, method, params })) as Promise<T>;
    if (timeoutMs === undefined) return response;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${method} 超时（${timeoutMs} ms）`)), timeoutMs);
    });
    return Promise.race([response, timeout]).finally(() => clearTimeout(timer));
  }

  notify(method: string, params?: unknown): void {
    writeFrame(this.child.stdin, params === undefined ? { method } : { method, params });
  }

  /** 结束整个进程树并等待退出；之后才能安全删除它的工作目录。 */
  dispose(): Promise<void> {
    this.child.stdin.end();
    return killProcessTree(this.child);
  }

  private onMessage(frame: unknown): void {
    if (typeof frame !== 'object' || frame === null) return;
    const message = frame as RpcMessage;
    if (message.method && message.id !== undefined) return void this.answer(message.id, message.method, message.params);
    if (message.method) return this.handlers.onNotification?.(message.method, message.params);
    if (message.id === undefined) return;
    const id = String(message.id);
    if (message.error) this.pending.reject(id, new RpcError(message.error.code, message.error.message));
    else this.pending.resolve(id, message.result);
  }

  private async answer(id: RequestId, method: string, params: unknown): Promise<void> {
    const reply = (body: Omit<RpcMessage, 'id'>) => writeFrame(this.child.stdin, { id, ...body });
    if (!this.handlers.onServerRequest) return reply({ error: { code: -32601, message: `未处理的请求：${method}` } });
    try {
      reply({ result: await this.handlers.onServerRequest(method, params, id) });
    } catch (error) {
      reply({ error: { code: -32000, message: (error as Error).message } });
    }
  }
}
