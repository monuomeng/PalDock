#!/usr/bin/env node
// 离线模拟的 Claude Code CLI：只实现 PalDock 用到的 stream-json 子集（-p --input-format/--output-format stream-json）。
// 用于适配器契约测试和应用层集成测试，不访问网络、不消耗额度。
//
// 会话记录写在 CLAUDE_CONFIG_DIR/projects/mock/<session_id>.jsonl，格式与真实 CLI 的会话记录相同的那部分，
// 跨进程可 --resume，适配器的 checkTurn 也读这份记录。
//
// 行为由提示词里的指令决定：
//   [mock:file-approval]   请求 Write 审批，批准才写 approved.txt
//   [mock:command]         请求 Bash 审批（pnpm install），批准才写 installed.txt
//   [mock:tool]            请求 WebFetch 审批
//   [mock:unknown-request] 发一个未定义的控制请求
//   [mock:withdraw]        请求审批后自己收回（control_cancel_request），然后完成
//   [mock:slow]            缓慢输出约 10 秒，可被中断
//   [mock:ignore-interrupt] 缓慢输出且不理会中断
//   [mock:fail]            以 is_error 结束（模拟 API 报错）
//   [mock:crash]           收到提示词后进程直接退出（会话记录里只有用户消息）
//   [mock:crash-after-complete]  回复写进会话记录后、发出 result 之前退出
// 默认：写入 mock-change.txt，流式输出几段文字后完成。
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('2.1.325-mock (Claude Code)\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  const loggedIn = process.env.MOCK_CLAUDE_LOGGED_OUT !== '1';
  process.stdout.write(`${JSON.stringify({ loggedIn, authMethod: loggedIn ? 'mock' : 'none' })}\n`);
  process.exit(loggedIn ? 0 : 1);
}

// 不写进工作目录（那是 worktree，会出现在改动里）
const home = process.env.CLAUDE_CONFIG_DIR ?? join(tmpdir(), 'paldock-mock-claude');
const projectDir = join(home, 'projects', 'mock');
mkdirSync(projectDir, { recursive: true });
const transcript = (id) => join(projectDir, `${id}.jsonl`);

const resumeAt = args.indexOf('--resume');
const resumeId = resumeAt >= 0 ? args[resumeAt + 1] : undefined;
if (resumeId && !existsSync(transcript(resumeId))) {
  process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
  process.exit(1);
}
const sessionId = resumeId ?? randomUUID();
if (!resumeId) writeFileSync(transcript(sessionId), '');
let lastUuid = null;
const record = (entry) => {
  const uuid = entry.uuid ?? randomUUID();
  appendFileSync(transcript(sessionId), `${JSON.stringify({ parentUuid: lastUuid, sessionId, ...entry, uuid })}\n`);
  lastUuid = uuid;
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let nextControl = 1;
const pendingControls = new Map();
function controlRequest(request) {
  const id = `mock_req_${nextControl++}`;
  send({ type: 'control_request', request_id: id, request });
  return { id, response: new Promise((resolve) => pendingControls.set(id, resolve)) };
}
const ask = async (tool_name, input) => (await controlRequest({ subtype: 'can_use_tool', tool_name, input }).response)?.response;

const state = { interrupted: false, initialized: false, busy: false };
const usage = { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 };
const modelUsage = {
  'claude-mock-main': { inputTokens: 10, outputTokens: 30, cacheReadInputTokens: 5, cacheCreationInputTokens: 6, costUSD: 0.01 },
  'claude-mock-sub': { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 },
};

function result(fields) {
  send({ type: 'result', session_id: sessionId, duration_ms: 1, num_turns: 1, usage, modelUsage, total_cost_usd: 0.011, ...fields });
}

const delta = (text) =>
  send({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });

function reply(text) {
  record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
  send({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

async function runTurn(text, cwd) {
  state.interrupted = false;
  if (text.includes('[mock:crash]')) process.exit(1);
  if (text.includes('[mock:slow]') || text.includes('[mock:ignore-interrupt]')) {
    for (let i = 0; i < 100; i++) {
      if (state.interrupted && !text.includes('[mock:ignore-interrupt]')) {
        record({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
        return result({ subtype: 'error_during_execution', is_error: false });
      }
      delta('.');
      await sleep(100);
    }
  }
  let final = '模拟执行完成：已写入 mock-change.txt。';
  // 子代理的输出带 parent_tool_use_id，宿主不应转发
  send({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: 'toolu_sub', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '子代理' } } });
  delta('正在处理。');
  if (text.includes('[mock:file-approval]')) {
    const path = join(cwd, 'approved.txt');
    const decision = await ask('Write', { file_path: path, content: 'approved\n' });
    if (decision?.behavior === 'allow') writeFileSync(decision.updatedInput.file_path, 'approved\n');
    final = decision?.behavior === 'allow' ? '已写入 approved.txt。' : '写入被拒绝。';
  } else if (text.includes('[mock:command]')) {
    const decision = await ask('Bash', { command: 'pnpm install', description: '安装依赖' });
    if (decision?.behavior === 'allow') writeFileSync(join(cwd, 'installed.txt'), 'ok\n');
    final = decision?.behavior === 'allow' ? '依赖已安装。' : '命令被拒绝。';
  } else if (text.includes('[mock:tool]')) {
    const decision = await ask('WebFetch', { url: 'https://example.com' });
    final = decision?.behavior === 'allow' ? '已联网。' : '联网被拒绝。';
  } else if (text.includes('[mock:unknown-request]')) {
    const response = await controlRequest({ subtype: 'mock_unknown' }).response;
    final = response?.subtype === 'error' ? '未知请求被拒绝。' : '未知请求得到了回复。';
  } else if (text.includes('[mock:withdraw]')) {
    const { id } = controlRequest({ subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hi' } });
    await sleep(50);
    pendingControls.delete(id);
    send({ type: 'control_cancel_request', request_id: id });
    final = '审批已收回。';
  } else if (text.includes('[mock:fail]')) {
    return result({ subtype: 'success', is_error: true, result: 'API Error: mock failure' });
  } else {
    writeFileSync(join(cwd, 'mock-change.txt'), 'mock\n');
  }
  if (resumeId) final = `已恢复：${final}`;
  delta('完成。');
  reply(final);
  if (text.includes('[mock:crash-after-complete]')) process.exit(1);
  result({ subtype: 'success', is_error: false, result: final });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === 'control_response') {
    const id = message.response?.request_id;
    pendingControls.get(id)?.(message.response);
    pendingControls.delete(id);
    return;
  }
  if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
    state.interrupted = true;
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    return;
  }
  if (message.type !== 'user' || state.busy) return;
  if (!state.initialized) {
    state.initialized = true;
    send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-mock', permissionMode: 'default', tools: ['Bash', 'Write'] });
  }
  const text = (message.message?.content ?? []).map((b) => b.text ?? '').join('');
  record({ type: 'user', uuid: message.uuid, message: { role: 'user', content: text } });
  state.busy = true;
  void runTurn(text, process.cwd()).finally(() => (state.busy = false));
});
