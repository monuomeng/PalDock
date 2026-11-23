import { join } from 'node:path';
import { AttentionQueries } from './attention.js';
import { Clock } from './clock.js';
import { Database } from './database.js';
import { EventLog } from './event-log.js';
import { Inbox } from './inbox.js';
import { MessageStore } from './messages.js';
import { migrate, type MigrateResult } from './migrations/index.js';
import { TaskRepository } from './task-repository.js';

export type { AttentionItem, AttentionQueries } from './attention.js';
export { Clock } from './clock.js';
export { Database } from './database.js';
export type { EventLog } from './event-log.js';
export type { Inbox, InboxItem } from './inbox.js';
export type { MessageRecord, MessageStore } from './messages.js';
export { MIGRATIONS, migrate, type MigrateResult, type Migration } from './migrations/index.js';
export { ACTIVE_RUN_STATUSES, interruptActiveWork, type InterruptedRun, type RecoveryReport } from './recovery.js';
export type * from './task-repository.js';
export type { Change } from './writes.js';

export interface Store {
  db: Database;
  events: EventLog;
  tasks: TaskRepository;
  inbox: Inbox;
  attention: AttentionQueries;
  messages: MessageStore;
  migration: MigrateResult;
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
    inbox: new Inbox(db, clock),
    attention: new AttentionQueries(db, clock),
    messages: new MessageStore(db, events, clock),
    migration,
    close: () => db.close(),
  };
}
