import type {
  Card,
  ChannelAccountRecord,
  ConversationRecord,
  InboundEnvelope,
  InboundRejection,
  PersistentEvent,
  StorePort,
} from '@paldock/contracts';
import type { P2Limits } from '@paldock/domain';
import { pairingCard } from './cards.js';
import type { InboundOutcome } from './channel-hub.js';

/** 处理一条消息需要的上下文：已识别的渠道账号与会话。 */
export interface InboundContext {
  /** 平台事件 ID：由它派生的操作（例如接续建任务）用它做幂等键，重放不重复执行。 */
  eventId: string;
  account: ChannelAccountRecord;
  conversation: ConversationRecord;
}

/** 已绑定账号的消息交给它：确定性命令、建任务、卡片动作（RemoteCommands）。 */
export interface InboundHandler {
  text(ctx: InboundContext, text: string): Promise<InboundOutcome>;
  action(ctx: InboundContext, token: string): Promise<InboundOutcome>;
}

export interface InboundProcessorDeps {
  store: StorePort;
  handler: InboundHandler;
  publish(events: PersistentEvent[]): void;
  /** 回复卡片：写 outbox 并唤醒投递。 */
  reply(conversation: ConversationRecord, card: Card): void;
  now: () => Date;
  limits: P2Limits;
}

/**
 * 入站管线的身份与准入（02「入站管线」第 4–7 步）：
 * 账号与会话 → 限速 → 绑定状态（未绑定的单聊只回配对码）→ 群白名单与 @ → 交给命令处理。
 * 每一步拒绝都写审计事件，不往下走；外部文本在这里之后仍是不可信内容。
 */
export class InboundProcessor {
  /** 每个渠道账号最近一分钟内的消息时间戳（内存即可：重启后清零不影响安全）。 */
  private readonly recent = new Map<string, number[]>();

  constructor(private readonly deps: InboundProcessorDeps) {}

  private get limits(): P2Limits {
    return this.deps.limits;
  }

  async process(envelope: InboundEnvelope): Promise<InboundOutcome> {
    const { channels } = this.deps.store;
    const { address, sender, body } = envelope;
    const account = channels.upsertAccount(address, sender.externalId, sender.displayName);
    const conversation = channels.upsertConversation(address, account.id, address.kind === 'dm' ? sender.displayName : '');
    const reject = (reason: InboundRejection) => this.reject(conversation, reason);

    if (!this.withinRate(account.id)) return reject('rate_limited');
    if (account.status === 'revoked') return reject('revoked');
    if (account.status === 'unbound') return address.kind === 'dm' ? this.offerPairing(account, conversation) : reject('unbound');
    if (address.kind === 'group') {
      if (!conversation.groupAllowed) return reject('group_not_allowed');
      if (body.kind === 'text' && !body.mentionsBot) return reject('not_mentioned');
    }
    const ctx = { eventId: envelope.eventId, account, conversation };
    return body.kind === 'action' ? this.deps.handler.action(ctx, body.token) : this.deps.handler.text(ctx, body.text);
  }

  private reject(conversation: ConversationRecord, reason: InboundRejection): InboundOutcome {
    this.deps.publish([this.deps.store.channels.audit(conversation.id, conversation.provider, reason)]);
    return 'rejected';
  }

  /** 未绑定的单聊：只回配对码（已有未过期的就沿用），由用户在桌面确认；消息本身不处理。 */
  private offerPairing(account: ChannelAccountRecord, conversation: ConversationRecord): InboundOutcome {
    const opened = this.deps.store.channels.openPairing(account, conversation.id, this.limits.pairingTtlMs, this.limits.maxPendingPairings);
    if (!opened) return this.reject(conversation, 'pairing_limit');
    this.deps.publish(opened.events);
    this.deps.reply(conversation, pairingCard(opened.code));
    return this.reject(conversation, 'unbound');
  }

  private withinRate(accountId: string): boolean {
    const now = this.deps.now().getTime();
    const window = (this.recent.get(accountId) ?? []).filter((t) => now - t < 60_000);
    const ok = window.length < this.limits.inboundPerMinute;
    if (ok) window.push(now);
    this.recent.set(accountId, window);
    return ok;
  }
}
