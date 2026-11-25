import { AGENT_ROLES } from '@paldock/contracts';
import { FACTORY_PROFILES } from '@paldock/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './index.js';

const now = () => new Date('2026-11-25T08:00:00.000Z');
let store: Store;
beforeEach(async () => {
  store = await openStore(':memory:', now);
});
afterEach(() => store.close());

const plan = (sql: string, ...params: string[]) =>
  store.db.raw
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((r) => String(r.detail))
    .join(' | ');

describe('助手角色设置', () => {
  it('迁移写入的出厂角色与 FACTORY_PROFILES 一致', () => {
    const profiles = store.agents.listProfiles();
    expect(profiles.map((p) => p.role)).toEqual([...AGENT_ROLES]);
    for (const p of profiles) {
      const factory = FACTORY_PROFILES[p.role];
      expect({ ...p, deliveryScope: [...p.deliveryScope] }).toMatchObject({
        displayName: factory.displayName,
        description: factory.description,
        executor: factory.executor,
        workspaceAccess: factory.workspaceAccess,
        deliveryScope: [...factory.deliveryScope],
        maxRunMinutes: factory.maxRunMinutes,
        maxConcurrency: factory.maxConcurrency,
        fallbackExecutor: null,
        version: 0,
      });
    }
  });

  it('改默认执行器按版本先到者为准，并记事件', () => {
    const dev = store.agents.getProfile('developer')!;
    const { record, events } = store.agents.setExecutor('developer', dev.version, 'codex');
    expect(record).toMatchObject({ executor: 'codex', version: dev.version + 1 });
    expect(events[0]).toMatchObject({ aggregateId: 'developer', type: 'agent.profile_changed', payload: { executor: 'codex' } });
    expect(() => store.agents.setExecutor('developer', dev.version, 'claude')).toThrow(/已被修改/);
  });

  it('项目覆盖优先于角色默认；取消覆盖后回到默认；查询走主键', () => {
    const ws = store.tasks.ensureWorkspace('demo', 'D:/demo');
    expect(store.agents.resolveExecutor(ws.id, 'developer')).toBe('claude');
    expect(store.agents.setOverride(ws.id, 'developer', 'codex').record).toEqual({ workspaceId: ws.id, role: 'developer', executor: 'codex' });
    expect(store.agents.resolveExecutor(ws.id, 'developer')).toBe('codex');
    expect(store.agents.resolveExecutor(ws.id, 'tester')).toBe('codex');
    expect(store.agents.listOverrides(ws.id)).toHaveLength(1);
    store.agents.setOverride(ws.id, 'developer', null);
    expect(store.agents.resolveExecutor(ws.id, 'developer')).toBe('claude');
    expect(store.agents.listOverrides(ws.id)).toEqual([]);
    expect(() => store.agents.setOverride('ws_missing', 'developer', 'codex')).toThrow(/项目不存在/);
    expect(plan('SELECT executor FROM agent_overrides WHERE workspace_id = ? AND role = ?', ws.id, 'developer')).toMatch(/PRIMARY KEY|sqlite_autoindex/);
  });
});

describe('Run 用量', () => {
  it('只写一次；没有记录时为 undefined', () => {
    const ws = store.tasks.ensureWorkspace('demo', 'D:/demo');
    const { subtask, session } = store.tasks.createTask({
      workspaceId: ws.id,
      title: 't',
      goal: 'g',
      role: 'developer',
      checkCommand: null,
      checkConfirmed: false,
      idempotencyKey: 'k',
    }).record;
    const run = store.runs.createRun({ subtaskId: subtask.id, sessionId: session.id, runtime: 'claude' }).record;
    expect(store.runs.getUsage(run.id)).toBeUndefined();
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5 };
    store.runs.recordUsage(run.id, usage);
    store.runs.recordUsage(run.id, { ...usage, inputTokens: 99 });
    expect(store.runs.getUsage(run.id)).toEqual(usage);
  });
});
