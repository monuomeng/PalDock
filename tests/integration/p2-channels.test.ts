/**
 * P2 验收（离线）：本地服务 + 模拟 Codex + 假的渠道适配器（冒用飞书），走完整的渠道管线：
 * 配对 → 外部建任务 → 进度与验收卡片 → 审批升级与远程审批 → 解绑后拒绝；以及重复事件、限速、出站失败分类。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChannelCredential, CredentialPort } from '@paldock/application';
import {
  ChannelDeliveryError,
  type Card,
  type ChannelAdapter,
  type ChannelAddress,
  type ChannelSink,
  type CommandArgsOf,
  type CommandName,
  type CommandResultOf,
  type InboundEnvelope,
  type PersistentEvent,
} from '@paldock/contracts';
import { LocalService } from '@paldock/local-service';
import { IpcClient, createIpcPath, createToken } from '@paldock/platform';
import { CodexAdapter, MOCK_APP_SERVER_PATH } from '@paldock/runtime-codex';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** 假适配器：记录发出和更新的卡片，测试用 say / click 模拟用户在手机上的操作。 */
class FakeAdapter implements ChannelAdapter {
  readonly provider = 'feishu' as const;
  readonly account = 'cli_test';
  sink: ChannelSink | undefined;
  readonly sent: { chatId: string; card: Card; ref: string }[] = [];
  readonly edits: { ref: string; card: Card }[] = [];
  /** 下一次 send 抛出的错误（测试出站失败分类）。 */
  failNext: ChannelDeliveryError | undefined;

  async start(sink: ChannelSink) {
    this.sink = sink;
    sink.state('connected');
  }
  async stop() {
    this.sink = undefined;
  }
  async send(address: ChannelAddress, card: Card) {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
    const ref = `om_${this.sent.length + 1}`;
    this.sent.push({ chatId: address.chatId, card, ref });
    return ref;
  }
  async edit(_address: ChannelAddress, ref: string, card: Card) {
    this.edits.push({ ref, card });
  }

  address(user: string, kind: 'dm' | 'group' = 'dm'): ChannelAddress {
    return { provider: 'feishu', account: this.account, tenant: 't1', chatId: kind === 'dm' ? `oc_${user}` : 'oc_group', threadKey: '', kind };
  }
  inbound(user: string, body: InboundEnvelope['body'], kind: 'dm' | 'group' = 'dm', eventId = randomUUID()) {
    this.sink!.inbound({ eventId, address: this.address(user, kind), sender: { externalId: `ou_${user}`, displayName: user }, body });
  }
  say(user: string, text: string, kind: 'dm' | 'group' = 'dm', mentionsBot = kind === 'group') {
    this.inbound(user, { kind: 'text', text, mentionsBot }, kind);
  }
  click(user: string, token: string, kind: 'dm' | 'group' = 'dm') {
    this.inbound(user, { kind: 'action', token }, kind);
  }
  /** 所有发出和更新过的卡片，按时间顺序。 */
  cards(): Card[] {
    return [...this.sent.map((s) => s.card), ...this.edits.map((e) => e.card)];
  }
}

class MemoryCredentials implements CredentialPort {
  readonly store = new Map<string, ChannelCredential>();
  async read(target: string) {
    return this.store.get(target);
  }
  async write(target: string, credential: ChannelCredential) {
    this.store.set(target, credential);
  }
  async remove(target: string) {
    this.store.delete(target);
  }
}

let root: string;
let dataRoot: string;
let repo: string;
let service: LocalService;
let client: IpcClient;
let adapter: FakeAdapter;
let credentials: MemoryCredentials;
const events: PersistentEvent[] = [];

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.longpaths=true', '-C', cwd, ...args], { encoding: 'utf8' });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'paldock-p2-'));
  dataRoot = join(root, 'data');
  repo = join(root, 'repo');
  mkdirSync(dataRoot);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  events.length = 0;
  adapter = new FakeAdapter();
  credentials = new MemoryCredentials();
  const token = createToken();
  const ipcPath = createIpcPath(dataRoot);
  service = await LocalService.start({
    dataRoot,
    ipcPath,
    token,
    runtime: new CodexAdapter({ configuredPath: MOCK_APP_SERVER_PATH, extraEnv: { MOCK_CODEX_HOME: join(root, 'mock-home') }, cancelWaitMs: 3_000 }),
    limits: { confirmIntervalMs: 50, expiryScanMs: 50, outputCheckpointMs: 50 },
    channels: {
      createAdapter: async () => adapter,
      credentials,
      limits: { outboxSpacingMs: 0, escalationScanMs: 50, outboxRetryBaseMs: 20 },
    },
  });
  client = new IpcClient((e) => events.push(e), () => {});
  await client.connect(ipcPath, token);
});

afterEach(async () => {
  await client.close();
  await service.stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const call = <N extends CommandName>(name: N, args: CommandArgsOf<N>) => client.request(name, args) as Promise<CommandResultOf<N>>;

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}；已发卡片：${adapter.cards().map((c) => c.title).join(' / ')}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const cardTitled = (title: string | RegExp, from = 0) =>
  waitFor(() => adapter.cards().slice(from).find((c) => (typeof title === 'string' ? c.title === title : title.test(c.title))), `卡片 ${title}`);
const buttonOf = (card: Card, label: string) => card.buttons.find((b) => b.label === label)!.token;

async function enableFeishu() {
  await credentials.write('paldock/feishu', { user: 'cli_test', secret: 's' });
  const [feishu] = await call('channel.overview', {});
  await call('channel.configure', { provider: 'feishu', expectedVersion: feishu!.settings.version, enabled: true });
}

/** 陌生人发消息 → 配对码 → 桌面确认 → 「绑定成功」。 */
async function pair(user: string) {
  const before = adapter.cards().length;
  adapter.say(user, '你好');
  const pairing = await cardTitled('请在电脑上确认绑定', before);
  const code = /配对码：(\w{4})-(\w{4})/.exec(pairing.lines.join('\n'))!.slice(1).join('');
  expect((await call('channel.pairings', {})).map((p) => p.code)).toContain(code);
  await call('channel.decidePairing', { code, approve: true });
  await cardTitled('绑定成功', before);
}

/** 先在桌面建一个任务，登记出唯一的项目（外部建任务时自动用它）。 */
async function registerWorkspace() {
  const created = await call('task.create', { rootPath: repo, goal: '桌面任务', idempotencyKey: `desk-${randomUUID()}` });
  return created.workspace;
}

describe('配对与准入', () => {
  it('启用渠道后状态为已连接，设置页能看到 App ID；未绑定的人只收到配对码，消息不处理', async () => {
    await enableFeishu();
    const [feishu] = await call('channel.overview', {});
    expect(feishu).toMatchObject({ settings: { enabled: true }, status: { state: 'connected' }, appId: 'cli_test' });

    adapter.say('stranger', '/tasks');
    const card = await cardTitled('请在电脑上确认绑定');
    expect(card.lines.join('\n')).not.toContain('最近的任务');
    await waitFor(() => events.some((e) => e.type === 'channel.inbound_rejected' && e.payload.reason === 'unbound'), '审计');

    // 再发一次沿用同一个配对码，不刷屏
    adapter.say('stranger', '还在吗');
    await waitFor(() => adapter.sent.length === 2 || undefined, '第二张配对卡片');
    expect(adapter.sent[1]!.card.lines).toEqual(card.lines);
    expect(await call('channel.pairings', {})).toHaveLength(1);
  });

  it('确认配对后可以用命令；解绑后消息一律拒绝且不回复', async () => {
    await enableFeishu();
    await pair('wang');
    adapter.say('wang', '/help');
    await cardTitled('PalDock 可用命令');

    const [account] = await call('channel.accounts', {});
    expect(account).toMatchObject({ status: 'active', displayName: 'wang' });
    await call('channel.setAccountStatus', { accountId: account!.id, expectedVersion: account!.version, status: 'revoked' });
    const sent = adapter.sent.length;
    adapter.say('wang', '/help');
    await waitFor(() => events.some((e) => e.type === 'channel.inbound_rejected' && e.payload.reason === 'revoked'), '解绑后拒绝');
    expect(adapter.sent.length).toBe(sent);
  });

  it('同一平台事件重复投递只处理一次；超过限速的消息丢弃并记审计', async () => {
    await enableFeishu();
    await pair('wang');
    const before = adapter.sent.length;
    const eventId = randomUUID();
    adapter.inbound('wang', { kind: 'text', text: '/tasks', mentionsBot: false }, 'dm', eventId);
    adapter.inbound('wang', { kind: 'text', text: '/tasks', mentionsBot: false }, 'dm', eventId);
    await cardTitled('还没有任务', before);
    await new Promise((r) => setTimeout(r, 100));
    expect(adapter.sent.length).toBe(before + 1);

    for (let i = 0; i < 12; i++) adapter.say('wang', '/tasks');
    await waitFor(() => events.some((e) => e.type === 'channel.inbound_rejected' && e.payload.reason === 'rate_limited'), '限速');
  });

  it('未加白名单的群、群里未 @ 机器人的消息都被拒绝；加入白名单后群里可以看任务但不能取消', async () => {
    await enableFeishu();
    await pair('wang');
    adapter.say('wang', '/tasks', 'group');
    await waitFor(() => events.some((e) => e.type === 'channel.inbound_rejected' && e.payload.reason === 'group_not_allowed'), '群未加白名单');

    const [group] = await call('channel.groups', {});
    await call('channel.setGroupAllowed', { conversationId: group!.id, expectedVersion: group!.version, allowed: true });
    adapter.say('wang', '/tasks', 'group', false);
    await waitFor(() => events.some((e) => e.type === 'channel.inbound_rejected' && e.payload.reason === 'not_mentioned'), '未 @');

    const before = adapter.cards().length;
    adapter.say('wang', '/tasks', 'group');
    await cardTitled('还没有任务', before);
    adapter.say('wang', '/cancel #abc', 'group');
    await cardTitled('群里不能做这个操作', before);
  });
});

describe('外部建任务与结果回发', () => {
  it('一句话 → 确认卡片 → 建任务执行 → 待命中卡片 → 手机上结束任务', async () => {
    await enableFeishu();
    await pair('wang');
    await registerWorkspace();

    adapter.say('wang', '加一个 hello 文件');
    const confirm = await cardTitled('新建任务？');
    expect(confirm.lines).toContain('目标：加一个 hello 文件');
    adapter.click('wang', buttonOf(confirm, '新建并开始'));
    const created = await cardTitled(/^已新建任务 #/);
    // 确认卡片被更新为结果，而不是另发一条
    expect(adapter.edits.map((e) => e.card)).toContain(created);
    const ref = /#(\w{6})/.exec(created.title)![1]!;

    await cardTitled(new RegExp(`#${ref} `));
    const review = await waitFor(() => adapter.cards().find((c) => c.buttons.some((b) => b.label === '结束任务')), '待命中卡片');
    expect(review.lines.join('\n')).toContain('模拟执行完成');
    adapter.click('wang', buttonOf(review, '结束任务'));
    await waitFor(() => adapter.cards().find((c) => c.lines.some((l) => l.startsWith('任务已结束'))), '已结束卡片');

    const [task] = (await call('task.list', { limit: 10 })).filter((t) => t.task.originConversationId);
    expect(task).toMatchObject({ subtaskStatus: 'succeeded' });

    // 按钮只能用一次：再点一次「结束任务」得到「已失效」
    adapter.click('wang', buttonOf(review, '结束任务'));
    await cardTitled('这个按钮已失效');
  });

  it('待命中时直接回复就是继续（同一 worktree、同一会话）；/done 结束后下一句话是新任务', async () => {
    await enableFeishu();
    await pair('wang');
    await registerWorkspace();
    adapter.say('wang', '写个文件');
    adapter.click('wang', buttonOf(await cardTitled('新建任务？'), '新建并开始'));
    const review = await waitFor(() => adapter.cards().find((c) => c.buttons.some((b) => b.label === '继续')), '待命中卡片');
    const ref = /#(\w{6})/.exec(review.title)![1]!;

    adapter.click('wang', buttonOf(review, '继续'));
    await cardTitled(`请直接回复 #${ref} 的下一步`);
    adapter.say('wang', '文件名改成 b.txt');
    await cardTitled(`#${ref} 继续执行`);
    await waitFor(() => adapter.cards().filter((c) => c.buttons.some((b) => b.label === '继续')).length === 2 || undefined, '第二次待命');
    const [task] = (await call('task.list', { limit: 10 })).filter((t) => t.task.originConversationId);
    const detail = await call('task.get', { taskId: task!.task.id });
    expect(detail.runs).toHaveLength(2);
    expect(detail.runs[0]!.reviews[0]).toMatchObject({ decision: 'rework', note: '文件名改成 b.txt' });
    expect(detail.runs[1]!.run.nativeThreadId).toBe(detail.runs[0]!.run.nativeThreadId);
    expect(adapter.sent.filter((s) => s.card.title === '新建任务？')).toHaveLength(1);

    adapter.say('wang', '/done');
    adapter.click('wang', buttonOf(await cardTitled(`结束 #${ref}？`), '结束任务'));
    await waitFor(async () => (await call('task.get', { taskId: task!.task.id })).subtask.status === 'succeeded' || undefined, '已结束');
    await waitFor(() => adapter.cards().find((c) => c.lines.some((l) => l.startsWith('任务已结束'))), '已结束卡片');
    adapter.say('wang', '再加一个文件');
    await waitFor(() => adapter.sent.filter((s) => s.card.title === '新建任务？').length === 2 || undefined, '新任务确认卡片');
  });

  it('当前任务还在执行时，普通消息不建任务也不续做', async () => {
    await enableFeishu();
    await pair('wang');
    await registerWorkspace();
    adapter.say('wang', '[mock:command] 装依赖');
    adapter.click('wang', buttonOf(await cardTitled('新建任务？'), '新建并开始'));
    const created = await cardTitled(/^已新建任务 #/);
    const ref = /#(\w{6})/.exec(created.title)![1]!;
    await waitFor(async () => {
      const [task] = (await call('task.list', { limit: 10 })).filter((t) => t.task.originConversationId);
      return task?.latestRunStatus === 'waiting_approval' || undefined;
    }, '等待审批');
    adapter.say('wang', '顺便改个名字');
    await cardTitled(`#${ref} 还在执行`);
    expect(adapter.sent.filter((s) => s.card.title === '新建任务？')).toHaveLength(1);
  });

  it('/continue 列出最近的任务；选中桌面上已结束的任务后，一句话就基于它的分支新建任务', async () => {
    await enableFeishu();
    await pair('wang');
    const desk = await call('task.create', { rootPath: repo, goal: '[mock:command] 装依赖', idempotencyKey: `desk-${randomUUID()}` });
    const approval = await waitFor(async () => {
      const d = await call('task.get', { taskId: desk.task.id });
      return d.runs.flatMap((r) => r.approvals).find((a) => a.status === 'pending');
    }, '桌面任务的审批');
    await call('approval.decide', { approvalId: approval.id, expectedVersion: approval.version, decision: 'allow_once' });
    const reviewing = await waitFor(async () => {
      const d = await call('task.get', { taskId: desk.task.id });
      return d.subtask.status === 'review' && d;
    }, '桌面任务待命');
    await call('review.decide', { subtaskId: reviewing.subtask.id, expectedVersion: reviewing.subtask.version, decision: 'accept' });
    const ref = desk.task.id.slice(5, 11);

    const before = adapter.cards().length;
    adapter.say('wang', '/continue');
    const list = await cardTitled('最近的任务', before);
    expect(list.lines[0]).toMatch(new RegExp(`^#${ref} 已完成 · (刚刚|\\d+ 分钟前) · `));
    adapter.click('wang', buttonOf(list, `#${ref}`));
    const history = await cardTitled(new RegExp(`^#${ref} `), before);
    expect(history.lines).toContain('第 1 轮 · 刚刚');
    expect(history.lines.join('\n')).toContain('指令：[mock:command] 装依赖');

    adapter.say('wang', '接着加测试');
    const continued = await cardTitled(new RegExp(`接着 #${ref} 做$`), before);
    const newRef = /#(\w{6})/.exec(continued.title)![1]!;
    const next = (await call('task.list', { limit: 10 })).find((t) => t.task.id.slice(5, 11) === newRef)!;
    expect(next.task.continuedFromTaskId).toBe(desk.task.id);
    const worktree = await waitFor(async () => (await call('task.get', { taskId: next.task.id })).subtask.worktreePath ?? undefined, '新 worktree');
    // 上个任务提交在分支上的文件，新任务的工作目录里也有
    expect(git(worktree, 'ls-files')).toContain('installed.txt');
    // 新任务从这个单聊继续，进度发回这里
    await waitFor(() => adapter.cards().find((c) => c.title.startsWith(`#${newRef} `) && c.lines.includes('开始执行。')), '新任务开始');
  });

  it('解绑后，这个人发起的任务不再往他的单聊发进度', async () => {
    await enableFeishu();
    await pair('wang');
    await registerWorkspace();
    adapter.say('wang', '[mock:command] 装依赖');
    adapter.click('wang', buttonOf(await cardTitled('新建任务？'), '新建并开始'));
    const [task] = await waitFor(async () => {
      const list = (await call('task.list', { limit: 10 })).filter((t) => t.task.originConversationId);
      return list.length > 0 && list;
    }, '外部任务');
    const detail = await waitFor(async () => {
      const d = await call('task.get', { taskId: task!.task.id });
      return d.runs.flatMap((r) => r.approvals).some((a) => a.status === 'pending') && d;
    }, '等待审批');
    const [account] = await call('channel.accounts', {});
    await call('channel.setAccountStatus', { accountId: account!.id, expectedVersion: account!.version, status: 'revoked' });
    const sent = adapter.sent.length;
    const edits = adapter.edits.length;
    const approval = detail.runs.flatMap((r) => r.approvals).find((a) => a.status === 'pending')!;
    await call('approval.decide', { approvalId: approval.id, expectedVersion: approval.version, decision: 'allow_once' });
    await waitFor(async () => (await call('task.get', { taskId: task!.task.id })).subtask.status === 'review' || undefined, '待验收');
    await new Promise((r) => setTimeout(r, 200));
    expect([adapter.sent.length, adapter.edits.length]).toEqual([sent, edits]);
  });

  it('不点确认就不建任务；取消命令要二次确认', async () => {
    await enableFeishu();
    await pair('wang');
    const ws = await registerWorkspace();
    adapter.say('wang', '算了');
    adapter.click('wang', buttonOf(await cardTitled('新建任务？'), '不用了'));
    await cardTitled('好的，不新建任务。');
    expect(await call('task.list', { limit: 10 })).toHaveLength(1);

    const [desk] = await call('task.list', { limit: 10 });
    adapter.say('wang', `/cancel #${desk!.task.id.slice(5, 11)}`);
    const confirm = await cardTitled(/^取消 #/);
    adapter.click('wang', buttonOf(confirm, '确认取消'));
    await cardTitled(/^已取消 #/);
    await waitFor(async () => (await call('task.get', { taskId: desk!.task.id })).subtask.status === 'cancelled' || undefined, '任务已取消');
    expect(ws.remoteApprovalLevel).toBe('L1');
  });
});

describe('审批升级', () => {
  async function waitingApproval(goal: string) {
    const created = await call('task.create', { rootPath: repo, goal, idempotencyKey: `k-${randomUUID()}` });
    return waitFor(async () => {
      const d = await call('task.get', { taskId: created.task.id });
      return d.runs.flatMap((r) => r.approvals).find((a) => a.status === 'pending') && d;
    }, '等待审批');
  }

  it('锁屏时升级到已绑定的单聊，手机上批准后桌面同步、卡片更新为已批准', async () => {
    await enableFeishu();
    await pair('wang');
    const detail = await waitingApproval('[mock:command] 装依赖');
    service.setPresence({ locked: true, idle: false });
    const card = await cardTitled('电脑上有一个审批等你处理');
    expect(card.lines.join('\n')).toContain('中风险');
    expect(await waitFor(() => events.find((e) => e.type === 'approval.escalated'), '升级事件')).toMatchObject({ payload: { channels: ['feishu'] } });

    adapter.click('wang', buttonOf(card, '批准本次'));
    await cardTitled('审批已批准');
    const done = await waitFor(async () => {
      const d = await call('task.get', { taskId: detail.task.id });
      return d.subtask.status === 'review' && d;
    }, '批准后完成');
    expect(done.runs[0]!.approvals[0]).toMatchObject({ status: 'approved', decidedVia: 'feishu' });
  });

  it('L0 项目只发提醒没有按钮；桌面处理后卡片更新，旧按钮失效', async () => {
    await enableFeishu();
    await pair('wang');
    const detail = await waitingApproval('[mock:command] 装依赖');
    await call('workspace.setRemoteApprovalLevel', { workspaceId: detail.workspace.id, expectedVersion: detail.workspace.version, level: 'L0' });
    service.setPresence({ locked: false, idle: true });
    const card = await cardTitled('电脑上有一个审批等你处理');
    expect(card.buttons).toEqual([]);
    expect(card.lines.join('\n')).toContain('远程审批等级是 L0');

    const approval = detail.runs.flatMap((r) => r.approvals).find((a) => a.status === 'pending')!;
    await call('approval.decide', { approvalId: approval.id, expectedVersion: approval.version, decision: 'deny' });
    const decided = await cardTitled('审批已拒绝');
    expect(decided.lines.at(-1)).toBe('在电脑上已拒绝');
    expect(adapter.edits.some((e) => e.card === decided)).toBe(true);
  });

  it('渠道停用时不升级（也不标记已升级）；重新启用后照常升级', async () => {
    await enableFeishu();
    await pair('wang');
    await waitingApproval('[mock:command] 装依赖');
    const [feishu] = await call('channel.overview', {});
    const [off] = await call('channel.configure', { provider: 'feishu', expectedVersion: feishu!.settings.version, enabled: false });
    service.setPresence({ locked: true, idle: false });
    await new Promise((r) => setTimeout(r, 200));
    expect(events.some((e) => e.type === 'approval.escalated')).toBe(false);
    await call('channel.configure', { provider: 'feishu', expectedVersion: off!.settings.version, enabled: true });
    await cardTitled('电脑上有一个审批等你处理');
  });

  it('桌面在场且未到 3 分钟时不升级；没有已绑定的单聊时也不升级', async () => {
    await enableFeishu();
    await waitingApproval('[mock:command] 装依赖');
    service.setPresence({ locked: true, idle: false });
    await new Promise((r) => setTimeout(r, 200));
    expect(events.some((e) => e.type === 'approval.escalated')).toBe(false);

    service.setPresence({ locked: false, idle: false });
    await pair('wang');
    await new Promise((r) => setTimeout(r, 200));
    expect(events.some((e) => e.type === 'approval.escalated')).toBe(false);
    service.setPresence({ locked: true, idle: false });
    await cardTitled('电脑上有一个审批等你处理');
  });
});

describe('出站与渠道设置', () => {
  it('明确拒绝的发送不重试；可重试的错误按退避重发；停用渠道后待发送的不再补发', async () => {
    await enableFeishu();
    adapter.failNext = new ChannelDeliveryError('failed', '没有权限');
    adapter.say('a', '你好');
    await waitFor(() => events.some((e) => e.type === 'channel.pairing_requested') || undefined, '配对请求');
    await new Promise((r) => setTimeout(r, 100));
    expect(adapter.sent).toHaveLength(0);

    adapter.failNext = new ChannelDeliveryError('retry', '网络错误');
    adapter.say('b', '你好');
    await cardTitled('请在电脑上确认绑定');
    expect(adapter.sent).toHaveLength(1);

    const [feishu] = await call('channel.overview', {});
    const stopped = await call('channel.configure', { provider: 'feishu', expectedVersion: feishu!.settings.version, enabled: false });
    expect(stopped[0]!.status.state).toBe('stopped');
  });

  it('凭据只写不回显；没有凭据时状态显示原因', async () => {
    const [feishu] = await call('channel.overview', {});
    const after = await call('channel.configure', { provider: 'feishu', expectedVersion: feishu!.settings.version, enabled: true });
    expect(after[0]!.status).toMatchObject({ state: 'error', detail: expect.stringContaining('没有找到凭据') });

    await expect(call('channel.configure', { provider: 'feishu', expectedVersion: 1, enabled: true, secret: 'x' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    const saved = await call('channel.configure', { provider: 'feishu', expectedVersion: 1, enabled: true, appId: 'cli_test', secret: 'top-secret' });
    expect(credentials.store.get('paldock/feishu')).toEqual({ user: 'cli_test', secret: 'top-secret' });
    expect(JSON.stringify(saved)).not.toContain('top-secret');
    expect(JSON.stringify(events)).not.toContain('top-secret');
    expect(saved[0]!.status.state).toBe('connected');
  });
});
