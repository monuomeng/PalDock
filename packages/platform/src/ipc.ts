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
 * 按行分隔的 JSON 帧。超过上限的帧直接报错，由调用方断开连接；
 * 这里只负责切分和 JSON 解析，帧结构由 contracts 中的 schema 校验。
 */
export function readFrames(socket: Socket, onFrame: (frame: unknown) => void, onError: (error: Error) => void): void {
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        onFrame(JSON.parse(line));
      } catch {
        return onError(new Error('无法解析的 IPC 帧'));
      }
    }
    if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES) onError(new Error('IPC 帧超过上限'));
  });
}

export function writeFrame(socket: Socket, frame: unknown): void {
  socket.write(`${JSON.stringify(frame)}\n`);
}
