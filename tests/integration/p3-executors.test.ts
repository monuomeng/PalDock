/**
 * P3-02 验收（离线）：本地服务同时接入模拟 Codex 与模拟 Claude，子任务按角色在项目里的执行器选用，
 * 改默认执行器、按项目覆盖都生效；能力检查不通过时不启动执行器，子任务阻塞并写明原因。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalService } from '@paldock/local-service';
import type { AgentSettings, CommandArgsOf, CommandName, TaskDetail } from '@paldock/contracts';
import { IpcClient, createIpcPath, createToken } from '@paldock/platform';
import { ClaudeAdapter, MOCK_CLAUDE_PATH } from '@paldock/runtime-claude';
import { CodexAdapter, MOCK_APP_SERVER_PATH } from '@paldock/runtime-codex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let root: string;
let repo: string;
let service: LocalService | undefined;
let client: IpcClient;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8' });

async function startService(claudeEnv: Record<string, string> = {}) {
  const dataRoot = join(root, 'data');
  const ipcPath = createIpcPath(dataRoot);
  const token = createToken();
  service = await LocalService.start({
    dataRoot,
    ipcPath,
    token,
    runtimes: {
      codex: new CodexAdapter({ configuredPath: MOCK_APP_SERVER_PATH, extraEnv: { MOCK_CODEX_HOME: join(root, 'codex-home') } }),
      claude: new ClaudeAdapter({ configuredPath: MOCK_CLAUDE_PATH, configDir: join(root, 'claude-home'), extraEnv: claudeEnv }),
    },
    limits: { confirmIntervalMs: 50, expiryScanMs: 50, outputCheckpointMs: 50 },
  });
  client = new IpcClient(() => {}, () => {});
  await client.connect(ipcPath, token);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'paldock-p3-'));
  repo = join(root, 'repo');
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
});
afterEach(async () => {
  await client?.close();
  await service?.stop();
  service = undefined;
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const call = <N extends CommandName>(name: N, args: CommandArgsOf<N>) => client.request(name, args);
let seq = 0;
const create = (goal: string) => call('task.create', { rootPath: repo, goal, idempotencyKey: `p3-${++seq}-${Date.now()}` }) as Promise<TaskDetail>;
async function settled(taskId: string): Promise<TaskDetail> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const d = (await call('task.get', { taskId })) as TaskDetail;
    if (d.subtask.status === 'review' || d.subtask.status === 'blocked') return d;
    if (Date.now() > deadline) throw new Error(`等待超时：${d.subtask.status}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe('P3 按角色选执行器', () => {
  it('开发助手默认用 Claude；改成 Codex 后新任务用 Codex；项目覆盖优先于默认', async () => {
    await startService();
    const first = await settled((await create('第一件事')).task.id);
    expect(first.subtask.status).toBe('review');
    expect(first.runs.at(-1)!.run.runtime).toBe('claude');

    const settings = (await call('agent.settings', {})) as AgentSettings;
    const dev = settings.agents.find((a) => a.profile.role === 'developer')!;
    expect(dev.check).toMatchObject({ ok: true });
    expect(settings.runtimes.map((r) => r.runtime)).toEqual(['codex', 'claude']);
    await call('agent.setExecutor', { role: 'developer', expectedVersion: dev.profile.version, executor: 'codex' });
    const second = await settled((await create('第二件事')).task.id);
    expect(second.runs.at(-1)!.run.runtime).toBe('codex');

    await call('agent.setOverride', { workspaceId: second.workspace.id, role: 'developer', executor: 'claude' });
    const third = await settled((await create('第三件事')).task.id);
    expect(third.runs.at(-1)!.run.runtime).toBe('claude');
  });

  it('执行器不可用（Claude 未登录）时不启动，子任务阻塞并写明原因', async () => {
    await startService({ MOCK_CLAUDE_LOGGED_OUT: '1' });
    const settings = (await call('agent.settings', {})) as AgentSettings;
    expect(settings.agents.find((a) => a.profile.role === 'developer')!.check).toMatchObject({ ok: false, problems: [expect.stringContaining('未登录')] });
    const blocked = await settled((await create('做不了')).task.id);
    expect(blocked.subtask.status).toBe('blocked');
    expect(blocked.subtask.statusReason).toMatch(/开发助手不能用 claude.*未登录/);
  });
});
