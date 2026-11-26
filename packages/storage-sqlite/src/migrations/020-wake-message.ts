/**
 * 0.3.9（Codex 复审 0.3.8）：协调助手的唤醒记下触发它的那条用户消息。约定同 001。
 * 交决定只认这条消息；执行前对话里已经有更新的用户消息时作废这次决定，交给下一轮。
 */
export const wakeMessageSchema = /* sql */ `
ALTER TABLE wakes ADD COLUMN message_id INTEGER;
`;
