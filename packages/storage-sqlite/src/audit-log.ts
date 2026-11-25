import type { AuditPort } from '@paldock/contracts';
import type { Clock } from './clock.js';
import type { Database } from './database.js';

const INSERT = `INSERT INTO audit_log (at, actor, action, target, result) VALUES (?, ?, ?, ?, ?)`;

/** 只追加的审计日志；不放参数正文，只记谁、做了什么、对象和结果。 */
export class AuditLog implements AuditPort {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  append(actor: string, action: string, target: string | null, result: string): void {
    this.db.run(INSERT, this.clock.iso(), actor, action, target, result.slice(0, 500));
  }
}
