import type { AdapterFactory, CredentialPort } from '@paldock/application';
import { P2_DEFAULTS } from '@paldock/domain';
import { deleteCredential, readCredential, writeCredential } from '@paldock/platform';

/** 系统凭据库（Windows 凭据管理器 / macOS 钥匙串）。 */
export const systemCredentials: CredentialPort = {
  read: readCredential,
  write: writeCredential,
  remove: deleteCredential,
};

/** 按渠道创建适配器；凭据只在这里交给 SDK。SDK 按需加载：没启用的渠道不拖慢服务启动。 */
export const createAdapter: AdapterFactory = async (provider, credential, settings, cursor) => {
  switch (provider) {
    case 'feishu': {
      const { createLarkTransport, FeishuAdapter } = await import('@paldock/channel-feishu');
      return new FeishuAdapter(credential.user, createLarkTransport(credential.user, credential.secret, P2_DEFAULTS.sendTimeoutMs));
    }
    case 'telegram': {
      const { createTelegramCall, TelegramAdapter } = await import('@paldock/channel-telegram');
      // Bot Token 形如 <bot 数字 ID>:<密钥>，冒号前的部分作为渠道账号
      const account = credential.secret.split(':')[0] ?? '';
      return new TelegramAdapter(account, {
        api: createTelegramCall(credential.secret, settings.proxyUrl),
        cursor: { get: () => cursor.get(account), set: (value) => cursor.set(account, value) },
        sendTimeoutMs: P2_DEFAULTS.sendTimeoutMs,
      });
    }
  }
};
