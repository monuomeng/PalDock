import type { ErrorCode } from '@paldock/contracts';

/** 可安全返回给客户端的业务错误；消息不得包含凭据、正文或绝对路径以外的敏感信息。 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
