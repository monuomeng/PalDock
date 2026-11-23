import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { killProcessTree } from '@paldock/platform';

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RpcHandlers {
  /** 服务端通知（无 id），例如 turn/started、item/agentMessage/delta。 */
  onNotification?: (method: string, params: unknown) => void;
  /** 服务端请求（有 id），例如审批；返回值作为 result 回复。 */
  onServerRequest?: (method: string, params: unknown, id: number | string) => Promise<unknown>;
  onExit?: (code: number | null) => void;
}

/**
 * 按行分隔的 JSON-RPC over stdio。Codex app-server 的消息不一定带 `jsonrpc: "2.0"`，
 * 这里收发两种都接受；参数以数组传给 spawn，不经过 shell。
 */
export class JsonRpcStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 0;

  constructor(command: string, args: readonly string[], private readonly handlers: RpcHandlers = {}, env?: NodeJS.ProcessEnv) {
    // posix 下 detached 让子进程成为进程组组长，便于整树结束
    this.child = spawn(command, args, { stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32', env: env ?? process.env });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
    this.child.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`进程已退出（${code}）`));
      this.pending.clear();
      handlers.onExit?.(code);
    });
  }

  get stderr(): NodeJS.ReadableStream {
    return this.child.stderr;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  /** 结束整个进程树并等待退出；之后才能安全删除它的工作目录。 */
  dispose(): Promise<void> {
    this.child.stdin.end();
    return killProcessTree(this.child);
  }

  private write(message: RpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return; // 非 JSON 行（例如调试输出）忽略
    }
    if (message.method && message.id !== undefined) return void this.answer(message.id, message.method, message.params);
    if (message.method) return this.handlers.onNotification?.(message.method, message.params);
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) pending?.reject(new RpcError(message.error.code, message.error.message));
    else pending?.resolve(message.result);
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    if (!this.handlers.onServerRequest) {
      return this.write({ id, error: { code: -32601, message: `未处理的请求：${method}` } });
    }
    try {
      this.write({ id, result: await this.handlers.onServerRequest(method, params, id) });
    } catch (error) {
      this.write({ id, error: { code: -32000, message: (error as Error).message } });
    }
  }
}
