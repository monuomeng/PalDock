import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { MAX_FRAME_BYTES } from '@paldock/contracts';

/**
 * 本机 IPC 端点：Windows 用带随机后缀的命名管道（不落盘），
 * macOS / Linux 用数据根下的 Unix 域套接字（权限 0600）。不开 TCP 端口。
 */
export function createIpcPath(dataRoot: string, platform = process.platform): string {
  return platform === 'win32'
    ? `\\\\.\\pipe\\paldock-${randomBytes(8).toString('hex')}`
    : join(dataRoot, 'paldock.sock');
}

export function listenIpc(path: string, onConnection: (socket: Socket) => void): Promise<Server> {
  const isSocketFile = !path.startsWith('\\\\.\\pipe\\');
  // 上次异常退出可能遗留套接字文件；PID 锁已保证此时没有别的服务在用
  if (isSocketFile) rmSync(path, { force: true });
  const server = createServer(onConnection);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      if (isSocketFile) chmodSync(path, 0o600);
      resolve(server);
    });
  });
}

/** 32 字节随机令牌，base64url 编码后 43 个字符。只经父子进程消息传递，不写盘、不进环境变量。 */
export function createToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokensEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 按行分隔的 JSON 帧，用于本机 IPC 和执行器的 stdio JSON-RPC。超过上限的帧报错，由调用方断开；
 * 这里只负责切分和 JSON 解析，帧结构由 contracts 中的 schema 校验。
 */
export function readFrames(
  input: NodeJS.ReadableStream,
  onFrame: (frame: unknown) => void,
  onError: (error: Error) => void,
  maxBytes = MAX_FRAME_BYTES,
): void {
  let pending = '';
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    const text = pending + chunk;
    let start = 0;
    for (let newline = text.indexOf('\n'); newline >= 0; newline = text.indexOf('\n', start)) {
      const line = text.slice(start, newline);
      start = newline + 1;
      if (line.length === 0) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return onError(new Error('无法解析的帧'));
      }
      onFrame(frame);
    }
    pending = text.slice(start);
    // UTF-8 每个 UTF-16 码元最多 3 字节，按字符数估算上限即可，不必逐次重新编码
    if (pending.length * 3 > maxBytes && Buffer.byteLength(pending) > maxBytes) onError(new Error('帧超过上限'));
  });
}

export function serializeFrame(frame: unknown): string {
  return `${JSON.stringify(frame)}\n`;
}

export function writeFrame(output: NodeJS.WritableStream, frame: unknown): void {
  output.write(serializeFrame(frame));
}
