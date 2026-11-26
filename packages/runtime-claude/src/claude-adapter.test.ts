import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeApprovalDecision, RuntimeEvent, RuntimeRun } from '@paldock/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './claude-adapter.js';
import { permissionResponse, resultEvent, toApprovalRequest, turnCheckFromTranscript } from './event-mapping.js';
import { MOCK_CLAUDE_PATH } from './mock-path.js';

let home: string;
let cwd: string;
let run: RuntimeRun | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'paldock-mock-claude-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'paldock-mock-claude-cwd-'));
});
afterEach(async () => {
  await run?.dispose();
  run = undefined;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const adapter = (extraEnv: Record<string, string> = {}) =>
  new ClaudeAdapter({ configuredPath: MOCK_CLAUDE_PATH, configDir: home, extraEnv, interruptWaitMs: 2_000, requestTimeoutMs: 10_000 });

/** 启动一次 Run，收集事件直到出现终态事件；approve 给出时自动回复每个审批。 */
async function runToEnd(prompt: string, options: { claude?: ClaudeAdapter; resumeThreadId?: string; approve?: RuntimeApprovalDecision } = {}) {
  const events: RuntimeEvent[] = [];
  let done!: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));
  const terminal = new Set(['completed', 'failed', 'interrupted', 'disconnected']);
  const started = (options.claude ?? adapter()).start(
    { runId: 'run_1', cwd, prompt, ...(options.resumeThreadId ? { resumeThreadId: options.resumeThreadId } : {}) },
    (event) => {
      events.push(event);
      // 事件可能先于 start() 的返回值送达，所以经 started 回复
      if (event.type === 'approval_request' && options.approve) {
        const decision = options.approve;
        void started.then((handle) => handle.respondApproval(event.request.nativeRequestId, decision));
      }
      if (terminal.has(event.type)) done();
    },
  );
  run = await started;
  return { events, finished, run };
}

const ofType = <T extends RuntimeEvent['type']>(events: RuntimeEvent[], type: T) =>
  events.filter((e): e is Extract<RuntimeEvent, { type: T }> => e.type === type);
const ids = (events: RuntimeEvent[]) => ({
  threadId: ofType(events, 'thread')[0]!.threadId,
  turnId: ofType(events, 'turn')[0]!.turnId,
});

describe('Claude 适配器（模拟 CLI）', () => {
  it('发现：报告版本与能力；未登录时不可用', async () => {
    expect(await adapter().discover()).toMatchObject({ available: true, version: '2.1.325-mock', capabilities: { resume: true, cancel: true } });
    expect(await adapter({ MOCK_CLAUDE_LOGGED_OUT: '1' }).discover()).toMatchObject({ available: false, reason: expect.stringContaining('未登录') });
    expect(await new ClaudeAdapter({ configuredPath: join(cwd, 'missing.exe') }).discover()).toMatchObject({ available: false });
  });

  it('正常流程：thread、turn、只转发主会话的流式输出、完成并带用量', async () => {
    const { events, finished } = await runToEnd('做一点改动');
    await finished;
    expect(events[0]).toMatchObject({ type: 'thread' });
    expect(events[1]).toMatchObject({ type: 'turn' });
    expect(ofType(events, 'output_delta').map((e) => e.text).join('')).toBe('正在处理。完成。');
    expect(events.at(-1)).toEqual({
      type: 'completed',
      finalMessage: '模拟执行完成：已写入 mock-change.txt。',
      // 按模型合计（主会话 + 子代理）
      usage: { inputTokens: 12, outputTokens: 34, cacheReadTokens: 5, cacheWriteTokens: 6, costUsd: 0.011 },
    });
    expect(existsSync(join(cwd, 'mock-change.txt'))).toBe(true);
  });

  it('turn ID 是宿主发出的用户消息 uuid，写进了会话记录', async () => {
    const { events, finished } = await runToEnd('做一点改动');
    await finished;
    const { threadId, turnId } = ids(events);
    const file = join(home, 'projects', 'mock', `${threadId}.jsonl`);
    expect(readFileSync(file, 'utf8')).toContain(turnId);
  });

  it('写文件审批：路径来自参数；拒绝后不写入，批准后写入', async () => {
    const denied = await runToEnd('[mock:file-approval]', { approve: 'deny' });
    await denied.finished;
    const [request] = ofType(denied.events, 'approval_request');
    // 模拟的 Claude 按它自己的 process.cwd() 解析路径，是真实路径（macOS 上 /var 是 /private/var 的链接）
    expect(request!.request).toMatchObject({ kind: 'file_change', paths: [join(realpathSync(cwd), 'approved.txt')] });
    expect(existsSync(join(cwd, 'approved.txt'))).toBe(false);
    await run?.dispose();

    const allowed = await runToEnd('[mock:file-approval]', { approve: 'allow_once' });
    await allowed.finished;
    expect(existsSync(join(cwd, 'approved.txt'))).toBe(true);
    expect(allowed.events.at(-1)).toMatchObject({ type: 'completed', finalMessage: '已写入 approved.txt。' });
  });

  it('Shell 审批映射为命令；其他工具映射为扩展权限', async () => {
    const command = await runToEnd('[mock:command]', { approve: 'allow_once' });
    await command.finished;
    expect(ofType(command.events, 'approval_request')[0]!.request).toMatchObject({ kind: 'command', command: 'pnpm install', reason: '安装依赖' });
    expect(existsSync(join(cwd, 'installed.txt'))).toBe(true);
    await run?.dispose();

    const tool = await runToEnd('[mock:tool]', { approve: 'deny' });
    await tool.finished;
    expect(ofType(tool.events, 'approval_request')[0]!.request).toMatchObject({ kind: 'permissions', summary: '使用工具 WebFetch' });
    expect(tool.events.at(-1)).toMatchObject({ finalMessage: '联网被拒绝。' });
  });

  it('执行器收回审批时上报 approval_withdrawn；未知控制请求回错误并记录', async () => {
    const withdrawn = await runToEnd('[mock:withdraw]');
    await withdrawn.finished;
    const [request] = ofType(withdrawn.events, 'approval_request');
    expect(ofType(withdrawn.events, 'approval_withdrawn')).toEqual([{ type: 'approval_withdrawn', nativeRequestId: request!.request.nativeRequestId }]);
    await run?.dispose();

    const unknown = await runToEnd('[mock:unknown-request]');
    await unknown.finished;
    expect(ofType(unknown.events, 'notice')).toEqual([{ type: 'notice', code: 'unknown_request', detail: 'mock_unknown' }]);
    expect(unknown.events.at(-1)).toMatchObject({ finalMessage: '未知请求被拒绝。' });
  });

  it('取消：发中断，以 error_during_execution 结束时报「已中断」', async () => {
    const { events, finished, run: handle } = await runToEnd('[mock:slow]');
    await handle.cancel();
    await finished;
    expect(events.at(-1)).toEqual({ type: 'interrupted' });
  });

  it('取消：执行器不理会中断时，超时后结束进程树并报「已中断」', async () => {
    const { events, finished, run: handle } = await runToEnd('[mock:ignore-interrupt]');
    await handle.cancel();
    await finished;
    expect(events.at(-1)).toEqual({ type: 'interrupted' });
    expect(ofType(events, 'completed')).toEqual([]);
  });

  it('API 报错（is_error）按失败上报', async () => {
    const { events, finished } = await runToEnd('[mock:fail]');
    await finished;
    expect(events.at(-1)).toMatchObject({ type: 'failed', message: 'API Error: mock failure' });
  });

  it('恢复：沿用原会话；会话不存在时启动失败、不发事件', async () => {
    const first = await runToEnd('第一轮');
    await first.finished;
    const { threadId } = ids(first.events);
    await run?.dispose();

    const resumed = await runToEnd('第二轮', { resumeThreadId: threadId });
    await resumed.finished;
    expect(ofType(resumed.events, 'thread')[0]!.threadId).toBe(threadId);
    expect(resumed.events.at(-1)).toMatchObject({ type: 'completed', finalMessage: expect.stringContaining('已恢复') });
    await run?.dispose();
    run = undefined;

    const events: RuntimeEvent[] = [];
    await expect(adapter().start({ runId: 'run_2', cwd, prompt: 'x', resumeThreadId: 'no-such-session' }, (e) => events.push(e))).rejects.toThrow(
      /No conversation found/,
    );
    expect(events).toEqual([]);
  });

  it('进程意外退出报 disconnected；按会话记录核对 turn', async () => {
    const crashed = await runToEnd('[mock:crash]');
    await crashed.finished;
    expect(crashed.events.at(-1)).toMatchObject({ type: 'disconnected' });
    const c = ids(crashed.events);
    expect(await adapter().checkTurn(c.threadId, c.turnId)).toEqual({ status: 'in_progress' });
    await run?.dispose();

    const late = await runToEnd('[mock:crash-after-complete]');
    await late.finished;
    expect(late.events.at(-1)).toMatchObject({ type: 'disconnected' });
    const l = ids(late.events);
    expect(await adapter().checkTurn(l.threadId, l.turnId)).toEqual({ status: 'completed', finalMessage: '模拟执行完成：已写入 mock-change.txt。' });
    expect(await adapter().checkTurn(l.threadId, 'turn-unknown')).toEqual({ status: 'not_found' });
    expect(await adapter().checkTurn('no-such-session', l.turnId)).toEqual({ status: 'not_found' });
    expect(await adapter().checkTurn('../escape', l.turnId)).toEqual({ status: 'not_found' });
  });
});

describe('Claude 事件映射', () => {
  it('相对路径按工作目录解析；路径缺失时 paths 为空（风险按目录外）', () => {
    expect(toApprovalRequest('Edit', { file_path: 'src/a.ts' }, 'r1', cwd)).toMatchObject({ kind: 'file_change', paths: [join(cwd, 'src/a.ts')] });
    expect(toApprovalRequest('NotebookEdit', {}, 'r2', cwd)).toMatchObject({ kind: 'file_change', paths: [] });
    expect(toApprovalRequest('PowerShell', { command: 'Remove-Item x' }, 'r3', cwd)).not.toHaveProperty('cwd');
  });

  it('批准原样带回参数；拒绝和取消都是 deny', () => {
    expect(permissionResponse('allow_once', { a: 1 })).toEqual({ behavior: 'allow', updatedInput: { a: 1 } });
    expect(permissionResponse('deny', { a: 1 })).toMatchObject({ behavior: 'deny' });
    expect(permissionResponse('cancel', { a: 1 })).toMatchObject({ behavior: 'deny' });
  });

  it('error_during_execution 只有宿主发过中断才算已中断', () => {
    const result = { type: 'result', subtype: 'error_during_execution', is_error: false };
    expect(resultEvent(result, true)).toEqual({ type: 'interrupted' });
    expect(resultEvent(result, false)).toMatchObject({ type: 'failed' });
  });

  it('核对：还在调工具算进行中；有中断标记算已中断；下一句用户消息之后的回复不算', () => {
    const line = (entry: object) => JSON.stringify(entry);
    const prompt = line({ type: 'user', uuid: 't1', message: { content: '做事' } });
    const toolUse = line({ type: 'assistant', message: { content: [{ type: 'tool_use' }], stop_reason: 'tool_use' } });
    const toolResult = line({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
    const interrupted = line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    const answer = line({ type: 'assistant', message: { content: [{ type: 'text', text: '好了' }], stop_reason: 'end_turn' } });
    const next = line({ type: 'user', uuid: 't2', message: { content: '下一句' } });
    expect(turnCheckFromTranscript([prompt, toolUse], 't1')).toEqual({ status: 'in_progress' });
    expect(turnCheckFromTranscript([prompt, toolUse, toolResult, answer], 't1')).toEqual({ status: 'completed', finalMessage: '好了' });
    expect(turnCheckFromTranscript([prompt, toolUse, interrupted], 't1')).toEqual({ status: 'interrupted' });
    expect(turnCheckFromTranscript([prompt, toolUse, next, answer], 't1')).toEqual({ status: 'in_progress' });
    expect(turnCheckFromTranscript(['不是 JSON', prompt], 't1')).toEqual({ status: 'in_progress' });
  });
});
