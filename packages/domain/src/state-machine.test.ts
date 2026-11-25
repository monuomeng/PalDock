import { RUN_STATUSES, SUBTASK_STATUSES, TASK_STATUSES } from '@paldock/contracts';
import { describe, expect, it } from 'vitest';
import { canApproveRemotely, classifyRisk, shouldEscalateApproval } from './approval-policy.js';
import { DomainError } from './errors.js';
import { approvalMachine, runMachine, subtaskMachine, taskMachine } from './state-machine.js';

describe('state machines', () => {
  it('子任务不能从 running 直接成功，只能经 review', () => {
    expect(subtaskMachine.canTransition('running', 'succeeded')).toBe(false);
    expect(subtaskMachine.canTransition('running', 'review')).toBe(true);
    expect(subtaskMachine.canTransition('review', 'succeeded')).toBe(true);
    expect(subtaskMachine.canTransition('review', 'queued')).toBe(true);
  });

  it('终态不能再迁移', () => {
    for (const s of ['succeeded', 'cancelled'] as const) {
      expect(taskMachine.isTerminal(s)).toBe(true);
      for (const to of TASK_STATUSES) expect(taskMachine.canTransition(s, to)).toBe(false);
    }
    expect(approvalMachine.isTerminal('approved')).toBe(true);
  });

  it('非法迁移抛 invalid_transition', () => {
    expect(() => taskMachine.assertTransition('draft', 'succeeded')).toThrow(DomainError);
    try {
      approvalMachine.assertTransition('denied', 'approved');
    } catch (e) {
      expect((e as DomainError).code).toBe('invalid_transition');
    }
  });

  it('Run 断线后进入 unconfirmed，查实后才能离开', () => {
    expect(runMachine.canTransition('running', 'unconfirmed')).toBe(true);
    expect(runMachine.canTransition('unconfirmed', 'succeeded')).toBe(true);
    expect(runMachine.canTransition('interrupted', 'running')).toBe(true);
    // P3-09：重启后按原生会话查实这一轮已完成时才补记成功（恢复程序只在 checkTurn 返回 completed 时用）
    expect(runMachine.canTransition('interrupted', 'succeeded')).toBe(true);
    expect(runMachine.canTransition('cancelled', 'succeeded')).toBe(false);
  });

  it('迁移表覆盖了契约里的每个状态', () => {
    for (const s of TASK_STATUSES) expect(() => taskMachine.isTerminal(s)).not.toThrow();
    for (const s of SUBTASK_STATUSES) expect(typeof subtaskMachine.isTerminal(s)).toBe('boolean');
    // 非终态都至少能取消，保证「取消任务会取消其所有未结束的 Run」可达
    for (const s of RUN_STATUSES) {
      if (!runMachine.isTerminal(s)) expect(runMachine.canTransition(s, 'cancelled')).toBe(true);
    }
  });
});

describe('approval policy', () => {
  it('远程审批等级', () => {
    const of = (riskLevel: 'low' | 'medium' | 'high', kind: 'command' | 'permissions' = 'command') => ({ riskLevel, kind });
    expect(canApproveRemotely('L0', of('low'))).toBe(false);
    expect(canApproveRemotely('L1', of('medium'))).toBe(true);
    expect(canApproveRemotely('L1', of('high'))).toBe(false);
    expect(canApproveRemotely('L2', of('high'))).toBe(true);
    expect(canApproveRemotely('L2', of('low', 'permissions'))).toBe(false);
  });

  it('桌面优先，满足任一条件才升级', () => {
    const present = { uiRunning: true, locked: false, idle: false };
    expect(shouldEscalateApproval(0, 60_000, present)).toBe(false);
    expect(shouldEscalateApproval(0, 180_000, present)).toBe(true);
    expect(shouldEscalateApproval(0, 0, { ...present, locked: true })).toBe(true);
    expect(shouldEscalateApproval(0, 0, { ...present, uiRunning: false })).toBe(true);
  });

  it('风险分级草案：worktree 内为低，装依赖为中，推送/合并/外发为高', () => {
    expect(classifyRisk('run_tests')).toBe('low');
    expect(classifyRisk('install_dependencies')).toBe('medium');
    for (const op of ['push_remote', 'merge_branch', 'write_outside_worktree', 'send_external_message'] as const) {
      expect(classifyRisk(op)).toBe('high');
    }
  });
});
