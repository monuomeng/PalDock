import type { ApprovalStatus, PlanStatus, RunStatus, SubtaskStatus, TaskStatus } from '@paldock/contracts';
import { DomainError } from './errors.js';

export interface StateMachine<S extends string> {
  readonly name: string;
  canTransition(from: S, to: S): boolean;
  /** 不允许的迁移抛出 `invalid_transition`；调用方在事务内先校验再写库。 */
  assertTransition(from: S, to: S): void;
  isTerminal(state: S): boolean;
}

function defineMachine<S extends string>(name: string, table: Readonly<Record<S, readonly S[]>>): StateMachine<S> {
  const allowed = new Map<S, ReadonlySet<S>>(
    (Object.entries(table) as [S, readonly S[]][]).map(([from, to]) => [from, new Set(to)]),
  );
  const canTransition = (from: S, to: S) => allowed.get(from)?.has(to) ?? false;
  return {
    name,
    canTransition,
    assertTransition(from, to) {
      if (!canTransition(from, to)) {
        throw new DomainError('invalid_transition', `${name}: ${from} → ${to} 不允许`);
      }
    },
    isTerminal: (state) => (allowed.get(state)?.size ?? 0) === 0,
  };
}

export const taskMachine = defineMachine<TaskStatus>('task', {
  draft: ['queued', 'cancelled'],
  // queued → blocked：服务重启时排队中的任务转为阻塞（恢复程序）
  queued: ['running', 'blocked', 'cancelled'],
  running: ['waiting_approval', 'waiting_dependency', 'blocked', 'succeeded', 'failed', 'cancelled'],
  waiting_approval: ['running', 'failed', 'cancelled'],
  waiting_dependency: ['running', 'blocked', 'cancelled'],
  blocked: ['queued', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
});

/**
 * 子任务交付后只能进入 `review`，`running → succeeded` 不存在：
 * 模型说「完成」不会推进状态，必须经过验收闸门或用户。
 * `review → queued` 是退回重做，次数不设上限，由调用方记录原因和累计次数。
 */
export const subtaskMachine = defineMachine<SubtaskStatus>('subtask', {
  draft: ['queued', 'cancelled'],
  queued: ['running', 'waiting_dependency', 'cancelled'],
  running: ['waiting_approval', 'blocked', 'review', 'failed', 'cancelled'],
  waiting_approval: ['running', 'failed', 'cancelled'],
  waiting_dependency: ['queued', 'blocked', 'cancelled'],
  // blocked → failed：服务重启后被中断、用户选择放弃；blocked → waiting_dependency：阻塞它的上游恢复了
  blocked: ['queued', 'waiting_dependency', 'failed', 'cancelled'],
  review: ['succeeded', 'failed', 'queued', 'cancelled'],
  succeeded: [],
  failed: ['queued'],
  cancelled: [],
});

/**
 * `unconfirmed` 只能在重新查到原生会话状态后离开，不猜测结果。
 * `interrupted → running` 表示按原生会话 ID 恢复成功。
 */
export const runMachine = defineMachine<RunStatus>('run', {
  starting: ['running', 'unconfirmed', 'interrupted', 'failed', 'cancelled'],
  running: ['waiting_approval', 'unconfirmed', 'interrupted', 'succeeded', 'failed', 'cancelled'],
  waiting_approval: ['running', 'unconfirmed', 'interrupted', 'failed', 'cancelled'],
  unconfirmed: ['running', 'waiting_approval', 'interrupted', 'succeeded', 'failed', 'cancelled'],
  interrupted: ['running', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
});

/** 每版计划只决定一次：确认、退回，或被同一任务的新一版取代。确认后不可修改。 */
export const planMachine = defineMachine<PlanStatus>('plan', {
  proposed: ['confirmed', 'rejected', 'superseded'],
  confirmed: [],
  rejected: [],
  superseded: [],
});

export const approvalMachine = defineMachine<ApprovalStatus>('approval', {
  pending: ['approved', 'denied', 'expired', 'cancelled'],
  approved: [],
  denied: [],
  expired: [],
  cancelled: [],
});
