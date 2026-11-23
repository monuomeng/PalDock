import type { SQLInputValue } from 'node:sqlite';
import type { Change, PersistentEventBody } from '@paldock/contracts';
import { DomainError, type StateMachine } from '@paldock/domain';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';

export type { Change };

/** 插入一行并追加对应事件，同一事务；记录直接来自 RETURNING，不回查。 */
export function insertWithEvent<T extends { id: string | number }>(
  db: Database,
  events: EventLog,
  sql: string,
  params: SQLInputValue[],
  toEvent: (record: T) => PersistentEventBody,
): Change<T> {
  return db.transaction(() => {
    const record = db.get<T>(sql, ...params)!;
    return { record, events: [events.append(String(record.id), toEvent(record))] };
  });
}

export interface TransitionSpec<S extends string> {
  machine: StateMachine<S>;
  /** `SELECT status, version FROM <table> WHERE id = ?` */
  select: string;
  /** 以 `WHERE id = $id AND version = $version` 结尾并 RETURNING 记录的 UPDATE。 */
  update: string;
}

export interface TransitionPlan {
  /** update 语句除 $id / $version / $to 外需要的命名参数。 */
  params: Record<string, SQLInputValue>;
  event: PersistentEventBody;
}

/**
 * 状态迁移：读当前状态 → 校验版本与状态机 → 带 version 条件更新 → 追加事件，同一事务。
 * 各实体的差异（额外列、事件形状）由 plan 回调根据迁移前的状态给出，规则留在 TypeScript 里。
 */
export function applyTransition<S extends string, T>(
  db: Database,
  events: EventLog,
  spec: TransitionSpec<S>,
  id: string,
  expectedVersion: number,
  to: S,
  plan: (from: S) => TransitionPlan,
): Change<T> {
  return db.transaction(() => {
    const current = db.get<{ status: S; version: number }>(spec.select, id);
    if (!current) throw new DomainError('not_found', `${spec.machine.name} 不存在：${id}`);
    if (current.version !== expectedVersion) {
      throw new DomainError('conflict', `${spec.machine.name} 已被修改（当前版本 ${current.version}）`);
    }
    spec.machine.assertTransition(current.status, to);

    const { params, event } = plan(current.status);
    const record = db.statement(spec.update).get({ ...params, id, version: expectedVersion, to }) as T;
    return { record, events: [events.append(id, event)] };
  });
}

/** `*.status_changed` 事件载荷；reason 缺省时不写该字段。 */
export function statusChanged<S extends string>(from: S, to: S, reason?: string) {
  return reason === undefined ? { from, to } : { from, to, reason };
}
