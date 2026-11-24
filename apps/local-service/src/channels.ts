import type { AdapterFactory, CredentialPort } from '@paldock/application';
import { createLarkTransport, FeishuAdapter } from '@paldock/channel-feishu';
import { P2_DEFAULTS } from '@paldock/domain';
import { deleteCredential, readCredential, writeCredential } from '@paldock/platform';

/** 系统凭据库（Windows 凭据管理器 / macOS 钥匙串）。 */
export const systemCredentials: CredentialPort = {
  read: readCredential,
  write: writeCredential,
  remove: deleteCredential,
};

/** 按渠道创建适配器；凭据只在这里交给 SDK。 */
export const createAdapter: AdapterFactory = (provider, credential) => {
  switch (provider) {
    case 'feishu':
      return new FeishuAdapter(credential.user, createLarkTransport(credential.user, credential.secret, P2_DEFAULTS.sendTimeoutMs));
    case 'telegram':
      throw new Error('Telegram 适配器尚未实现');
  }
};
