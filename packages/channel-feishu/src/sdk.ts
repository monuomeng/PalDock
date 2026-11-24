import * as Lark from '@larksuiteoapi/node-sdk';
import { ChannelDeliveryError } from '@paldock/contracts';
import { classifyFeishuError, type FeishuTransport } from './adapter.js';

/** 飞书业务错误码里表示限流的几个（频控），可重试。 */
const RATE_LIMITED = new Set([99991400, 230020]);

interface ApiResponse<T> {
  code?: number;
  msg?: string;
  data?: T;
}

/**
 * 基于官方 SDK（@larksuiteoapi/node-sdk，MIT）的传输层：WSClient 长连接 + Client 调开放接口。
 * 凭据只在构造时传入 SDK，不打印、不落盘；SDK 日志级别设为 warn，不输出事件正文。
 */
export function createLarkTransport(appId: string, appSecret: string, timeoutMs: number): FeishuTransport {
  const base = { appId, appSecret, loggerLevel: Lark.LoggerLevel.warn };
  const client = new Lark.Client(base);
  let ws: Lark.WSClient | undefined;

  async function call<T>(method: 'GET' | 'POST' | 'PATCH', url: string, data?: unknown, params?: Record<string, string>): Promise<T | undefined> {
    let response: ApiResponse<T>;
    try {
      response = await client.request<ApiResponse<T>>({ method, url, data, params, timeout: timeoutMs });
    } catch (error) {
      throw classifyFeishuError(error);
    }
    if (response.code === 0) return response.data;
    const outcome = RATE_LIMITED.has(response.code ?? -1) ? 'retry' : 'failed';
    throw new ChannelDeliveryError(outcome, `飞书返回错误 ${response.code}：${(response.msg ?? '').slice(0, 200)}`);
  }

  return {
    async connect(handlers) {
      const dispatcher = new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': (data: unknown) => handlers.message(data as Parameters<typeof handlers.message>[0]),
        'card.action.trigger': (data: unknown) => handlers.cardAction(data as Parameters<typeof handlers.cardAction>[0]),
      });
      ws = new Lark.WSClient({
        ...base,
        onReady: () => handlers.state('connected'),
        onReconnecting: () => handlers.state('reconnecting'),
        onReconnected: () => handlers.state('connected'),
        onError: (error) => handlers.state('error', error.message.slice(0, 200)),
      });
      await ws.start({ eventDispatcher: dispatcher });
    },
    close() {
      ws?.close();
      ws = undefined;
    },
    async sendCard(chatId, content) {
      const data = await call<{ message_id: string }>('POST', '/open-apis/im/v1/messages', { receive_id: chatId, msg_type: 'interactive', content }, {
        receive_id_type: 'chat_id',
      });
      if (!data?.message_id) throw new ChannelDeliveryError('unknown', '飞书没有返回消息 ID');
      return data.message_id;
    },
    async patchCard(messageId, content) {
      await call('PATCH', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, { content });
    },
    async botOpenId() {
      const data = await call<{ bot?: { open_id?: string } }>('GET', '/open-apis/bot/v3/info');
      return data?.bot?.open_id;
    },
    async userName(openId) {
      const data = await call<{ user?: { name?: string } }>('GET', `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`, undefined, {
        user_id_type: 'open_id',
      });
      return data?.user?.name;
    },
  };
}
