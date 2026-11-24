#!/usr/bin/env node
// 离线模拟的 Codex app-server：按行分隔的 JSON-RPC over stdio，只实现 PalDock 用到的方法。
// 用于适配器契约测试、应用层集成测试和桌面端到端检查，不访问网络、不消耗额度。
//
// 用法：node mock-app-server.mjs app-server --listen stdio://
// thread 状态存放在 MOCK_CODEX_HOME（缺省为 CODEX_HOME）下，跨进程可 resume / read。
//
// 行为由提示词里的指令决定（可组合）：
//   [mock:file-approval]   先请求文件改动审批，批准才写 approved.txt
//   [mock:command]         请求命令审批（pnpm install），批准才写 installed.txt
//   [mock:permissions]     请求权限扩展（联网）
//   [mock:unknown-request] 发一个未定义的服务端请求
//   [mock:slow]            缓慢输出约 10 秒，可被中断
//   [mock:fail]            turn 以 failed 结束
//   [mock:crash]           turn 开始后进程直接退出（turn 留在 inProgress）
//   [mock:crash-after-complete]  turn 完成并落盘后、发出 turn/completed 之前退出
//   [mock:withdraw]        请求审批后自己收回（serverRequest/resolved），然后完成
//   [mock:early-approval]  在 turn/start 响应之前就发出命令审批（批准才写 early.txt）
// 默认：写入 mock-change.txt，流式输出几段文字后完成。
// MOCK_CODEX_START_DELAY_MS：turn/start 响应后延迟多久才发 turn/started（测试「开始前取消」）。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const home = process.env.MOCK_CODEX_HOME ?? process.env.CODEX_HOME ?? join(process.cwd(), '.mock-codex');
const threadsDir = join(home, 'mock-threads');
mkdirSync(threadsDir, { recursive: true });
const startDelayMs = Number(process.env.MOCK_CODEX_START_DELAY_MS ?? 0);

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.166.0-mock\n');
  process.exit(0);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const threadFile = (id) => join(threadsDir, `${id}.json`);
const loadThread = (id) => (existsSync(threadFile(id)) ? JSON.parse(readFileSync(threadFile(id), 'utf8')) : undefined);
const saveThread = (thread) => writeFileSync(threadFile(thread.id), JSON.stringify(thread));

let nextServerRequestId = 1000;
const serverRequests = new Map();
function serverRequest(method, params) {
  const id = nextServerRequestId++;
  send({ id, method, params });
  return { id, response: new Promise((resolve) => serverRequests.set(id, resolve)) };
}

/** 当前进行中的 turn，供 turn/interrupt 使用。 */
const active = new Map();

async function runTurn(thread, turn, text) {
  const ctl = { interrupted: false, started: false };
  active.set(turn.id, ctl);
  const base = { threadId: thread.id, turnId: turn.id };
  if (startDelayMs > 0) await sleep(startDelayMs);
  ctl.started = true;
  notify('turn/started', { threadId: thread.id, turn: { ...turn, status: 'inProgress' } });

  if (text.includes('[mock:crash]')) {
    await sleep(50);
    process.exit(3);
  }
  const say = async (delta) => {
    notify('item/agentMessage/delta', { ...base, itemId: 'msg', delta });
    await sleep(5);
  };

  if (text.includes('[mock:unknown-request]')) {
    serverRequest('item/tool/requestUserInput', { ...base, itemId: 'q', questions: [] });
    await sleep(20);
  }
  if (text.includes('[mock:file-approval]')) {
    const itemId = `fc_${randomUUID()}`;
    const path = join(thread.cwd, 'approved.txt');
    notify('item/started', { ...base, item: { type: 'fileChange', id: itemId, changes: [{ path, kind: 'add', diff: '+ok' }], status: 'inProgress' } });
    const { response } = serverRequest('item/fileChange/requestApproval', { ...base, itemId, startedAtMs: Date.now(), reason: null });
    const { result } = await response;
    if (result?.decision === 'accept') writeFileSync(path, 'approved\n');
    await say(result?.decision === 'accept' ? '已写入 approved.txt。' : '审批被拒绝，未写入。');
  }
  if (text.includes('[mock:command]')) {
    const { response } = serverRequest('item/commandExecution/requestApproval', {
      ...base,
      itemId: 'cmd',
      kind: 'command',
      startedAtMs: Date.now(),
      environmentId: null,
      command: 'pnpm install',
      cwd: thread.cwd,
      reason: '需要联网安装依赖',
    });
    const { result } = await response;
    if (result?.decision === 'accept') writeFileSync(join(thread.cwd, 'installed.txt'), 'installed\n');
    await say(result?.decision === 'accept' ? '已安装。' : '命令被拒绝。');
  }
  if (text.includes('[mock:permissions]')) {
    const { response } = serverRequest('item/permissions/requestApproval', {
      ...base,
      itemId: 'perm',
      environmentId: null,
      startedAtMs: Date.now(),
      cwd: thread.cwd,
      reason: '需要联网',
      permissions: { network: { enabled: true }, fileSystem: null },
    });
    const { result } = await response;
    await say(result?.permissions?.network ? '已获得联网权限。' : '没有获得额外权限。');
  }
  if (text.includes('[mock:withdraw]')) {
    const { id } = serverRequest('item/commandExecution/requestApproval', {
      ...base,
      itemId: 'cmd2',
      kind: 'command',
      startedAtMs: Date.now(),
      environmentId: null,
      command: 'echo hi',
      cwd: thread.cwd,
    });
    await sleep(100);
    serverRequests.delete(id);
    notify('serverRequest/resolved', { threadId: thread.id, requestId: id });
  }
  if (text.includes('[mock:slow]')) {
    for (let i = 0; i < 200 && !ctl.interrupted; i++) {
      await say(`${i} `);
      await sleep(45);
    }
  }
  if (ctl.interrupted) return finish(thread, turn, 'interrupted');
  if (text.includes('[mock:fail]')) return finish(thread, turn, 'failed', null, { message: '模拟失败' });

  writeFileSync(join(thread.cwd, 'mock-change.txt'), `turn ${turn.id}\n`);
  for (const part of ['正在', '处理', '。完成。']) await say(part);
  const finalMessage = '模拟执行完成：已写入 mock-change.txt。';
  notify('item/completed', { ...base, item: { type: 'agentMessage', id: 'msg', text: finalMessage, phase: null }, completedAtMs: Date.now() });

  if (text.includes('[mock:crash-after-complete]')) {
    persistTurn(thread, turn, 'completed', finalMessage);
    process.exit(3);
  }
  return finish(thread, turn, 'completed', finalMessage);
}

function persistTurn(thread, turn, status, finalMessage, error = null) {
  const saved = loadThread(thread.id) ?? thread;
  const items = finalMessage ? [{ type: 'agentMessage', id: 'msg', text: finalMessage, phase: null }] : [];
  saved.turns = saved.turns.map((t) => (t.id === turn.id ? { ...t, status, items, error } : t));
  saveThread(saved);
  return saved.turns.find((t) => t.id === turn.id);
}

function finish(thread, turn, status, finalMessage = null, error = null) {
  active.delete(turn.id);
  const done = persistTurn(thread, turn, status, finalMessage, error);
  notify('turn/completed', { threadId: thread.id, turn: done });
}

const newTurn = () => ({ id: `turn_${randomUUID()}`, status: 'inProgress', items: [], error: null });

const handlers = {
  initialize: () => ({ userAgent: 'mock/0.0.0', codexHome: home, platformOs: process.platform }),
  'thread/start': ({ cwd }) => {
    const thread = { id: `thr_${randomUUID()}`, cwd, turns: [] };
    saveThread(thread);
    return { thread: { id: thread.id, turns: [] }, cwd, sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'on-request' };
  },
  'thread/resume': ({ threadId, cwd }) => {
    const thread = loadThread(threadId);
    if (!thread) throw Object.assign(new Error(`thread not found: ${threadId}`), { code: -32600 });
    if (cwd) saveThread({ ...thread, cwd });
    return { thread: { id: thread.id, turns: thread.turns } };
  },
  'thread/read': ({ threadId }) => {
    const thread = loadThread(threadId);
    if (!thread) throw Object.assign(new Error(`thread not found: ${threadId}`), { code: -32600 });
    return { thread: { id: thread.id, turns: thread.turns } };
  },
  'turn/start': ({ threadId, input }) => {
    const thread = loadThread(threadId);
    if (!thread) throw Object.assign(new Error(`thread not found: ${threadId}`), { code: -32600 });
    const turn = newTurn();
    thread.turns.push(turn);
    saveThread(thread);
    const text = input.map((part) => part.text ?? '').join('\n');
    if (text.includes('[mock:early-approval]')) {
      // 先于 turn/start 的响应发出审批请求，验证客户端在 Run 尚未记录 turn 时也能处理
      const { response } = serverRequest('item/commandExecution/requestApproval', {
        threadId,
        turnId: turn.id,
        itemId: 'early',
        kind: 'command',
        startedAtMs: Date.now(),
        environmentId: null,
        command: 'echo early',
        cwd: thread.cwd,
      });
      void response.then(({ result }) => {
        if (result?.decision === 'accept') writeFileSync(join(thread.cwd, 'early.txt'), 'early\n');
        setImmediate(() => void runTurn(thread, turn, text.replace('[mock:early-approval]', '')));
      });
      return { turn };
    }
    setImmediate(() => void runTurn(thread, turn, text));
    return { turn };
  },
  'turn/interrupt': ({ turnId }) => {
    const ctl = active.get(turnId);
    // 与真实 Codex 一致：turn/started 之前中断会报错
    if (!ctl?.started) throw Object.assign(new Error('no active turn to interrupt'), { code: -32600 });
    ctl.interrupted = true;
    return {};
  },
};

createInterface({ input: process.stdin }).on('line', async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined && message.id !== undefined) {
    serverRequests.get(message.id)?.(message);
    serverRequests.delete(message.id);
    return;
  }
  if (message.id === undefined) return; // 通知，例如 initialized
  const handler = handlers[message.method];
  if (!handler) return send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  try {
    send({ id: message.id, result: await handler(message.params ?? {}) });
  } catch (error) {
    send({ id: message.id, error: { code: error.code ?? -32000, message: error.message } });
  }
});
process.stdin.on('end', () => process.exit(0));
