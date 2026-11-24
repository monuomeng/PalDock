import {
  ChannelDeliveryError,
  classifyNetworkError,
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

/** 用户名查询结果缓存：同一个人只查一次，避免每条消息都打一次接口。 */
const NAME_CACHE_LIMIT = 500;
/** 查名字最多等这么久：消息要先落库平台才算收到，不能被通讯录接口拖住；超时就用 open_id 末尾，下次再查。 */
const NAME_LOOKUP_MS = 1_500;

/**
 * 飞书单聊与群聊适配器：WSClient 长连接收 im.message.receive_v1 和 card.action.trigger（无需公网地址），
 * 回复一律发交互卡片（只有卡片能更新）。入站事件交给 sink 落库后才返回，平台据此确认收到。
 */
export class FeishuAdapter implements ChannelAdapter {
  readonly provider = 'feishu' as const;
  private sink: ChannelSink | undefined;
  private ctx: ParseContext;
  private readonly names = new Map<string, string>();

  constructor(
    readonly account: string,
    private readonly transport: FeishuTransport,
  ) {
    this.ctx = { account, botOpenId: undefined };
  }

  async start(sink: ChannelSink): Promise<void> {
    this.sink = sink;
    // 机器人 open_id 只用来判断群里是否 @ 了它；拿不到不影响单聊，与建连并行
    void this.transport.botOpenId().then(
      (botOpenId) => (this.ctx = { account: this.account, botOpenId }),
      () => undefined,
    );
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
    let name = this.names.get(openId);
    if (!name) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), NAME_LOOKUP_MS)));
      name = await Promise.race([this.transport.userName(openId).catch(() => undefined), timeout]);
      clearTimeout(timer);
      if (name) {
        if (this.names.size >= NAME_CACHE_LIMIT) this.names.clear();
        this.names.set(openId, name);
      }
    }
    // 拿不到名字时显示 open_id 末 6 位，便于在桌面核对是谁
    return name ?? `飞书用户 …${openId.slice(-6)}`;
  }

  send(address: ChannelAddress, card: Card): Promise<string> {
    return this.transport.sendCard(address.chatId, renderCard(card, address.kind));
  }

  edit(address: ChannelAddress, messageRef: string, card: Card): Promise<void> {
    return this.transport.patchCard(messageRef, renderCard(card, address.kind));
  }
}

/** 飞书接口（axios）错误 → 投递结果：限流与服务端错误可重试，超时与连接中断不确定，其余 4xx（权限、参数、被移出群）不重试。 */
export function classifyFeishuError(error: unknown): ChannelDeliveryError {
  if (error instanceof ChannelDeliveryError) return error;
  const e = error as { code?: unknown; response?: { status?: number }; message?: string };
  const status = e.response?.status;
  return classifyNetworkError({
    ...(typeof e.code === 'string' ? { code: e.code } : {}),
    ...(status !== undefined ? { status } : {}),
    message: `飞书：${(e.message ?? String(error)).slice(0, 200)}`,
  });
}
