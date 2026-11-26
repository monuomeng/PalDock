/**
 * 协调助手在发起的对话里找你批（2026-11-26 你同意，0.3.8）。约定同 001。
 * - 问题：每个对话同一时刻只有一个在等回答（部分唯一索引）；各项（审批或 Git 卡片的编号、版本、建议的决定、提交块）存为 JSON。
 * - 审批记下它在哪个问题里问过你：问题里的审批不再另外外发审批卡片（只通知一次）。
 */
export const approvalQuestionsSchema = /* sql */ `
CREATE TABLE approval_questions (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions (id),
  run_id       TEXT,
  message_id   INTEGER,
  author       TEXT NOT NULL CHECK (author IN ('coordinator', 'host')),
  text         TEXT NOT NULL,
  items        TEXT NOT NULL CHECK (json_valid(items)),
  status       TEXT NOT NULL CHECK (status IN ('open', 'replaced', 'done', 'void')),
  delivery     TEXT NOT NULL CHECK (delivery IN ('desktop', 'pending', 'sent', 'failed')),
  escalated_at TEXT,
  result       TEXT,
  version      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  closed_at    TEXT
) STRICT;
CREATE UNIQUE INDEX approval_questions_one_open ON approval_questions (session_id) WHERE status = 'open';
CREATE INDEX approval_questions_by_session ON approval_questions (session_id, created_at);
CREATE INDEX approval_questions_by_message ON approval_questions (message_id) WHERE message_id IS NOT NULL;

ALTER TABLE approvals ADD COLUMN question_id TEXT;
`;
