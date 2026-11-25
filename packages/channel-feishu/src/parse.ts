import type { ChannelAddress, InboundEnvelope } from '@paldock/contracts';
import type { ButtonValue } from './render.js';

/**
 * 飞书事件 → InboundEnvelope 的纯函数（EventDispatcher 已把 header 与 event 合并成一个对象）。
 * 只取 PalDock 需要的字段；不认识的消息类型转成空文本，由命令层提示「只支持文字」。
 */

export interface MessageEvent {
  event_id?: string;
  tenant_key?: string;
  sender?: { sender_id?: { open_id?: string }; sender_type?: string };
  message?: {
    message_id: string;
    parent_id?: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: { key: string; id?: { open_id?: string }; name?: string }[];
  };
}

export interface CardActionEvent {
  event_id?: string;
  tenant_key?: string;
  operator?: { open_id?: string; name?: string };
  action?: { value?: Partial<ButtonValue> | string };
  context?: { open_message_id?: string; open_chat_id?: string };
}

export interface ParseContext {
  /** App ID：渠道账号。 */
  account: string;
  /** 机器人自己的 open_id；拿不到时群里任何 @ 都算 @ 了机器人（飞书默认只把 @机器人 的群消息推给应用）。 */
  botOpenId: string | undefined;
}

type Parsed = Omit<InboundEnvelope, 'sender'> & { sender: { externalId: string } };

function address(ctx: ParseContext, tenant: string | undefined, chatId: string, kind: ChannelAddress['kind']): ChannelAddress {
  // P2 不按话题分会话：卡片回调里拿不到话题 ID，分开后按钮会对不上会话
  return { provider: 'feishu', account: ctx.account, tenant: tenant ?? '', chatId, threadKey: '', kind };
}

/** 文本消息里 @ 的占位符形如 @_user_1，去掉后剩下用户真正写的内容。 */
function textOf(message: NonNullable<MessageEvent['message']>): string {
  if (message.message_type !== 'text') return '';
  try {
    const { text } = JSON.parse(message.content) as { text?: string };
    return (text ?? '').replace(/@_user_\d+/g, '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

export function parseMessage(data: MessageEvent, ctx: ParseContext): Parsed | undefined {
  const message = data.message;
  const sender = data.sender?.sender_id?.open_id;
  // 只处理人发的消息（机器人自己的消息、其他应用的消息不处理）
  if (!message || !sender || (data.sender?.sender_type && data.sender.sender_type !== 'user')) return undefined;
  const kind = message.chat_type === 'p2p' ? 'dm' : 'group';
  const mentions = message.mentions ?? [];
  const mentionsBot = ctx.botOpenId ? mentions.some((m) => m.id?.open_id === ctx.botOpenId) : mentions.length > 0;
  return {
    eventId: data.event_id ?? `message:${message.message_id}`,
    address: address(ctx, data.tenant_key, message.chat_id, kind),
    sender: { externalId: sender },
    // 引用回复时 parent_id 是被引用消息的 ID（对得上我们发出的卡片就能认出是在回答哪个问题）
    body: { kind: 'text', text: textOf(message), mentionsBot, ...(message.parent_id ? { replyTo: message.parent_id } : {}) },
  };
}

export function parseCardAction(data: CardActionEvent, ctx: ParseContext): Parsed | undefined {
  const value = typeof data.action?.value === 'string' ? (JSON.parse(data.action.value) as Partial<ButtonValue>) : data.action?.value;
  const chatId = data.context?.open_chat_id;
  const operator = data.operator?.open_id;
  if (!value?.t || !chatId || !operator || (value.k !== 'dm' && value.k !== 'group')) return undefined;
  return {
    // 同一次点击的重投递带同一个 event_id；没有时用消息 + 令牌兜底（令牌本身也是一次性的）
    eventId: data.event_id ?? `card:${data.context?.open_message_id ?? ''}:${value.t}`,
    address: address(ctx, data.tenant_key, chatId, value.k),
    sender: { externalId: operator },
    body: { kind: 'action', token: value.t },
  };
}
