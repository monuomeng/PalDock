/**
 * 协调助手在发起的对话里找你批（2026-11-26 你同意，0.3.8，plan.md 第 16 节）。离线，模拟执行器（协调助手的工具调用由测试代它发出），真实文件系统。
 * 发布条件：审批期间能正常对话；新事项不能改变一句「可以」的对象。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalConversation, ChannelNotifier, CoordinatorService, McpGateway, PlanService, RunSupervisor, TaskGraphScheduler, type GitOpsService } from '@paldock/application';
import type { Card, GitOpRecord, MainSessionRecord, PersistentEvent, RunStartRequest, RuntimeAdapter, RuntimeApprovalRequest, RuntimeEvent } from '@paldock/contracts';
import { P2_DEFAULTS } from '@paldock/domain';
import { openStore, type Store } from '@paldock/storage-sqlite';
import { afterEach, describe, expect, it } from 'vitest';

interface FakeRun {
  request: RunStartRequest;
  ended: boolean;
  ask(request: Omit<RuntimeApprovalRequest, 'nativeRequestId'>): Promise<string>;
  succeed(text?: string): void;
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
    const run: FakeRun = {
      request,
      ended: false,
      ask: (what) =>
        new Promise<string>((resolve) => {
          const id = `perm_${Math.random()}`;
          decisions.set(id, resolve);
          onEvent({ type: 'approval_request', request: { ...what, nativeRequestId: id } });
        }),
      succeed: (text = '好的') => {
        if (run.ended) return;
        run.ended = true;
        onEvent({ type: 'output_delta', text });
        onEvent({ type: 'completed', finalMessage: text });
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
        run.ended = true;
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
let outside: string;
let store: Store;
let runtime: FakeRuntime;
let supervisor: RunSupervisor;
let plans: PlanService;
let coordinator: CoordinatorService;
let conversation: ApprovalConversation;
let gateway: McpGateway;
let workspaceId: string;
let main: MainSessionRecord;
const gitCalls: string[] = [];
const logs: string[] = [];

async function setup(options: { hostFallbackMs?: number } = {}) {
  root = mkdtempSync(join(tmpdir(), 'paldock-askconv-'));
  const repo = join(root, 'repo');
  outside = join(root, 'assets');
  const dataRoot = join(root, 'data');
  for (const d of [repo, outside, dataRoot]) mkdirSync(d);
  // 项目外原来就有的两张参考图（不是这一轮生成的）
  writeFileSync(join(outside, 'login-before.png'), 'a');
  writeFileSync(join(outside, 'login-after.png'), 'b');
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  store = await openStore(':memory:');
  runtime = new FakeRuntime();
  let scheduler!: TaskGraphScheduler;
  const publish = (events: PersistentEvent[]) => {
    scheduler.onEvents(events);
    coordinator.onEvents(events);
    conversation.onEvents(events);
  };
  const log = (m: string) => logs.push(m);
  // Git 卡片的执行由一个计数的替身代替（只看是否执行、执行几次）
  const gitOps = {
    decide: async (opId: string, version: number, decision: string, hunkIds: string[] = []) => {
      gitCalls.push(`${opId}:${decision}${hunkIds.length > 0 ? `:${hunkIds.join(',')}` : ''}`);
      const { record, events } = store.git.finishOp(opId, version, decision === 'confirm' ? 'done' : 'cancelled', decision === 'confirm' ? '已推送' : '已取消');
      publish(events);
      return record;
    },
  } as unknown as GitOpsService;
  gateway = new McpGateway({ store, publish, plans: () => plans, coordinator: () => coordinator, approvals: () => conversation, gitOps: () => gitOps });
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
  plans = new PlanService({ store, scheduler, publish });
  coordinator = new CoordinatorService({ store, supervisor, publish, log, questionContext: (s, m) => conversation.openQuestionContext(s, m) });
  conversation = new ApprovalConversation({
    store,
    publish,
    log,
    supervisor,
    gitOps: () => gitOps,
    poke: (s) => coordinator.poke(s),
    limits: { askDebounceMs: 50, hostFallbackMs: options.hostFallbackMs ?? 60_000 },
  });
  workspaceId = store.tasks.ensureWorkspace('repo', repo).id;
  main = store.coordinator.createMainSession(workspaceId, '主会话').record;
}

afterEach(async () => {
  conversation?.stop();
  coordinator?.stop();
  await supervisor?.stop();
  plans?.stop();
  store?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  logs.length = 0;
  gitCalls.length = 0;
});

async function until<T>(read: () => T, ok: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}（当前 ${JSON.stringify(value)}；日志 ${logs.join(' / ')}）`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 协调助手这一轮：拿它的令牌调工具。 */
function tools(run: FakeRun) {
  const caller = gateway.authenticate(run.request.mcpServer!.env.PALDOCK_MCP_TOKEN!)!;
  return {
    call: (tool: string, args: unknown) => gateway.call(caller, tool, args),
    async: (tool: string, args: unknown) => Promise.resolve(gateway.call(caller, tool, args)),
  };
}

const isCoordinatorRun = (r: FakeRun) => store.runs.getRun(r.request.runId)?.subtaskId === main.subtaskId;
/** 第 n 个（从 1 起）协调助手的 Run。 */
const coordinatorTurn = (n: number) => until(() => runtime.runs.filter(isCoordinatorRun)[n - 1], (r) => r !== undefined, `协调助手第 ${n} 轮`);
const nodeRun = () => until(() => runtime.runs.find((r) => !isCoordinatorRun(r)), (r) => r !== undefined, '节点开始');

/** 你在桌面对话里说话；返回消息编号。 */
function say(text: string): number {
  coordinator.send(main.sessionId, text, `k-${Math.random()}`);
  return store.db.get<{ id: number }>(`SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`, main.sessionId)!.id;
}

/** 协调助手在这个对话里提出一个测试节点的计划，你确认；测试助手开始。 */
async function startTester(): Promise<FakeRun> {
  say('比对登录页前后的截图');
  const turn = await coordinatorTurn(1);
  const { planId } = tools(turn).call('propose_plan', { title: '比对登录页', goal: 'g', nodes: [{ key: 't', role: 'tester', title: '比对截图', goal: '比对' }] }) as { planId: string };
  turn.succeed('计划已提出');
  await plans.confirm(planId, store.plans.getPlan(planId)!.version);
  return nodeRun();
}

const read = (path: string) => ({ kind: 'permissions' as const, summary: `读取（Read）：${path}`, readPaths: [path] });
const pending = () => store.db.all<{ id: string; question_id: string | null }>(`SELECT id, question_id FROM approvals WHERE status = 'pending' ORDER BY requested_at, rowid`);
const statusOf = (id: string) => store.runs.getApproval(id)!.status;

/** 测试助手要读两张项目外的参考图；等协调助手被唤醒（原任务挂着），返回两条审批和协调助手这一轮。 */
async function twoImages(tester: FakeRun) {
  const answers = [tester.ask(read(join(outside, 'login-before.png'))), tester.ask(read(join(outside, 'login-after.png')))];
  const [a, b] = await until(pending, (p) => p.length === 2, '两条待审批');
  const turn = await coordinatorTurn(2);
  return { a: a!.id, b: b!.id, answers, turn };
}

function proposePush(): GitOpRecord {
  const { record } = store.git.proposeOp({
    workspaceId,
    sessionId: main.sessionId,
    runId: null,
    request: { kind: 'push', remote: 'origin', targets: [{ url: 'D:/remote.git', remoteSha: null }], branch: 'main', remoteBranch: 'main', head: 'a1b2c3d4e5f6', commits: ['a1b2c3d x'], totalCommits: 1 },
  });
  conversation.onEvents([{ type: 'git.proposed', aggregateId: record.id, payload: { kind: 'push', workspaceId, sessionId: main.sessionId } } as unknown as PersistentEvent]);
  return record;
}

describe('发布条件', () => {
  it('原任务挂着等审批时，协调助手照样被唤醒、在原对话里问你、回答追问；你部分放行后看到哪一步继续了', async () => {
    await setup();
    const tester = await startTester();
    const { a, b, answers, turn } = await twoImages(tester);
    // 测试助手的 Run 还挂着（等审批），协调助手这一轮已经在跑
    expect(tester.ended).toBe(false);
    expect(turn.request.prompt).toContain('【需要用户决定】');
    expect(turn.request.prompt).toContain('login-before.png');
    const { questionId } = tools(turn).call('suggest_decision', {
      text: '测试助手要比对登录页前后的变化。login-before.png 和 login-after.png 在项目目录外，需要你同意才能读取。我建议只允许读这两张，要继续吗？',
      items: [
        { ref: a, decision: 'allow' },
        { ref: b, decision: 'allow' },
      ],
    }) as { questionId: string };
    turn.succeed('');
    expect(pending().every((p) => p.question_id === questionId)).toBe(true);
    expect(store.messages.get(store.questions.get(questionId)!.messageId!)!.body).toContain('我建议只允许读这两张');

    // 追问：协调助手先回答，问题继续挂着
    say('图片在哪？');
    const t3 = await coordinatorTurn(3);
    expect(t3.request.prompt).toContain(`当前在等用户回答的问题 ${questionId}`);
    t3.succeed('两张都在你的 assets 目录里。');
    expect([statusOf(a), statusOf(b)]).toEqual(['pending', 'pending']);
    expect(store.questions.get(questionId)!.status).toBe('open');

    // 部分放行：只放行第一张，第二张继续等
    const msg = say('第一张可以');
    const t4 = await coordinatorTurn(4);
    // 唤醒里给出你这条消息的编号（交决定时要带上）
    expect(t4.request.prompt).toContain(`这一轮是用户消息 ${msg} 触发的`);
    const result = (await tools(t4).async('resolve_approvals', { questionId, items: [{ ref: a, decision: 'allow' }], userMessageId: msg, decisionQuote: '第一张可以' })) as { results: string[]; remaining: string[] };
    t4.succeed('第一张已放行，测试继续了；第二张还在等你。');
    expect(await answers[0]).toBe('allow_once');
    expect(result.results[0]).toMatch(/已放行，节点「比对截图」继续了/);
    expect(result.remaining).toHaveLength(1);
    expect([statusOf(a), statusOf(b)]).toEqual(['approved', 'pending']);
    expect(store.runs.getApproval(a)!.decidedVia).toBe('desktop');
    expect(store.db.all<{ action: string }>(`SELECT action FROM audit_log WHERE action = 'approval.conversation'`)).toHaveLength(1);
  });

  it('你打字期间来了推送请求：「第一张可以」只对应读图的问题，推送没执行；推送排在后面，不能顺带处理', async () => {
    await setup();
    const tester = await startTester();
    const { a, b, turn } = await twoImages(tester);
    const { questionId } = tools(turn).call('suggest_decision', {
      text: '测试助手要读 login-before.png 和 login-after.png（项目外），建议都允许，要继续吗？',
      items: [
        { ref: a, decision: 'allow' },
        { ref: b, decision: 'allow' },
      ],
    }) as { questionId: string };
    turn.succeed('');
    // 推送卡片在问题挂着时到达：不打断问题
    const push = proposePush();
    await new Promise((r) => setTimeout(r, 150));
    expect(store.questions.openOf(main.sessionId)!.id).toBe(questionId);
    const msg = say('第一张可以');
    const t3 = await coordinatorTurn(3);
    // 协调助手想顺带问推送：问题还开着，新事项排在后面
    expect(() => tools(t3).call('suggest_decision', { text: '要推送 a1b2c3d 到 origin/main 吗？', items: [{ ref: push.id, decision: 'confirm' }] })).toThrow(/排在后面/);
    // 也不能把推送塞进这次决定
    await expect(tools(t3).async('resolve_approvals', { questionId, items: [{ ref: push.id, decision: 'confirm' }], userMessageId: msg, decisionQuote: '可以' })).rejects.toThrow(/不在这个问题里/);
    await tools(t3).async('resolve_approvals', { questionId, items: [{ ref: a, decision: 'allow' }], userMessageId: msg, decisionQuote: '第一张可以' });
    t3.succeed('第一张已放行。');
    expect([statusOf(a), statusOf(b)]).toEqual(['approved', 'pending']);
    expect(store.git.getOp(push.id)!.status).toBe('proposed');
    expect(gitCalls).toEqual([]);
    // 之后协调助手被唤醒再问剩下的事（第二张和推送分开问）
    const t4 = await coordinatorTurn(4);
    expect(t4.request.prompt).toContain('login-after.png');
    expect(t4.request.prompt).toContain(push.id);
    expect(() => tools(t4).call('suggest_decision', { text: '第二张和推送 a1b2c3d 到 origin/main', items: [{ ref: b, decision: 'allow' }, { ref: push.id, decision: 'confirm' }] })).toThrow(/只能涉及一件事/);
    t4.succeed('');
  });
});

describe('一句话算不算同意', () => {
  it('「我还没说可以」「为什么要我点允许？」带着肯定词但都保持待决；没有新消息、消息早于问题时拒绝', async () => {
    await setup();
    const tester = await startTester();
    const { a, b, turn } = await twoImages(tester);
    const early = store.db.get<{ id: number }>(`SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`, main.sessionId)!.id;
    // 不是你的新消息触发的这一轮：不能交决定
    const { questionId } = tools(turn).call('suggest_decision', { text: '测试助手要读 login-before.png、login-after.png，建议允许？', items: [{ ref: a, decision: 'allow' }, { ref: b, decision: 'allow' }] }) as { questionId: string };
    await expect(tools(turn).async('resolve_approvals', { questionId, items: [{ ref: a, decision: 'allow' }], userMessageId: early, decisionQuote: '比对' })).rejects.toThrow(/新消息/);
    turn.succeed('');
    const m1 = say('我还没说可以');
    const t3 = await coordinatorTurn(3);
    await expect(tools(t3).async('resolve_approvals', { questionId, items: [{ ref: a, decision: 'allow' }], userMessageId: m1, decisionQuote: '可以' })).rejects.toThrow(/否定或还没决定/);
    // 早于问题的那条消息也不行
    await expect(tools(t3).async('resolve_approvals', { questionId, items: [{ ref: a, decision: 'allow' }], userMessageId: early, decisionQuote: '比对' })).rejects.toThrow(/早于问题/);
    t3.succeed('好的，你想好了告诉我。');
    const m2 = say('为什么要我点允许？');
    const t4 = await coordinatorTurn(4);
    await expect(tools(t4).async('resolve_approvals', { questionId, items: [{ ref: a, decision: 'allow' }], userMessageId: m2, decisionQuote: '允许' })).rejects.toThrow(/提问/);
    // 原话对不上也不行
    await expect(tools(t4).async('resolve_approvals', { questionId, items: [{ ref: a, decision: 'deny' }], userMessageId: m2, decisionQuote: '不用了' })).rejects.toThrow(/原样引用/);
    t4.succeed('因为图片在项目外。');
    expect([statusOf(a), statusOf(b)]).toEqual(['pending', 'pending']);
    expect(store.questions.get(questionId)!.status).toBe('open');
  });
});

describe('部分批准与只执行一次', () => {
  it('「第一张可以」之后原来整组的按钮失效，点了也不会放行第二张；第二张的新问题只对应第二张', async () => {
    await setup();
    const tester = await startTester();
    const { a, b, answers, turn } = await twoImages(tester);
    const q = tools(turn).call('suggest_decision', { text: '测试助手要读 login-before.png、login-after.png，建议都允许？', items: [{ ref: a, decision: 'allow' }, { ref: b, decision: 'allow' }] }) as { questionId: string };
    turn.succeed('');
    const old = store.questions.get(q.questionId)!;
    const msg = say('第一张可以');
    const t3 = await coordinatorTurn(3);
    await tools(t3).async('resolve_approvals', { questionId: q.questionId, items: [{ ref: a, decision: 'allow' }], userMessageId: msg, decisionQuote: '第一张可以' });
    // 这一轮里重新问第二张：只对应第二张
    const q2 = tools(t3).call('suggest_decision', { text: '第二张 login-after.png 还要读吗？', items: [{ ref: b, decision: 'allow' }] }) as { questionId: string };
    t3.succeed('');
    // 点旧问题的「按建议处理」：已经处理过了，第二张不受影响
    await expect(conversation.decideByButton(old.id, old.version, 'accept', undefined, 'desktop')).rejects.toThrow(/已经处理过/);
    expect([statusOf(a), statusOf(b)]).toEqual(['approved', 'pending']);
    expect(await answers[0]).toBe('allow_once');
    expect(store.questions.get(q2.questionId)!.items.map((i) => i.ref)).toEqual([b]);
    // 「都不要」只拒绝这个问题里列出的项
    const q2r = store.questions.get(q2.questionId)!;
    await conversation.decideByButton(q2r.id, q2r.version, 'reject', undefined, 'desktop');
    expect(await answers[1]).toBe('deny');
  });

  it('先回「可以」再点旧按钮：推送只执行一次；你可以批准协调助手提出的推送卡片；问题里要写明推送目标', async () => {
    await setup();
    say('推送当前分支');
    const t1 = await coordinatorTurn(1);
    const push = proposePush();
    expect(() => tools(t1).call('suggest_decision', { text: '要推送吗？', items: [{ ref: push.id, decision: 'confirm' }] })).toThrow(/写明目标/);
    const q = tools(t1).call('suggest_decision', { text: '要把 a1b2c3d 推送到 origin/main（D:/remote.git）吗？', items: [{ ref: push.id, decision: 'confirm' }] }) as { questionId: string };
    t1.succeed('');
    const before = store.questions.get(q.questionId)!;
    const msg = say('可以，推吧');
    const t2 = await coordinatorTurn(2);
    await tools(t2).async('resolve_approvals', { questionId: q.questionId, items: [{ ref: push.id, decision: 'confirm' }], userMessageId: msg, decisionQuote: '可以，推吧' });
    t2.succeed('已推送。');
    await expect(conversation.decideByButton(before.id, before.version, 'accept', undefined, 'desktop')).rejects.toThrow(/已经处理过/);
    expect(gitCalls).toEqual([`${push.id}:confirm`]);
  });
});

describe('协调助手说不了话时', () => {
  it('协调助手没在时限内发出问题：宿主自己在对话里问（带按钮），不让请求静默挂着', async () => {
    await setup({ hostFallbackMs: 300 });
    const tester = await startTester();
    const { a, answers, turn } = await twoImages(tester);
    // 协调助手这一轮什么也没问就结束了
    turn.succeed('');
    const q = await until(() => store.questions.openOf(main.sessionId), (x) => x !== undefined, '宿主代问');
    expect(q!.author).toBe('host');
    expect(store.messages.get(q!.messageId!)!.role).toBe('system');
    await conversation.decideByButton(q!.id, q!.version, 'accept', undefined, 'desktop');
    expect(statusOf(a)).toBe('approved');
    expect(await answers[0]).toBe('allow_once');
    // 结果写回对话：看得到哪一步继续了
    const last = store.db.get<{ body: string }>(`SELECT body FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1`, main.sessionId)!;
    expect(last.body).toMatch(/已放行，节点「比对截图」继续了/);
  });

  it('发起请求的就是主会话自己（单人模式或协调助手自己读文件）：它在等审批没法开口，宿主直接在对话里问', async () => {
    await setup();
    const run = store.runs.createRun({ subtaskId: main.subtaskId, sessionId: main.sessionId, runtime: 'claude' }).record;
    const approval = store.runs.requestApproval({ runId: run.id, kind: 'permissions', riskLevel: 'medium', summary: `读取（Read）：${join(outside, 'login-before.png')}`, detail: null, cwd: null, nativeRequestId: 'x', ttlMs: 60_000, access: 'read' });
    conversation.onEvents(approval.events);
    const q = await until(() => store.questions.openOf(main.sessionId), (x) => x !== undefined, '宿主代问');
    expect(q!.author).toBe('host');
    expect(q!.items.map((i) => i.ref)).toEqual([approval.record.id]);
    expect(store.coordinator.nextPendingWake(main.sessionId)).toBeUndefined();
  });

  it('来源缺失（单独建的任务）：不借用别的会话，留在桌面「待我处理」，照常按规则提醒', async () => {
    await setup();
    const task = store.tasks.createTask({ workspaceId, title: '单独的任务', goal: 'g', role: 'developer', checkCommand: null, checkConfirmed: false, idempotencyKey: 'solo-task' }).record;
    const run = store.runs.createRun({ subtaskId: task.subtask.id, sessionId: task.session.id, runtime: 'claude' }).record;
    const approval = store.runs.requestApproval({ runId: run.id, kind: 'permissions', riskLevel: 'high', summary: '使用工具 WebFetch', detail: null, cwd: null, nativeRequestId: 'x', ttlMs: 60_000 });
    conversation.onEvents(approval.events);
    await new Promise((r) => setTimeout(r, 150));
    expect(conversation.sourceSession(approval.record)).toBeUndefined();
    expect(store.questions.openOf(main.sessionId)).toBeUndefined();
    expect(store.coordinator.nextPendingWake(main.sessionId)).toBeUndefined();
  });
});

describe('外部会话', () => {
  async function external(level: 'L1' | 'L2') {
    const ws = store.tasks.getWorkspace(workspaceId)!;
    store.tasks.setRemoteApprovalLevel(ws.id, ws.version, level);
    const dm = { provider: 'telegram' as const, account: 'bot', tenant: '', chatId: 'c1', threadKey: '', kind: 'dm' as const };
    const account = store.channels.upsertAccount(dm, 'u1', '我');
    if (account.status !== 'active') store.channels.setAccountStatus(account.id, account.version, 'active');
    const conv = store.channels.upsertConversation(dm, account.id, '我');
    store.channels.setMainSession(conv.id, main.sessionId);
    const sent: { card: Card; subject?: string | undefined }[] = [];
    const notifier = new ChannelNotifier({
      store,
      publish: () => {},
      send: (_c, card, subject) => sent.push({ card, subject }),
      presence: () => ({ uiRunning: false, locked: false, idle: false }),
      attached: () => true,
      now: () => new Date(Date.now() + 10 * 60_000),
      limits: P2_DEFAULTS,
      approvals: () => conversation,
    });
    return { sent, notifier, conversationId: conv.id };
  }

  it('从 Telegram 发起的对话：问题只发一张卡片回原会话，不再另外外发审批卡；敏感路径只说要到电脑上确认，不写路径', async () => {
    await setup();
    const { sent, notifier } = await external('L2');
    const tester = await startTester();
    const answer = tester.ask(read(join(homedir(), '.ssh', 'id_ed25519')));
    const [s] = await until(pending, (p) => p.length === 1, '待审批');
    const turn = await coordinatorTurn(2);
    const { questionId } = tools(turn).call('suggest_decision', { text: '测试助手要读一个敏感文件，建议拒绝。', items: [{ ref: s!.id, decision: 'deny' }] }) as { questionId: string };
    turn.succeed('');
    notifier.onEvents(store.events.since(0, 10_000).filter((e) => e.type === 'question.created'));
    notifier.escalate();
    const cards = sent.filter((x) => x.subject === `question:${questionId}`);
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards[0]!.card)).not.toContain('.ssh');
    expect(cards[0]!.card.lines.join('\n')).toContain('需要到电脑上确认');
    // 「按建议处理」不在外部给（敏感路径只能在电脑上批），「都不要」在
    expect(cards[0]!.card.buttons.map((b) => b.label)).toEqual(['都不要']);
    // 审批本身不再另外外发
    expect(sent.filter((x) => x.subject?.startsWith('approval'))).toHaveLength(0);
    // 外部渠道里点「按建议处理」被拒：要到电脑上
    const q = store.questions.get(questionId)!;
    await expect(conversation.decideByButton(q.id, q.version, 'accept', undefined, 'telegram')).rejects.toThrow(/电脑上确认/);
    void answer;
  });

  it('桌面对话里的问题：你不在电脑前时发一条问题卡片到已绑定的单聊，只发一次', async () => {
    await setup();
    const { sent, notifier, conversationId } = await external('L2');
    // 这个主会话是桌面的：解除绑定，另一个单聊只作为提醒目标
    store.db.run(`UPDATE external_conversations SET main_session_id = NULL WHERE id = ?`, conversationId);
    const tester = await startTester();
    void tester.ask({ kind: 'permissions', summary: '使用工具 WebFetch' });
    const [x] = await until(pending, (p) => p.length === 1, '待审批');
    const turn = await coordinatorTurn(2);
    const { questionId } = tools(turn).call('suggest_decision', { text: '测试助手要联网（使用工具 WebFetch），建议允许？', items: [{ ref: x!.id, decision: 'allow' }] }) as { questionId: string };
    turn.succeed('');
    expect(store.questions.get(questionId)!.delivery).toBe('desktop');
    notifier.escalate();
    notifier.escalate();
    expect(sent.filter((m) => m.subject === `question:${questionId}`)).toHaveLength(1);
    expect(sent.filter((m) => m.subject?.startsWith('approval'))).toHaveLength(0);
  });

  it('投递失败：问题记成失败，审批照常按规则外发，桌面一直可以处理', async () => {
    await setup();
    const { sent, notifier, conversationId } = await external('L2');
    const tester = await startTester();
    void tester.ask({ kind: 'permissions', summary: '使用工具 WebFetch' });
    const [x] = await until(pending, (p) => p.length === 1, '待审批');
    const turn = await coordinatorTurn(2);
    const { questionId } = tools(turn).call('suggest_decision', { text: '测试助手要联网（使用工具 WebFetch），建议允许？', items: [{ ref: x!.id, decision: 'allow' }] }) as { questionId: string };
    turn.succeed('');
    // 模拟投递失败
    store.db.run(`INSERT INTO outbox (channel, target, subject, payload, next_attempt_at, created_at, status) VALUES ('telegram', ?, ?, '{}', '2026-01-01', '2026-01-01', 'failed')`, conversationId, `question:${questionId}`);
    notifier.escalate();
    expect(store.questions.get(questionId)!.delivery).toBe('failed');
    expect(sent.some((s) => s.subject === `approval:${x!.id}`)).toBe(true);
  });
});

describe('决定绑定触发这一轮的那条消息（0.3.9）', () => {
  it('「可以」紧接着「等等，不要」：第一轮按「可以」交的决定作废，第二轮按最新的话处理，什么都没放行', async () => {
    await setup();
    const tester = await startTester();
    const { a, b, turn } = await twoImages(tester);
    const { questionId } = tools(turn).call('suggest_decision', { text: '测试助手要读 login-before.png、login-after.png，建议都允许？', items: [{ ref: a, decision: 'allow' }, { ref: b, decision: 'allow' }] }) as { questionId: string };
    // 协调助手这一轮还没结束，你连发两句：两条都排着
    const yes = say('可以');
    const wait = say('等等，不要');
    turn.succeed('');
    const t3 = await coordinatorTurn(3);
    expect(t3.request.prompt).toContain(`这一轮是用户消息 ${yes} 触发的`);
    // 只能用触发这一轮的那条消息
    await expect(tools(t3).async('resolve_approvals', { questionId, items: [{ ref: a, decision: 'deny' }], userMessageId: wait, decisionQuote: '不要' })).rejects.toThrow(/不是触发这一轮的那条/);
    // 按「可以」交：你之后又说了话，作废
    await expect(tools(t3).async('resolve_approvals', { questionId, items: [{ ref: a, decision: 'allow' }, { ref: b, decision: 'allow' }], userMessageId: yes, decisionQuote: '可以' })).rejects.toThrow(/又发了消息.*作废/);
    t3.succeed('');
    const t4 = await coordinatorTurn(4);
    await expect(tools(t4).async('resolve_approvals', { questionId, items: [{ ref: a, decision: 'allow' }], userMessageId: wait, decisionQuote: '等等，不要' })).rejects.toThrow(/还没决定/);
    t4.succeed('好，先不放行。');
    expect([statusOf(a), statusOf(b)]).toEqual(['pending', 'pending']);
    expect(store.questions.get(questionId)!.status).toBe('open');
  });

  it('执行前刚到一条新消息：这次决定不执行', async () => {
    await setup();
    const tester = await startTester();
    const { a, b, turn } = await twoImages(tester);
    const { questionId } = tools(turn).call('suggest_decision', { text: '测试助手要读 login-before.png、login-after.png，建议都允许？', items: [{ ref: a, decision: 'allow' }, { ref: b, decision: 'allow' }] }) as { questionId: string };
    turn.succeed('');
    const yes = say('可以');
    const t3 = await coordinatorTurn(3);
    say('不对，先别读');
    await expect(tools(t3).async('resolve_approvals', { questionId, items: [{ ref: a, decision: 'allow' }], userMessageId: yes, decisionQuote: '可以' })).rejects.toThrow(/作废/);
    t3.succeed('');
    expect([statusOf(a), statusOf(b)]).toEqual(['pending', 'pending']);
  });
});

describe('提交块限定在卡片和问题范围内（0.3.9）', () => {
  function proposeCommitCard(): GitOpRecord {
    const hunk = (id: string, evidenced: boolean) => ({ id, path: 'a.txt', patch: `diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-a\n+${id}\n`, evidenced, note: '', stagedByUser: false });
    const { record } = store.git.proposeOp({
      workspaceId,
      sessionId: main.sessionId,
      runId: null,
      request: { kind: 'commit', message: '加一行', branch: 'main', head: 'abc', scope: { kind: 'session', label: '这个对话发起的任务', taskIds: [] }, hunks: [hunk('0:0', true), hunk('1:0', false)], staged: [] },
    });
    return record;
  }

  it('suggest 只能挑卡片上的块；resolve 只能交问题里列出的块（你没看到的块不会被提交）', async () => {
    await setup();
    say('提交这次的改动');
    const t1 = await coordinatorTurn(1);
    const card = proposeCommitCard();
    expect(() => tools(t1).call('suggest_decision', { text: '提交「加一行」？', items: [{ ref: card.id, decision: 'confirm', hunkIds: ['9:9'] }] })).toThrow(/不在提交卡片/);
    const { questionId } = tools(t1).call('suggest_decision', { text: '提交「加一行」（只含第一块）？', items: [{ ref: card.id, decision: 'confirm', hunkIds: ['0:0'] }] }) as { questionId: string };
    t1.succeed('');
    const msg = say('可以，提交第二块');
    const t2 = await coordinatorTurn(2);
    await expect(tools(t2).async('resolve_approvals', { questionId, items: [{ ref: card.id, decision: 'confirm', hunkIds: ['1:0'] }], userMessageId: msg, decisionQuote: '可以' })).rejects.toThrow(/不在问题里/);
    expect(gitCalls).toEqual([]);
    await tools(t2).async('resolve_approvals', { questionId, items: [{ ref: card.id, decision: 'confirm', hunkIds: ['0:0'] }], userMessageId: msg, decisionQuote: '可以' });
    t2.succeed('');
    expect(gitCalls).toEqual([`${card.id}:confirm:0:0`]);
  });
});
