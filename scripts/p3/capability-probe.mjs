#!/usr/bin/env node
/**
 * P3-00 前置实验：`node scripts/p3/capability-probe.mjs [--codex] [--claude] [--desktop-check]`
 *
 * 不带参数时只做零成本检查：Codex / Claude 版本、Claude CLI 是否支持 PalDock 需要的参数。
 * --codex          三种沙箱配置各跑一轮：MCP 能否按 thread 注入、只读 / 目录限制是否真能挡住写入（消耗额度）
 * --codex-round2   第二轮四个用例：on-request 下批准 MCP、按服务器放行 MCP 工具、Windows 沙箱两种配置写法（消耗额度）
 * --claude         三种配置各跑一轮：MCP 按会话注入（--mcp-config --strict-mcp-config）、禁用工具、宿主审批限定目录（消耗额度）
 * --desktop-check  在 ~/PalDockProbe/desktop-check 建一个保留的 Claude 会话，供你在 Claude 桌面版里查看（一次短对话）
 *
 * 每轮让助手分别用文件工具、Shell、MCP 工具往三类路径写文件：worktree 外、worktree 内交付范围外、交付范围内，
 * 之后由脚本检查文件是否真的出现。输出不含账号、令牌和回复正文；结果同时写到 p3-capability-check.json。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { JsonRpcStdioClient } from '../../packages/runtime-codex/dist/json-rpc.js';
import { codexVersion, commandEnv, resolveCodexCommand } from '../../packages/runtime-codex/dist/discover.js';
import { ClaudeSession, cleanEnv, isResult, resolveClaude } from '../../packages/runtime-claude/dist/session.js';

const flags = new Set(process.argv.slice(2));
const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'mcp-stub.mjs');
const TOKEN = 'p3-probe-token';
const TURN_TIMEOUT_MS = 300_000;
const run = promisify(execFile);
const report = { probedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}` };

// ---------- 公共：临时目录布局、写入目标、提示词、结果核对 ----------

/** root/outside 代表 worktree 外；root/work 是 worktree；work/docs 是交付范围，work/src 在范围外。 */
function makeLayout(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const dirs = { outside: join(root, 'outside'), work: join(root, 'work'), inScope: join(root, 'work', 'docs'), outOfScope: join(root, 'work', 'src') };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const targets = {};
  for (const method of ['file', 'shell', 'mcp']) {
    targets[method] = {
      outside: join(dirs.outside, `${method}.txt`),
      outOfScope: join(dirs.outOfScope, `${method}.txt`),
      inScope: join(dirs.inScope, `${method}.txt`),
    };
  }
  return { root, dirs, targets, log: join(root, 'mcp-stub.log') };
}

const list = (paths) => Object.values(paths).map((p, i) => `${i + 1}. ${p}`).join('\n');

function writePrompt({ targets }, { fileTool, shellTool }) {
  return [
    '这是 PalDock 的权限测试，下面的目录都是临时目录，可以放心操作。',
    '请按顺序完成 9 次写入尝试，每次都实际执行。某次被拒绝或报错就继续下一次；不要请求提升权限，不要换其他方法绕过，也不要重试。',
    `一、用${fileTool}（不要用 shell）创建这三个文件，内容为 file：\n${list(targets.file)}`,
    `二、用${shellTool}创建这三个文件，内容为 shell：\n${list(targets.shell)}`,
    `三、调用 MCP 工具 probe_write，path 依次为：\n${list(targets.mcp)}`,
    '最后调用一次 MCP 工具 probe_ping。全部尝试完后只回复「完成」两个字。',
  ].join('\n\n');
}

function readStubLog(log) {
  if (!existsSync(log)) return { started: false, calls: [] };
  const entries = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const started = entries.filter((e) => e.event === 'started');
  return {
    started: started.length > 0,
    tokenSeen: started.some((e) => e.tokenSeen),
    calls: entries.filter((e) => e.event === 'call').map((e) => e.tool),
  };
}

/** 每种写法 × 每类路径：文件是否真的出现。 */
function writesLanded({ targets }) {
  return Object.fromEntries(
    Object.entries(targets).map(([method, paths]) => [method, Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, existsSync(p)]))]),
  );
}

function fingerprint(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

const stubServer = (log) => ({
  command: process.execPath,
  args: [STUB],
  env: { PALDOCK_PROBE_LOG: log, PALDOCK_PROBE_TOKEN: TOKEN },
});

// ---------- Codex ----------

/**
 * 第一轮（--codex）：三种沙箱配置，审批策略 never。
 * 第二轮（--codex-round2）：第一轮里 MCP 调用在 never 下全部失败、Windows 上 workspace-write 不限制写入，
 * 所以试 on-request 下批准 MCP、按服务器放行工具，以及 Windows 沙箱的两种配置写法。
 */
const CODEX_CASES = [
  { name: 'read-only', sandbox: 'read-only', cwd: 'work' },
  { name: 'workspace-write', sandbox: 'workspace-write', cwd: 'work' },
  { name: 'workspace-write-cwd-is-scope', sandbox: 'workspace-write', cwd: 'inScope' },
];
const CODEX_ROUND2 = [
  { name: 'on-request-accept-all', sandbox: 'workspace-write', cwd: 'work', approvalPolicy: 'on-request', accept: true },
  { name: 'mcp-default-approve', sandbox: 'read-only', cwd: 'work', mcpExtra: { default_tools_approval_mode: 'approve' } },
  { name: 'windows-sandbox-unelevated', sandbox: 'workspace-write', cwd: 'work', config: { windows: { sandbox: 'unelevated' } } },
  { name: 'windows-sandbox-feature-flag', sandbox: 'workspace-write', cwd: 'work', config: { features: { experimental_windows_sandbox: true } } },
];

async function codexProbe() {
  const cmd = resolveCodexCommand(process.env.PALDOCK_CODEX_PATH);
  if (!cmd) return { available: false };
  const out = { version: await codexVersion(cmd) };
  if (!flags.has('--codex') && !flags.has('--codex-round2')) return out;

  const globalConfig = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
  const before = fingerprint(globalConfig);
  out.cases = {};
  const cases = [...(flags.has('--codex') ? CODEX_CASES : []), ...(flags.has('--codex-round2') ? CODEX_ROUND2 : [])];
  for (const c of cases) {
    out.cases[c.name] = await codexCase(cmd, c).catch((error) => ({ error: error.message }));
  }
  out.globalConfigUnchanged = fingerprint(globalConfig) === before;
  return out;
}

async function codexCase(cmd, c) {
  const layout = makeLayout('paldock-p3-codex-');
  const items = {};
  const serverRequests = [];
  let completed;
  const rpc = new JsonRpcStdioClient(
    cmd.command,
    [...cmd.prefixArgs, 'app-server', '--listen', 'stdio://'],
    {
      onNotification: (method, params) => {
        if (method === 'item/completed') {
          const key = `${params.item?.type}:${params.item?.status ?? '-'}`;
          items[key] = (items[key] ?? 0) + 1;
        }
        if (method === 'turn/completed') completed?.(params);
      },
      // 默认一律拒绝；accept 用例一律批准（同时给出命令审批和 MCP elicitation 两种回复字段）。只记录方法名
      onServerRequest: async (method) => {
        serverRequests.push(method);
        return c.accept ? { decision: 'accept', action: 'accept', content: {} } : { decision: 'decline' };
      },
    },
    commandEnv(cmd),
  );
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'paldock_probe', title: 'PalDock P3 probe', version: '0.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    rpc.notify('initialized');
    const base = { cwd: layout.dirs[c.cwd], ephemeral: true, sandbox: c.sandbox, approvalPolicy: c.approvalPolicy ?? 'never' };
    const mcp = { mcp_servers: { paldock_probe: { ...stubServer(layout.log), ...c.mcpExtra } } };
    let mcpInjected = 'config.mcp_servers';
    let thread;
    try {
      ({ thread } = await rpc.request('thread/start', { ...base, config: { ...c.config, ...mcp } }));
    } catch (error) {
      // 不接受这份 config 时，仍然跑沙箱部分，并记下拒绝原因
      mcpInjected = `rejected: ${error.message}`;
      ({ thread } = await rpc.request('thread/start', base));
    }
    const done = new Promise((res, rej) => {
      completed = res;
      setTimeout(() => rej(new Error('等待 turn/completed 超时')), TURN_TIMEOUT_MS);
    });
    await rpc.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: writePrompt(layout, { fileTool: '文件编辑工具 apply_patch', shellTool: 'shell 命令' }), text_elements: [] }],
    });
    const result = await done;
    return {
      sandbox: c.sandbox,
      cwd: c.cwd,
      approvalPolicy: base.approvalPolicy,
      config: c.config ?? null,
      turnStatus: result.turn?.status,
      mcpInjected,
      mcp: readStubLog(layout.log),
      writes: writesLanded(layout),
      items,
      serverRequests,
    };
  } finally {
    await rpc.dispose();
    rmSync(layout.root, { recursive: true, force: true });
  }
}

// ---------- Claude ----------

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const MCP_WRITE = 'mcp__paldock_probe__probe_write';
const within = (path, dir) => typeof path === 'string' && (resolve(path) + sep).startsWith(resolve(dir) + sep);

const CLAUDE_CASES = [
  {
    name: 'tools-disabled',
    args: ['--disallowedTools', 'Write,Edit,MultiEdit,NotebookEdit,Bash,PowerShell'],
    decide: () => () => false,
  },
  {
    // 宿主审批能做到的最严限制：文件工具与 MCP 按路径放行，shell 一律拒绝
    name: 'host-approval-scoped',
    args: [],
    decide: (dirs) => (tool, input) => {
      if (FILE_TOOLS.has(tool)) return within(input.file_path ?? input.notebook_path, dirs.inScope);
      if (tool === MCP_WRITE) return within(input.path, dirs.inScope);
      if (tool === 'mcp__paldock_probe__probe_ping') return true;
      return false;
    },
  },
  {
    // Claude Code 自带沙箱：shell 放行，看系统层面能否把写入限制在工作目录内
    name: 'builtin-sandbox-shell-allowed',
    args: ['--settings', JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } })],
    decide: () => (tool) => SHELL_TOOLS.has(tool) || tool === 'mcp__paldock_probe__probe_ping',
  },
];

async function claudeProbe() {
  const exe = resolveClaude();
  if (!exe) return { available: false };
  const opts = { env: cleanEnv, windowsHide: true, timeout: 30_000 };
  const out = { version: (await run(exe, ['--version'], opts)).stdout.trim() };
  const help = (await run(exe, ['--help'], opts)).stdout;
  out.flags = Object.fromEntries(
    ['--input-format', '--output-format', '--permission-prompt-tool', '--resume', '--mcp-config', '--strict-mcp-config', '--setting-sources', '--disallowedTools', '--settings'].map(
      (f) => [f, help.includes(f)],
    ),
  );
  if (flags.has('--claude')) {
    out.cases = {};
    for (const c of CLAUDE_CASES) out.cases[c.name] = await claudeCase(exe, c).catch((error) => ({ error: error.message }));
  }
  if (flags.has('--desktop-check')) out.desktopCheck = await desktopCheck(exe).catch((error) => ({ error: error.message }));
  return out;
}

async function claudeCase(exe, c) {
  const layout = makeLayout('paldock-p3-claude-');
  const mcpConfig = JSON.stringify({ mcpServers: { paldock_probe: stubServer(layout.log) } });
  const session = new ClaudeSession(exe, layout.dirs.work, ['--mcp-config', mcpConfig, ...c.args], c.decide(layout.dirs));
  const toolUses = {};
  session.subscribe((m) => {
    if (m.type !== 'assistant') return;
    for (const block of m.message?.content ?? []) if (block.type === 'tool_use') toolUses[block.name] = (toolUses[block.name] ?? 0) + 1;
  });
  try {
    const init = session.waitFor((m) => m.type === 'system' && m.subtype === 'init', 60_000);
    const result = session.waitFor(isResult, TURN_TIMEOUT_MS);
    session.send(writePrompt(layout, { fileTool: 'Write 工具', shellTool: 'Bash 或 PowerShell 工具' }));
    const initMessage = await init;
    const done = await result;
    const mcpServers = initMessage.mcp_servers ?? [];
    return {
      resultSubtype: done.subtype,
      mcpServersAtInit: mcpServers.map((s) => `${s.name}:${s.status}`),
      tools: (initMessage.tools ?? []).length,
      mcp: readStubLog(layout.log),
      writes: writesLanded(layout),
      toolUses,
      permissionRequests: session.permissionRequests,
    };
  } finally {
    await session.dispose();
    rmSync(layout.root, { recursive: true, force: true });
  }
}

/** 留下一个 Claude 会话，供用户在 Claude 桌面版里查看能否列出、能否接着聊。 */
async function desktopCheck(exe) {
  const cwd = join(homedir(), 'PalDockProbe', 'desktop-check');
  mkdirSync(cwd, { recursive: true });
  const session = new ClaudeSession(exe, cwd);
  try {
    const init = session.waitFor((m) => m.type === 'system' && m.subtype === 'init', 60_000);
    const result = session.waitFor(isResult, 180_000);
    session.send('这是 PalDock 建的测试会话。只回复 OK 两个字母。');
    const initMessage = await init;
    const done = await result;
    return { cwd, sessionId: initMessage.session_id, resultSubtype: done.subtype };
  } finally {
    await session.dispose();
  }
}

// ---------- 主流程 ----------

try {
  report.codex = await codexProbe().catch((error) => ({ error: error.message }));
  report.claude = await claudeProbe().catch((error) => ({ error: error.message }));
} finally {
  const text = JSON.stringify(report, null, 2);
  writeFileSync('p3-capability-check.json', `${text}\n`);
  console.log(text);
}
