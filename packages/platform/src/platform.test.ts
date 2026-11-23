import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquirePidLock, createIpcPath, createToken, listenIpc, readFrames, tokensEqual, writeFrame } from './index.js';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'paldock-platform-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('PID 锁', () => {
  it('第二个持有者被拒绝，释放后可再次获取', () => {
    const first = acquirePidLock(dir);
    expect(first.acquired).toBe(true);
    expect(acquirePidLock(dir, process.pid + 1)).toEqual({ acquired: false, holderPid: process.pid });
    if (first.acquired) first.release();
    expect(acquirePidLock(dir).acquired).toBe(true);
  });

  it('持有者已退出的遗留锁被接管', () => {
    writeFileSync(join(dir, 'paldock.lock'), '999999');
    expect(acquirePidLock(dir).acquired).toBe(true);
  });
});

describe('IPC', () => {
  it('令牌比较为定长比较，长度不同直接不等', () => {
    const token = createToken();
    expect(token).toHaveLength(43);
    expect(tokensEqual(token, token)).toBe(true);
    expect(tokensEqual(token, `${token}x`)).toBe(false);
  });

  it('命名管道 / 套接字上按行收发帧，半包能正确拼接', async () => {
    const path = createIpcPath(dir);
    const received: unknown[] = [];
    const server = await listenIpc(path, (socket) => readFrames(socket, (f) => received.push(f), () => {}));
    const client = connect(path);
    await new Promise<void>((resolve) => client.once('connect', resolve));
    writeFrame(client, { kind: 'a' });
    client.write('{"kind":');
    client.write('"b"}\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual([{ kind: 'a' }, { kind: 'b' }]);
    client.write('not json\n{"kind":"c"}\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 解析失败的行被跳过，同一块里后面的帧照常处理
    expect(received).toEqual([{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }]);
    client.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
});
