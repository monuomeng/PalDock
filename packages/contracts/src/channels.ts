import { z } from 'zod';

/**
 * 外部聊天渠道契约（02「聊天渠道适配器」）。适配器只做协议转换：把平台事件归一化为 InboundEnvelope、
 * 把 Card 渲染成平台消息；身份、准入、路由和命令都在公共管线（packages/application/src/channels）里。
 */

/** 首版只有飞书和 Telegram（ADR 0002）；测试用的假适配器也冒用其中之一。 */
export const CHANNEL_PROVIDERS = ['feishu', 'telegram'] as const;
export const ChannelProvider = z.enum(CHANNEL_PROVIDERS);
export type ChannelProvider = z.infer<typeof ChannelProvider>;

export const ConversationKind = z.enum(['dm', 'group']);
export type ConversationKind = z.infer<typeof ConversationKind>;

const Key = z.string().max(200);

/**
 * 渠道会话的自然键：`provider + account + tenant + chatId + threadKey`。
 * account 是渠道账号（飞书 App ID、Telegram bot ID）；没有租户或话题的平台用空串。
 */
export const ChannelAddress = z.object({
  provider: ChannelProvider,
  account: Key.min(1),
  tenant: Key,
  chatId: Key.min(1),
  threadKey: Key,
  kind: ConversationKind,
});
export type ChannelAddress = z.infer<typeof ChannelAddress>;

export const InboundBody = z.discriminatedUnion('kind', [
  /** 文本消息；群聊里 @机器人 的部分已由适配器去掉，mentionsBot 记录是否 @ 了它。 */
  /** replyTo：引用回复时被引用消息的平台 ID（飞书 parent_id、Telegram reply_to_message.message_id）。 */
  z.object({ kind: z.literal('text'), text: z.string().max(8000), mentionsBot: z.boolean(), replyTo: z.string().min(1).max(200).optional() }),
  /** 卡片按钮（飞书卡片回调、Telegram 内联键盘）：只带 PalDock 下发的一次性动作令牌。 */
  z.object({ kind: z.literal('action'), token: z.string().min(1).max(64) }),
]);
export type InboundBody = z.infer<typeof InboundBody>;

/** 归一化后的入站事件；先整体写入 inbox（以 eventId 去重）再处理。正文是不可信内容。 */
export const InboundEnvelope = z.object({
  eventId: Key.min(1),
  address: ChannelAddress,
  sender: z.object({ externalId: Key.min(1), displayName: Key }),
  body: InboundBody,
});
export type InboundEnvelope = z.infer<typeof InboundEnvelope>;

export type CardTone = 'info' | 'success' | 'warning' | 'danger';

export interface CardButton {
  label: string;
  /** 一次性动作令牌，点击后原样回到 InboundBody.token。 */
  token: string;
  style: 'primary' | 'danger' | 'default';
}

/** 渠道无关的卡片：飞书渲染为交互卡片，Telegram 渲染为文本加内联键盘。内容一律按纯文本显示。 */
export interface Card {
  title: string;
  tone: CardTone;
  lines: string[];
  buttons: CardButton[];
}

export const CHANNEL_STATES = ['stopped', 'connecting', 'connected', 'reconnecting', 'error'] as const;
export const ChannelState = z.enum(CHANNEL_STATES);
export type ChannelState = z.infer<typeof ChannelState>;

export interface ChannelStatus {
  provider: ChannelProvider;
  state: ChannelState;
  /** 出错原因或连接说明；不含凭据。 */
  detail: string | null;
  since: string;
  /** 最近一次从断线恢复的时间；之后一段时间内平台可能补投延迟的消息（飞书实测约 5 分钟）。 */
  recoveredAt: string | null;
}

/** 适配器把入站事件和连接状态交给公共管线；inbound 返回时事件已落库，适配器这时才可以向平台确认收到。 */
export interface ChannelSink {
  inbound(envelope: InboundEnvelope): void;
  state(state: ChannelState, detail?: string): void;
}

/**
 * 发送失败的分类：`retry` 确定没有发出，可以重试；`unknown` 可能已经发出（超时），不盲目重发；
 * `failed` 平台明确拒绝（权限、参数），重试也不会成功。
 */
export class ChannelDeliveryError extends Error {
  constructor(
    readonly outcome: 'retry' | 'unknown' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'ChannelDeliveryError';
  }
}

/** 连接没建立起来的网络错误码：请求肯定没到平台，可以重试。 */
const CONNECT_FAILURES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * 各渠道共用的网络层错误分类（平台自己的错误码由适配器先处理）：
 * 连不上可重试；HTTP 429 / 5xx 可重试；其余网络错误（超时、连接中断）不确定是否已发出。
 */
export function classifyNetworkError(error: { code?: string; status?: number; message: string }): ChannelDeliveryError {
  const { code, status, message } = error;
  if (code && CONNECT_FAILURES.has(code)) return new ChannelDeliveryError('retry', `网络不可用：${message}`);
  if (status === 429 || (status !== undefined && status >= 500)) return new ChannelDeliveryError('retry', `平台暂时不可用（${status}）：${message}`);
  if (status !== undefined) return new ChannelDeliveryError('failed', `平台拒绝了请求（${status}）：${message}`);
  return new ChannelDeliveryError('unknown', `网络中断或超时：${message}`);
}

export interface ChannelAdapter {
  readonly provider: ChannelProvider;
  /** 渠道账号（飞书 App ID、Telegram bot ID），是 inbox 队列名与会话键的一部分。 */
  readonly account: string;
  start(sink: ChannelSink): Promise<void>;
  stop(): Promise<void>;
  /** 发出一张卡片，返回平台消息 ID（后续更新用）。失败抛 ChannelDeliveryError。 */
  send(address: ChannelAddress, card: Card): Promise<string>;
  /** 更新已发出的卡片。 */
  edit(address: ChannelAddress, messageRef: string, card: Card): Promise<void>;
}

export const CHANNEL_ACCOUNT_STATUSES = ['unbound', 'active', 'revoked'] as const;
export const ChannelAccountStatus = z.enum(CHANNEL_ACCOUNT_STATUSES);
export type ChannelAccountStatus = z.infer<typeof ChannelAccountStatus>;

export const PAIRING_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type PairingStatus = (typeof PAIRING_STATUSES)[number];

export const CHANNEL_ACTION_KINDS = [
  'create_task',
  'cancel_task',
  'approve',
  'deny',
  /** 「结束任务」：提交到任务分支，任务结束。 */
  'accept_review',
  /** 待命中卡片上的「继续」：设为当前任务，下一条文字就是指令。 */
  'continue_task',
  /** /continue 列表里选一个任务：设为当前任务并显示它做过什么。 */
  'select_task',
  'dismiss',
  /** 计划确认卡片上的「确认」「退回」（P3-10），受远程审批等级约束。 */
  'confirm_plan',
  'reject_plan',
  /** 协调助手问题下面的按钮（0.3.8）：按建议处理、都不要、只处理带目标的这一项。 */
  'question_accept',
  'question_reject',
  'question_item',
] as const;
export const ChannelActionKind = z.enum(CHANNEL_ACTION_KINDS);
export type ChannelActionKind = z.infer<typeof ChannelActionKind>;

/** 入站被拒绝的原因，写入审计事件。 */
export const InboundRejection = z.enum([
  'unbound',
  'revoked',
  'pairing_limit',
  'group_not_allowed',
  'not_mentioned',
  'rate_limited',
  'invalid_action',
  'not_allowed_here',
]);
export type InboundRejection = z.infer<typeof InboundRejection>;

/** 外部平台上的一个人（渠道账号）；绑定到 Principal 后才能使用。 */
export interface ChannelAccountRecord {
  id: string;
  provider: ChannelProvider;
  account: string;
  externalId: string;
  displayName: string;
  status: ChannelAccountStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationRecord {
  id: string;
  provider: ChannelProvider;
  account: string;
  tenant: string;
  chatId: string;
  threadKey: string;
  kind: ConversationKind;
  /** 单聊所属的渠道账号。 */
  ownerAccountId: string | null;
  defaultWorkspaceId: string | null;
  /** 群聊白名单（只对群聊有意义）。 */
  groupAllowed: boolean;
  title: string;
  /** 单聊的当前任务：普通文字按它的状态续做、提示或新建（只对单聊有意义）。 */
  currentTaskId: string | null;
  /** 这个外部会话对应的协调助手主会话（P3-10）。 */
  mainSessionId: string | null;
  version: number;
  lastSeenAt: string;
}

/** 待桌面确认的配对请求；code 只在桌面和发起人的单聊里出现。 */
export interface PairingRecord {
  code: string;
  accountId: string;
  provider: ChannelProvider;
  displayName: string;
  status: PairingStatus;
  createdAt: string;
  expiresAt: string;
}

export interface ChannelActionRecord {
  token: string;
  conversationId: string;
  kind: ChannelActionKind;
  targetId: string;
  targetVersion: number | null;
  payload: string | null;
  status: 'pending' | 'used' | 'void';
  expiresAt: string;
}

/** 渠道的非秘密设置；凭据在系统凭据库，不在这里。 */
export interface ChannelSettingsRecord {
  provider: ChannelProvider;
  enabled: boolean;
  /** Telegram 代理地址等；不含凭据。 */
  proxyUrl: string | null;
  version: number;
}

/** 设置页显示的渠道概况；appId 是飞书凭据里的 App ID（不是秘密），App Secret 与 Bot Token 从不返回。 */
export interface ChannelOverview {
  settings: ChannelSettingsRecord;
  status: ChannelStatus;
  appId: string | null;
  /** 断线恢复后的提示期内为 true：平台可能补投延迟的消息。 */
  recentlyRecovered: boolean;
}
