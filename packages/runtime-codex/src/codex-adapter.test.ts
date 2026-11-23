import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent, RuntimeRun } from '@paldock/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from './codex-adapter.js';
import { approvalResponse, toApprovalRequest } from './event-mapping.js';
import { MOCK_APP_SERVER_PATH } from './mock-path.js';

let home: string;
let cwd: string;
let run: RuntimeRun | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'paldock-mock-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'paldock-mock-cwd-'));
});
afterEach(async () => {
  await run?.dispose();
  run = undefined;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const adapter = (extraEnv: Record<string, string> = {}) =>
  new CodexAdapter({
    configuredPath: MOCK_APP_SERVER_PATH,
    extraEnv: { MOCK_CODEX_HOME: home, ...extraEnv },
    cancelWaitMs: 2_000,
    interruptWaitMs: 2_000,
    requestTimeoutMs: 10_000,
  });

/** 启动一次 Run，收集事件直到出现终态事件；onEvent 可在途中响应（例如批准审批）。 */
async function runToEnd(prompt: string, options: { codex?: CodexAdapter; resumeThreadId?: string; onEvent?: (e: RuntimeEvent) => void } = {}) {
  const events: RuntimeEvent[] = [];
  let done!: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));
  const terminal = new Set(['completed', 'failed', 'interrupted', 'disconnected']);
  run = await (options.codex ?? adapter()).start(
    { runId: 'run_1', cwd, prompt, ...(options.resumeThreadId ? { resumeThreadId: options.resumeThreadId } : {}) },
    (event) => {
      events.push(event);
      options.onEvent?.(event);
      if (terminal.has(event.type)) done();
    },
  );
  return { events, finished, run };
}

const ofType = <T extends RuntimeEvent['type']>(events: RuntimeEvent[], type: T) =>
  events.filter((e): e is Extract<RuntimeEvent, { type: T }> => e.type === type);

describe('Codex 适配器（模拟 app-server）', () => {
  it('发现：模拟执行器报告版本与能力', async () => {
    expect(await adapter().discover()).toMatchObject({ available: true, version: '0.0.0-mock', capabilities: { cancel: true } });
  });

  it('正常流程：thread、turn、流式输出、完成并带最后一条回复', async () => {
    const { events, finished } = await runToEnd('做一点改动');
    await finished;
    expect(events[0]).toMatchObject({ type: 'thread' });
    expect(events[1]).toMatchObject({ type: 'turn' });
    expect(ofType(events, 'output_delta').map((e) => e.text).join('')).toBe('正在处理。完成。');
    expect(events.at(-1)).toEqual({ type: 'completed', finalMessage: '模拟执行完成：已写入 mock-change.txt。' });
    expect(existsSync(join(cwd, 'mock-change.txt'))).toBe(true);
  });

  it('文件改动审批：路径来自 item/started；拒绝后不写入', async () => {
    const { events, finished } = await runToEnd('[mock:file-approval]', {
      onEvent: (e) => e.type === 'approval_request' && run!.respondApproval(e.request.nativeRequestId, 'deny'),
    });
    await finished;
    const [request] = ofType(events, 'approval_request');
    expect(request?.request).toMatchObject({ kind: 'file_change', summary: '修改 1 个文件' });
    expect(request?.request.paths?.[0]).toMatch(/approved\.txt$/);
    expect(existsSync(join(cwd, 'approved.txt'))).toBe(false);
    expect(events.at(-1)?.type).toBe('completed');
  });

  it('命令审批：批准后执行', async () => {
    const { finished } = await runToEnd('[mock:command]', {
      onEvent: (e) => e.type === 'approval_request' && run!.respondApproval(e.request.nativeRequestId, 'allow_once'),
    });
    await finished;
    expect(existsSync(join(cwd, 'installed.txt'))).toBe(true);
  });

  it('权限扩展：即使传入允许也只授予空权限', async () => {
    const { events, finished } = await runToEnd('[mock:permissions]', {
      onEvent: (e) => e.type === 'approval_request' && run!.respondApproval(e.request.nativeRequestId, 'allow_once'),
    });
    await finished;
    expect(ofType(events, 'approval_request')[0]?.request).toMatchObject({ kind: 'permissions', summary: '请求扩展权限：联网' });
    expect(ofType(events, 'output_delta').map((e) => e.text).join('')).toContain('没有获得额外权限');
  });

  it('未识别的服务端请求立即回错误并上报，turn 不挂起', async () => {
    const { events, finished } = await runToEnd('[mock:unknown-request]');
    await finished;
    expect(ofType(events, 'notice')).toEqual([{ type: 'notice', code: 'unknown_request', detail: 'item/tool/requestUserInput' }]);
    expect(events.at(-1)?.type).toBe('completed');
  });

  it('执行器收回请求时上报 approval_withdrawn', async () => {
    const { events, finished } = await runToEnd('[mock:withdraw]');
    await finished;
    const [request] = ofType(events, 'approval_request');
    expect(ofType(events, 'approval_withdrawn')).toEqual([{ type: 'approval_withdrawn', nativeRequestId: request!.request.nativeRequestId }]);
  });

  it('执行中取消：等 turn/started 后中断，以 interrupted 结束', async () => {
    const { events, finished, run: handle } = await runToEnd('[mock:slow]');
    while (!events.some((e) => e.type === 'output_delta')) await new Promise((r) => setTimeout(r, 10));
    await handle.cancel();
    await finished;
    expect(events.at(-1)).toEqual({ type: 'interrupted' });
  });

  it('开始前取消：先等 turn/started 再中断，不会报 no active turn', async () => {
    const { events, finished, run: handle } = await runToEnd('[mock:slow]', { codex: adapter({ MOCK_CODEX_START_DELAY_MS: '300' }) });
    await handle.cancel();
    await finished;
    expect(events.at(-1)).toEqual({ type: 'interrupted' });
    expect(ofType(events, 'output_delta').length).toBeLessThan(5);
  });

  it('turn 失败映射为 failed', async () => {
    const { events, finished } = await runToEnd('[mock:fail]');
    await finished;
    expect(events.at(-1)).toEqual({ type: 'failed', message: '模拟失败' });
  });

  it('进程崩溃上报 disconnected；核对只认这次的 turn', async () => {
    const first = await runToEnd('第一轮');
    await first.finished;
    const threadId = ofType(first.events, 'thread')[0]!.threadId;
    const firstTurn = ofType(first.events, 'turn')[0]!.turnId;

    const crashed = await runToEnd('[mock:crash]', { resumeThreadId: threadId });
    await crashed.finished;
    expect(crashed.events.at(-1)).toMatchObject({ type: 'disconnected' });
    const crashedTurn = ofType(crashed.events, 'turn')[0]!.turnId;

    const codex = adapter();
    expect(await codex.checkTurn(threadId, crashedTurn)).toEqual({ status: 'in_progress' });
    expect(await codex.checkTurn(threadId, firstTurn)).toMatchObject({ status: 'completed' });
    expect(await codex.checkTurn(threadId, 'turn_unknown')).toEqual({ status: 'not_found' });
    expect(await codex.checkTurn('thr_unknown', firstTurn)).toEqual({ status: 'not_found' });
  });

  it('完成落盘后崩溃：核对得到 completed 与最终回复', async () => {
    const { events, finished } = await runToEnd('[mock:crash-after-complete]');
    await finished;
    expect(events.at(-1)).toMatchObject({ type: 'disconnected' });
    const threadId = ofType(events, 'thread')[0]!.threadId;
    const turnId = ofType(events, 'turn')[0]!.turnId;
    expect(await adapter().checkTurn(threadId, turnId)).toEqual({
      status: 'completed',
      finalMessage: '模拟执行完成：已写入 mock-change.txt。',
    });
  });

  it('续做失败时启动直接报错，不静默新建 thread', async () => {
    await expect(runToEnd('继续', { resumeThreadId: 'thr_missing' })).rejects.toThrow(/thread not found/);
  });
});

describe('协议映射', () => {
  it('fileChange 带 grantRoot 时一并列入路径', () => {
    const request = toApprovalRequest('item/fileChange/requestApproval', { itemId: 'x', grantRoot: 'C:/' }, '7', new Map());
    expect(request).toMatchObject({ kind: 'file_change', paths: ['C:/'], summary: '修改 1 个文件' });
  });

  it('审批决定映射到协议值', () => {
    expect(approvalResponse('command', 'allow_once')).toEqual({ decision: 'accept' });
    expect(approvalResponse('file_change', 'deny')).toEqual({ decision: 'decline' });
    expect(approvalResponse('command', 'cancel')).toEqual({ decision: 'cancel' });
    expect(approvalResponse('permissions', 'allow_once')).toEqual({ permissions: {}, scope: 'turn' });
  });

  it('非审批请求返回 undefined', () => {
    expect(toApprovalRequest('account/chatgptAuthTokens/refresh', {}, '1', new Map())).toBeUndefined();
  });
});
