/**
 * P2-10 任务续做：单聊记一个「当前任务」，普通文字按它的状态续做；任务可以接续自一个已结束的任务。
 * 「退回意见」的等待令牌被当前任务取代，删掉该列并作废还没用的旧按钮。
 */
export const taskContinuationSchema = /* sql */ `
ALTER TABLE external_conversations ADD COLUMN current_task_id TEXT REFERENCES tasks (id);
-- 任务进度也发给把它设为当前任务的单聊（例如在手机上继续电脑上建的任务）
CREATE INDEX conversations_by_current_task ON external_conversations (current_task_id) WHERE current_task_id IS NOT NULL;
ALTER TABLE external_conversations DROP COLUMN awaiting_token;
UPDATE channel_actions SET status = 'void' WHERE status = 'pending' AND kind IN ('rework_review', 'rework_note');

ALTER TABLE tasks ADD COLUMN continued_from_task_id TEXT REFERENCES tasks (id);

-- /continue 列表：按子任务最近一次变化倒序
CREATE INDEX subtasks_by_activity ON subtasks (updated_at);
`;
