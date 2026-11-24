import type { Card, ChannelAddress, ConversationKind, InboundEnvelope } from '@paldock/contracts';

/**
 * Telegram Bot API 的 Update → InboundEnvelope，以及 Card → sendMessage 参数。纯函数，便于离线测试。
 * 只处理文字消息与内联键盘回调；其他类型的消息转成空文本，由命令层提示「只支持文字」。
 */

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
}

export interface TgEntity {
  type: string;
  offset: number;
  length: number;
  user?: TgUser;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  entities?: TgEntity[];
  reply_to_message?: { from?: TgUser };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: { message_id: number; chat: TgChat }; data?: string };
}

export interface BotIdentity {
  /** bot 的数字 ID（Bot Token 冒号前的部分），作为渠道账号。 */
  id: string;
  username: string;
}

type Parsed = InboundEnvelope;

const kindOf = (chat: TgChat): ConversationKind | undefined =>
  chat.type === 'private' ? 'dm' : chat.type === 'group' || chat.type === 'supergroup' ? 'group' : undefined;

const nameOf = (user: TgUser) => [user.first_name, user.last_name].filter(Boolean).join(' ') || (user.username ? `@${user.username}` : `Telegram 用户 ${user.id}`);

function address(bot: BotIdentity, chat: TgChat, kind: ConversationKind): ChannelAddress {
  return { provider: 'telegram', account: bot.id, tenant: '', chatId: String(chat.id), threadKey: '', kind };
}

/**
 * 群里只认明确发给机器人的消息：@机器人、回复机器人的消息、或 /命令@机器人。
 * 去掉文本里的 @机器人，命令后缀 @机器人 留给命令层处理。
 */
function textOf(message: TgMessage, bot: BotIdentity): { text: string; mentionsBot: boolean } {
  const text = message.text ?? '';
  const handle = `@${bot.username}`.toLowerCase();
  let mentionsBot = message.reply_to_message?.from?.id === Number(bot.id);
  let stripped = text;
  for (const entity of [...(message.entities ?? [])].sort((a, b) => b.offset - a.offset)) {
    const part = text.slice(entity.offset, entity.offset + entity.length);
    const isBot =
      (entity.type === 'mention' && part.toLowerCase() === handle) || (entity.type === 'text_mention' && entity.user?.id === Number(bot.id));
    if (isBot) {
      mentionsBot = true;
      stripped = stripped.slice(0, entity.offset) + stripped.slice(entity.offset + entity.length);
    } else if (entity.type === 'bot_command' && part.toLowerCase().endsWith(handle)) {
      mentionsBot = true;
    }
  }
  return { text: stripped.replace(/\s+/g, ' ').trim(), mentionsBot };
}

export function parseUpdate(update: TgUpdate, bot: BotIdentity): Parsed | undefined {
  const eventId = `update:${update.update_id}`;
  const { message, callback_query: query } = update;
  if (message?.from && !message.from.is_bot) {
    const kind = kindOf(message.chat);
    if (!kind) return undefined;
    return {
      eventId,
      address: address(bot, message.chat, kind),
      sender: { externalId: String(message.from.id), displayName: nameOf(message.from) },
      body: { kind: 'text', ...textOf(message, bot) },
    };
  }
  if (query?.message && query.data) {
    const kind = kindOf(query.message.chat);
    if (!kind) return undefined;
    return {
      eventId,
      address: address(bot, query.message.chat, kind),
      sender: { externalId: String(query.from.id), displayName: nameOf(query.from) },
      body: { kind: 'action', token: query.data.slice(0, 64) },
    };
  }
  return undefined;
}

const TONE_MARK = { info: 'ℹ️', success: '✅', warning: '⚠️', danger: '⛔' } as const;

/** Card → sendMessage / editMessageText 的参数。不设 parse_mode，内容按纯文本显示。 */
export function renderMessage(card: Card): { text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } } {
  const text = [`${TONE_MARK[card.tone]} ${card.title}`, '', ...card.lines].join('\n').slice(0, 4096);
  if (card.buttons.length === 0) return { text };
  return { text, reply_markup: { inline_keyboard: [card.buttons.map((b) => ({ text: b.label, callback_data: b.token }))] } };
}
