import {
  CodedError,
  type Change,
  type ProjectAgentSettings,
  type ProjectRolePatch,
  type ProjectRoleSetting,
  type ProjectSettingsPatch,
  type ProjectSettingsStorePort,
} from '@paldock/contracts';
import type { Clock } from './clock.js';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';

type SettingsRow = Omit<ProjectAgentSettings, 'soloReview'> & { soloReview: number };
type RoleRow = Omit<ProjectRoleSetting, 'enabled'> & { enabled: number };

const SQL = {
  settings: `
    SELECT workspace_id AS workspaceId, mode, solo_executor AS soloExecutor, solo_isolation AS soloIsolation,
           solo_approval AS soloApproval, solo_review AS soloReview, version
      FROM project_agent_settings WHERE workspace_id = ?`,
  upsertSettings: `
    INSERT INTO project_agent_settings (workspace_id, mode, solo_executor, solo_isolation, solo_approval, solo_review, version, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?8)
    ON CONFLICT (workspace_id) DO UPDATE SET mode = ?2, solo_executor = ?3, solo_isolation = ?4, solo_approval = ?5, solo_review = ?6,
      version = version + 1, updated_at = ?8
    WHERE version = ?7`,
  role: `
    SELECT workspace_id AS workspaceId, role, enabled, isolation, approval, version
      FROM project_role_settings WHERE workspace_id = ? AND role = ?`,
  roles: `SELECT role FROM agent_profiles WHERE role <> 'coordinator' ORDER BY rowid`,
  access: `SELECT workspace_access AS access FROM agent_profiles WHERE role = ?`,
  upsertRole: `
    INSERT INTO project_role_settings (workspace_id, role, enabled, isolation, approval, version, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 1, ?7)
    ON CONFLICT (workspace_id, role) DO UPDATE SET enabled = ?3, isolation = ?4, approval = ?5, version = version + 1, updated_at = ?7
    WHERE version = ?6`,
} as const;

/**
 * 项目级助手设置（2026-11-26 已定）。没有行时返回默认值（version 0），第一次保存插入；之后按版本号更新，先到者为准。
 * 默认：团队模式；单人模式直接在项目目录里改、worktree 内自动批准、不审阅；角色全部启用，可写角色独立 worktree、只读角色只读。
 */
export class ProjectSettingsRepository implements ProjectSettingsStorePort {
  constructor(
    private readonly db: Database,
    private readonly events: EventLog,
    private readonly clock: Clock,
  ) {}

  get(workspaceId: string): ProjectAgentSettings {
    const row = this.db.get<SettingsRow>(SQL.settings, workspaceId);
    if (!row) return { workspaceId, mode: 'team', soloExecutor: null, soloIsolation: 'direct', soloApproval: 'worktree_auto', soloReview: false, version: 0 };
    return { ...row, soloReview: row.soloReview === 1 };
  }

  set(workspaceId: string, expectedVersion: number, patch: ProjectSettingsPatch): Change<ProjectAgentSettings> {
    return this.db.transaction(() => {
      const current = this.get(workspaceId);
      if (current.version !== expectedVersion) throw new CodedError('conflict', '项目设置已被修改，请刷新');
      const next = { ...current, ...patch };
      const changed = this.db.run(
        SQL.upsertSettings,
        workspaceId,
        next.mode,
        next.soloExecutor,
        next.soloIsolation,
        next.soloApproval,
        next.soloReview ? 1 : 0,
        expectedVersion,
        this.clock.iso(),
      );
      if (changed === 0) throw new CodedError('conflict', '项目设置已被修改，请刷新');
      return { record: this.get(workspaceId), events: [this.events.append(workspaceId, { type: 'project.settings_changed', payload: { role: null } })] };
    });
  }

  role(workspaceId: string, role: string): ProjectRoleSetting {
    const row = this.db.get<RoleRow>(SQL.role, workspaceId, role);
    if (row) return { ...row, enabled: row.enabled === 1 };
    const access = this.db.get<{ access: string }>(SQL.access, role)?.access;
    return { workspaceId, role, enabled: true, isolation: access === 'worktree_write' ? 'worktree' : 'readonly', approval: 'worktree_auto', version: 0 };
  }

  roles(workspaceId: string): ProjectRoleSetting[] {
    return this.db.all<{ role: string }>(SQL.roles).map(({ role }) => this.role(workspaceId, role));
  }

  setRole(workspaceId: string, role: string, expectedVersion: number, patch: ProjectRolePatch): Change<ProjectRoleSetting> {
    return this.db.transaction(() => {
      const current = this.role(workspaceId, role);
      if (current.version !== expectedVersion) throw new CodedError('conflict', '项目设置已被修改，请刷新');
      const next = { ...current, ...patch };
      const changed = this.db.run(SQL.upsertRole, workspaceId, role, next.enabled ? 1 : 0, next.isolation, next.approval, expectedVersion, this.clock.iso());
      if (changed === 0) throw new CodedError('conflict', '项目设置已被修改，请刷新');
      return { record: this.role(workspaceId, role), events: [this.events.append(workspaceId, { type: 'project.settings_changed', payload: { role } })] };
    });
  }
}
