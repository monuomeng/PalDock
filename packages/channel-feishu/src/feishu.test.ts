import { ChannelDeliveryError, type ChannelSink, type ChannelState, type InboundEnvelope } from '@paldock/contracts';
import { describe, expect, it } from 'vitest';
import { classifyFeishuError, FeishuAdapter, type FeishuTransport } from './adapter.js';
import { parseCardAction, parseMessage, type MessageEvent } from './parse.js';
import { renderCard } from './render.js';

const ctx = { account: 'cli_app', botOpenId: 'ou_bot' };

/** 与 P0 实测的 im.message.receive_v1（EventDispatcher 合并 header 后）同形的样本；ID 为虚构。 */
const message = (over: Partial<NonNullable<MessageEvent['message']>> = {}): MessageEvent => ({
  event_id: 'ev_1',
  tenant_key: 'tk',
  sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
  message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '加一个文件' }), ...over },
});

describe('飞书事件解析', () => {
  it('单聊文字消息', () => {
    expect(parseMessage(message(), ctx)).toEqual({
      eventId: 'ev_1',
      address: { provider: 'feishu', account: 'cli_app', tenant: 'tk', chatId: 'oc_1', threadKey: '', kind: 'dm' },
      sender: { externalId: 'ou_user' },
      body: { kind: 'text', text: '加一个文件', mentionsBot: false },
    });
  });

  it('群聊里去掉 @ 占位符，并判断是否 @ 了机器人', () => {
    const mentions = [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'PalDock' }];
    const parsed = parseMessage(message({ chat_type: 'group', content: JSON.stringify({ text: '@_user_1  /tasks' }), mentions }), ctx);
    expect(parsed?.body).toEqual({ kind: 'text', text: '/tasks', mentionsBot: true });
    expect(parsed?.address.kind).toBe('group');
    const other = parseMessage(message({ chat_type: 'group', mentions: [{ key: '@_user_1', id: { open_id: 'ou_x' } }] }), ctx);
    expect(other?.body).toMatchObject({ mentionsBot: false });
    // 拿不到机器人 open_id 时，任何 @ 都算（飞书默认只推 @机器人 的群消息）
    expect(parseMessage(message({ chat_type: 'group', mentions: [{ key: '@_user_1' }] }), { ...ctx, botOpenId: undefined })?.body).toMatchObject({
      mentionsBot: true,
    });
  });

  it('非文字消息转为空文本；机器人发的消息与缺字段的事件不处理', () => {
    expect(parseMessage(message({ message_type: 'image', content: '{"image_key":"x"}' }), ctx)?.body).toMatchObject({ text: '' });
    expect(parseMessage({ ...message(), sender: { sender_id: { open_id: 'ou_x' }, sender_type: 'app' } }, ctx)).toBeUndefined();
    expect(parseMessage({ event_id: 'e' }, ctx)).toBeUndefined();
  });

  it('卡片回调：取动作令牌和会话类型；值缺失或类型不对时不处理', () => {
    const data = {
      event_id: 'ev_2',
      tenant_key: 'tk',
      operator: { open_id: 'ou_user', name: '小王' },
      action: { value: { t: 'tok', k: 'dm' as const } },
      context: { open_message_id: 'om_1', open_chat_id: 'oc_1' },
    };
    expect(parseCardAction(data, ctx)).toEqual({
      eventId: 'ev_2',
      address: { provider: 'feishu', account: 'cli_app', tenant: 'tk', chatId: 'oc_1', threadKey: '', kind: 'dm' },
      sender: { externalId: 'ou_user' },
      body: { kind: 'action', token: 'tok' },
    });
    expect(parseCardAction({ ...data, event_id: undefined }, ctx)?.eventId).toBe('card:om_1:tok');
    expect(parseCardAction({ ...data, action: { value: JSON.stringify({ t: 'tok', k: 'group' }) } }, ctx)?.address.kind).toBe('group');
    expect(parseCardAction({ ...data, action: { value: { t: 'tok' } } }, ctx)).toBeUndefined();
  });
});

describe('卡片渲染', () => {
  it('纯文本卡片，按钮带令牌与会话类型，可被后续更新', () => {
    const json = JSON.parse(
      renderCard({ title: '审批', tone: 'danger', lines: ['a', '**b**'], buttons: [{ label: '批准', token: 'tok', style: 'primary' }] }, 'dm'),
    );
    expect(json.config).toEqual({ wide_screen_mode: true, update_multi: true });
    expect(json.header).toEqual({ title: { tag: 'plain_text', content: '审批' }, template: 'red' });
    expect(json.elements[0]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: 'a\n**b**' } });
    expect(json.elements[1].actions[0]).toMatchObject({ type: 'primary', value: { t: 'tok', k: 'dm' } });
    expect(JSON.parse(renderCard({ title: 't', tone: 'info', lines: [], buttons: [] }, 'dm')).elements).toHaveLength(1);
  });
});

describe('错误分类', () => {
  it('超时与连接中断不确定是否发出；限流、5xx、网络不可达可重试；其余不重试', () => {
    expect(classifyFeishuError({ code: 'ECONNABORTED', message: 'timeout' }).outcome).toBe('unknown');
    expect(classifyFeishuError({ code: 'ECONNRESET' }).outcome).toBe('unknown');
    expect(classifyFeishuError({ code: 'ENOTFOUND' }).outcome).toBe('retry');
    expect(classifyFeishuError({ response: { status: 429 } }).outcome).toBe('retry');
    expect(classifyFeishuError({ response: { status: 502 } }).outcome).toBe('retry');
    expect(classifyFeishuError({ response: { status: 400 }, message: 'bad' }).outcome).toBe('failed');
    const own = new ChannelDeliveryError('retry', 'x');
    expect(classifyFeishuError(own)).toBe(own);
  });
});

describe('适配器', () => {
  function setup(userName: (id: string) => Promise<string | undefined> = async () => '小王') {
    let handlers!: Parameters<FeishuTransport['connect']>[0];
    const calls: string[] = [];
    const transport: FeishuTransport = {
      connect: async (h) => {
        handlers = h;
        h.state('connected');
      },
      close: () => calls.push('close'),
      sendCard: async (chatId) => (calls.push(`send:${chatId}`), 'om_9'),
      patchCard: async (id) => void calls.push(`patch:${id}`),
      botOpenId: async () => 'ou_bot',
      userName: async (id) => (calls.push(`name:${id}`), userName(id)),
    };
    const inbound: InboundEnvelope[] = [];
    const states: ChannelState[] = [];
    const sink: ChannelSink = { inbound: (e) => inbound.push(e), state: (s) => states.push(s) };
    const adapter = new FeishuAdapter('cli_app', transport);
    return { adapter, sink, inbound, states, calls, handlers: () => handlers };
  }

  it('消息带上显示名交给管线，名字只查一次；查不到时用 open_id 末尾', async () => {
    const { adapter, sink, inbound, states, calls, handlers } = setup();
    await adapter.start(sink);
    await handlers().message(message());
    await handlers().message({ ...message(), event_id: 'ev_3' });
    expect(states).toEqual(['connected']);
    expect(inbound.map((e) => e.sender)).toEqual([
      { externalId: 'ou_user', displayName: '小王' },
      { externalId: 'ou_user', displayName: '小王' },
    ]);
    expect(calls.filter((c) => c.startsWith('name:'))).toHaveLength(1);

    const anonymous = setup(async () => undefined);
    await anonymous.adapter.start(anonymous.sink);
    await anonymous.handlers().message(message());
    expect(anonymous.inbound[0]!.sender.displayName).toBe('飞书用户 …u_user');
  });

  it('卡片回调立即回一个提示；发送与更新调用对应接口；停止后不再接收', async () => {
    const { adapter, sink, inbound, calls, handlers } = setup();
    await adapter.start(sink);
    const reply = await handlers().cardAction({
      operator: { open_id: 'ou_user' },
      action: { value: { t: 'tok', k: 'dm' } },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
    });
    expect(reply).toEqual({ toast: { type: 'info', content: '已收到，处理中' } });
    expect(inbound[0]!.body).toEqual({ kind: 'action', token: 'tok' });

    const address = inbound[0]!.address;
    expect(await adapter.send(address, { title: 't', tone: 'info', lines: [], buttons: [] })).toBe('om_9');
    await adapter.edit(address, 'om_9', { title: 't', tone: 'info', lines: [], buttons: [] });
    await adapter.stop();
    await handlers().message(message());
    expect(inbound).toHaveLength(1);
    expect(calls).toEqual(['send:oc_1', 'patch:om_9', 'close']);
  });
});
