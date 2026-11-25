import type { AutoDecisionRecord, AutoDecisionStorePort, Change } from '@paldock/contracts';
import type { Clock } from './clock.js';
import { COLUMNS } from './columns.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';
import { insertWithEvent } from './writes.js';

const SQL = {
  insert: `
    INSERT INTO auto_decisions (workspace_id, task_id, plan_id, subtask_id, kind, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING ${COLUMNS.autoDecision()}`,
  // auto_decisions_by_workspace 倒序；不筛项目时按主键倒序
  byWorkspace: `SELECT ${COLUMNS.autoDecision()} FROM auto_decisions WHERE workspace_id = ? ORDER BY id DESC LIMIT ?`,
  all: `SELECT ${COLUMNS.autoDecision()} FROM auto_decisions ORDER BY id DESC LIMIT ?`,
} as const;

/** 自动处理记录单：凡是没经过用户的决定都留一条，只追加。 */
export class AutoDecisionLog implements AutoDecisionStorePort {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly clock: Clock,
  ) {}

  record(input: Omit<AutoDecisionRecord, 'id' | 'createdAt'>): Change<AutoDecisionRecord> {
    const params = [input.workspaceId, input.taskId, input.planId, input.subtaskId, input.kind, input.reason.slice(0, 500), this.clock.iso()];
    return insertWithEvent<AutoDecisionRecord>(
      this.db,
      this.events,
      SQL.insert,
      params,
      (r) => ({ type: 'auto.decided', payload: { decisionId: r.id, kind: r.kind } }),
      (r) => r.taskId,
    );
  }

  list(workspaceId: string | null, limit: number): AutoDecisionRecord[] {
    return workspaceId ? this.db.all<AutoDecisionRecord>(SQL.byWorkspace, workspaceId, limit) : this.db.all<AutoDecisionRecord>(SQL.all, limit);
  }
}
