import type { PersistentEvent, RunStatus } from '@paldock/contracts';
import type { Database } from './database.js';
import type { EventLog } from './event-log.js';

// 两条语句的条件都与部分索引 runs_active 逐字一致
const ACTIVE = `status IN ('starting', 'running', 'waiting_approval', 'unconfirmed')`;
const SELECT_ACTIVE_RUNS = `SELECT id, status, native_session_id AS nativeSessionId FROM runs WHERE ${ACTIVE}`;
const MARK_INTERRUPTED = `UPDATE runs SET status = 'interrupted', version = version + 1 WHERE ${ACTIVE}`;

const REOPEN_PROCESSING = `
  UPDATE inbox SET status = 'pending', lease_until = NULL
   WHERE status = 'processing'`;

export interface InterruptedRun {
  id: string;
  /** 可按原生会话 ID 尝试 resume；为空则只能提示用户重跑或放弃。 */
  nativeSessionId: string | null;
}

export interface RecoveryReport {
  interruptedRuns: InterruptedRun[];
  reopenedInbox: number;
  events: PersistentEvent[];
}

/**
 * 服务启动时（此时没有任何执行器连接）和正常退出前运行：所有未结束的 Run 置为 interrupted，
 * 处理中的入站事件放回队列重做。外部副作用是否已发生在这里无法判定，交给后续核实。
 */
export function interruptActiveWork(db: Database, events: EventLog, reason: string): RecoveryReport {
  return db.transaction(() => {
    const active = db.all<{ id: string; status: RunStatus; nativeSessionId: string | null }>(SELECT_ACTIVE_RUNS);
    db.run(MARK_INTERRUPTED);
    const emitted = active.map((run) =>
      events.append(run.id, {
        type: 'run.status_changed',
        payload: { from: run.status, to: 'interrupted', reason },
      }),
    );
    const reopenedInbox = db.run(REOPEN_PROCESSING);
    return {
      interruptedRuns: active.map(({ id, nativeSessionId }) => ({ id, nativeSessionId })),
      reopenedInbox,
      events: emitted,
    };
  });
}
