/**
 * P3-10 验收（离线）：外部渠道的普通消息进协调助手主会话；对编号问题的三种回复识别与拿不准时交给协调助手；
 * 协调助手的回复与外部发起任务的完成汇总经 outbox 发回；确定性命令照旧；计划确认卡片受远程审批等级约束。
 * 渠道用 P2 的假适配器（冒用飞书），执行器是测试里可控的模拟；组件按本地服务的接法手工装配。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChannelService,
  CoordinatorService,
  IntegrationService,
  McpGateway,
  PlanService,
  ReviewGate,
  RunSupervisor,
  TaskGraphScheduler,
  TaskService,
  type ChannelCredential,
  type CredentialPort,
} from '@paldock/application';
import type { Card, ChannelAdapter, ChannelAddress, ChannelSink, InboundEnvelope, PersistentEvent, RunStartRequest, RuntimeAdapter, RuntimeEvent } from '@paldock/contracts';
import { openStore, type Store } from '@paldock/storage-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

class FakeAdapter implements ChannelAdapter {
  readonly provider = 'feishu' as const;
  readonly account = 'cli_test';
  sink: ChannelSink | undefined;
  readonly sent: { chatId: string; card: Card; ref: string }[] = [];
  readonly edits: { ref: string; card: Card }[] = [];
  async start(sink: ChannelSink) {
    this.sink = sink;
    sink.state('connected');
  }
  async stop() {
    this.sink = undefined;
  }
  async send(address: ChannelAddress, card: Card) {
    const ref = `om_${this.sent.length + 1}`;
    this.sent.push({ chatId: address.chatId, card, ref });
    return ref;
  }
  async edit(_address: ChannelAddress, ref: string, card: Card) {
    this.edits.push({ ref, card });
  }
  inbound(user: string, body: InboundEnvelope['body']) {
    const address: ChannelAddress = { provider: 'feishu', account: this.account, tenant: 't1', chatId: `oc_${user}`, threadKey: '', kind: 'dm' };
    this.sink!.inbound({ eventId: randomUUID(), address, sender: { externalId: `ou_${user}`, displayName: user }, body });
  }
  say(user: string, text: string, replyTo?: string) {
    this.inbound(user, { kind: 'text', text, mentionsBot: false, ...(replyTo ? { replyTo } : {}) });
  }
  click(user: string, token: string) {
    this.inbound(user, { kind: 'action', token });
  }
  cards(): Card[] {
    return [...this.sent.map((s) => s.card), ...this.edits.map((e) => e.card)];
  }
}

class MemoryCredentials implements CredentialPort {
  readonly map = new Map<string, ChannelCredential>();
  async read(target: string) {
    return this.map.get(target);
  }
  async write(target: string, credential: ChannelCredential) {
    this.map.set(target, credential);
  }
  async remove(target: string) {
    this.map.delete(target);
  }
}

interface FakeRun {
  request: RunStartRequest;
  title: string;
  ended: boolean;
  call(tool: string, args?: unknown): unknown;
  succeed(text?: string, files?: Record<string, string>): void;
}

/** 协调助手、开发助手的 Run 由测试结束；审阅 Run 自动交「通过」。 */
class FakeRuntime implements RuntimeAdapter {
  readonly name = 'claude';
  readonly runs: FakeRun[] = [];
  gateway!: McpGateway;
  async discover() {
    const capabilities = { resume: true, streaming: true, approvals: true, cancel: true, workingDirectoryRestriction: false, attachments: false };
    return { runtime: this.name, available: true, capabilities };
  }
  async start(request: RunStartRequest, onEvent: (event: RuntimeEvent) => void) {
    const review = /请审阅子任务「(.+?)」/.test(request.prompt);
    const title = review ? '审阅' : (request.instructions?.includes('协调助手') || /^(用户说：|任务事件)/.test(request.prompt)) ? '协调' : (/你负责的子任务：(.+)/.exec(request.prompt)?.[1] ?? '?');
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const run: FakeRun = {
      request,
      title,
      ended: false,
      call: (tool, args = {}) => this.gateway.call(this.gateway.authenticate(request.mcpServer!.env.PALDOCK_MCP_TOKEN!)!, tool, args),
      succeed: (text = `${title} 完成`, files = {}) => {
        if (run.ended) return;
        run.ended = true;
        for (const [path, content] of Object.entries(files)) writeFileSync(join(request.cwd, path), content);
        void ready.then(() => onEvent({ type: 'completed', finalMessage: text }));
      },
    };
    this.runs.push(run);
    setImmediate(() => {
      onEvent({ type: 'thread', threadId: request.resumeThreadId ?? `thr_${request.runId}` });
      onEvent({ type: 'turn', turnId: `turn_${request.runId}` });
      started();
      if (review) {
        run.call('submit_review', { decision: 'accept' });
        run.succeed();
      }
    });
    return { cancel: async () => {}, respondApproval: () => {}, dispose: async () => {} };
  }
  async checkTurn() {
    return { status: 'not_found' as const };
  }
  of(title: string) {
    return this.runs.filter((r) => r.title === title);
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8' }).trim();

let root: string;
let repo: string;
let store: Store;
let runtime: FakeRuntime;
let adapter: FakeAdapter;
let supervisor: RunSupervisor;
let channels: ChannelService;
let coordinator: CoordinatorService;
let plans: PlanService;
let integration: IntegrationService;
let workspaceId: string;
const logs: string[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'paldock-p3-ext-'));
  repo = join(root, 'repo');
  const dataRoot = join(root, 'data');
  mkdirSync(repo);
  mkdirSync(dataRoot);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

  store = await openStore(':memory:');
  runtime = new FakeRuntime();
  adapter = new FakeAdapter();
  let scheduler!: TaskGraphScheduler;
  let gate!: ReviewGate;
  const publish = (batch: PersistentEvent[]) => {
    scheduler.onEvents(batch);
    gate.onEvents(batch);
    coordinator.onEvents(batch);
    channels.onEvents(batch);
  };
  const log = (message: string) => logs.push(message);
  const gateway = new McpGateway({ store, publish, plans: () => plans, coordinator: () => coordinator });
  runtime.gateway = gateway;
  supervisor = new RunSupervisor({
    store,
    runtimes: { claude: runtime },
    mcp: { gateway, server: (token) => ({ name: 'paldock', command: 'node', args: [], env: { PALDOCK_MCP_TOKEN: token } }) },
    dataRoot,
    publish,
    publishEphemeral: () => {},
    log,
  });
  scheduler = new TaskGraphScheduler({ store, supervisor, publish, log });
  integration = new IntegrationService({ store, supervisor, dataRoot, publish, log });
  gate = new ReviewGate({ store, supervisor, publish, log, integration });
  coordinator = new CoordinatorService({ store, supervisor, publish, log });
  plans = new PlanService({ store, scheduler, integration, supervisor, publish });
  const tasks = new TaskService({ store, supervisor, scheduler, integration, dataRoot, publish });
  const credentials = new MemoryCredentials();
  channels = new ChannelService({
    store,
    tasks,
    coordinator,
    plans,
    credentials,
    createAdapter: async () => adapter,
    publish,
    publishEphemeral: () => {},
    log,
    limits: { outboxSpacingMs: 0, escalationScanMs: 30, outboxRetryBaseMs: 20, escalationWaitMs: 60 * 60 * 1000 },
  });
  coordinator.start();
  channels.start();
  workspaceId = store.tasks.ensureWorkspace('repo', repo).id;
  await credentials.write('paldock/feishu', { user: 'cli_test', secret: 's' });
  const [feishu] = channels.overview();
  await channels.configure({ provider: 'feishu', expectedVersion: feishu!.settings.version, enabled: true, proxyUrl: null });
  await until(() => adapter.sink, (s) => s !== undefined, '渠道连接');
  // 配对：陌生人发消息 → 配对码 → 桌面确认
  adapter.say('wang', '你好');
  await until(() => channels.listPairings()[0], (p) => p !== undefined, '配对码');
  channels.decidePairing(channels.listPairings()[0]!.code, true);
  await cardTitled('绑定成功');
});

afterEach(async () => {
  await channels.stop();
  coordinator.stop();
  await supervisor.stop();
  await integration.idle();
  store.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  const failures = logs.filter((l) => / failed/.test(l) && !/finished: failed/.test(l));
  logs.length = 0;
  expect(failures.join(' / ')).toBe('');
});

async function until<T>(read: () => T, ok: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}（已发卡片：${adapter.cards().map((c) => c.title).join(' / ')}；日志 ${logs.join(' / ')}）`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const cardTitled = (title: string | RegExp, from = 0) =>
  until(() => adapter.cards().slice(from).find((c) => (typeof title === 'string' ? c.title === title : title.test(c.title))), (c) => c !== undefined, `卡片 ${title}`).then((c) => c!);
const sentTitled = (title: string | RegExp) =>
  until(() => adapter.sent.findLast((s) => (typeof title === 'string' ? s.card.title === title : title.test(s.card.title))), (s) => s !== undefined, `卡片 ${title}`).then((s) => s!);
const coordRun = (n: number) => until(() => runtime.of('协调')[n - 1], (r) => r !== undefined, `第 ${n} 次协调助手唤醒`).then((r) => r!);
const session = () => store.channels.activeDirectConversations()[0]!.mainSessionId!;
const idle = () => until(() => store.coordinator.runningWake(session()), (w) => w === undefined, '唤醒结束');
/** 让桌面「没人」：通知和计划卡片立即满足升级条件。 */
const leaveDesk = () => channels.setPresence({ uiRunning: true, locked: false, idle: true });

/** 协调助手在一次唤醒里问一个编号问题，等卡片发到单聊。 */
async function ask(run: FakeRun, question: string): Promise<{ id: number; ref: string }> {
  const asked = run.call('notify_user', { message: question, question: true }) as { noticeId: number; ref: string };
  const sent = await sentTitled(`协调助手的问题 · ${asked.ref}`);
  return { id: asked.noticeId, ref: sent.ref };
}

describe('P3 外部消息进主会话', () => {
  it('普通消息进这个外部会话的主会话（标明渠道），协调助手的回复发回单聊；命令照旧', async () => {
    adapter.say('wang', '帮我看看登录页能加记住我吗');
    await cardTitled('收到，已交给协调助手');
    const run = await coordRun(1);
    expect(run.request.prompt).toContain('用户说：\n帮我看看登录页能加记住我吗');
    const main = store.coordinator.getMainSession(session())!;
    expect(main).toMatchObject({ title: '飞书 · wang', workspaceId });
    expect(store.coordinator.recentMessages(main.sessionId, 5)).toEqual([expect.objectContaining({ role: 'user', channel: 'feishu', body: '帮我看看登录页能加记住我吗' })]);
    // 不再直接弹「新建任务」
    expect(adapter.cards().some((c) => c.title === '新建任务？')).toBe(false);
    run.succeed('可以，我先看一下代码再给你计划。');
    const reply = await cardTitled('协调助手');
    expect(reply.lines).toEqual(['可以，我先看一下代码再给你计划。']);
    await idle();

    // 确定性命令不经协调助手
    adapter.say('wang', '/tasks');
    await cardTitled('还没有任务');
    adapter.say('wang', '/new 加一个 hello 文件');
    await cardTitled('新建任务？');
    expect(runtime.of('协调')).toHaveLength(1);
    // 同一个外部会话沿用同一个主会话
    expect(store.coordinator.mainSessions(workspaceId).filter((s) => s.title.startsWith('飞书'))).toHaveLength(1);
  });

  it('对编号问题的回复：引用回复、Q 编号开头、只有一个待答问题，都交回提问方并标为已答', async () => {
    leaveDesk();
    adapter.say('wang', '开始吧');
    const run = await coordRun(1);
    const q1 = await ask(run, '用 cookie 还是 localStorage？');
    const q2 = await ask(run, '过期时间设多久？');
    run.succeed('我问了两个问题');
    await idle();

    // 1. 引用回复第一张问题卡片
    adapter.say('wang', '用 cookie', q1.ref);
    await cardTitled(`已把你的回复交给协调助手（Q${q1.id}）`);
    const r2 = await coordRun(2);
    expect(r2.request.prompt).toContain(`用户在飞书回复了你的问题 Q${q1.id}（用 cookie 还是 localStorage？）：\n用 cookie`);
    expect(store.coordinator.getNotice(q1.id)).toMatchObject({ status: 'read', answeredAt: expect.any(String) });
    r2.succeed('好的');
    await idle();

    // 2. 以 Q 编号开头
    adapter.say('wang', `q${q2.id}：30 天`);
    await cardTitled(`已把你的回复交给协调助手（Q${q2.id}）`);
    const r3 = await coordRun(3);
    expect(r3.request.prompt).toContain(`Q${q2.id}（过期时间设多久？）：\n30 天`);
    r3.succeed('明白');
    await idle();

    // 3. 只有一个待答问题时直接回复
    const r4run = await (async () => {
      adapter.say('wang', '还有吗');
      return coordRun(4);
    })();
    const q3 = await ask(r4run, '要不要补 e2e 测试？');
    r4run.succeed('最后一个问题');
    await idle();
    adapter.say('wang', '要');
    await cardTitled(`已把你的回复交给协调助手（Q${q3.id}）`);
    const r5 = await coordRun(5);
    expect(r5.request.prompt).toContain(`Q${q3.id}（要不要补 e2e 测试？）：\n要`);
    r5.succeed('好');
    await idle();
    // 答复记在提问的会话里，问题都已答、不再外发
    const messages = store.coordinator.recentMessages(session(), 50).filter((m) => m.role === 'user').map((m) => m.body);
    expect(messages).toEqual(expect.arrayContaining([`回复 Q${q1.id}：用 cookie`, `回复 Q${q2.id}：30 天`, `回复 Q${q3.id}：要`]));
    expect(store.coordinator.openQuestionsSentTo(store.channels.activeDirectConversations()[0]!.id)).toEqual([]);
  });

  it('有多个待答问题又认不出来时，不猜：交给协调助手并附上候选问题', async () => {
    leaveDesk();
    adapter.say('wang', '开始吧');
    const run = await coordRun(1);
    const a = await ask(run, '要支持手机端吗？');
    const b = await ask(run, '要加埋点吗？');
    run.succeed('问了两个');
    await idle();
    adapter.say('wang', '好的');
    await cardTitled('收到，已交给协调助手');
    const next = await coordRun(2);
    expect(next.request.prompt).toContain(`这条消息可能是在回答你之前的问题：Q${a.id}「要支持手机端吗？」；Q${b.id}「要加埋点吗？」`);
    expect(store.coordinator.getNotice(a.id)?.answeredAt).toBeNull();
    expect(store.coordinator.getNotice(b.id)?.answeredAt).toBeNull();
    next.succeed('你是说哪个问题？');
    await idle();
  });

  it('外部发起的任务做完后，协调助手的汇总发回发起的单聊', async () => {
    adapter.say('wang', '加一个 a.txt');
    const run = await coordRun(1);
    const { planId, taskId } = run.call('propose_plan', {
      title: '加 a.txt',
      goal: '加一个 a.txt',
      nodes: [{ key: 'a', role: 'developer', title: '写 a', goal: '写 a.txt' }],
    }) as { planId: string; taskId: string };
    run.succeed('计划已提，请确认。');
    await idle();
    await plans.confirm(planId, store.plans.getPlan(planId)!.version);
    (await until(() => runtime.of('写 a')[0], (r) => r !== undefined, '开发开始'))!.succeed('写好了', { 'a.txt': 'a\n' });
    await until(() => store.tasks.getTask(taskId)!.status, (s) => s === 'succeeded', '任务成功');
    const woke = await coordRun(2);
    expect(woke.request.prompt).toContain('全部节点已通过');
    woke.succeed('a.txt 已经加好，在集成分支上，等你合并。');
    const summary = await until(() => adapter.cards().filter((c) => c.title === '协调助手').at(-1), (c) => c?.lines[0]?.startsWith('a.txt 已经加好') ?? false, '汇总发回');
    expect(summary!.lines[0]).toContain('等你合并');
  });

  it('计划确认卡片：桌面没人时发到单聊，可以确认（记下来自飞书）；L1 遇到带检查命令的计划只提醒；点的时候按当前等级重新判断', async () => {
    leaveDesk();
    adapter.say('wang', '开始吧');
    const run = await coordRun(1);
    const simple = run.call('propose_plan', { title: '简单计划', goal: 'g', nodes: [{ key: 'a', role: 'developer', title: '写 a', goal: '写 a' }] }) as { planId: string };
    const card = await cardTitled(/^计划待确认 · 简单计划/);
    expect(card.lines).toEqual(expect.arrayContaining(['· 写 a（developer · claude）', '改执行器、检查命令或删节点请到电脑上；这里只能确认或退回。']));
    adapter.click('wang', card.buttons.find((b) => b.label === '确认')!.token);
    await until(() => store.plans.getPlan(simple.planId)!.status, (s) => s === 'confirmed', '远程确认');
    expect(store.plans.getPlan(simple.planId)!.decidedVia).toBe('feishu');
    await cardTitled(/^计划已确认 · /);

    // 带检查命令：L1（默认）只提醒，没有确认按钮
    const checked = run.call('propose_plan', {
      title: '带检查',
      goal: 'g',
      nodes: [{ key: 'b', role: 'developer', title: '写 b', goal: '写 b', check: { executable: 'pnpm', args: ['test'] } }],
    }) as { planId: string };
    const warning = await cardTitled(/^计划待确认 · 带检查/);
    expect(warning.buttons).toEqual([]);
    expect(warning.lines).toEqual(expect.arrayContaining(['· 写 b：pnpm test', expect.stringContaining('远程审批等级是 L1，请到电脑上确认')]));
    expect(store.plans.getPlan(checked.planId)!.status).toBe('proposed');

    // L2 时有按钮；点之前改回 L1：按当前等级拒绝
    let ws = store.tasks.getWorkspace(workspaceId)!;
    ws = store.tasks.setRemoteApprovalLevel(ws.id, ws.version, 'L2').record;
    const third = run.call('propose_plan', {
      title: '第三个',
      goal: 'g',
      nodes: [{ key: 'c', role: 'developer', title: '写 c', goal: '写 c', check: { executable: 'pnpm', args: ['lint'] } }],
    }) as { planId: string };
    const l2 = await cardTitled(/^计划待确认 · 第三个/);
    expect(l2.buttons.map((b) => b.label)).toEqual(['确认', '退回']);
    store.tasks.setRemoteApprovalLevel(ws.id, ws.version, 'L1');
    adapter.click('wang', l2.buttons.find((b) => b.label === '确认')!.token);
    const refused = await cardTitled('没有完成');
    expect(refused.lines.join('')).toContain('只能在电脑上确认');
    expect(store.plans.getPlan(third.planId)!.status).toBe('proposed');
    run.succeed('提了三个计划');
    await idle();
  });
});
