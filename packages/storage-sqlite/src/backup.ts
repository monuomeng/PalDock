import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import type { Database } from './database.js';

export interface BackupResult {
  /** 备份目录：内含 paldock.db 和 artifacts/ 副本。 */
  path: string;
}

/**
 * 手动备份到 <数据根>/backups/manual-<时间>/。先复制产物、再在线备份数据库：
 * 产物文件只增不改，先复制保证库里引用的文件都在备份中（备份期间新增的产物不在库的快照里，多复制无害）。
 * 不在范围内：worktree、执行器原生会话、凭据（见 docs/ops/backup-and-uninstall.md）。
 */
export async function backupDataRoot(db: Database, dataRoot: string, now: Date): Promise<BackupResult> {
  const path = join(dataRoot, 'backups', `manual-${now.toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(path, { recursive: true });
  const artifacts = join(dataRoot, 'artifacts');
  if (existsSync(artifacts)) cpSync(artifacts, join(path, 'artifacts'), { recursive: true });
  await backup(db.raw, join(path, 'paldock.db'));
  return { path };
}
