import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistentEvent, RuntimeAdapter } from '@paldock/contracts';
import { IpcClient, createIpcPath, createToken, readFrames, writeFrame } from '@paldock/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataRootLockedError, LocalService } from './service.js';

let dir: string;
let repo: string;
let token: string;
let ipcPath: string;
let service: LocalService | undefined;

/** 不启动任何执行器：start 直接失败，用于只测 IPC 的场景。 */
const offlineRuntime: RuntimeAdapter = {
  name: 'offline',
  discover: async () => ({ runtime: 'offline', available: false, capabilities: {} as never }),
  start: async () => {
    throw new Error('offline');
  },
  checkTurn: async () => ({ status: 'not_found' }),
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'paldock-svc-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  token = createToken();
  ipcPath = createIpcPath(join(dir, 'data'));
  mkdirSync(join(dir, 'data'));
  service = await LocalService.start({ dataRoot: join(dir, 'data'), ipcPath, token, runtime: offlineRuntime });
});
afterEach(async () => {
  await service?.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function connectClient(events: PersistentEvent[] = []) {
  const client = new IpcClient((e) => events.push(e));
  await client.connect(ipcPath, token);
  return client;
}

const newTask = (client: IpcClient, key: string) =>
  client.request('task.create', { rootPath: repo, goal: '样例任务', idempotencyKey: key }) as Promise<{ task: { id: string } }>;

describe('本地服务 IPC', () => {
  it('错误令牌被断开，收不到 welcome', async () => {
    const socket = connect(ipcPath);
    const frames: unknown[] = [];
    readFrames(socket, (f) => frames.push(f), () => {});
    socket.once('connect', () => writeFrame(socket, { kind: 'hello', schemaVersion: 1, token: 'x'.repeat(43), client: 'evil' }));
    await new Promise((resolve) => socket.once('close', resolve));
    expect(frames).toEqual([]);
  });

  it('命令执行并广播事件；断线重连按序号补发', async () => {
    const seen: PersistentEvent[] = [];
    const a = await connectClient(seen);
    await newTask(a, 'key-aaaaaaaa');
    await a.close();
    const before = seen.length;
    // 第一次登记的项目先记一条工作区方式（默认当前工作区），然后才是建任务
    expect(seen.map((e) => e.type).slice(0, 2)).toEqual(['workspace.mode_changed', 'task.created']);

    // 离线期间由另一个客户端再建一个任务
    const b = await connectClient();
    await newTask(b, 'key-bbbbbbbb');
    await b.close();

    // 同一个客户端重连：connect 返回时已补齐断线期间的事件
    await a.connect(ipcPath, token);
    expect(seen.slice(before).map((e) => e.type)).toContain('task.created');
    await a.close();

    // 全新客户端不补发历史（连接期间后台 Run 启动失败的新事件可能到达，那不是历史）
    const fresh: PersistentEvent[] = [];
    await (await connectClient(fresh)).close();
    expect(fresh.filter((e) => e.type === 'task.created')).toEqual([]);
  });

  it('令牌错误时 connect 被拒绝而不是一直挂起', async () => {
    await expect(new IpcClient(() => {}).connect(ipcPath, createToken())).rejects.toThrow();
  });

  it('业务错误带错误码返回，参数错误为 bad_request', async () => {
    const client = await connectClient();
    await expect(client.request('task.get', { taskId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(client.request('task.create', { rootPath: '', goal: '', idempotencyKey: 'x' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(client.request('task.create', { rootPath: join(dir, 'missing'), goal: 'g', idempotencyKey: 'key-cccccccc' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    // 没有任何提交的仓库在建任务时就被拒绝，而不是等执行时创建 worktree 失败
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    execFileSync('git', ['init', '-q', empty]);
    await expect(client.request('task.create', { rootPath: empty, goal: 'g', idempotencyKey: 'key-eeeeeeee' })).rejects.toThrow(/还没有任何提交/);
    await client.close();
  });

  it('执行器启动失败时任务进入阻塞并带原因', async () => {
    const client = await connectClient();
    const { task } = await newTask(client, 'key-dddddddd');
    for (let i = 0; i < 100; i++) {
      const detail = (await client.request('task.get', { taskId: task.id })) as { subtask: { status: string; statusReason: string } };
      if (detail.subtask.status === 'blocked') {
        expect(detail.subtask.statusReason).toMatch(/启动失败/);
        return client.close();
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('任务没有进入阻塞');
  });

  it('同一数据根不能启动第二个服务', async () => {
    await expect(LocalService.start({ dataRoot: join(dir, 'data'), ipcPath: createIpcPath(dir), token })).rejects.toBeInstanceOf(
      DataRootLockedError,
    );
  });
});
