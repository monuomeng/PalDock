import type { Card, ConversationKind } from '@paldock/contracts';

const TEMPLATE = { info: 'blue', success: 'green', warning: 'orange', danger: 'red' } as const;

/** 按钮回传的值：动作令牌，以及会话类型（卡片回调里只有 chat ID，没有单聊/群聊之分）。 */
export interface ButtonValue {
  t: string;
  k: ConversationKind;
}

/**
 * Card → 飞书消息卡片 JSON。全部用 plain_text，不解析 Markdown，避免外部内容注入链接或 @。
 * `update_multi` 让卡片可以被后续 patch 更新（审批处理后改成结果）。
 */
export function renderCard(card: Card, kind: ConversationKind): string {
  const elements: unknown[] = [{ tag: 'div', text: { tag: 'plain_text', content: card.lines.join('\n') } }];
  if (card.buttons.length > 0) {
    elements.push({
      tag: 'action',
      actions: card.buttons.map((b) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: b.label },
        type: b.style, // 飞书按钮的 type 与 Card 的 style 同名
        value: { t: b.token, k: kind } satisfies ButtonValue,
      })),
    });
  }
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: card.title }, template: TEMPLATE[card.tone] },
    elements,
  });
}
