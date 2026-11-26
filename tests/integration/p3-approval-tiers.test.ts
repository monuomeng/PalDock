/**
 * 项目外只读访问的审批分层（2026-11-26 已定，0.3.7）。离线，模拟执行器，真实文件系统。
 * - 助手这一轮自己生成的文件：自动放行（approval.auto）；
 * - 敏感路径：只能你批，「允许一次」可用；协调助手不能批；
 * - 其余当前「只能拒绝」的权限扩展：你可以「允许一次」；
 * - 其余项目外只读：交协调助手判断（approval.coordinator），不能自批；拿不准或超时回到你这里；
 * - 同一次 Run 短时间内的审批合成一组，外部渠道只发一条。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelNotifier, CoordinatorService, PlanService, RunSupervisor, TaskGraphScheduler, TaskService, McpGateway, IntegrationService } from '@paldock/application';
import type { Card, MainSessionRecord, PersistentEvent, RunStartRequest, RuntimeAdapter, RuntimeApprovalRequest, RuntimeEvent } from '@paldock/contracts';
import { P2_DEFAULTS } from '@paldock/domain';
import { openStore, type Store } from '@paldock/storage-sqlite';
import { afterEach, describe, expect, it } from 'vitest';

interface FakeRun {
  request: RunStartRequest;
  ask(request: Omit<RuntimeApprovalRequest, 'nativeRequestId'>): Promise<string>;
  succeed(): void;
}

class FakeRuntime implements RuntimeAdapter {
  readonly name = 'claude';
  readonly runs: FakeRun[] = [];
  async discover() {
    const capabilities = { resume: true, streaming: true, approvals: true, cancel: true, workingDirectoryRestriction: false, attachments: false };
    return { runtime: this.name, available: true, capabilities };
  }
  async start(request: RunStartRequest, onEvent: (event: RuntimeEvent) => void) {
    const decisions = new Map<string, (decision: string) => void>();
    let ended = false;
    const run: FakeRun = {
      request,
      ask: (what) =>
        new Promise<string>((resolve) => {
          const id = `perm_${Math.random()}`;
          decisions.set(id, resolve);
          onEvent({ type: 'approval_request', request: { ...what, nativeRequestId: id } });
        }),
      succeed: () => {
        if (ended) return;
        ended = true;
        onEvent({ type: 'completed', finalMessage: '完成' });
      },
    };
    this.runs.push(run);
    setImmediate(() => {
      onEvent({ type: 'thread', threadId: `thr_${request.runId}` });
      onEvent({ type: 'turn', turnId: `turn_${request.runId}` });
    });
    return {
      respondApproval: (id: string, decision: string) => decisions.get(id)?.(decision),
      cancel: async () => {
        ended = true;
        onEvent({ type: 'interrupted' });
      },
      dispose: async () => {},
    };
  }
  async checkTurn() {
    return { status: 'not_found' as const };
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

let root: string;
let repo: string;
let outside: string;
let store: Store;
let runtime: FakeRuntime;
let supervisor: RunSupervisor;
let plans: PlanService;
let tasks: TaskService;
let coordinator: CoordinatorService;
let gateway: McpGateway;
let workspaceId: string;
let main: MainSessionRecord;
let coordinatorRun: string;
const logs: string[] = [];

async function setup(limits: { coordinatorApprovalMs?: number } = {}) {
  root = mkdtempSync(join(tmpdir(), 'paldock-tiers-'));
  repo = join(root, 'repo');
  outside = join(root, 'outside');
  const dataRoot = join(root, 'data');
  for (const d of [repo, outside, dataRoot]) mkdirSync(d);
  // 项目外、在 Run 开始前就有的文件（不是这一轮生成的）
  writeFileSync(join(outside, 'reference.png'), 'old');
  writeFileSync(join(outside, 'other.png'), 'old');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  store = await openStore(':memory:');
  runtime = new FakeRuntime();
  let scheduler!: TaskGraphScheduler;
  const publish = (events: PersistentEvent[]) => scheduler.onEvents(events);
  const log = (message: string) => logs.push(message);
  gateway = new McpGateway({ store, publish, plans: () => plans, coordinator: () => coordinator });
  supervisor = new RunSupervisor({ store, runtimes: { claude: runtime }, dataRoot, publish, publishEphemeral: () => {}, log, coordinatorApprovals: true, limits });
  scheduler = new TaskGraphScheduler({ store, supervisor, publish, log });
  plans = new PlanService({ store, scheduler, publish });
  const integration = new IntegrationService({ store, supervisor, dataRoot, publish, log });
  tasks = new TaskService({ store, supervisor, scheduler, integration, dataRoot, publish });
  coordinator = new CoordinatorService({ store, supervisor, publish, log });
  workspaceId = store.tasks.ensureWorkspace('repo', repo).id;
  main = store.coordinator.createMainSession(workspaceId, '主会话').record;
  coordinatorRun = store.runs.createRun({ subtaskId: store.tasks.getSubtaskOfTask(main.taskId)!.id, sessionId: main.sessionId, runtime: 'claude' }).record.id;
}

afterEach(async () => {
  await supervisor?.stop();
  plans?.stop();
  store?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  logs.length = 0;
});

async function startNode(): Promise<FakeRun> {
  const caller = gateway.authenticate(gateway.issue(coordinatorRun, 'coordinator', 60_000))!;
  const { planId } = gateway.call(caller, 'propose_plan', { title: '比对截图', goal: 'g', nodes: [{ key: 't', role: 'tester', title: '比对', goal: '比对截图' }] }) as { planId: string };
  await plans.confirm(planId, store.plans.getPlan(planId)!.version);
  return until(() => runtime.runs[0], (r) => r !== undefined, '节点开始');
}

async function until<T>(read: () => T, ok: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}（当前 ${JSON.stringify(value)}；日志 ${logs.join(' / ')}）`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const read = (path: string) => ({ kind: 'permissions' as const, summary: `读取（Read）：${path}`, readPaths: [path] });
const pending = () => store.db.all<{ id: string; risk_level: string; sensitive: number; routed_to: string | null; group_id: string | null; access: string | null; version: number }>(
  `SELECT id, risk_level, sensitive, routed_to, group_id, access, version FROM approvals WHERE status = 'pending' ORDER BY requested_at, rowid`,
);
const audit = (action: string) => store.db.all<{ result: string }>(`SELECT result FROM audit_log WHERE action = ? ORDER BY id`, action).map((r) => r.result);

describe('项目外只读的审批分层', () => {
  it('助手这一轮自己生成的文件（Run 开始后在项目外新建）：自动放行，记 approval.auto', async () => {
    await setup();
    const run = await startNode();
    const shot = join(outside, 'snake_smoke', '2_menu_color.png');
    mkdirSync(join(outside, 'snake_smoke'));
    writeFileSync(shot, 'png');
    expect(await run.ask(read(shot))).toBe('allow_once');
    expect(audit('approval.auto')).toContain('allow:read_own_output');
    expect(pending()).toHaveLength(0);
  });

  it('敏感路径：高风险、只能你批；「允许一次」可用；协调助手不能批', async () => {
    await setup();
    const run = await startNode();
    const answer = run.ask(read(join(homedir(), '.ssh', 'id_ed25519')));
    const [a] = await until(pending, (p) => p.length === 1, '待审批');
    expect(a).toMatchObject({ risk_level: 'high', sensitive: 1, routed_to: null, access: 'read' });
    expect(() => coordinator.decideApproval(coordinatorRun, a!.id, 'allow', '看起来需要')).toThrow(/没有交给你判断/);
    tasks.decideApproval(a!.id, a!.version, 'allow_once');
    expect(await answer).toBe('allow_once');
  });

  it('其余权限扩展（以前只能拒绝）：你可以「允许一次」，按钮不再是灰的', async () => {
    await setup();
    const run = await startNode();
    const answer = run.ask({ kind: 'permissions', summary: '使用工具 WebFetch', detail: '{"url":"https://example.com"}' });
    const [a] = await until(pending, (p) => p.length === 1, '待审批');
    expect(a).toMatchObject({ risk_level: 'high', routed_to: null, access: null });
    tasks.decideApproval(a!.id, a!.version, 'allow_once');
    expect(await answer).toBe('allow_once');
  });

  it('非敏感的项目外只读：交协调助手判断，allow 记 approval.coordinator；发起读取的 Run 不能自批', async () => {
    await setup();
    const run = await startNode();
    const answer = run.ask(read(join(outside, 'reference.png')));
    const [a] = await until(pending, (p) => p.length === 1, '待审批');
    expect(a).toMatchObject({ risk_level: 'medium', routed_to: 'coordinator', sensitive: 0 });
    expect(() => coordinator.decideApproval(run.request.runId, a!.id, 'allow', '我自己批')).toThrow();
    expect(coordinator.decideApproval(coordinatorRun, a!.id, 'allow', '要和参考图比对')).toMatchObject({ status: 'approved' });
    expect(await answer).toBe('allow_once');
    expect(audit('approval.coordinator')).toEqual(['allow: 要和参考图比对']);
    expect(store.runs.getApproval(a!.id)!.decidedVia).toBe('coordinator');
  });

  it('协调助手拿不准：交回给你；它超时没答复也交回给你', async () => {
    await setup({ coordinatorApprovalMs: 200 });
    const run = await startNode();
    void run.ask(read(join(outside, 'reference.png')));
    const [a] = await until(pending, (p) => p.length === 1, '待审批');
    coordinator.decideApproval(coordinatorRun, a!.id, 'unsure', '不确定是不是这张');
    expect(store.runs.getApproval(a!.id)!.routedTo).toBeNull();
    // 第二个：没人答复，超时后交回
    void run.ask(read(join(outside, 'other.png')));
    const b = await until(pending, (p) => p.length === 2, '第二个').then((p) => p[1]!);
    expect(b.routed_to).toBe('coordinator');
    await until(() => store.runs.getApproval(b.id)!.routedTo, (r) => r === null, '超时交回');
  });

  it('交给协调助手时唤醒提出这个任务的主会话，唤醒内容带审批编号和路径', async () => {
    await setup();
    const run = await startNode();
    void run.ask(read(join(outside, 'reference.png')));
    const [a] = await until(pending, (p) => p.length === 1, '待审批');
    coordinator.onEvents(store.events.since(0, 1000).filter((e) => e.type === 'approval.requested' && e.aggregateId === a!.id));
    const wake = store.coordinator.nextPendingWake(main.sessionId);
    expect(wake?.summary).toContain(a!.id);
    expect(wake?.summary).toContain('reference.png');
  });
});

describe('同一次 Run 的审批合成一组', () => {
  it('4 个同时到达的请求：同一组；外部渠道只发 1 条合并消息', async () => {
    await setup();
    const run = await startNode();
    for (let i = 1; i <= 4; i++) void run.ask({ kind: 'permissions', summary: `使用工具 WebFetch ${i}` });
    const items = await until(pending, (p) => p.length === 4, '4 个待审批');
    expect(new Set(items.map((i) => i.group_id)).size).toBe(1);
    // 外部渠道：绑定一个单聊，桌面没人看时升级
    const sent: Card[] = [];
    const dm = { provider: 'telegram' as const, account: 'bot', tenant: '', chatId: 'c1', threadKey: '', kind: 'dm' as const };
    const account = store.channels.upsertAccount(dm, 'u1', '我');
    if (account.status !== 'active') store.channels.setAccountStatus(account.id, account.version, 'active');
    store.channels.upsertConversation(dm, account.id, '我');
    const notifier = new ChannelNotifier({
      store,
      publish: () => {},
      send: (_c, card) => sent.push(card),
      presence: () => ({ uiRunning: false, locked: false, idle: false }),
      attached: () => true,
      now: () => new Date(Date.now() + 5_000),
      limits: P2_DEFAULTS,
    });
    notifier.escalate();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('电脑上有 4 个审批等你处理');
    notifier.escalate();
    expect(sent).toHaveLength(1);
  });

  it('外部渠道：权限扩展、敏感路径的读取按远程审批等级——L2 能远程「允许一次」，L1 只能拒绝并说明原因', async () => {
    await setup();
    const run = await startNode();
    void run.ask(read(join(homedir(), '.ssh', 'id_ed25519')));
    await until(pending, (p) => p.length === 1, '待审批');
    const dm = { provider: 'telegram' as const, account: 'bot', tenant: '', chatId: 'c1', threadKey: '', kind: 'dm' as const };
    const account = store.channels.upsertAccount(dm, 'u1', '我');
    if (account.status !== 'active') store.channels.setAccountStatus(account.id, account.version, 'active');
    store.channels.upsertConversation(dm, account.id, '我');
    const escalate = (level: 'L1' | 'L2') => {
      const ws = store.tasks.getWorkspace(workspaceId)!;
      store.tasks.setRemoteApprovalLevel(ws.id, ws.version, level);
      store.db.run(`UPDATE approvals SET escalated_at = NULL`);
      const sent: Card[] = [];
      new ChannelNotifier({
        store,
        publish: () => {},
        send: (_c, card) => sent.push(card),
        presence: () => ({ uiRunning: false, locked: false, idle: false }),
        attached: () => true,
        now: () => new Date(Date.now() + 5_000),
        limits: P2_DEFAULTS,
      }).escalate();
      return sent[0]!;
    };
    const l1 = escalate('L1');
    expect(l1.buttons).toHaveLength(0);
    expect(l1.lines.join('\n')).toMatch(/远程审批等级是 L1.*只能拒绝.*调到 L2/);
    const l2 = escalate('L2');
    expect(l2.buttons.map((b) => b.label)).toEqual(['批准本次', '拒绝']);
  });
});
