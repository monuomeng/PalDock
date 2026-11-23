import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { MAX_FRAME_BYTES } from '@paldock/contracts';

/**
 * 本机 IPC 端点：Windows 用带随机后缀的命名管道（不落盘），
 * macOS / Linux 用数据根下的 Unix 域套接字（权限 0600）。不开 TCP 端口。
 */
/** macOS 的 sockaddr_un.sun_path 只有 104 字节（Linux 108），含结尾的 \0。 */
const MAX_SOCKET_PATH_BYTES = 103;

export function createIpcPath(dataRoot: string, platform = process.platform): string {
  if (platform === 'win32') return `\\\\.\\pipe\\paldock-${randomBytes(8).toString('hex')}`;
  const preferred = join(dataRoot, 'paldock.sock');
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred;
  // 数据根路径太长时退到 /tmp 下的短名字；文件权限仍是 0600，且连接要校验令牌
  const digest = createHash('sha256').update(dataRoot).digest('hex').slice(0, 12);
  return `/tmp/paldock-${digest}.sock`;
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

export class FrameError extends Error {
  constructor(readonly kind: 'parse' | 'too_large') {
    super(kind === 'parse' ? '无法解析的帧' : '帧超过上限');
  }
}

/**
 * 按行分隔的 JSON 帧，用于本机 IPC 和执行器的 stdio JSON-RPC；帧结构由 contracts 中的 schema 校验。
 * 无法解析的行报 `parse` 后跳过、继续处理后续行；缓冲超过上限报 `too_large` 并丢弃缓冲。
 * 是否断开由调用方决定：本机 IPC 两种都断开，执行器 stdout 只在超限时结束进程。
 */
export function readFrames(
  input: NodeJS.ReadableStream,
  onFrame: (frame: unknown) => void,
  onError: (error: FrameError) => void,
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
        onError(new FrameError('parse'));
        continue;
      }
      onFrame(frame);
    }
    pending = text.slice(start);
    // UTF-8 每个 UTF-16 码元最多 3 字节：先用字符数粗判，超过才精确计算
    if (pending.length * 3 > maxBytes && Buffer.byteLength(pending) > maxBytes) {
      pending = '';
      onError(new FrameError('too_large'));
    }
  });
}

export function serializeFrame(frame: unknown): string {
  return `${JSON.stringify(frame)}\n`;
}

export function writeFrame(output: NodeJS.WritableStream, frame: unknown): void {
  output.write(serializeFrame(frame));
}
