import {
  CodedError,
  type Card,
  type ChannelAccountRecord,
  type ChannelAdapter,
  type ChannelOverview,
  type ChannelProvider,
  type ChannelSettingsRecord,
  type ConversationRecord,
  type EphemeralEvent,
  type PairingRecord,
  type PersistentEvent,
  type StorePort,
} from '@paldock/contracts';
import { P2_DEFAULTS, type DesktopPresence, type P2Limits } from '@paldock/domain';
import type { TaskService } from '../task-service.js';
import { pairedCard } from './cards.js';
import { ChannelHub } from './channel-hub.js';
import { InboundProcessor } from './inbound-processor.js';
import { ChannelNotifier } from './notifier.js';
import { RemoteCommands } from './remote-commands.js';

/** 渠道凭据：飞书 user = App ID、secret = App Secret；Telegram user 固定为 bot、secret = Bot Token。 */
export interface ChannelCredential {
  user: string;
  secret: string;
}

/** 系统凭据库（Windows 凭据管理器、macOS 钥匙串），见 packages/platform/src/credentials.ts。 */
export interface CredentialPort {
  read(target: string): Promise<ChannelCredential | undefined>;
  write(target: string, credential: ChannelCredential): Promise<void>;
  remove(target: string): Promise<void>;
}

/** 渠道自己的收取游标（Telegram 的 update offset），按账号存在本地库。 */
export interface ChannelCursor {
  get(account: string): string | undefined;
  set(account: string, cursor: string): void;
}

/** 由宿主（本地服务）按渠道创建具体适配器；应用层不依赖飞书或 Telegram 的 SDK。 */
export type AdapterFactory = (
  provider: ChannelProvider,
  credential: ChannelCredential,
  settings: ChannelSettingsRecord,
  cursor: ChannelCursor,
) => Promise<ChannelAdapter>;

export const credentialTarget = (provider: ChannelProvider) => `paldock/${provider}`;

export interface ChannelServiceDeps {
  store: StorePort;
  tasks: TaskService;
  credentials: CredentialPort;
  createAdapter: AdapterFactory;
  publish(events: PersistentEvent[]): void;
  publishEphemeral(event: EphemeralEvent): void;
  log(message: string): void;
  now?: () => Date;
  limits?: Partial<P2Limits>;
}

export interface ChannelConfigInput {
  provider: ChannelProvider;
  expectedVersion: number;
  enabled: boolean;
  proxyUrl: string | null;
  /** 只在用户填写时更新凭据；飞书需要 App ID 与 App Secret 一起填。 */
  credential?: ChannelCredential;
  forgetCredential?: boolean;
}

/**
 * 外部渠道的组装与对桌面的用例：设置与凭据、适配器启停、配对确认、账号与群白名单、桌面状态。
 * 管线本身在 ChannelHub（运转）、InboundProcessor（身份与准入）、RemoteCommands（命令与动作）、
 * ChannelNotifier（通知与审批升级）。
 */
export class ChannelService {
  private readonly hub: ChannelHub;
  private readonly notifier: ChannelNotifier;
  private readonly limits: P2Limits;
  private readonly now: () => Date;
  private readonly appIds = new Map<ChannelProvider, string>();
  private presence: DesktopPresence = { uiRunning: true, locked: false, idle: false };
  private escalationTimer: NodeJS.Timeout | undefined;
  /** 同一渠道的启停串行执行，避免连续保存设置时新旧适配器交错。 */
  private readonly applying = new Map<ChannelProvider, Promise<void>>();

  constructor(private readonly deps: ChannelServiceDeps) {
    this.limits = { ...P2_DEFAULTS, ...deps.limits };
    this.now = deps.now ?? (() => new Date());
    // 限额与时钟在这里定一次，管线各部分共用
    const common = { store: deps.store, publish: deps.publish, limits: this.limits, now: this.now };
    const send = (c: ConversationRecord, card: Card, subject?: string) => this.send(c, card, subject);
    const commands = new RemoteCommands({ ...common, tasks: deps.tasks, reply: send });
    const processor = new InboundProcessor({ ...common, handler: commands, reply: send });
    this.hub = new ChannelHub({
      ...common,
      publishEphemeral: deps.publishEphemeral,
      log: deps.log,
      process: (envelope) => processor.process(envelope),
    });
    this.notifier = new ChannelNotifier({ ...common, send, presence: () => this.presence });
  }

  /** 启动已启用的渠道（不阻塞服务启动）与升级扫描。 */
  start(): void {
    this.hub.start();
    for (const settings of this.deps.store.channels.listSettings()) {
      if (settings.enabled) void this.apply(settings);
    }
    this.escalationTimer = setInterval(() => this.escalate(), this.limits.escalationScanMs);
    this.escalationTimer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.escalationTimer);
    await Promise.allSettled([...this.applying.values()]);
    await this.hub.stop();
  }

  /** 应用层写入的持久事件也送到这里：从外部建的任务的进度、审批的处理结果。 */
  onEvents(events: PersistentEvent[]): void {
    this.notifier.onEvents(events);
  }

  /** 桌面状态来自 Electron 主进程（powerMonitor）；锁屏或空闲时待审批立即满足升级条件。 */
  setPresence(presence: DesktopPresence): void {
    const changed = presence.locked !== this.presence.locked || presence.idle !== this.presence.idle;
    this.presence = presence;
    if (changed) this.escalate();
  }

  escalate(): void {
    this.notifier.escalate();
  }

  /** 写 outbox 并唤醒投递（唤醒推迟到当前事务之后）。 */
  private send(conversation: ConversationRecord, card: Card, subject?: string): void {
    this.deps.store.outbox.enqueue(conversation.provider, conversation.id, card, subject ?? null);
    this.hub.kick();
  }

  overview(): ChannelOverview[] {
    const nowMs = this.now().getTime();
    return this.deps.store.channels.listSettings().map((settings) => {
      const status = this.hub.status(settings.provider) ?? {
        provider: settings.provider,
        state: 'stopped' as const,
        detail: null,
        since: this.now().toISOString(),
        recoveredAt: null,
      };
      const recentlyRecovered = status.recoveredAt !== null && nowMs - Date.parse(status.recoveredAt) < this.limits.recoveryNoticeMs;
      return { settings, status, appId: this.appIds.get(settings.provider) ?? null, recentlyRecovered };
    });
  }

  /** 保存设置：先写凭据（只写不回显），再写设置并按新设置重启或停用渠道。 */
  async configure(input: ChannelConfigInput): Promise<ChannelOverview[]> {
    const target = credentialTarget(input.provider);
    if (input.forgetCredential) {
      await this.deps.credentials.remove(target);
      this.appIds.delete(input.provider);
    } else if (input.credential) {
      await this.deps.credentials.write(target, input.credential);
    }
    const change = this.deps.store.channels.updateSettings(input.provider, input.expectedVersion, input.enabled, input.proxyUrl);
    this.deps.publish(change.events);
    await this.apply(change.record);
    return this.overview();
  }

  private apply(settings: ChannelSettingsRecord): Promise<void> {
    const previous = this.applying.get(settings.provider) ?? Promise.resolve();
    const next = previous.then(() => this.restart(settings)).catch((error: Error) => this.deps.log(`${settings.provider} apply failed: ${error.message}`));
    this.applying.set(settings.provider, next);
    return next;
  }

  private async restart(settings: ChannelSettingsRecord): Promise<void> {
    const { provider } = settings;
    await this.hub.detach(provider);
    if (!settings.enabled) {
      // 停用后不在重新启用时补发积压的消息
      this.deps.store.outbox.failPending(provider, '渠道已停用');
      return;
    }
    const credential = await this.deps.credentials.read(credentialTarget(provider)).catch(() => undefined);
    if (!credential) return this.hub.reportError(provider, '没有找到凭据，请在设置里填写');
    if (provider === 'feishu') this.appIds.set(provider, credential.user);
    const { channels } = this.deps.store;
    const cursor: ChannelCursor = { get: (account) => channels.getCursor(provider, account), set: (account, value) => channels.setCursor(provider, account, value) };
    let adapter: ChannelAdapter;
    try {
      adapter = await this.deps.createAdapter(provider, credential, settings, cursor);
    } catch (error) {
      return this.hub.reportError(provider, `渠道启动失败：${(error as Error).message}`.slice(0, 300));
    }
    // 启动失败的原因已记在渠道状态上（hub.attach），界面会显示
    await this.hub.attach(adapter).catch(() => undefined);
  }

  listPairings(): PairingRecord[] {
    return this.deps.store.channels.listPairings();
  }

  /** 桌面确认配对：绑定账号并在那个单聊里回一条「绑定成功」。 */
  decidePairing(code: string, approve: boolean): void {
    const change = this.deps.store.channels.decidePairing(code, approve);
    this.deps.publish(change.events);
    if (!approve) return;
    const conversation = this.deps.store.channels.getConversation(change.record.conversationId);
    if (conversation) this.send(conversation, pairedCard());
  }

  listAccounts(): ChannelAccountRecord[] {
    return this.deps.store.channels.listAccounts();
  }

  /** 解绑后该账号的消息一律拒绝，已发出的卡片按钮也失效（动作执行前会重新核对账号状态）。允许重新配对 = 回到未绑定。 */
  setAccountStatus(accountId: string, expectedVersion: number, to: 'revoked' | 'unbound'): void {
    const account = this.deps.store.channels.getAccount(accountId);
    if (!account) throw new CodedError('not_found', '渠道账号不存在');
    if (to === 'unbound' && account.status !== 'revoked') throw new CodedError('bad_request', '只有已解绑的账号可以重新配对');
    this.deps.publish(this.deps.store.channels.setAccountStatus(accountId, expectedVersion, to).events);
  }

  listGroups(): ConversationRecord[] {
    return this.deps.store.channels.listGroups();
  }

  setGroupAllowed(conversationId: string, expectedVersion: number, allowed: boolean): void {
    const conversation = this.deps.store.channels.getConversation(conversationId);
    if (conversation?.kind !== 'group') throw new CodedError('not_found', '群聊不存在');
    const change = this.deps.store.channels.setConversation(conversationId, expectedVersion, {
      groupAllowed: allowed,
      defaultWorkspaceId: conversation.defaultWorkspaceId,
    });
    this.deps.publish(change.events);
  }
}
