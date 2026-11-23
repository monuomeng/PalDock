import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type Row = Record<string, SQLInputValue>;

/**
 * node:sqlite 的薄封装：统一 PRAGMA、缓存预编译语句、提供事务。
 * 只有本地服务进程持有写连接（单写者），因此这里不处理多连接写冲突。
 */
export class Database {
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  private constructor(readonly raw: DatabaseSync) {}

  static open(path: string): Database {
    const raw = new DatabaseSync(path);
    raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    return new Database(raw);
  }

  /** 同一 SQL 只编译一次；仓储类把 SQL 写成常量，命中率即为 100%。 */
  statement(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.statement(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.statement(sql).run(...params).changes);
  }

  /**
   * 外层用 BEGIN IMMEDIATE 立即拿写锁，避免读后写升级失败；嵌套调用用 SAVEPOINT。
   * 状态表更新、事件追加、outbox 写入都应在同一个 transaction 回调里完成。
   */
  transaction<T>(fn: () => T): T {
    const savepoint = `sp_${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }
}
