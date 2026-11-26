/**
 * 只提交这次、只推送看过的（0.3.7，2026-11-26 已定）。约定同 001。
 * - 写入记录多一个「写之前文件内容的摘要」：整文件写入重放时据此确认期间没人改过这个文件。
 * - 卡片多一种：这一轮里暂存区变了（index），由你选择保留或恢复。git_ops 的 kind 是 CHECK 约束，只能重建这张表（没有别的表引用它）。
 * - 卡片请求的格式变了（提交带范围、推送和合并锁定预览时的提交）：升级前还没处理的卡片一律作废，请让助手重新提出。
 * - 审批分层（2026-11-26 已定）：项目外只读（access = read）、敏感路径、合并展示的组、交给协调助手判断中（routed_to）。
 */
export const commitScopeSchema = /* sql */ `
ALTER TABLE run_writes ADD COLUMN before_hash TEXT;

CREATE TABLE git_ops_new (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  session_id   TEXT,
  run_id       TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('commit', 'push', 'merge', 'index')),
  status       TEXT NOT NULL CHECK (status IN ('proposed', 'done', 'failed', 'cancelled', 'stale')),
  request      TEXT NOT NULL CHECK (json_valid(request)),
  result       TEXT,
  version      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  decided_at   TEXT
) STRICT;
INSERT INTO git_ops_new
  SELECT id, workspace_id, session_id, run_id, kind,
         CASE WHEN status = 'proposed' THEN 'stale' ELSE status END,
         request,
         CASE WHEN status = 'proposed' THEN '升级到 0.3.7 后作废：卡片格式变了，请让助手重新提出' ELSE result END,
         CASE WHEN status = 'proposed' THEN version + 1 ELSE version END,
         created_at,
         CASE WHEN status = 'proposed' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE decided_at END
    FROM git_ops;
DROP TABLE git_ops;
ALTER TABLE git_ops_new RENAME TO git_ops;
CREATE INDEX git_ops_open ON git_ops (workspace_id, created_at) WHERE status = 'proposed';
CREATE INDEX git_ops_by_session ON git_ops (session_id, created_at);

-- 项目外只读（Read / Glob / Grep 之类，不含 shell）
ALTER TABLE approvals ADD COLUMN access TEXT CHECK (access IS NULL OR access = 'read');
-- 敏感路径（凭据、密钥、.env 之类）：只能由你批，协调助手不能批
ALTER TABLE approvals ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0, 1));
-- 同一次 Run 短时间内的多个审批合并成一张卡、一条通知
ALTER TABLE approvals ADD COLUMN group_id TEXT;
-- 交给协调助手判断中；它批不了、不确定或超时就清空，回到你这里
ALTER TABLE approvals ADD COLUMN routed_to TEXT CHECK (routed_to IS NULL OR routed_to = 'coordinator');
CREATE INDEX approvals_by_group ON approvals (group_id) WHERE group_id IS NOT NULL;
`;
