import type { AdapterFactory, CredentialPort } from '@paldock/application';
import { deleteCredential, readCredential, writeCredential } from '@paldock/platform';

/** 系统凭据库（Windows 凭据管理器 / macOS 钥匙串）。 */
export const systemCredentials: CredentialPort = {
  read: readCredential,
  write: writeCredential,
  remove: deleteCredential,
};

/** 按渠道创建适配器。 */
export const createAdapter: AdapterFactory = (provider) => {
  throw new Error(`${provider} 适配器尚未实现`);
};
