/**
 * P3-10 外部消息进主会话：外部会话对应的主会话；消息来自哪个渠道；协调助手问题的答复；
 * 已发卡片按平台消息 ID 反查（引用回复）；计划确认卡片的升级与决定来源。约定同 001。
 */
export const externalMainSessionSchema = /* sql */ `
-- 每个外部会话一个主会话（不和桌面的合并）
ALTER TABLE external_conversations ADD COLUMN main_session_id TEXT REFERENCES sessions (id);
CREATE UNIQUE INDEX conversations_by_main_session ON external_conversations (main_session_id) WHERE main_session_id IS NOT NULL;

-- 这条消息从哪个渠道来；桌面上写的为空
ALTER TABLE messages ADD COLUMN channel TEXT CHECK (channel IS NULL OR channel IN ('feishu', 'telegram'));

-- 答复交回提问方后问题算已答（同时状态记为已读，不再外发）
ALTER TABLE user_notices ADD COLUMN answered_at TEXT;
ALTER TABLE user_notices ADD COLUMN answer_message_id INTEGER REFERENCES messages (id);

-- 引用回复：按平台消息 ID 找到我们发出的那张卡片（主题 notice:<编号>）
CREATE INDEX channel_messages_by_ref ON channel_messages (conversation_id, message_ref);

-- 计划确认卡片：和审批一样桌面优先，满足升级条件才发到单聊；记下在哪一端确认或退回
ALTER TABLE plans ADD COLUMN escalated_at TEXT;
ALTER TABLE plans ADD COLUMN decided_via TEXT CHECK (decided_via IS NULL OR decided_via IN ('desktop', 'feishu', 'telegram'));
CREATE INDEX plans_unescalated ON plans (created_at) WHERE status = 'proposed' AND escalated_at IS NULL;
`;
