import { join } from 'node:path';
import type { RecoveryReport, StorePort } from '@paldock/contracts';
import { AttentionQueries } from './attention.js';
import { backupDataRoot, type BackupResult } from './backup.js';
import { ChannelRepository } from './channel-repository.js';
import { Clock } from './clock.js';
import { Database } from './database.js';
import { EventLog } from './event-log.js';
import { Inbox } from './inbox.js';
import { MessageStore } from './messages.js';
import { migrate, type MigrateResult } from './migrations/index.js';
import { Outbox } from './outbox.js';
import { interruptActiveWork } from './recovery.js';
import { RunRepository } from './run-repository.js';
import { TaskRepository } from './task-repository.js';

export type { AttentionQueries } from './attention.js';
export type { BackupResult } from './backup.js';
export type { ChannelRepository } from './channel-repository.js';
export { Clock } from './clock.js';
export { Database } from './database.js';
export type { EventLog } from './event-log.js';
export type { Inbox, InboxItem } from './inbox.js';
export type { MessageStore } from './messages.js';
export type { Outbox } from './outbox.js';
export { MIGRATIONS, migrate, type MigrateResult, type Migration } from './migrations/index.js';
export { ACTIVE_RUN_STATUSES, interruptActiveWork } from './recovery.js';
export type { RunRepository } from './run-repository.js';
export type { TaskRepository } from './task-repository.js';

export interface Store extends StorePort {
  db: Database;
  events: EventLog;
  tasks: TaskRepository;
  runs: RunRepository;
  inbox: Inbox;
  attention: AttentionQueries;
  messages: MessageStore;
  channels: ChannelRepository;
  outbox: Outbox;
  migration: MigrateResult;
  /** 中断所有未结束的工作（启动恢复、正常退出前）。 */
  interruptActiveWork(reason: string): RecoveryReport;
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
  return {
    db,
    events,
    tasks: new TaskRepository(db, events, clock),
    runs: new RunRepository(db, events, clock),
    inbox: new Inbox(db, clock),
    attention: new AttentionQueries(db, clock),
    messages: new MessageStore(db, events, clock),
    channels: new ChannelRepository(db, events, clock),
    outbox: new Outbox(db, clock),
    migration,
    interruptActiveWork: (reason) => interruptActiveWork(db, events, clock, reason),
    backup: () => {
      if (inMemory) return Promise.reject(new Error('内存库不支持备份'));
      return backupDataRoot(db, dataRoot, now());
    },
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  };
}
