import { join } from 'node:path';
import type { PersistentEvent, RecoveryItem, RecoveryReport, StorePort } from '@paldock/contracts';
import { AgentRepository } from './agent-repository.js';
import { AttentionQueries } from './attention.js';
import { AuditLog } from './audit-log.js';
import { RoleSessionRepository } from './role-session-repository.js';
import { backupDataRoot, type BackupResult } from './backup.js';
import { ChannelRepository } from './channel-repository.js';
import { Clock } from './clock.js';
import { Database } from './database.js';
import { EventLog } from './event-log.js';
import { Inbox } from './inbox.js';
import { MessageStore } from './messages.js';
import { migrate, type MigrateResult } from './migrations/index.js';
import { Outbox } from './outbox.js';
import { PlanRepository } from './plan-repository.js';
import { MergeRepository } from './merge-repository.js';
import { CoordinatorRepository } from './coordinator-repository.js';
import { AutoDecisionLog } from './auto-decisions.js';
import { interruptActiveWork } from './recovery.js';
import { RunRepository } from './run-repository.js';
import { TaskRepository } from './task-repository.js';

export type { AgentRepository } from './agent-repository.js';
export type { AttentionQueries } from './attention.js';
export type { BackupResult } from './backup.js';
export type { ChannelRepository } from './channel-repository.js';
export { Clock } from './clock.js';
export { Database } from './database.js';
export type { EventLog } from './event-log.js';
export type { Inbox, InboxItem } from './inbox.js';
export type { MessageStore } from './messages.js';
export type { Outbox } from './outbox.js';
export type { PlanRepository } from './plan-repository.js';
export type { MergeRepository } from './merge-repository.js';
export type { CoordinatorRepository } from './coordinator-repository.js';
export type { AutoDecisionLog } from './auto-decisions.js';
export { MIGRATIONS, migrate, type MigrateResult, type Migration } from './migrations/index.js';
export { ACTIVE_RUN_STATUSES, interruptActiveWork } from './recovery.js';
export type { RunRepository } from './run-repository.js';
export type { TaskRepository } from './task-repository.js';

export interface Store extends StorePort {
  db: Database;
  events: EventLog;
  tasks: TaskRepository;
  runs: RunRepository;
  agents: AgentRepository;
  plans: PlanRepository;
  merges: MergeRepository;
  coordinator: CoordinatorRepository;
  autoDecisions: AutoDecisionLog;
  audit: AuditLog;
  inbox: Inbox;
  attention: AttentionQueries;
  messages: MessageStore;
  channels: ChannelRepository;
  outbox: Outbox;
  roleSessions: RoleSessionRepository;
  migration: MigrateResult;
  /** 中断所有未结束的工作（启动恢复、正常退出前）。 */
  interruptActiveWork(reason: string): RecoveryReport;
  recordRecovery(item: Omit<RecoveryItem, 'at'>): PersistentEvent;
  /** 手动备份数据库与 artifacts/；内存库不支持。 */
  backup(): Promise<BackupResult>;
  /** 多个仓储写入合成一个事务（内层用 SAVEPOINT）。 */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** 打开数据根下的 paldock.db 并迁移到最新版本；`:memory:` 用于测试。 */
export async function openStore(dataRoot: string | ':memory:', now: () => Date = () => new Date()): Promise<Store> {
  const inMemory = dataRoot === ':memory:';
  const clock = new Clock(now);
  const db = Database.open(inMemory ? ':memory:' : join(dataRoot, 'paldock.db'));
  const migration = await migrate(db, inMemory ? { now } : { backupDir: join(dataRoot, 'backups'), now });
  const events = new EventLog(db, clock);
  const tasks = new TaskRepository(db, events, clock);
  return {
    db,
    events,
    tasks,
    plans: new PlanRepository(db, events, clock, tasks),
    merges: new MergeRepository(db, clock),
    coordinator: new CoordinatorRepository(db, events, clock),
    autoDecisions: new AutoDecisionLog(db, events, clock),
    runs: new RunRepository(db, events, clock),
    agents: new AgentRepository(db, events, clock),
    audit: new AuditLog(db, clock),
    inbox: new Inbox(db, clock),
    attention: new AttentionQueries(db, clock),
    messages: new MessageStore(db, events, clock),
    channels: new ChannelRepository(db, events, clock),
    outbox: new Outbox(db, clock),
    roleSessions: new RoleSessionRepository(db, clock),
    migration,
    interruptActiveWork: (reason) => interruptActiveWork(db, events, clock, reason),
    recordRecovery: ({ kind, targetId, outcome, detail }) =>
      events.append(targetId, { type: 'recovery.performed', payload: detail ? { kind, outcome, detail: detail.slice(0, 500) } : { kind, outcome } }),
    backup: () => {
      if (inMemory) return Promise.reject(new Error('内存库不支持备份'));
      return backupDataRoot(db, dataRoot, now());
    },
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
}
