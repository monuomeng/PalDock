import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistentEvent } from '@paldock/contracts';
import { IpcClient, createIpcPath, createToken, readFrames, writeFrame } from '@paldock/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataRootLockedError, LocalService } from './service.js';

let dir: string;
let token: string;
let ipcPath: string;
let service: LocalService | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'paldock-svc-'));
  token = createToken();
  ipcPath = createIpcPath(dir);
  service = await LocalService.start({ dataRoot: dir, ipcPath, token });
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
    const ws = (await a.request('workspace.create', { name: 'demo', rootPath: join(dir, 'proj') })) as { id: string };
    const task = (await a.request('task.create', { workspaceId: ws.id, title: '样例任务' })) as { id: string };
    await a.close();

    // 离线期间由另一个客户端推进状态
    const b = await connectClient();
    await b.request('task.transition', { taskId: task.id, expectedVersion: 0, to: 'queued' });
    await b.close();

    // 同一个客户端重连：connect 返回时已补齐断线期间的事件
    await a.connect(ipcPath, token);
    expect(seen.map((e) => e.type)).toEqual(['task.created', 'task.status_changed']);
    await a.close();

    // 全新客户端不补发历史
    const fresh: PersistentEvent[] = [];
    await (await connectClient(fresh)).close();
    expect(fresh).toEqual([]);
  });

  it('业务错误带错误码返回，参数错误为 bad_request', async () => {
    const client = await connectClient();
    await expect(client.request('task.transition', { taskId: 'nope', expectedVersion: 0, to: 'queued' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(client.request('task.create', { workspaceId: '', title: '' })).rejects.toMatchObject({ code: 'bad_request' });
    await client.close();
  });

  it('同一数据根不能启动第二个服务', async () => {
    await expect(LocalService.start({ dataRoot: dir, ipcPath: createIpcPath(dir), token })).rejects.toBeInstanceOf(
      DataRootLockedError,
    );
  });
});
