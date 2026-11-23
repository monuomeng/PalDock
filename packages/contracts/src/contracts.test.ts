import { describe, expect, it } from 'vitest';
import { ClientFrame, PersistentEvent, SCHEMA_VERSION, ServerFrame } from './index.js';

const base = { schemaVersion: SCHEMA_VERSION, seq: 1, aggregateId: 'task_1', occurredAt: '2026-11-22T10:00:00.000Z' };

describe('persistent event contract', () => {
  it('接受合法事件并保留全部字段（往返不丢数据）', () => {
    const event = { ...base, type: 'task.status_changed', payload: { from: 'queued', to: 'running' } };
    expect(PersistentEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it('拒绝未知类型、错误版本和非法状态', () => {
    expect(PersistentEvent.safeParse({ ...base, type: 'task.exploded', payload: {} }).success).toBe(false);
    expect(
      PersistentEvent.safeParse({ ...base, schemaVersion: 99, type: 'task.created', payload: { workspaceId: 'w', title: 't' } })
        .success,
    ).toBe(false);
    expect(
      PersistentEvent.safeParse({ ...base, type: 'task.status_changed', payload: { from: 'queued', to: 'review' } }).success,
    ).toBe(false);
  });

  it('审批决定不能是 pending', () => {
    const decided = { ...base, type: 'approval.decided', payload: { status: 'pending', via: 'desktop' } };
    expect(PersistentEvent.safeParse(decided).success).toBe(false);
  });
});

describe('ipc frames', () => {
  it('hello 要求足够长的令牌', () => {
    expect(ClientFrame.safeParse({ kind: 'hello', schemaVersion: 1, token: 'short', client: 'x' }).success).toBe(false);
    expect(ClientFrame.safeParse({ kind: 'hello', schemaVersion: 1, token: 'a'.repeat(43), client: 'x' }).success).toBe(true);
  });

  it('未登记的命令被拒绝', () => {
    expect(ClientFrame.safeParse({ kind: 'command', id: '1', name: 'fs.deleteAll', args: {} }).success).toBe(false);
  });

  it('结果帧按 ok 区分成功与错误', () => {
    expect(ServerFrame.parse({ kind: 'result', id: '1', ok: true, value: 3 })).toMatchObject({ ok: true });
    expect(ServerFrame.safeParse({ kind: 'result', id: '1', ok: false, value: 3 }).success).toBe(false);
  });
});
