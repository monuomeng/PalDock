import { join } from 'node:path';
import { AttentionQueries } from './attention.js';
import { Database } from './database.js';
import { EventLog } from './event-log.js';
import { Inbox } from './inbox.js';
import { MessageStore } from './messages.js';
import { migrate, type MigrateResult } from './migrations/index.js';
import { recoverOnStartup } from './recovery.js';
import { TaskRepository } from './task-repository.js';

export * from './attention.js';
export * from './database.js';
export * from './event-log.js';
export * from './inbox.js';
export * from './messages.js';
export * from './migrations/index.js';
export * from './recovery.js';
export * from './status-transition.js';
export * from './task-repository.js';

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
  const db = Database.open(inMemory ? ':memory:' : join(dataRoot, 'paldock.db'));
  const migration = await migrate(db, inMemory ? { now } : { backupDir: join(dataRoot, 'backups'), now });
  const events = new EventLog(db, now);
  return {
    db,
    events,
    tasks: new TaskRepository(db, events, now),
    inbox: new Inbox(db, now),
    attention: new AttentionQueries(db, now),
    messages: new MessageStore(db, events, now),
    migration,
    close: () => db.close(),
  };
}

