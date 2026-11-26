import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import type { Database } from '../database.js';
import { initialSchema } from './001-initial.js';
import { p1Schema } from './002-p1-sessions-runs.js';
import { p2Schema } from './003-p2-channels.js';
import { taskContinuationSchema } from './004-task-continuation.js';
import { agentProfilesSchema } from './005-agent-profiles.js';
import { mcpBridgeSchema } from './006-mcp-bridge.js';
import { taskGraphSchema } from './007-task-graph.js';
import { reviewGateSchema } from './008-review-gate.js';
import { integrationBranchSchema } from './009-integration-branch.js';
import { prepareCommandSchema } from './010-prepare-command.js';
import { coordinatorSchema } from './011-coordinator.js';
import { planEditAutoSchema } from './012-plan-edit-auto.js';
import { externalMainSessionSchema } from './013-external-main-session.js';
import { planAutoConfirmSchema } from './014-plan-auto-confirm.js';
import { roleSessionsSchema } from './015-role-sessions.js';
import { projectSettingsSchema } from './016-project-settings.js';
import { currentWorkspaceSchema } from './017-current-workspace.js';
import { commitScopeSchema } from './018-commit-scope.js';
import { approvalQuestionsSchema } from './019-approval-questions.js';
import { wakeMessageSchema } from './020-wake-message.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** 单向递增；已发布的迁移不再修改，只追加新版本。 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial', sql: initialSchema },
  { version: 2, name: 'p1-sessions-runs', sql: p1Schema },
  { version: 3, name: 'p2-channels', sql: p2Schema },
  { version: 4, name: 'task-continuation', sql: taskContinuationSchema },
  { version: 5, name: 'agent-profiles', sql: agentProfilesSchema },
  { version: 6, name: 'mcp-bridge', sql: mcpBridgeSchema },
  { version: 7, name: 'task-graph', sql: taskGraphSchema },
  { version: 8, name: 'review-gate', sql: reviewGateSchema },
  { version: 9, name: 'integration-branch', sql: integrationBranchSchema },
  { version: 10, name: 'prepare-command', sql: prepareCommandSchema },
  { version: 11, name: 'coordinator', sql: coordinatorSchema },
  { version: 12, name: 'plan-edit-auto', sql: planEditAutoSchema },
  { version: 13, name: 'external-main-session', sql: externalMainSessionSchema },
  { version: 14, name: 'plan-auto-confirm', sql: planAutoConfirmSchema },
  { version: 15, name: 'role-sessions', sql: roleSessionsSchema },
  { version: 16, name: 'project-settings', sql: projectSettingsSchema },
  { version: 17, name: 'current-workspace', sql: currentWorkspaceSchema },
  { version: 18, name: 'commit-scope', sql: commitScopeSchema },
  { version: 19, name: 'approval-questions', sql: approvalQuestionsSchema },
  { version: 20, name: 'wake-message', sql: wakeMessageSchema },
];

export interface MigrateResult {
  from: number;
  to: number;
  backupPath?: string;
}

function currentVersion(db: Database): number {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
  ) STRICT`);
  return db.get<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations')?.v ?? 0;
}

export interface MigrateOptions {
  backupDir?: string;
  now?: () => Date;
  migrations?: readonly Migration[];
}

/**
 * 有待执行的迁移且库里已有数据时，先用 SQLite online backup 备份到 backupDir，
 * 再在一个事务里依次执行；任何一步失败整体回滚，备份保留供恢复。
 */
export async function migrate(db: Database, options: MigrateOptions = {}): Promise<MigrateResult> {
  const { backupDir, now = () => new Date(), migrations = MIGRATIONS } = options;
  const from = currentVersion(db);
  const pending = migrations.filter((m) => m.version > from);
  if (pending.length === 0) return { from, to: from };

  let backupPath: string | undefined;
  if (from > 0 && backupDir) {
    mkdirSync(backupDir, { recursive: true });
    backupPath = join(backupDir, `paldock-v${from}-${now().toISOString().replace(/[:.]/g, '-')}.db`);
    await backup(db.raw, backupPath);
  }

  db.transaction(() => {
    for (const m of pending) {
      db.raw.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, now().toISOString());
    }
  });
  const to = pending.at(-1)!.version;
  return backupPath ? { from, to, backupPath } : { from, to };
}
