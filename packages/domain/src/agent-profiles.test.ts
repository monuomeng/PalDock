import type { RuntimeDiscovery } from '@paldock/contracts';
import { describe, expect, it } from 'vitest';
import { checkCapability } from './agent-profiles.js';

const available: RuntimeDiscovery = {
  runtime: 'codex',
  available: true,
  version: '0.166.0',
  capabilities: { resume: true, streaming: true, approvals: true, cancel: true, workingDirectoryRestriction: true, attachments: false },
};

describe('能力检查', () => {
  it('Windows：只读角色可用（实测可强制）；可写角色标「不隔离」但不拒绝', () => {
    expect(checkCapability('read', 'codex', available, 'win32')).toEqual({ ok: true, isolation: 'read_only', problems: [], warnings: [] });
    const write = checkCapability('worktree_write', 'claude', available, 'win32');
    expect(write).toMatchObject({ ok: true, isolation: 'not_isolated' });
    expect(write.warnings[0]).toMatch(/^不隔离/);
  });

  it('macOS 未实测：只提醒不拒绝', () => {
    expect(checkCapability('read', 'claude', available, 'darwin')).toMatchObject({ ok: true, isolation: 'unverified' });
    expect(checkCapability('worktree_write', 'codex', available, 'darwin')).toMatchObject({ ok: true, isolation: 'unverified' });
  });

  it('执行器不可用或缺少审批、取消时拒绝，原因来自发现结果', () => {
    expect(checkCapability('read', 'claude', { ...available, available: false, reason: 'Claude Code 未登录' }, 'win32')).toMatchObject({
      ok: false,
      problems: ['Claude Code 未登录'],
    });
    expect(checkCapability('read', 'codex', undefined, 'win32')).toMatchObject({ ok: false, problems: ['codex 不可用'] });
    const noApprovals = { ...available, capabilities: { ...available.capabilities, approvals: false, cancel: false } };
    expect(checkCapability('worktree_write', 'codex', noApprovals, 'win32').problems).toEqual(['codex 不支持宿主审批', 'codex 不支持取消']);
  });
});
