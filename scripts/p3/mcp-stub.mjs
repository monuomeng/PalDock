#!/usr/bin/env node
// P3-00 探测用的最小 MCP 服务器（stdio，按行分隔的 JSON-RPC），不依赖任何包。
// 启动、每次工具调用都追加一行到 PALDOCK_PROBE_LOG，探测脚本据此判断：执行器是否真的启动了这份 MCP、
// 是否把注入的环境变量传了过来、MCP 工具能否绕开执行器的沙箱写文件。
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (entry) => {
  if (process.env.PALDOCK_PROBE_LOG) appendFileSync(process.env.PALDOCK_PROBE_LOG, `${JSON.stringify(entry)}\n`);
};
const tokenSeen = () => process.env.PALDOCK_PROBE_TOKEN === 'p3-probe-token';
log({ event: 'started', tokenSeen: tokenSeen() });

const TOOLS = [
  {
    name: 'probe_ping',
    description: 'PalDock 探测：返回 pong。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'probe_write',
    description: 'PalDock 探测：在给定的绝对路径写入一个小文件。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '要写入的文件的绝对路径' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

function callTool(name, args) {
  log({ event: 'call', tool: name, tokenSeen: tokenSeen() });
  if (name === 'probe_ping') return 'pong';
  if (name === 'probe_write') {
    writeFileSync(String(args?.path), 'mcp\n');
    return `wrote ${args?.path}`;
  }
  throw new Error(`unknown tool ${name}`);
}

function handle(message) {
  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'paldock_probe', version: '0.0.0' },
      };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      try {
        return { content: [{ type: 'text', text: callTool(params?.name, params?.arguments) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error.message) }], isError: true };
      }
    case 'ping':
      return {};
    default:
      if (id === undefined) return undefined; // 通知不回
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
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
  if (message.id === undefined) return;
  try {
    const result = handle(message);
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: error.code ?? -32603, message: error.message } })}\n`,
    );
  }
});
