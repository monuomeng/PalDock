import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquirePidLock,
  createIpcPath,
  createToken,
  isInside,
  isInsideReal,
  isSystemDirectory,
  keychainSecret,
  listenIpc,
  readFrames,
  relativeReal,
  tokensEqual,
  writeFrame,
} from './index.js';

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
  it('posix 套接字路径超过 sun_path 上限时退到 /tmp 短路径', () => {
    const root = '/Users/a/Library/Application Support/PalDock';
    expect(createIpcPath(root, 'darwin')).toBe(join(root, 'paldock.sock'));
    expect(createIpcPath(`/Users/a/${'x'.repeat(120)}`, 'darwin')).toMatch(/^\/tmp\/paldock-[0-9a-f]{12}\.sock$/);
    expect(createIpcPath('D:/data', 'win32')).toMatch(/^\\\\\.\\pipe\\paldock-[0-9a-f]{16}$/);
  });

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

describe('系统目录判断', () => {
  it('用户临时目录（真实路径，macOS 上在 /private/var/folders 下）不算系统目录（CI 实测）', () => {
    expect(isSystemDirectory(realpathSync.native(dir))).toBe(false);
    expect(isSystemDirectory(realpathSync.native(tmpdir()))).toBe(false);
  });

  it('系统目录本身被拦住', () => {
    const system = process.platform === 'win32' ? (process.env.SystemRoot ?? 'C:\Windows') : '/usr';
    expect(isSystemDirectory(join(system, 'x'))).toBe(true);
  });
});

describe('钥匙串读出的秘密', () => {
  it('ASCII 原样返回，非 ASCII 从十六进制解码', () => {
    expect(keychainSecret('a"b\\c d\n', 'password: "a\\"b"')).toBe('a"b\\c d');
    const hex = Buffer.from('第二个 x:y', 'utf8').toString('hex').toUpperCase();
    expect(keychainSecret(`${hex}\n`, `password: 0x${hex}  "\\347..."`)).toBe('第二个 x:y');
    // 十六进制样子的 ASCII 秘密不能被误解码
    expect(keychainSecret('deadbeef\n', 'password: "deadbeef"')).toBe('deadbeef');
  });
});

describe('按真实路径判断在不在目录里（0.3.9）', () => {
  it('经过软链（Windows 上是目录联接）的路径、还不存在的文件、盘符大小写不同，都按真实路径判断', () => {
    const root = mkdtempSync(join(tmpdir(), 'paldock-real-'));
    try {
      const project = join(root, 'project');
      mkdirSync(join(project, 'src'), { recursive: true });
      const link = join(root, 'link');
      symlinkSync(project, link, 'junction');
      // 经过链接写进项目里的文件（还不存在）：在项目里
      expect(isInsideReal(project, join(link, 'src', 'new.ts'))).toBe(true);
      expect(isInsideReal(link, join(project, 'src', 'a.ts'))).toBe(true);
      expect(relativeReal(project, join(link, 'src', 'new.ts'))?.split(sep).join('/')).toBe('src/new.ts');
      // 普通字符串比较判断不出来
      expect(isInside(project, join(link, 'src', 'new.ts'))).toBe(false);
      // 兄弟目录、项目外
      expect(isInsideReal(project, join(root, 'project-other', 'a.ts'))).toBe(false);
      expect(relativeReal(project, join(root, 'x.ts'))).toBeUndefined();
      if (process.platform === 'win32') expect(isInsideReal(project.toUpperCase(), join(project, 'a.ts'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
