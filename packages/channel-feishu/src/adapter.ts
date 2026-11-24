import {
  ChannelDeliveryError,
  type Card,
  type ChannelAdapter,
  type ChannelAddress,
  type ChannelSink,
  type ChannelState,
} from '@paldock/contracts';
import { parseCardAction, parseMessage, type CardActionEvent, type MessageEvent, type ParseContext } from './parse.js';
import { renderCard } from './render.js';

/** 飞书开放平台的最小调用面；真实实现见 sdk.ts，测试注入假的。 */
export interface FeishuTransport {
  /** 长连接：收到事件时调用 handlers；返回值作为卡片回调的响应。 */
  connect(handlers: {
    message(data: MessageEvent): Promise<void>;
    cardAction(data: CardActionEvent): Promise<unknown>;
    state(state: ChannelState, detail?: string): void;
  }): Promise<void>;
  close(): void;
  sendCard(chatId: string, content: string): Promise<string>;
  patchCard(messageId: string, content: string): Promise<void>;
  botOpenId(): Promise<string | undefined>;
  /** 用户显示名（需要通讯录权限）；拿不到时返回 undefined。 */
  userName(openId: string): Promise<string | undefined>;
}

/** 用户名查询结果缓存：同一个人只查一次，查不到也记下，避免每条消息都打一次接口。 */
const NAME_CACHE_LIMIT = 500;

/**
 * 飞书单聊与群聊适配器：WSClient 长连接收 im.message.receive_v1 和 card.action.trigger（无需公网地址），
 * 回复一律发交互卡片（只有卡片能更新）。入站事件交给 sink 落库后才返回，平台据此确认收到。
 */
export class FeishuAdapter implements ChannelAdapter {
  readonly provider = 'feishu' as const;
  private sink: ChannelSink | undefined;
  private ctx: ParseContext;
  private readonly names = new Map<string, string | undefined>();

  constructor(
    readonly account: string,
    private readonly transport: FeishuTransport,
  ) {
    this.ctx = { account, botOpenId: undefined };
  }

  async start(sink: ChannelSink): Promise<void> {
    this.sink = sink;
    // 机器人 open_id 只用来判断群里是否 @ 了它；拿不到不影响单聊
    this.ctx = { account: this.account, botOpenId: await this.transport.botOpenId().catch(() => undefined) };
    await this.transport.connect({
      message: (data) => this.onMessage(data),
      cardAction: (data) => this.onCardAction(data),
      state: (state, detail) => this.sink?.state(state, detail),
    });
  }

  async stop(): Promise<void> {
    this.sink = undefined;
    this.transport.close();
  }

  private async onMessage(data: MessageEvent): Promise<void> {
    const parsed = parseMessage(data, this.ctx);
    if (!parsed || !this.sink) return;
    const displayName = await this.displayName(parsed.sender.externalId);
    this.sink.inbound({ ...parsed, sender: { ...parsed.sender, displayName } });
  }

  /** 卡片回调要在 3 秒内响应：只落库，返回一个提示，结果另发卡片。 */
  private async onCardAction(data: CardActionEvent): Promise<unknown> {
    const parsed = parseCardAction(data, this.ctx);
    if (!parsed || !this.sink) return {};
    this.sink.inbound({ ...parsed, sender: { ...parsed.sender, displayName: data.operator?.name ?? '' } });
    return { toast: { type: 'info', content: '已收到，处理中' } };
  }

  private async displayName(openId: string): Promise<string> {
    if (!this.names.has(openId)) {
      if (this.names.size >= NAME_CACHE_LIMIT) this.names.clear();
      this.names.set(openId, await this.transport.userName(openId).catch(() => undefined));
    }
    // 拿不到名字时显示 open_id 末 6 位，便于在桌面核对是谁
    return this.names.get(openId) ?? `飞书用户 …${openId.slice(-6)}`;
  }

  send(address: ChannelAddress, card: Card): Promise<string> {
    return this.transport.sendCard(address.chatId, renderCard(card, address.kind));
  }

  edit(address: ChannelAddress, messageRef: string, card: Card): Promise<void> {
    return this.transport.patchCard(messageRef, renderCard(card, address.kind));
  }
}

/** 飞书接口错误 → 投递结果：限流与服务端错误可重试，超时不确定，其余（权限、参数、被移出群）不重试。 */
export function classifyFeishuError(error: unknown): ChannelDeliveryError {
  if (error instanceof ChannelDeliveryError) return error;
  const e = error as { code?: string | number; response?: { status?: number }; message?: string };
  const status = e.response?.status;
  const message = (e.message ?? String(error)).slice(0, 200);
  if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') return new ChannelDeliveryError('unknown', `飞书接口超时：${message}`);
  if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return new ChannelDeliveryError('retry', `网络不可用：${message}`);
  if (status === 429 || (status !== undefined && status >= 500)) return new ChannelDeliveryError('retry', `飞书接口暂时不可用（${status}）`);
  if (e.code === 'ECONNRESET' || e.code === 'EPIPE') return new ChannelDeliveryError('unknown', `连接中断：${message}`);
  return new ChannelDeliveryError('failed', `飞书拒绝了请求：${message}`);
}
