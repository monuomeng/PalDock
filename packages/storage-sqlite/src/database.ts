import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { CodedError } from '@paldock/contracts';

export type Row = Record<string, SQLInputValue>;

// SQLite 扩展错误码：https://www.sqlite.org/rescode.html
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** 把调用方能理解的约束错误转成业务错误码；其余错误原样抛出，由服务端记为 internal。 */
function toCodedError(error: unknown): unknown {
  const errcode = (error as { errcode?: number }).errcode;
  if (errcode === SQLITE_CONSTRAINT_FOREIGNKEY) return new CodedError('not_found', '引用的对象不存在');
  if (errcode === SQLITE_CONSTRAINT_UNIQUE || errcode === SQLITE_CONSTRAINT_PRIMARYKEY) {
    return new CodedError('conflict', '对象已存在');
  }
  return error;
}

function mapErrors<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw toCodedError(error);
  }
}

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
    return mapErrors(() => this.statement(sql).get(...params) as T | undefined);
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return mapErrors(() => this.statement(sql).all(...params) as T[]);
  }

  run(sql: string, ...params: SQLInputValue[]): number {
    return mapErrors(() => Number(this.statement(sql).run(...params).changes));
  }

  /**
   * 外层用 BEGIN IMMEDIATE 立即拿写锁，避免读后写升级失败；嵌套调用用 SAVEPOINT。
   * 状态表更新、事件追加、outbox 写入都应在同一个 transaction 回调里完成。
   */
  transaction<T>(fn: () => T): T {
    const outermost = this.depth === 0;
    const savepoint = `sp_${this.depth}`;
    this.raw.exec(outermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth++;
    let result: T;
    try {
      result = fn();
    } catch (error) {
      this.depth--;
      this.raw.exec(outermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw toCodedError(error);
    }
    this.depth--;
    try {
      this.raw.exec(outermost ? 'COMMIT' : `RELEASE ${savepoint}`);
    } catch (error) {
      // 提交失败（磁盘满、忙等）时事务仍处于打开状态，必须回滚，否则后续写入都会失败
      if (this.raw.isTransaction) this.raw.exec(outermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
    return result;
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }
}
