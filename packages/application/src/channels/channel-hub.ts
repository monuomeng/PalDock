import {
  ChannelDeliveryError,
  InboundEnvelope,
  type ChannelAdapter,
  type ChannelAddress,
  type ChannelProvider,
  type ChannelSink,
  type ChannelState,
  type ChannelStatus,
  type EphemeralEvent,
  type OutboxItem,
  type StorePort,
} from '@paldock/contracts';
import { P2_DEFAULTS, type P2Limits } from '@paldock/domain';

export type InboundOutcome = 'done' | 'rejected';

export interface ChannelHubDeps {
  store: StorePort;
  publishEphemeral(event: EphemeralEvent): void;
  log(message: string): void;
  /** 处理一条已落库的入站事件（身份、准入、路由、命令），见 InboundProcessor。 */
  process(envelope: InboundEnvelope): Promise<InboundOutcome>;
  now?: () => Date;
  limits?: Partial<P2Limits>;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** inbox 的队列名与会话键；会话键决定串行处理的粒度。 */
export const inboxQueue = (provider: ChannelProvider, account: string) => `${provider}:${account}`;
export const conversationKey = (a: ChannelAddress) => [a.provider, a.account, a.tenant, a.chatId, a.threadKey].join('|');

/**
 * 渠道公共管线的运转部分：适配器的启停与连接状态、入站「先落库再处理」、出站按到期时间逐条投递。
 * 不认识任何具体平台；身份与命令交给 deps.process。
 */
export class ChannelHub {
  private readonly adapters = new Map<ChannelProvider, ChannelAdapter>();
  private readonly statuses = new Map<ChannelProvider, ChannelStatus>();
  private readonly limits: P2Limits;
  private readonly now: () => Date;
  private draining: Promise<void> | undefined;
  private dispatching: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly deps: ChannelHubDeps) {
    this.limits = { ...P2_DEFAULTS, ...deps.limits };
    this.now = deps.now ?? (() => new Date());
  }

  /** 定时兜底：租约过期的入站事件、到期重试的出站消息。 */
  start(): void {
    this.timer = setInterval(() => this.kick(), 5_000);
    this.timer.unref();
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.adapters.keys()].map((provider) => this.detach(provider)));
    await Promise.allSettled([this.draining, this.dispatching]);
  }

  /** 启动适配器；同一渠道已有适配器时先停掉旧的。启动失败时状态记为 error 并抛出。 */
  async attach(adapter: ChannelAdapter): Promise<void> {
    await this.detach(adapter.provider);
    this.adapters.set(adapter.provider, adapter);
    this.setState(adapter.provider, 'connecting', null);
    const sink: ChannelSink = {
      inbound: (envelope) => this.ingest(adapter, envelope),
      state: (state, detail) => {
        if (this.adapters.get(adapter.provider) === adapter) this.setState(adapter.provider, state, detail ?? null);
      },
    };
    try {
      await adapter.start(sink);
    } catch (error) {
      this.adapters.delete(adapter.provider);
      this.setState(adapter.provider, 'error', errorText(error));
      throw error;
    }
  }

  async detach(provider: ChannelProvider): Promise<void> {
    const adapter = this.adapters.get(provider);
    if (!adapter) return;
    this.adapters.delete(provider);
    await adapter.stop().catch((error) => this.deps.log(`${provider} stop failed: ${errorText(error)}`));
    this.setState(provider, 'stopped', null);
  }

  /** 设置失败（例如凭据缺失）但没有适配器可启动时，也让界面看到原因。 */
  reportError(provider: ChannelProvider, detail: string): void {
    this.setState(provider, 'error', detail);
  }

  isAttached(provider: ChannelProvider): boolean {
    return this.adapters.has(provider);
  }

  status(provider: ChannelProvider): ChannelStatus | undefined {
    return this.statuses.get(provider);
  }

  /** 有新的入站或出站工作：各自串行跑一轮，已在跑时不重复启动。 */
  kick(): void {
    if (this.stopped) return;
    this.draining ??= this.drainInbox().finally(() => (this.draining = undefined));
    this.dispatching ??= this.dispatchOutbox().finally(() => (this.dispatching = undefined));
  }

  private setState(provider: ChannelProvider, state: ChannelState, detail: string | null): void {
    const previous = this.statuses.get(provider);
    if (previous?.state === state && previous.detail === detail) return;
    const at = this.now().toISOString();
    // 从断线或出错恢复：之后一段时间内平台可能补投延迟的消息，界面据此提示
    const recovered = state === 'connected' && (previous?.state === 'reconnecting' || previous?.state === 'error');
    const status: ChannelStatus = { provider, state, detail, since: at, recoveredAt: recovered ? at : (previous?.recoveredAt ?? null) };
    this.statuses.set(provider, status);
    this.deps.publishEphemeral({ type: 'channel.status', ...status });
  }

  /** 适配器回调：校验后整体写入 inbox（平台事件 ID 去重），返回后适配器才向平台确认。 */
  private ingest(adapter: ChannelAdapter, raw: InboundEnvelope): void {
    const parsed = InboundEnvelope.safeParse(raw);
    if (!parsed.success || parsed.data.address.provider !== adapter.provider || parsed.data.address.account !== adapter.account) {
      this.deps.log(`${adapter.provider} dropped malformed inbound event`);
      return;
    }
    const envelope = parsed.data;
    const fresh = this.deps.store.inbox.accept(
      inboxQueue(adapter.provider, adapter.account),
      envelope.eventId,
      conversationKey(envelope.address),
      JSON.stringify(envelope),
    );
    if (fresh) this.kick();
  }

  /** 单个工作器按到达顺序处理，天然满足同一会话串行；处理出错的事件记为 rejected，不无限重试。 */
  private async drainInbox(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const item = this.deps.store.inbox.claim(this.limits.inboxLeaseMs);
      if (!item) return;
      let outcome: InboundOutcome = 'rejected';
      try {
        outcome = await this.deps.process(InboundEnvelope.parse(JSON.parse(item.payload)));
      } catch (error) {
        this.deps.log(`inbound ${item.queue} failed: ${errorText(error)}`);
      }
      if (this.stopped) return; // 数据库可能已关闭；租约过期后下次启动重做
      this.deps.store.inbox.finish(item.queue, item.eventId, outcome);
    }
  }

  private async dispatchOutbox(): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      const item = this.deps.store.outbox.claimDue();
      if (!item) return;
      await this.deliver(item);
      await sleep(this.limits.outboxSpacingMs);
    }
  }

  /** 有主题且已发过卡片的更新原卡片（更新失败时改发新卡片），否则发新卡片。 */
  private async deliver(item: OutboxItem): Promise<void> {
    const { store } = this.deps;
    const adapter = this.adapters.get(item.provider);
    const conversation = store.channels.getConversation(item.conversationId);
    if (!conversation) return store.outbox.markFinal(item.id, 'failed', '会话不存在');
    if (!adapter) return this.retryOrFail(item, '渠道未连接');
    const address: ChannelAddress = conversation;
    try {
      const ref = item.subject ? store.outbox.messageRef(item.conversationId, item.subject) : undefined;
      if (ref) {
        const edited = await adapter.edit(address, ref, item.card).then(
          () => true,
          (error: unknown) => {
            if (error instanceof ChannelDeliveryError && error.outcome === 'failed') return false;
            throw error;
          },
        );
        if (edited) return store.outbox.markSent(item, ref);
      }
      store.outbox.markSent(item, await adapter.send(address, item.card));
    } catch (error) {
      const outcome = error instanceof ChannelDeliveryError ? error.outcome : 'retry';
      if (outcome === 'retry') return this.retryOrFail(item, errorText(error));
      store.outbox.markFinal(item.id, outcome, errorText(error));
      this.deps.log(`${item.provider} delivery ${outcome}: ${errorText(error)}`);
    }
  }

  private retryOrFail(item: OutboxItem, error: string): void {
    if (item.attempts >= this.limits.outboxMaxAttempts) return this.deps.store.outbox.markFinal(item.id, 'failed', error);
    this.deps.store.outbox.markRetry(item.id, this.limits.outboxRetryBaseMs * 2 ** (item.attempts - 1), error);
  }
}
