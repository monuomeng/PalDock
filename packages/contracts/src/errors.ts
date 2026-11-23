import type { ErrorCode } from './ipc.js';

/**
 * 带错误码、可安全返回给客户端的错误。服务端业务规则抛出，IPC 客户端收到错误结果时原样重建，
 * 两侧可以用同一个 instanceof / code 判断。消息不得包含凭据或消息正文。
 */
export class CodedError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CodedError';
  }
}
