import type { Card, ChannelAdapter, ChannelAddress, ChannelSink } from '@paldock/contracts';
import { classifyTelegramError, isNotModified, TelegramApiError, type TelegramCall } from './api.js';
import { parseUpdate, renderMessage, type BotIdentity, type TgUpdate } from './parse.js';

/** 长轮询的游标（下一个 update_id），存在本地库里，重启后不重复也不漏收。 */
export interface CursorPort {
  get(): string | undefined;
  set(cursor: string): void;
}

export interface TelegramAdapterOptions {
  api: { call: TelegramCall; close(): Promise<void> };
  cursor: CursorPort;
  sendTimeoutMs: number;
  /** 长轮询每次在 Telegram 端最多挂起的秒数。 */
  pollSeconds?: number;
  /** 出错后重试的起始与最大间隔。 */
  backoffMs?: { base: number; max: number };
}

const DEFAULT_POLL_SECONDS = 25;
const DEFAULT_BACKOFF = { base: 1_000, max: 60_000 };

/**
 * Telegram 适配器：getUpdates 长轮询（无需公网地址、不用 webhook），回复发带内联键盘的纯文本消息。
 * 一批更新全部交给 sink 落库后才推进游标；sink 按 eventId 去重，所以重放一批不会重复处理。
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly provider = 'telegram' as const;
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    /** bot 的数字 ID，即 Bot Token 冒号前的部分。 */
    readonly account: string,
    private readonly options: TelegramAdapterOptions,
  ) {}

  async start(sink: ChannelSink): Promise<void> {
    this.controller = new AbortController();
    this.loop = this.poll(sink, this.controller.signal);
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    await this.loop;
    await this.options.api.close();
  }

  private async poll(sink: ChannelSink, signal: AbortSignal): Promise<void> {
    const { call } = this.options.api;
    const pollSeconds = this.options.pollSeconds ?? DEFAULT_POLL_SECONDS;
    const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF;
    let bot: BotIdentity | undefined;
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (!bot) {
          const me = await call<{ id: number; username?: string }>('getMe', {}, { timeoutMs: this.options.sendTimeoutMs, signal });
          bot = { id: String(me.id), username: me.username ?? '' };
          sink.state('connected');
        }
        const offset = Number(this.options.cursor.get() ?? 0);
        const updates = await call<TgUpdate[]>(
          'getUpdates',
          { offset, timeout: pollSeconds, allowed_updates: ['message', 'callback_query'] },
          { timeoutMs: (pollSeconds + 10) * 1000, signal },
        );
        if (failures > 0) sink.state('connected');
        failures = 0;
        this.deliver(sink, bot, updates);
      } catch (error) {
        if (signal.aborted) return;
        const fatal = fatalReason(error);
        if (fatal) return sink.state('error', fatal);
        failures += 1;
        sink.state(error instanceof TelegramApiError && error.status === 409 ? 'error' : 'reconnecting', describe(error));
        const retryAfter = error instanceof TelegramApiError ? (error.retryAfterSeconds ?? 0) * 1000 : 0;
        await sleep(Math.max(retryAfter, Math.min(backoff.max, backoff.base * 2 ** (failures - 1))), signal);
      }
    }
  }

  private deliver(sink: ChannelSink, bot: BotIdentity, updates: TgUpdate[]): void {
    if (updates.length === 0) return;
    for (const update of updates) {
      const envelope = parseUpdate(update, bot);
      if (envelope) sink.inbound(envelope);
      // 回调要应答，否则按钮一直转圈；应答失败不影响处理
      if (update.callback_query) {
        void this.options.api
          .call('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: '已收到，处理中' }, { timeoutMs: this.options.sendTimeoutMs })
          .catch(() => undefined);
      }
    }
    this.options.cursor.set(String(updates.at(-1)!.update_id + 1));
  }

  async send(address: ChannelAddress, card: Card): Promise<string> {
    try {
      const message = await this.options.api.call<{ message_id: number }>(
        'sendMessage',
        { chat_id: address.chatId, ...renderMessage(card) },
        { timeoutMs: this.options.sendTimeoutMs },
      );
      return String(message.message_id);
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }

  async edit(address: ChannelAddress, messageRef: string, card: Card): Promise<void> {
    // 显式传空键盘：新卡片没有按钮时把旧按钮去掉
    const body = { reply_markup: { inline_keyboard: [] }, ...renderMessage(card), chat_id: address.chatId, message_id: Number(messageRef) };
    try {
      await this.options.api.call('editMessageText', body, { timeoutMs: this.options.sendTimeoutMs });
    } catch (error) {
      if (!isNotModified(error)) throw classifyTelegramError(error);
    }
  }
}

/** 重试也没用的错误：Token 无效或 bot 被删。 */
function fatalReason(error: unknown): string | undefined {
  if (error instanceof TelegramApiError && (error.status === 401 || error.status === 404)) return 'Bot Token 无效或已被撤销，请在设置里重新填写';
  return undefined;
}

function describe(error: unknown): string {
  if (error instanceof TelegramApiError && error.status === 409) return '这个 bot 设置了 webhook 或另有程序在收消息，请先停掉对方';
  return classifyTelegramError(error).message;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
