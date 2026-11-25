import { SUBTASK_STATUSES, TASK_STATUSES, type GraphNode, type PlanNodeInput, type SubtaskStatus } from '@paldock/contracts';
import { describe, expect, it } from 'vitest';
import { subtaskMachine, taskMachine } from './state-machine.js';
import { graphStep, pathProblem, taskPath, taskStatusOf, upstreamBlockReason, validatePlan } from './task-graph.js';

const ROLES = new Set(['developer', 'tester', 'docs']);
const node = (key: string, dependsOn: string[] = [], extra: Partial<PlanNodeInput> = {}): PlanNodeInput => ({
  key,
  role: 'developer',
  title: key,
  goal: `做 ${key}`,
  paths: [],
  dependsOn,
  ...extra,
});

describe('validatePlan', () => {
  it('菱形图通过', () => {
    expect(() => validatePlan([node('a'), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c'])], ROLES)).not.toThrow();
  });

  it('拒绝空计划、超过 8 个节点、重复或不合法的节点键', () => {
    expect(() => validatePlan([], ROLES)).toThrow(/至少要有一个/);
    expect(() => validatePlan(Array.from({ length: 9 }, (_, i) => node(`n${i}`)), ROLES)).toThrow(/最多 8 个/);
    expect(() => validatePlan([node('a'), node('a')], ROLES)).toThrow(/节点键重复：a/);
    expect(() => validatePlan([node('Bad')], ROLES)).toThrow(/节点键不合法/);
  });

  it('角色必须存在（不含协调助手）', () => {
    expect(() => validatePlan([node('a', [], { role: 'coordinator' })], ROLES)).toThrow(/没有角色 coordinator/);
    expect(() => validatePlan([node('a', [], { role: 'magician' })], ROLES)).toThrow(/没有角色 magician/);
  });

  it('依赖只能引用本计划内的其他节点，且不能有环', () => {
    expect(() => validatePlan([node('a', ['zzz'])], ROLES)).toThrow(/依赖的节点 zzz 不在计划里/);
    expect(() => validatePlan([node('a', ['a'])], ROLES)).toThrow(/不能依赖自己/);
    expect(() => validatePlan([node('a', ['c']), node('b', ['a']), node('c', ['b']), node('d')], ROLES)).toThrow(/依赖有环：a、b、c/);
  });

  it('路径必须在项目目录内', () => {
    for (const bad of ['/etc/passwd', '\\\\server\\share', 'C:\\Windows', 'c:foo', '~/x', '../up', 'src/../../up', 'a\\..\\b']) {
      expect(pathProblem(bad), bad).toBeDefined();
    }
    for (const ok of ['src/index.ts', 'docs/**', '**/*.test.ts', '.github/workflows', 'a..b/c']) expect(pathProblem(ok), ok).toBeUndefined();
    expect(() => validatePlan([node('a', [], { paths: ['src', '../secret'] })], ROLES)).toThrow(/a：不能用 \.\. 跳出项目目录/);
  });

  it('一次列出全部问题', () => {
    expect(() => validatePlan([node('a', ['x'], { role: 'nobody', paths: ['/abs'] })], ROLES)).toThrow(/没有角色 nobody；a：不能用绝对路径.*；a：依赖的节点 x/);
  });
});

const g = (id: string, status: SubtaskStatus, dependsOn: string[] = [], statusReason: string | null = null): GraphNode => ({
  id,
  title: id.toUpperCase(),
  status,
  statusReason,
  version: 0,
  dependsOn,
});
const diamond = (a: SubtaskStatus, b: SubtaskStatus = 'waiting_dependency', c: SubtaskStatus = 'waiting_dependency', d: SubtaskStatus = 'waiting_dependency') => [
  g('d', d, ['b', 'c']),
  g('b', b, ['a']),
  g('c', c, ['a']),
  g('a', a),
];

describe('graphStep', () => {
  it('上游没完成时什么都不做', () => {
    expect(graphStep(diamond('running'))).toEqual([]);
    expect(graphStep(diamond('review'))).toEqual([]);
  });

  it('上游成功后放行下游；全部依赖成功才放行汇合点', () => {
    expect(graphStep(diamond('succeeded'))).toEqual([
      { id: 'b', from: 'waiting_dependency', to: 'queued' },
      { id: 'c', from: 'waiting_dependency', to: 'queued' },
    ]);
    expect(graphStep(diamond('succeeded', 'succeeded', 'running'))).toEqual([]);
    expect(graphStep(diamond('succeeded', 'succeeded', 'succeeded'))).toEqual([{ id: 'd', from: 'waiting_dependency', to: 'queued' }]);
  });

  it('上游失败或阻塞时下游链式阻塞并写明原因', () => {
    expect(graphStep(diamond('blocked'))).toEqual([
      { id: 'b', from: 'waiting_dependency', to: 'blocked', reason: '上游「A」阻塞' },
      { id: 'c', from: 'waiting_dependency', to: 'blocked', reason: '上游「A」阻塞' },
      { id: 'd', from: 'waiting_dependency', to: 'blocked', reason: '上游「B」阻塞' },
    ]);
    expect(graphStep(diamond('succeeded', 'failed', 'running'))).toEqual([{ id: 'd', from: 'waiting_dependency', to: 'blocked', reason: '上游「B」失败' }]);
  });

  it('上游恢复后解除因它而起的阻塞；自身失败的阻塞不动', () => {
    const byA = upstreamBlockReason('A', 'blocked');
    const byB = upstreamBlockReason('B', 'blocked');
    expect(graphStep(diamond('queued', 'blocked', 'blocked', 'blocked').map((n) => ({ ...n, statusReason: n.id === 'd' ? byB : n.id === 'a' ? null : byA })))).toEqual([
      { id: 'b', from: 'blocked', to: 'waiting_dependency' },
      { id: 'c', from: 'blocked', to: 'waiting_dependency' },
      { id: 'd', from: 'blocked', to: 'waiting_dependency' },
    ]);
    // c 自己失败（执行失败也进 blocked）：不自动解除，d 继续阻塞
    const nodes = [g('a', 'succeeded'), g('c', 'blocked', ['a'], '执行失败：x'), g('d', 'blocked', ['c'], upstreamBlockReason('C', 'blocked'))];
    expect(graphStep(nodes)).toEqual([]);
    // 上游已成功、因它阻塞的下游直接排队
    expect(graphStep([g('a', 'succeeded'), g('b', 'blocked', ['a'], byA)])).toEqual([{ id: 'b', from: 'blocked', to: 'queued' }]);
  });

  it('给出的迁移都在子任务状态机里', () => {
    const statuses: SubtaskStatus[] = ['queued', 'running', 'review', 'succeeded', 'failed', 'blocked', 'cancelled', 'waiting_dependency'];
    for (const a of statuses) {
      for (const b of statuses) {
        const nodes = [g('a', a), g('b', b, ['a'], b === 'blocked' ? upstreamBlockReason('A', 'blocked') : null), g('c', 'waiting_dependency', ['b'])];
        for (const change of graphStep(nodes)) expect(subtaskMachine.canTransition(change.from, change.to), `${change.from}→${change.to}`).toBe(true);
      }
    }
  });
});

describe('taskStatusOf', () => {
  it('单子任务与 P1 行为一致', () => {
    expect(taskStatusOf('queued', ['running'])).toBe('running');
    expect(taskStatusOf('running', ['review'])).toBe('running');
    expect(taskStatusOf('running', ['queued'])).toBe('running');
    expect(taskStatusOf('running', ['blocked'])).toBe('blocked');
    expect(taskStatusOf('blocked', ['queued'])).toBe('queued');
    expect(taskStatusOf('running', ['succeeded'])).toBe('succeeded');
    expect(taskStatusOf('blocked', ['failed'])).toBe('failed');
    expect(taskStatusOf('running', ['cancelled'])).toBe('cancelled');
  });

  it('任务图：有在做的就是执行中，全卡住才阻塞，草稿没有子任务时不变', () => {
    expect(taskStatusOf('draft', [])).toBe('draft');
    expect(taskStatusOf('draft', ['queued', 'waiting_dependency'])).toBe('queued');
    expect(taskStatusOf('running', ['succeeded', 'blocked', 'running'])).toBe('running');
    expect(taskStatusOf('running', ['succeeded', 'blocked', 'blocked'])).toBe('blocked');
    expect(taskStatusOf('running', ['succeeded', 'failed', 'blocked'])).toBe('blocked');
    expect(taskStatusOf('running', ['succeeded', 'cancelled', 'cancelled'])).toBe('cancelled');
    expect(taskStatusOf('running', ['succeeded', 'failed'])).toBe('failed');
  });

  it('从任何非终态都能走到推导出的状态', () => {
    for (const current of TASK_STATUSES) {
      if (taskMachine.isTerminal(current)) continue;
      for (const a of SUBTASK_STATUSES) {
        for (const b of SUBTASK_STATUSES) {
          const to = taskStatusOf(current, [a, b]);
          // waiting_approval / waiting_dependency 是任务层不用的状态，推导不会给出它们
          if (current === 'waiting_approval' || current === 'waiting_dependency') continue;
          expect(taskPath(current, to), `${current} → ${to}（${a}, ${b}）`).toBeDefined();
        }
      }
    }
  });
});
