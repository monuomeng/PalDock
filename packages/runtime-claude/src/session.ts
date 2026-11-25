/**
 * Claude Code CLI 的 stream-json 会话（P0 探测共用）。子进程使用白名单环境变量：
 * 在 Claude 桌面版或另一个 Claude Code 会话里启动时，继承的 CLAUDE_* 变量会让子进程挂到宿主会话上。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { killProcessTree, readFrames, writeFrame } from '@paldock/platform';

export type Message = Record<string, unknown> & { type: string; subtype?: string };

/** 只传运行所需的系统变量，不继承宿主会话的 CLAUDE_* / ANTHROPIC_*。 */
const CLEAN_ENV_KEYS = ['PATH', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'COMSPEC'];
export const cleanEnv = Object.fromEntries(CLEAN_ENV_KEYS.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])));

/** PATH 上的 claude；否则找 Claude 桌面版自带的最新一份（路径随版本变化，仅供 P0 探测）。 */
export function resolveClaude(): string | undefined {
  if (process.env.PALDOCK_CLAUDE_PATH) return process.env.PALDOCK_CLAUDE_PATH;
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    const candidate = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (dir && existsSync(candidate)) return candidate;
  }
  const root = join(process.env.LOCALAPPDATA ?? '', 'Claude-Data');
  if (!existsSync(root)) return undefined;
  for (const profile of readdirSync(root)) {
    const versions = join(root, profile, 'claude-code');
    if (!existsSync(versions)) continue;
    const latest = readdirSync(versions).sort().at(-1);
    const build = latest && readdirSync(join(versions, latest)).at(0);
    const exe = build && join(versions, latest, build, 'claude.exe');
    if (exe && existsSync(exe)) return exe;
  }
  return undefined;
}

/** 宿主审批：返回 true 批准这次工具调用。探测默认一律拒绝。 */
export type PermissionDecider = (toolName: string, input: Record<string, unknown>) => boolean;
const denyAll: PermissionDecider = () => false;

export class ClaudeSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(m: Message) => void>();
  readonly seen = new Map<string, number>();
  readonly permissionRequests: string[] = [];
  private nextRequest = 0;

  constructor(exe: string, cwd: string, extraArgs: string[] = [], private readonly decide: PermissionDecider = denyAll) {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--strict-mcp-config',
      '--setting-sources', '',
      ...extraArgs,
    ];
    this.child = spawn(exe, args, { cwd, env: cleanEnv, stdio: 'pipe', windowsHide: true });
    this.child.stdin.on('error', () => {});
    readFrames(this.child.stdout, (frame) => this.onMessage(frame as Message), () => {});
  }

  private onMessage(message: Message): void {
    const key = message.subtype ? `${message.type}/${message.subtype}` : message.type;
    this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
    const request = message.request as { subtype?: string; tool_name?: string; input?: Record<string, unknown> } | undefined;
    if (message.type === 'control_request' && request?.subtype === 'can_use_tool') {
      const tool = request.tool_name ?? 'unknown';
      const input = request.input ?? {};
      const allowed = this.decide(tool, input);
      // 只记录工具名和决定，不记录参数
      this.permissionRequests.push(`${tool}:${allowed ? 'allow' : 'deny'}`);
      writeFrame(this.child.stdin, {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'PalDock 探测拒绝了这次操作' },
        },
      });
    }
    for (const listener of this.listeners) listener(message);
  }

  /** 订阅所有输出消息（探测用来统计子代理等事件）。 */
  subscribe(listener: (m: Message) => void): void {
    this.listeners.add(listener);
  }

  waitFor(predicate: (m: Message) => boolean, timeoutMs: number): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error('等待 Claude 消息超时'));
      }, timeoutMs);
      const listener = (m: Message) => {
        if (!predicate(m)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(m);
      };
      this.listeners.add(listener);
    });
  }

  send(text: string): void {
    writeFrame(this.child.stdin, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: '',
    });
  }

  interrupt(): void {
    writeFrame(this.child.stdin, {
      type: 'control_request',
      request_id: `paldock_${++this.nextRequest}`,
      request: { subtype: 'interrupt' },
    });
  }

  dispose(): Promise<void> {
    this.child.stdin.end();
    return killProcessTree(this.child);
  }
}

export const isResult = (m: Message) => m.type === 'result';
