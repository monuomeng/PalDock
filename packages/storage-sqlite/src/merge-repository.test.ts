import { MERGE_PHASES } from '@paldock/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './index.js';

let clock = Date.parse('2026-11-25T08:00:00.000Z');
let store: Store;
beforeEach(async () => {
  store = await openStore(':memory:', () => new Date((clock += 1000)));
});
afterEach(() => store.close());

const queryPlan = (sql: string, ...params: string[]) =>
  store.db.raw
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((r) => String(r.detail))
    .join(' | ');

function seed() {
  const ws = store.tasks.ensureWorkspace('demo', 'D:/demo');
  const { task, subtask } = store.tasks.createTask({ workspaceId: ws.id, title: 't', goal: 'g', role: 'developer', checkCommand: null, checkConfirmed: false, idempotencyKey: 'k' }).record;
  return { task, subtask };
}

describe('任务集成分支与合并记录', () => {
  it('集成分支只记一次', () => {
    const { task } = seed();
    expect(task).toMatchObject({ integrationBranch: null, integrationWorktree: null, integrationBase: null });
    const set = store.tasks.setIntegration(task.id, 'paldock/abc', 'D:/data/worktrees/abc-integration', 'sha0')!;
    expect(set).toMatchObject({ integrationBranch: 'paldock/abc', integrationWorktree: 'D:/data/worktrees/abc-integration', integrationBase: 'sha0', version: task.version + 1 });
    expect(store.tasks.setIntegration(task.id, 'paldock/other', 'x', 'y')).toBeUndefined();
    expect(store.tasks.getTask(task.id)?.integrationBranch).toBe('paldock/abc');
  });

  it('节点换基线带版本', () => {
    const { subtask } = seed();
    const rebased = store.tasks.rebaseSubtask(subtask.id, subtask.version, 'sha9');
    expect(rebased).toMatchObject({ baseCommit: 'sha9', version: subtask.version + 1 });
    expect(() => store.tasks.rebaseSubtask(subtask.id, subtask.version, 'sha8')).toThrow(/已被修改/);
  });

  it('合并操作只能往后走；最近一次按子任务取', () => {
    const { task, subtask } = seed();
    const op = store.merges.start({ taskId: task.id, subtaskId: subtask.id, sourceSha: 'src1', targetOld: 'old1' });
    expect(op).toMatchObject({ phase: 'started', candidateSha: null, conflictFiles: null });
    expect(store.merges.advance(op.id, 'candidate', { candidateSha: 'cand1' })).toMatchObject({ phase: 'candidate', candidateSha: 'cand1' });
    expect(store.merges.advance(op.id, 'done')).toMatchObject({ phase: 'done', candidateSha: 'cand1' });
    expect(() => store.merges.advance(op.id, 'conflict')).toThrow(/已结束/);

    const again = store.merges.start({ taskId: task.id, subtaskId: subtask.id, sourceSha: 'src2', targetOld: 'cand1' });
    store.merges.advance(again.id, 'conflict', { conflictFiles: ['src/a.ts'], detail: '冲突' });
    expect(store.merges.latestOf(subtask.id)).toMatchObject({ id: again.id, phase: 'conflict', conflictFiles: ['src/a.ts'], detail: '冲突' });
    expect(store.merges.latestOf('sub_none')).toBeUndefined();
  });

  it('phase 的 CHECK 列表与契约一致；查询走索引', () => {
    const sql = store.db.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name = 'merge_ops'`)!.sql;
    const list = /phase\s+TEXT NOT NULL CHECK \(phase IN \(([^)]*)\)\)/.exec(sql)![1]!;
    expect(list.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...MERGE_PHASES]);
    const latest = queryPlan(`SELECT id FROM merge_ops WHERE subtask_id = ? ORDER BY created_at DESC LIMIT 1`, 's');
    expect(latest).toContain('merge_ops_by_subtask');
    expect(latest).not.toContain('TEMP B-TREE');
    expect(queryPlan(`SELECT id FROM merge_ops WHERE phase IN ('started', 'candidate') ORDER BY created_at`)).toContain('merge_ops_open');
  });
});
