import {
  CodedError,
  type AgentOverrideRecord,
  type AgentProfileRecord,
  type AgentRole,
  type AgentStorePort,
  type Change,
  type Executor,
} from '@paldock/contracts';
import type { Clock } from './clock.js';
import { COLUMNS } from './columns.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';

type ProfileRow = Omit<AgentProfileRecord, 'deliveryScope'> & { deliveryScope: string };
const toProfile = ({ deliveryScope, ...row }: ProfileRow): AgentProfileRecord => ({ ...row, deliveryScope: JSON.parse(deliveryScope) as string[] });

const SQL = {
  // 角色只有六个，整表读
  selectProfiles: `SELECT ${COLUMNS.agentProfile()} FROM agent_profiles ORDER BY rowid`,
  selectProfile: `SELECT ${COLUMNS.agentProfile()} FROM agent_profiles WHERE role = ?`,
  setExecutor: `
    UPDATE agent_profiles SET executor = ?, version = version + 1, updated_at = ? WHERE role = ? AND version = ?
    RETURNING ${COLUMNS.agentProfile()}`,
  // 走主键 (workspace_id, role) 的前缀
  selectOverrides: `SELECT ${COLUMNS.agentOverride()} FROM agent_overrides WHERE workspace_id = ? ORDER BY role`,
  upsertOverride: `
    INSERT INTO agent_overrides (workspace_id, role, executor, updated_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT (workspace_id, role) DO UPDATE SET executor = ?3, updated_at = ?4
    RETURNING ${COLUMNS.agentOverride()}`,
  deleteOverride: `DELETE FROM agent_overrides WHERE workspace_id = ? AND role = ?`,
  workspaceExists: `SELECT 1 AS found FROM workspaces WHERE id = ?`,
  // 项目覆盖优先；主键查找各一次
  resolveExecutor: `
    SELECT coalesce(o.executor, p.executor) AS executor
      FROM agent_profiles p LEFT JOIN agent_overrides o ON o.workspace_id = ?1 AND o.role = p.role
     WHERE p.role = ?2`,
} as const;

export class AgentRepository implements AgentStorePort {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly clock: Clock,
  ) {}

  listProfiles(): AgentProfileRecord[] {
    return this.db.all<ProfileRow>(SQL.selectProfiles).map(toProfile);
  }

  getProfile(role: AgentRole): AgentProfileRecord | undefined {
    const row = this.db.get<ProfileRow>(SQL.selectProfile, role);
    return row && toProfile(row);
  }

  /** 改角色的默认执行器；先到者为准。 */
  setExecutor(role: AgentRole, expectedVersion: number, executor: Executor): Change<AgentProfileRecord> {
    return this.db.transaction(() => {
      const row = this.db.get<ProfileRow>(SQL.setExecutor, executor, this.clock.iso(), role, expectedVersion);
      if (!row) throw new CodedError(this.getProfile(role) ? 'conflict' : 'not_found', '角色不存在或已被修改');
      return { record: toProfile(row), events: [this.events.append(role, { type: 'agent.profile_changed', payload: { executor } })] };
    });
  }

  listOverrides(workspaceId: string): AgentOverrideRecord[] {
    return this.db.all<AgentOverrideRecord>(SQL.selectOverrides, workspaceId);
  }

  /** 项目覆盖没有并发冲突的顾虑（最后一次设置生效），不带版本号。 */
  setOverride(workspaceId: string, role: AgentRole, executor: Executor | null): Change<AgentOverrideRecord | null> {
    return this.db.transaction(() => {
      if (!this.db.get(SQL.workspaceExists, workspaceId)) throw new CodedError('not_found', '项目不存在');
      const record = executor ? this.db.get<AgentOverrideRecord>(SQL.upsertOverride, workspaceId, role, executor, this.clock.iso())! : null;
      if (!executor) this.db.run(SQL.deleteOverride, workspaceId, role);
      return { record, events: [this.events.append(workspaceId, { type: 'workspace.agent_override_changed', payload: { role, executor } })] };
    });
  }

  resolveExecutor(workspaceId: string, role: AgentRole): Executor | undefined {
    return this.db.get<{ executor: Executor }>(SQL.resolveExecutor, workspaceId, role)?.executor;
  }
}
