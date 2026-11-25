#!/usr/bin/env node
// PalDock MCP 桥：执行器（Codex / Claude Code）按会话启动的 stdio MCP 服务器，经本机 IPC 连回本地服务。
// 只做协议转换：MCP tools/list、tools/call ↔ 服务的 mcp_list、mcp_call。工具列表、身份、权限全在服务端按令牌决定。
// 不依赖任何包（执行器用 Node 或 Electron 的 Node 模式直接运行这个文件）。
//
// 环境变量：PALDOCK_IPC_PATH（本地服务的管道 / 套接字）、PALDOCK_MCP_TOKEN（这次 Run 的一次性令牌）。
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

const SCHEMA_VERSION = 1;
const ipcPath = process.env.PALDOCK_IPC_PATH;
const token = process.env.PALDOCK_MCP_TOKEN;
if (!ipcPath || !token) {
  process.stderr.write('PalDock MCP 桥缺少 PALDOCK_IPC_PATH 或 PALDOCK_MCP_TOKEN\n');
  process.exit(1);
}

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });

// ---- 与本地服务的连接 ----
let nextId = 0;
const pending = new Map();
let welcomed;
const ready = new Promise((resolve, reject) => (welcomed = { resolve, reject }));
const socket = connect(ipcPath);
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(`${JSON.stringify({ kind: 'mcp_hello', schemaVersion: SCHEMA_VERSION, token })}\n`));
socket.on('error', () => {});
socket.on('close', () => {
  welcomed.reject(new Error('PalDock 拒绝了连接或已关闭'));
  for (const { reject } of pending.values()) reject(new Error('与 PalDock 的连接已断开'));
  pending.clear();
  // 服务不在了，工具都不可用；退出让执行器把这个服务器标为断开
  setTimeout(() => process.exit(1), 50);
});
let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (frame.kind === 'welcome') welcomed.resolve();
    else if (frame.kind === 'result' && pending.has(frame.id)) {
      const { resolve, reject } = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.ok) resolve(frame.value);
      else reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
    }
  }
});

async function request(frame) {
  await ready;
  const id = `m${++nextId}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.write(`${JSON.stringify({ ...frame, id })}\n`);
  });
}

// ---- MCP（stdio，按行分隔的 JSON-RPC）----
async function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'paldock', version: '0.1.0' },
        instructions: 'PalDock 的编排工具：先用 get_task 读任务，完成后用 submit_result 交接。',
      });
    case 'tools/list':
      return reply(id, { tools: await request({ kind: 'mcp_list' }) });
    case 'tools/call':
      try {
        const value = await request({ kind: 'mcp_call', tool: String(params?.name ?? ''), args: params?.arguments ?? {} });
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value } });
      } catch (error) {
        // 业务拒绝（无权限、参数错、已提交过）作为工具结果返回，让助手看到原因
        return reply(id, { content: [{ type: 'text', text: error.message }], isError: true });
      }
    case 'ping':
      return reply(id, {});
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || message.id === null) return; // 通知不回
  handle(message).catch((error) => fail(message.id, -32603, error.message));
});
process.stdin.on('end', () => {
  socket.end();
  process.exit(0);
});
