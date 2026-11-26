/**
 * P3-07 验收（离线）：协调助手主会话与最小唤醒循环。
 * 模拟执行器由测试控制：协调助手的每次 Run（一次唤醒）调用哪些 MCP 工具、回复什么、何时结束。
 * 覆盖：你的消息唤醒并沿用原生会话、任务事件唤醒与频率限制、单次唤醒的请求上限、notify_user 先桌面再升级到单聊、
 * 滚动摘要的写入与新开会话时的注入。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelNotifier, CoordinatorService, McpGateway, PlanService, RunSupervisor, TaskGraphScheduler } from '@paldock/application';
import type { Card, ChannelAddress, MainSessionRecord, PersistentEvent, RunStartRequest, RuntimeAdapter, RuntimeEvent } from '@paldock/contracts';
import { P2_DEFAULTS } from '@paldock/domain';
import { openStore, type Store } from '@paldock/storage-sqlite';
import { afterEach, describe, expect, it } from 'vitest';

interface FakeRun {
  request: RunStartRequest;
  ended: boolean;
  call(tool: string, args?: unknown): unknown;
  reply(text: string): void;
  fail(message: string): void;
}

class FakeRuntime implements RuntimeAdapter {
  readonly runs: FakeRun[] = [];
  /** 为真时，带 resumeThreadId 的启动直接失败（原生会话丢了）。 */
  failResume = false;
  constructor(
    private readonly gateway: () => McpGateway,
    readonly name = 'claude',
  ) {}

  async discover() {
    const capabilities = { resume: true, streaming: true, approvals: true, cancel: true, workingDirectoryRestriction: false, attachments: false };
    return { runtime: this.name, available: true, capabilities };
  }

  async start(request: RunStartRequest, onEvent: (event: RuntimeEvent) => void) {
    if (request.resumeThreadId && this.failResume) throw new Error('thread not found');
    const run: FakeRun = {
      request,
      ended: false,
      call: (tool, args = {}) => {
        const gateway = this.gateway();
        const caller = gateway.authenticate(request.mcpServer!.env.PALDOCK_MCP_TOKEN!);
        if (!caller) throw new Error('令牌已作废');
        return gateway.call(caller, tool, args);
      },
      // 真实执行器总是先报 thread / turn 再结束：结束事件排在启动事件之后
      reply: (text) => {
        if (run.ended) return;
        run.ended = true;
        void started.then(() => onEvent({ type: 'completed', finalMessage: text }));
      },
      fail: (message) => {
        if (run.ended) return;
        run.ended = true;
        void started.then(() => onEvent({ type: 'failed', message }));
      },
    };
    this.runs.push(run);
    const started = new Promise<void>((resolve) =>
      setImmediate(() => {
        onEvent({ type: 'thread', threadId: request.resumeThreadId ?? `thr_${request.runId}` });
        onEvent({ type: 'turn', turnId: `turn_${request.runId}` });
        resolve();
      }),
    );
    return {
      cancel: async () => {
        if (run.ended) return;
        run.ended = true;
        onEvent({ type: 'interrupted' });
      },
      respondApproval: () => {},
      dispose: async () => {},
    };
  }

  async checkTurn() {
    return { status: 'not_found' as const };
  }

  active(): FakeRun[] {
    return this.runs.filter((r) => !r.ended);
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8' }).trim();

let root: string;
let codex: FakeRuntime;
let repo: string;
let store: Store;
let runtime: FakeRuntime;
let supervisor: RunSupervisor;
let coordinator: CoordinatorService;
let plans: PlanService;
let gateway: McpGateway;
let session: MainSessionRecord;
const events: PersistentEvent[] = [];
const logs: string[] = [];

async function setup(limits: ConstructorParameters<typeof CoordinatorService>[0]['limits'] = {}, withCodex = false) {
  root = mkdtempSync(join(tmpdir(), 'paldock-p3-coord-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  mkdirSync(join(root, 'data'));
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

  store = await openStore(':memory:');
  let scheduler!: TaskGraphScheduler;
  const publish = (batch: PersistentEvent[]) => {
    events.push(...batch);
    scheduler.onEvents(batch);
    coordinator.onEvents(batch);
  };
  const log = (message: string) => logs.push(message);
  gateway = new McpGateway({ store, publish, plans: () => plans, coordinator: () => coordinator });
  runtime = new FakeRuntime(() => gateway);
  supervisor = new RunSupervisor({
    store,
    runtimes: withCodex ? { claude: runtime, codex: (codex = new FakeRuntime(() => gateway, 'codex')) } : { claude: runtime },
    mcp: { gateway, server: (token) => ({ name: 'paldock', command: 'node', args: [], env: { PALDOCK_MCP_TOKEN: token } }) },
    dataRoot: join(root, 'data'),
    publish,
    publishEphemeral: () => {},
    log,
  });
  scheduler = new TaskGraphScheduler({ store, supervisor, publish, log });
  plans = new PlanService({ store, scheduler, publish });
  coordinator = new CoordinatorService({ store, supervisor, publish, log, limits });
  coordinator.start();
  const workspaceId = store.tasks.ensureWorkspace('repo', repo).id;
  [session] = coordinator.sessions(workspaceId);
}

afterEach(async () => {
  coordinator?.stop();
  await supervisor?.stop();
  expect(logs.filter((l) => / failed/.test(l) && !/finished: failed/.test(l))).toEqual([]);
  store?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  logs.length = 0;
  events.length = 0;
});

async function until<T>(read: () => T, ok: (value: T) => boolean, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}（当前 ${JSON.stringify(value)}；日志 ${logs.join(' / ')}）`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

let seq = 0;
const say = (text: string) => coordinator.send(session.sessionId, text, `say-${++seq}-${text}`);
const nthRun = (n: number) => until(() => runtime.runs[n - 1], (r) => r !== undefined, `第 ${n} 次唤醒的 Run`).then((r) => r!);
const wakes = () => store.coordinator.listWakes(session.sessionId, 50).reverse();
const waitIdle = () => until(() => store.coordinator.runningWake(session.sessionId), (w) => w === undefined, '唤醒结束');

const node = { key: 'dev', role: 'developer', title: '实现', goal: '实现记住我' };

describe('协调助手主会话', () => {
  it('你的消息唤醒协调助手；它经 MCP 提计划、回复存成消息；下一次沿用同一个原生会话', async () => {
    await setup();
    expect(session).toMatchObject({ title: '默认会话' });
    // 对话任务不出现在任务列表
    expect(store.tasks.listTasks(10)).toEqual([]);

    say('给登录页加「记住我」');
    const first = await nthRun(1);
    expect(first.request.cwd).toBe(repo); // 只读，在项目根目录
    expect(first.request.resumeThreadId).toBeUndefined();
    expect(first.request.prompt).toContain('用户说：\n给登录页加「记住我」');
    // 角色说明只在新开会话时作为 instructions 给一次，不混在每一轮的提示词里
    expect(first.request.instructions).toContain('你只读');
    expect(first.request.prompt).not.toContain('你只读');
    const planned = first.call('propose_plan', { title: '记住我', goal: '加记住我', nodes: [node] }) as { taskId: string; planId: string };
    expect(store.plans.getPlan(planned.planId)?.proposedByRunId).toBe(first.request.runId);
    first.reply('已经拆成一个开发子任务，请在任务详情里确认计划。');
    await waitIdle();
    expect(wakes().map((w) => [w.trigger, w.status, w.runId])).toEqual([['user_message', 'done', first.request.runId]]);
    const messages = store.coordinator.recentMessages(session.sessionId, 10);
    expect(messages.map((m) => [m.role, m.body])).toEqual([
      ['user', '给登录页加「记住我」'],
      ['assistant', '已经拆成一个开发子任务，请在任务详情里确认计划。'],
    ]);
    // 协调助手的子任务不进状态机，「待我处理」里也没有它
    expect(store.tasks.getSubtask(session.subtaskId)?.status).toBe('draft');

    say('顺便补测试');
    const second = await nthRun(2);
    expect(second.request.resumeThreadId).toBe(`thr_${first.request.runId}`);
    // 沿用原生会话时不再注入历史
    expect(second.request.prompt).not.toContain('最近的对话');
    // 续用时不重发角色说明；任务板变了（多了草稿任务）才附最新的
    expect(second.request.instructions).toBeUndefined();
    expect(second.request.prompt).not.toContain('你只读');
    expect(second.request.prompt).toContain('任务板（有变化，最新）');
    expect(second.request.prompt).toContain('记住我（draft）');
    second.reply('好');
    await waitIdle();

    // 任务板没变：这一轮只有你说的话
    say('再加一句');
    const third = await nthRun(3);
    expect(third.request.prompt).toBe('用户说：\n再加一句');
    third.reply('好');
    await waitIdle();
  });

  it('任务事件唤醒：两次之间至少隔一段时间，每天超过上限的跳过并通知你', async () => {
    await setup({ eventWakeMinIntervalMs: 400, eventWakesPerDay: 2 });
    say('开始');
    const first = await nthRun(1);
    const { taskId, planId } = first.call('propose_plan', { title: '记住我', goal: '加记住我', nodes: [node] }) as { taskId: string; planId: string };
    first.reply('计划已提');
    await waitIdle();

    const reject = (id: string, note: string) => plans.reject(id, store.plans.getPlan(id)!.version, note);
    const repropose = () => plans.propose(first.request.runId, { taskId, title: '记住我', goal: '加记住我', nodes: [{ ...node, paths: [], dependsOn: [] }] }).id;
    reject(planId, '先别做');
    const woke = await nthRun(2);
    expect(woke.request.prompt).toContain('任务事件（不是用户的消息）');
    expect(woke.request.prompt).toMatch(/计划第 1 版被用户退回，意见：先别做/);
    const startedAt = Date.now();
    woke.reply('我改一下计划');
    await waitIdle();

    // 第二个事件来得太快：排队，到间隔后才唤醒
    reject(repropose(), '还是不行');
    await new Promise((r) => setTimeout(r, 100));
    expect(runtime.runs).toHaveLength(2);
    expect(wakes().at(-1)).toMatchObject({ trigger: 'task_event', status: 'pending' });
    // 你的消息不被它挡住：先处理
    say('先回答我一下');
    const answered = await nthRun(3);
    expect(answered.request.prompt).toContain('用户说：\n先回答我一下');
    answered.reply('好');
    await waitIdle();
    const third = await nthRun(4);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);
    expect(third.request.prompt).toContain('计划第 2 版被用户退回');
    third.reply('好');
    await waitIdle();

    // 今天已经 2 次：第三个事件跳过，并通知你一次
    reject(repropose(), '第三次');
    await until(() => wakes().at(-1)?.status, (s) => s === 'dropped', '跳过');
    expect(runtime.runs).toHaveLength(4);
    const notices = store.coordinator.notices(session.sessionId, 10);
    expect(notices).toEqual([expect.objectContaining({ kind: 'info', body: expect.stringContaining('达到上限') })]);
    // 跳过记进自动处理记录单
    expect(store.autoDecisions.list(session.workspaceId, 10)).toEqual([expect.objectContaining({ kind: 'wake_dropped', taskId: session.taskId })]);
    // 你发的消息不受限制
    say('那就先这样');
    (await nthRun(5)).reply('好的');
    await waitIdle();
  });

  it('它提出的任务里节点阻塞时唤醒这个会话，带上事件摘要', async () => {
    await setup();
    say('开始');
    const first = await nthRun(1);
    const { planId } = first.call('propose_plan', { title: '记住我', goal: '加记住我', nodes: [node] }) as { planId: string };
    first.reply('计划已提');
    await waitIdle();
    await plans.confirm(planId, store.plans.getPlan(planId)!.version);
    const work = await nthRun(2);
    expect(work.request.prompt).toContain('你负责的子任务：实现');
    work.fail('编译不过');
    const woke = await nthRun(3);
    expect(woke.request.prompt).toMatch(/任务事件（不是用户的消息）：\n任务 #[0-9a-f]{6}「记住我」：节点「实现」阻塞：执行失败：编译不过/);
    expect(wakes().map((w) => [w.trigger, w.status])).toEqual([
      ['user_message', 'done'],
      ['task_event', 'running'],
    ]);
    woke.call('notify_user', { message: '开发子任务编译失败，要我换个执行器重试吗？', question: true });
    woke.reply('已问用户');
    await waitIdle();
  });

  it('确认计划时带了意见：唤醒协调助手，把意见交给它', async () => {
    await setup();
    say('开始');
    const first = await nthRun(1);
    const { planId } = first.call('propose_plan', { title: '记住我', goal: '加记住我', nodes: [{ ...node, role: 'reviewer' }] }) as { planId: string };
    first.reply('计划已提');
    await waitIdle();
    await plans.confirm(planId, store.plans.getPlan(planId)!.version, '记得补文档');
    await until(() => wakes().length, (n) => n === 2, '确认意见唤醒');
    expect(wakes()[1]).toMatchObject({ trigger: 'task_event', summary: expect.stringContaining('计划第 1 版已确认，用户的意见：记得补文档') });
  });

  it('单次唤醒的请求上限：到软上限提醒收尾，超过硬上限拒绝、中断这次唤醒并通知你', async () => {
    await setup({ wakeSoftRequests: 2, wakeHardRequests: 3 });
    say('看看任务');
    const run = await nthRun(1);
    expect(run.call('get_status', {})).toEqual([]);
    expect(run.call('get_status', {})).toEqual({ result: [], warning: expect.stringContaining('请尽快收尾') });
    expect(run.call('get_status', {})).toMatchObject({ warning: expect.stringContaining('已用 3 次') });
    expect(() => run.call('get_status', {})).toThrow(/超过 3 次上限/);
    await until(() => wakes()[0]?.status, (s) => s === 'failed', '唤醒被中断');
    expect(wakes()[0]).toMatchObject({ requests: 4 });
    expect(store.coordinator.notices(session.sessionId, 10)[0]).toMatchObject({ body: expect.stringContaining('已强制停止') });
    expect(store.autoDecisions.list(session.workspaceId, 10)).toEqual([expect.objectContaining({ kind: 'wake_aborted', reason: expect.stringContaining('看看任务') })]);
  });

  it('notify_user：先在桌面；没人看时按审批升级规则发到已绑定的单聊，带编号，只发一次；看过的不外发', async () => {
    await setup();
    say('做完告诉我');
    const run = await nthRun(1);
    const asked = run.call('notify_user', { message: '要不要顺便补 e2e 测试？', question: true }) as { noticeId: number; ref: string };
    expect(asked.ref).toBe(`Q${asked.noticeId}`);
    run.reply('我问了你一个问题');
    await waitIdle();
    expect(store.attention.list()).toEqual([expect.objectContaining({ kind: 'notice', itemId: String(asked.noticeId), taskId: session.taskId })]);

    // 一个已绑定的飞书单聊
    const dm: ChannelAddress = { provider: 'feishu', account: 'cli_app', tenant: 't1', chatId: 'oc_dm', threadKey: '', kind: 'dm' };
    const account = store.channels.upsertAccount(dm, 'ou_1', '用户');
    store.channels.setAccountStatus(account.id, account.version, 'active');
    store.channels.upsertConversation(dm, account.id, '用户');
    const sent: Card[] = [];
    let skew = 0;
    const notifier = new ChannelNotifier({
      store,
      publish: () => {},
      send: (_c, card) => sent.push(card),
      presence: () => ({ uiRunning: true, locked: false, idle: false }),
      attached: () => true,
      now: () => new Date(Date.now() + skew),
      limits: { ...P2_DEFAULTS, escalationWaitMs: 60_000 },
    });
    notifier.escalate();
    expect(sent).toEqual([]); // 桌面在、还没到 1 分钟：先等桌面
    skew = 61_000;
    notifier.escalate();
    expect(sent).toEqual([expect.objectContaining({ title: `协调助手的问题 · ${asked.ref}`, lines: expect.arrayContaining([expect.stringContaining(`带上编号 ${asked.ref}`)]) })]);
    notifier.escalate();
    expect(sent).toHaveLength(1);
    expect(store.coordinator.getNotice(asked.noticeId)?.escalatedAt).not.toBeNull();

    // 在桌面看过的不外发
    say('再说一件事');
    const second = await nthRun(2);
    second.call('notify_user', { message: '测试都过了' });
    second.reply('好');
    await waitIdle();
    coordinator.ack(session.sessionId);
    notifier.escalate();
    expect(sent).toHaveLength(1);
    expect(store.attention.list()).toEqual([]);
  });

  it('滚动摘要：每满 N 次唤醒提示写；原生会话续不上时新开，首条提示注入最新摘要和最近的消息', async () => {
    await setup({ summaryEveryWakes: 2, contextMessages: 10 });
    for (const [i, text] of ['第一句', '第二句'].entries()) {
      say(text);
      const run = await nthRun(i + 1);
      expect(run.request.prompt).not.toContain('write_summary');
      run.reply(`回复${i + 1}`);
      await waitIdle();
    }
    say('第三句');
    const third = await nthRun(3);
    expect(third.request.prompt).toContain('这次结束前请调用 write_summary');
    expect(third.call('write_summary', { summary: '目标：记住我；已定：先做开发' })).toEqual({ version: 1 });
    third.reply('回复3');
    await waitIdle();
    expect(store.coordinator.latestSummary(session.sessionId)).toMatchObject({ version: 1, wakesDone: 2, body: '目标：记住我；已定：先做开发' });

    // 原生会话丢了：续做失败后这次唤醒放回队列，新开会话重试，并注入摘要与最近的消息
    runtime.failResume = true;
    say('第四句');
    const fresh = await nthRun(4);
    expect(fresh.request.resumeThreadId).toBeUndefined();
    expect(fresh.request.prompt).toContain('这个会话之前的摘要：\n目标：记住我；已定：先做开发');
    expect(fresh.request.prompt).toContain('最近的对话：');
    expect(fresh.request.prompt).toContain('用户：第三句');
    expect(fresh.request.prompt).toContain('你：回复3');
    // 新开会话时也要写一份新的摘要
    expect(fresh.request.prompt).toContain('write_summary');
    fresh.reply('回复4');
    await waitIdle();
    expect(wakes().map((w) => w.status)).toEqual(['done', 'done', 'done', 'done']);
  });
});

describe('单人模式（项目级助手设置，2026-11-26 已定）', () => {
  it('主会话直接在项目目录里工作：换一套单人说明、不能提计划；改完审阅助手在只读会话里看一遍，结论作为一条消息', async () => {
    await setup();
    // 团队模式下协调助手只读
    say('看看');
    const team = await nthRun(1);
    expect(team.request).toMatchObject({ cwd: repo, readOnly: true });
    team.reply('看过了');
    await waitIdle();

    store.projectSettings.set(session.workspaceId, 0, { mode: 'solo', soloReview: true });
    say('在 README 里加一行说明');
    const solo = await nthRun(2);
    // 换了模式：新开会话，单人说明只发这一次；工作目录就是项目目录，可写
    expect(solo.request.resumeThreadId).toBeUndefined();
    expect(solo.request.instructions).toContain('单人助手');
    expect(solo.request).toMatchObject({ cwd: repo });
    expect(solo.request.readOnly).toBeUndefined();
    expect(() => solo.call('propose_plan', { title: 't', goal: 'g', nodes: [{ key: 'a', role: 'developer', title: 'a', goal: 'a' }] })).toThrow(/单人模式/);
    writeFileSync(join(repo, 'README.md'), '# demo\n说明\n');
    solo.reply('加好了');

    // 工作区有未提交的改动：审阅助手看一遍（只读，审阅助手自己的会话），结论成为对话里的一条消息
    const review = await nthRun(3);
    expect(review.request.prompt).toContain('请审阅单人助手');
    expect(review.request).toMatchObject({ cwd: repo, readOnly: true });
    review.reply('通过，改动合理');
    await until(() => store.coordinator.recentMessages(session.sessionId, 10).map((m) => m.body), (b) => b.includes('审阅助手：通过，改动合理'), '审阅结论进对话');
    expect(store.runs.getRun(review.request.runId)).toMatchObject({ purpose: 'review' });
  });

  it('单人用 Codex、审阅设为 Claude：改完后的审阅照审阅角色的设置，实际启动 Claude，只读（Codex 复审 P2）', async () => {
    await setup({}, true);
    store.agents.setOverride(session.workspaceId, 'reviewer', 'claude');
    store.projectSettings.set(session.workspaceId, 0, { mode: 'solo', soloExecutor: 'codex', soloReview: true });
    say('改一下 README');
    const solo = await until(() => codex.runs[0], (r) => r !== undefined, '单人助手在 Codex 上开始');
    expect(runtime.runs).toHaveLength(0);
    writeFileSync(join(repo, 'README.md'), '# demo\n改了\n');
    solo.reply('改好了');
    const review = await until(() => runtime.runs[0], (r) => r !== undefined, '审阅在 Claude 上开始');
    expect(review.request.prompt).toContain('请审阅单人助手');
    expect(review.request.readOnly).toBe(true);
    expect(codex.runs).toHaveLength(1);
    review.reply('通过');
    await until(() => store.coordinator.recentMessages(session.sessionId, 10).map((m) => m.body), (b) => b.includes('审阅助手：通过'), '审阅结论进对话');
  });
});
