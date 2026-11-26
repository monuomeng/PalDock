/**
 * P3-03 验收（离线）：MCP 桥按 Run 签发一次性令牌、按角色暴露工具、拒绝越权并写审计；
 * 模拟 Claude 像真实 CLI 一样按 --mcp-config 启动桥，经本机 IPC 调到本地服务。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpGateway } from '@paldock/application';
import type { CommandArgsOf, CommandName, TaskDetail } from '@paldock/contracts';
import { LocalService } from '@paldock/local-service';
import { IpcClient, createIpcPath, createToken } from '@paldock/platform';
import { ClaudeAdapter, MOCK_CLAUDE_PATH } from '@paldock/runtime-claude';
import { openStore, type Store } from '@paldock/storage-sqlite';
import { afterEach, describe, expect, it } from 'vitest';

describe('MCP 网关', () => {
  let store: Store;
  afterEach(() => store?.close());

  async function seedRun() {
    let clock = Date.parse('2026-11-25T08:00:00Z');
    store = await openStore(':memory:');
    const ws = store.tasks.ensureWorkspace('demo', 'D:/demo');
    const { subtask, session } = store.tasks.createTask({
      workspaceId: ws.id,
      title: '加记住我',
      goal: '实现记住我',
      role: 'developer',
      checkCommand: null,
      checkConfirmed: false,
      idempotencyKey: 'k',
    }).record;
    const run = store.runs.createRun({ subtaskId: subtask.id, sessionId: session.id, runtime: 'claude' }).record;
    const gateway = new McpGateway({ store, publish: () => {}, now: () => clock });
    return { run, gateway, advance: (ms: number) => (clock += ms) };
  }
  const audit = () => store.db.all<{ actor: string; action: string; result: string }>('SELECT actor, action, result FROM audit_log ORDER BY id');

  it('令牌只认签发的那次 Run 和角色；错误、过期、作废的令牌一律拒绝并审计', async () => {
    const { run, gateway, advance } = await seedRun();
    const token = gateway.issue(run.id, 'developer', 60_000);
    const caller = gateway.authenticate(token)!;
    expect(caller).toEqual({ runId: run.id, role: 'developer' });
    expect(gateway.list(caller).map((t) => t.name)).toEqual(['get_task', 'submit_result', 'write_summary']);
    expect(gateway.call(caller, 'get_task', {})).toMatchObject({ goal: '实现记住我', role: { name: 'developer', displayName: '开发助手' }, checkCommand: null });

    expect(gateway.authenticate(createToken())).toBeUndefined();
    expect(() => gateway.call(caller, 'get_status', {})).toThrow(/不能调用/);
    expect(() => gateway.call(caller, 'write_file', {})).toThrow(/没有工具/);
    expect(() => gateway.call(caller, 'submit_result', { summary: '' })).toThrow();

    advance(61_000);
    expect(() => gateway.call(caller, 'get_task', {})).toThrow(/已作废/);
    expect(gateway.authenticate(token)).toBeUndefined();

    const fresh = gateway.issue(run.id, 'developer', 60_000);
    gateway.revoke(run.id);
    expect(gateway.authenticate(fresh)).toBeUndefined();

    expect(audit().map((a) => `${a.action}:${a.result}`)).toEqual([
      'mcp.get_task:ok',
      'mcp.hello:denied:invalid_token',
      'mcp.get_status:denied:role',
      'mcp.write_file:denied:unknown_tool',
      'mcp.submit_result:denied:invalid_args',
      'mcp.get_task:denied:revoked',
      'mcp.hello:denied:expired',
      'mcp.hello:denied:invalid_token',
    ]);
  });

  it('协调助手只看到协调工具；交接记录每次 Run 只收一份', async () => {
    const { run, gateway } = await seedRun();
    const coordinator = gateway.authenticate(gateway.issue(run.id, 'coordinator', 60_000))!;
    expect(gateway.list(coordinator).map((t) => t.name)).toEqual(['notify_user', 'decide_approval', 'write_summary', 'get_status', 'propose_plan', 'propose_commit', 'propose_push', 'propose_merge']);
    expect(gateway.call(coordinator, 'get_status', {})).toEqual([expect.objectContaining({ title: '加记住我' })]);
    // 只看调用方所在的项目：别的项目的任务不给
    const other = store.tasks.ensureWorkspace('other', 'D:/other');
    store.tasks.createTask({ workspaceId: other.id, title: '别的项目', goal: 'x', role: 'developer', checkCommand: null, checkConfirmed: false, idempotencyKey: 'k2' });
    expect((gateway.call(coordinator, 'get_status', {}) as { title: string }[]).map((t) => t.title)).toEqual(['加记住我']);
    expect(gateway.call(gateway.authenticate(gateway.issue('run_missing', 'coordinator', 60_000))!, 'get_status', {})).toEqual([]);

    const dev = gateway.authenticate(gateway.issue(run.id, 'developer', 60_000))!;
    expect(gateway.call(dev, 'submit_result', { summary: '改好了', notes: '跑过测试' })).toMatchObject({ handoffId: run.id });
    expect(() => gateway.call(dev, 'submit_result', { summary: '再交一次' })).toThrow(/已经提交过/);
    expect(store.runs.getHandoff(run.id)).toMatchObject({ summary: '改好了', notes: '跑过测试' });
  });
});

describe('MCP 桥端到端（模拟 Claude）', () => {
  let root: string;
  let service: LocalService | undefined;
  let client: IpcClient | undefined;
  afterEach(async () => {
    await client?.close();
    await service?.stop();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it('执行器按会话启动桥，专业助手能读任务、交接一次，越权调用被拒绝', async () => {
    root = mkdtempSync(join(tmpdir(), 'paldock-p3-mcp-'));
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    const dataRoot = join(root, 'data');
    mkdirSync(dataRoot);
    const ipcPath = createIpcPath(dataRoot);
    const token = createToken();
    service = await LocalService.start({
      dataRoot,
      ipcPath,
      token,
      runtime: new ClaudeAdapter({ configuredPath: MOCK_CLAUDE_PATH, configDir: join(root, 'claude-home') }),
    });
    client = new IpcClient(() => {}, () => {});
    await client.connect(ipcPath, token);
    const call = <N extends CommandName>(name: N, args: CommandArgsOf<N>) => client!.request(name, args);

    const created = (await call('task.create', { rootPath: repo, goal: '[mock:mcp] 加一个功能', idempotencyKey: 'mcp-bridge-1' })) as TaskDetail;
    let detail = created;
    for (const deadline = Date.now() + 15_000; detail.subtask.status !== 'review' && detail.subtask.status !== 'blocked'; ) {
      if (Date.now() > deadline) throw new Error(`等待超时：${detail.subtask.status}`);
      await new Promise((r) => setTimeout(r, 50));
      detail = (await call('task.get', { taskId: created.task.id })) as TaskDetail;
    }
    expect(detail.subtask.status).toBe('review');
    const final = detail.runs.at(-1)!.result?.finalMessage ?? '';
    expect(JSON.parse(final)).toEqual({
      server: 'paldock',
      allowed: 'mcp__paldock',
      tools: ['get_task', 'submit_result', 'write_summary'],
      goal: '[mock:mcp] 加一个功能',
      submitted: true,
      resubmitDenied: true,
      statusDenied: true,
    });
  });
});
