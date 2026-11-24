import { ChannelDeliveryError, type ChannelSink, type ChannelState, type InboundEnvelope } from '@paldock/contracts';
import { describe, expect, it } from 'vitest';
import { TelegramAdapter } from './adapter.js';
import { classifyTelegramError, isNotModified, TelegramApiError, type TelegramCall } from './api.js';
import { parseUpdate, renderMessage, type TgMessage, type TgUpdate } from './parse.js';

const bot = { id: '42', username: 'PalDockBot' };
const user = { id: 7, first_name: '小', last_name: '王' };

/** 与 Bot API 文档同形的样本；ID 为虚构。 */
const text = (over: Partial<TgMessage> = {}, update_id = 100): TgUpdate => ({
  update_id,
  message: { message_id: 1, from: user, chat: { id: 7, type: 'private' }, text: '加一个文件', ...over },
});

describe('Telegram 更新解析', () => {
  it('私聊文字消息', () => {
    expect(parseUpdate(text(), bot)).toEqual({
      eventId: 'update:100',
      address: { provider: 'telegram', account: '42', tenant: '', chatId: '7', threadKey: '', kind: 'dm' },
      sender: { externalId: '7', displayName: '小 王' },
      body: { kind: 'text', text: '加一个文件', mentionsBot: false },
    });
  });

  it('群里识别 @机器人、回复机器人、/命令@机器人，并去掉 @机器人', () => {
    const group = { id: -100, type: 'supergroup' as const };
    const mention = parseUpdate(text({ chat: group, text: '@PalDockBot  /tasks', entities: [{ type: 'mention', offset: 0, length: 11 }] }), bot);
    expect(mention?.body).toEqual({ kind: 'text', text: '/tasks', mentionsBot: true });
    expect(mention?.address.kind).toBe('group');
    expect(parseUpdate(text({ chat: group, text: '好的', reply_to_message: { from: { id: 42 } } }), bot)?.body).toMatchObject({ mentionsBot: true });
    expect(parseUpdate(text({ chat: group, text: '/status@paldockbot abc', entities: [{ type: 'bot_command', offset: 0, length: 18 }] }), bot)?.body).toEqual({
      kind: 'text',
      text: '/status abc',
      mentionsBot: true,
    });
    expect(parseUpdate(text({ chat: group, text: '@other hi', entities: [{ type: 'mention', offset: 0, length: 6 }] }), bot)?.body).toMatchObject({
      mentionsBot: false,
    });
  });

  it('非文字消息转为空文本；bot 发的、频道里的消息不处理', () => {
    expect(parseUpdate(text({ text: undefined }), bot)?.body).toMatchObject({ text: '' });
    expect(parseUpdate(text({ from: { id: 9, is_bot: true } }), bot)).toBeUndefined();
    expect(parseUpdate(text({ chat: { id: -1, type: 'channel' } }), bot)).toBeUndefined();
    expect(parseUpdate({ update_id: 1 }, bot)).toBeUndefined();
  });

  it('按钮回调取 callback_data 作为动作令牌', () => {
    const update: TgUpdate = { update_id: 5, callback_query: { id: 'cq', from: user, message: { message_id: 3, chat: { id: 7, type: 'private' } }, data: 'tok' } };
    expect(parseUpdate(update, bot)).toMatchObject({ eventId: 'update:5', body: { kind: 'action', token: 'tok' }, address: { kind: 'dm' } });
  });
});

describe('消息渲染', () => {
  it('纯文本加语气标记，按钮一行，超长截断', () => {
    expect(renderMessage({ title: '审批', tone: 'danger', lines: ['a', '*b*'], buttons: [{ label: '批准', token: 'tok', style: 'primary' }] })).toEqual({
      text: '⛔ 审批\n\na\n*b*',
      reply_markup: { inline_keyboard: [[{ text: '批准', callback_data: 'tok' }]] },
    });
    expect(renderMessage({ title: 't', tone: 'info', lines: ['x'.repeat(5000)], buttons: [] }).text).toHaveLength(4096);
  });
});

describe('错误分类', () => {
  it('429 与 5xx、连不上可重试；超时与中断不确定；其余 4xx 不重试；未修改算成功', () => {
    expect(classifyTelegramError(new TelegramApiError(429, 'Too Many Requests', 3)).outcome).toBe('retry');
    expect(classifyTelegramError(new TelegramApiError(502, 'Bad Gateway')).outcome).toBe('retry');
    expect(classifyTelegramError(new TelegramApiError(403, 'bot was blocked by the user')).outcome).toBe('failed');
    expect(classifyTelegramError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).outcome).toBe('retry');
    expect(classifyTelegramError(new Error('Proxy response (403) !== 200 when HTTP Tunneling')).outcome).toBe('retry');
    expect(classifyTelegramError(Object.assign(new Error('x'), { name: 'TimeoutError' })).outcome).toBe('unknown');
    expect(classifyTelegramError(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })).outcome).toBe('unknown');
    const own = new ChannelDeliveryError('retry', 'x');
    expect(classifyTelegramError(own)).toBe(own);
    expect(isNotModified(new TelegramApiError(400, 'Bad Request: message is not modified: ...'))).toBe(true);
  });
});

describe('适配器', () => {
  /** 按方法名排队应答；getUpdates 队列空时挂起直到停止。 */
  function setup(script: Record<string, (body: Record<string, unknown>) => unknown> = {}) {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const updates: (TgUpdate[] | Error)[] = [];
    let cursor: string | undefined;
    const call: TelegramCall = async <T,>(method: string, body: object, options: { signal?: AbortSignal }) => {
      calls.push({ method, body: body as Record<string, unknown> });
      if (method === 'getUpdates') {
        const next = updates.shift();
        if (next instanceof Error) throw next;
        if (next) return next as T;
        await new Promise((resolve) => options.signal?.addEventListener('abort', resolve));
        throw new Error('aborted');
      }
      const handler = script[method];
      if (handler) return handler(body as Record<string, unknown>) as T;
      if (method === 'getMe') return { id: 42, username: 'PalDockBot' } as T;
      return { message_id: 9 } as T;
    };
    let closed = false;
    const inbound: InboundEnvelope[] = [];
    const states: [ChannelState, string | undefined][] = [];
    const sink: ChannelSink = { inbound: (e) => inbound.push(e), state: (s, d) => states.push([s, d]) };
    const adapter = new TelegramAdapter('42', {
      api: { call, close: async () => void (closed = true) },
      cursor: { get: () => cursor, set: (c) => (cursor = c) },
      sendTimeoutMs: 1000,
      backoffMs: { base: 1, max: 5 },
    });
    return { adapter, sink, inbound, states, calls, updates, cursor: () => cursor, closed: () => closed };
  }

  const settle = async (until: () => boolean) => {
    for (let i = 0; i < 100 && !until(); i++) await new Promise((r) => setTimeout(r, 2));
  };

  it('收到一批更新后全部交给管线再推进游标，按钮回调会应答；停止后关闭连接', async () => {
    const t = setup();
    const callback: TgUpdate = { update_id: 101, callback_query: { id: 'cq', from: user, message: { message_id: 3, chat: { id: 7, type: 'private' } }, data: 'tok' } };
    t.updates.push([text(), callback]);
    await t.adapter.start(t.sink);
    await settle(() => t.cursor() === '102');
    expect(t.states).toEqual([['connected', undefined]]);
    expect(t.inbound.map((e) => e.body.kind)).toEqual(['text', 'action']);
    expect(t.calls.find((c) => c.method === 'answerCallbackQuery')?.body).toMatchObject({ callback_query_id: 'cq' });
    // 下一轮从新游标开始
    await settle(() => t.calls.filter((c) => c.method === 'getUpdates').length === 2);
    expect(t.calls.filter((c) => c.method === 'getUpdates').map((c) => c.body.offset)).toEqual([0, 102]);
    await t.adapter.stop();
    expect(t.closed()).toBe(true);
  });

  it('网络错误进入重连并恢复；Token 无效时停在错误状态；409 提示冲突', async () => {
    const t = setup();
    t.updates.push(Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }), new TelegramApiError(409, 'Conflict'), []);
    await t.adapter.start(t.sink);
    await settle(() => t.states.length >= 4);
    expect(t.states.map(([s]) => s)).toEqual(['connected', 'reconnecting', 'error', 'connected']);
    expect(t.states[2]![1]).toContain('webhook');
    await t.adapter.stop();

    const bad = setup({
      getMe: () => {
        throw new TelegramApiError(401, 'Unauthorized');
      },
    });
    await bad.adapter.start(bad.sink);
    await settle(() => bad.states.length > 0);
    expect(bad.states).toEqual([['error', 'Bot Token 无效或已被撤销，请在设置里重新填写']]);
    expect(bad.calls.map((c) => c.method)).toEqual(['getMe']);
    await bad.adapter.stop();
  });

  it('发送返回消息 ID；更新时没有按钮会清掉旧键盘，内容未变算成功；失败按类别抛出', async () => {
    const address = { provider: 'telegram' as const, account: '42', tenant: '', chatId: '7', threadKey: '', kind: 'dm' as const };
    const card = { title: 't', tone: 'info' as const, lines: [], buttons: [] };
    let editError: Error | undefined = new TelegramApiError(400, 'Bad Request: message is not modified');
    const t = setup({
      editMessageText: () => {
        if (editError) throw editError;
        return true;
      },
      sendMessage: () => {
        throw new TelegramApiError(403, 'Forbidden: bot was blocked by the user');
      },
    });
    await t.adapter.edit(address, '9', card);
    expect(t.calls.at(-1)?.body).toMatchObject({ chat_id: '7', message_id: 9, reply_markup: { inline_keyboard: [] } });
    editError = new TelegramApiError(429, 'Too Many Requests');
    await expect(t.adapter.edit(address, '9', card)).rejects.toMatchObject({ outcome: 'retry' });
    await expect(t.adapter.send(address, card)).rejects.toMatchObject({ outcome: 'failed' });
    expect(await setup().adapter.send(address, card)).toBe('9');
  });
});
