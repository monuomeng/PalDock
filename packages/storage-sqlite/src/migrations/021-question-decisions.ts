/**
 * 0.3.10（你批准）：同一条用户消息对同一个问题只能交一次决定。约定同 001。
 * 交决定时先在这里记一笔（问题 + 消息唯一）；被拒也算用过（越界、原话不符、不是明确确认……），
 * 服务重启、外部渠道重投、协调助手换个说法再交，都不会再执行。
 */
export const questionDecisionsSchema = /* sql */ `
CREATE TABLE question_decisions (
  question_id TEXT NOT NULL REFERENCES approval_questions (id),
  message_id  INTEGER NOT NULL,
  outcome     TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (question_id, message_id)
) STRICT;
`;
