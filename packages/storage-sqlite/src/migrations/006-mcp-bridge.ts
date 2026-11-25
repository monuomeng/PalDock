/**
 * P3-03 MCP 桥：专业助手提交的交接记录（每次 Run 一份），以及审计日志按时间查询的索引。
 * 一次性令牌只放在服务内存里：服务重启时所有 Run 都已中断，旧令牌本来就该作废，落库反而多一处要清理的凭据。
 */
export const mcpBridgeSchema = /* sql */ `
CREATE TABLE run_handoffs (
  run_id       TEXT PRIMARY KEY REFERENCES runs (id),
  summary      TEXT NOT NULL,
  notes        TEXT,
  submitted_at TEXT NOT NULL
) STRICT;

CREATE INDEX audit_by_time ON audit_log (at);
`;
