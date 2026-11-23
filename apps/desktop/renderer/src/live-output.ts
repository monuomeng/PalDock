/**
 * 流式输出的临时缓冲：服务端每隔几秒把片段合并成一条持久消息（message.created），
 * 收到该事件后清空对应 Run 的缓冲，重新拉取详情时显示持久消息。断线期间的片段不补发。
 */
const buffers = new Map<string, string>();

export function appendLive(runId: string, text: string): void {
  buffers.set(runId, (buffers.get(runId) ?? '') + text);
  const target = document.querySelector<HTMLElement>(`[data-live-run="${CSS.escape(runId)}"]`);
  if (!target) return;
  const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 40;
  target.append(text);
  if (nearBottom) target.scrollTop = target.scrollHeight;
}

export function liveText(runId: string): string {
  return buffers.get(runId) ?? '';
}

export function clearLive(runId: string): void {
  buffers.delete(runId);
}
