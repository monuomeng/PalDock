import { ChannelDeliveryError, classifyNetworkError } from '@paldock/contracts';
import { Agent, fetch, ProxyAgent, type Dispatcher } from 'undici';

/** Bot API 返回 ok=false 时的错误；description 来自 Telegram，不含 Token。 */
export class TelegramApiError extends Error {
  constructor(
    readonly status: number,
    readonly description: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Telegram 返回 ${status}：${description.slice(0, 200)}`);
    this.name = 'TelegramApiError';
  }
}

/** 调一个 Bot API 方法；适配器只依赖这个函数，测试注入假的。 */
export type TelegramCall = <T>(method: string, body: object, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<T>;

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/**
 * 基于 undici fetch 的 Bot API 调用（https://api.telegram.org/bot<token>/<method>）。
 * Token 只拼进请求地址，错误文本里出现时替换掉；配置了代理时所有请求都经代理（HTTP CONNECT）。
 */
export function createTelegramCall(token: string, proxyUrl: string | null): { call: TelegramCall; close(): Promise<void> } {
  const dispatcher: Dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : new Agent();
  const redact = (text: string) => text.split(token).join('<token>');

  const call: TelegramCall = async <T>(method: string, body: object, options: { timeoutMs: number; signal?: AbortSignal }) => {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    let response: Awaited<ReturnType<typeof fetch>>;
    let payload: ApiResponse<T>;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        dispatcher,
      });
      payload = (await response.json()) as ApiResponse<T>;
    } catch (error) {
      throw sanitize(error, redact);
    }
    if (payload.ok) return payload.result as T;
    throw new TelegramApiError(payload.error_code ?? response.status, redact(payload.description ?? ''), payload.parameters?.retry_after);
  };

  return { call, close: () => dispatcher.close() };
}

/**
 * 网络错误只保留错误码与去掉 Token 的说明，避免底层错误对象带出请求地址。
 * undici 把真正的原因包在 cause 链里（代理拒绝隧道时在第三层），取链上第一个字符串错误码和最深的说明。
 */
function sanitize(error: unknown, redact: (text: string) => string): Error {
  let code: string | undefined;
  let detail = String(error);
  for (let e = error as { code?: unknown; message?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (!code && typeof e.code === 'string') code = e.code;
    if (e.message) detail = e.message;
  }
  const result = new Error(redact(detail).slice(0, 200)) as Error & { code?: string };
  result.name = (error as { name?: string }).name ?? 'Error';
  if (code) result.code = code;
  return result;
}

/** Bot API 错误 → 投递结果：429、5xx、连不上（含代理拒绝建立隧道）可重试；超时与连接中断不确定是否已发出；其余 4xx 不重试。 */
export function classifyTelegramError(error: unknown): ChannelDeliveryError {
  if (error instanceof ChannelDeliveryError) return error;
  if (error instanceof TelegramApiError) return classifyNetworkError({ status: error.status, message: error.message });
  const e = error as { code?: string; message?: string };
  const message = `Telegram：${(e.message ?? String(error)).slice(0, 200)}`;
  // undici 的代理隧道失败没有专门的错误码（UND_ERR_ABORTED 也用于其他中止），只能看说明
  if (message.includes('HTTP Tunneling')) return new ChannelDeliveryError('retry', `代理不可用：${message}`);
  return classifyNetworkError({ ...(e.code ? { code: e.code } : {}), message });
}

/** 编辑内容与原消息相同时 Telegram 返回 400，按成功处理。 */
export const isNotModified = (error: unknown) => error instanceof TelegramApiError && error.status === 400 && /message is not modified/i.test(error.description);
