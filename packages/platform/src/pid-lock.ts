import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_FILE = 'paldock.lock';

export type LockResult = { acquired: true; release: () => void } | { acquired: false; holderPid: number };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但属于其他用户，同样视为存活
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolder(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把确认失效的锁文件改名移走。改名是原子的，同时接管时只有一个进程能移走同一个文件；
 * 若移走的已不是那份失效锁（别人刚写入了新锁），立即放回并放弃接管。
 */
function removeStaleLock(path: string, stalePid: number | undefined, pid: number): void {
  const aside = `${path}.stale-${pid}`;
  try {
    renameSync(path, aside);
  } catch {
    return; // 已被其他进程移走
  }
  if (readHolder(aside) === stalePid) rmSync(aside, { force: true });
  else renameSync(aside, path);
}

/**
 * 数据根上的 PID 锁，防止两个服务写同一个数据库（Electron 单实例锁之外的第二道防线）。
 * 用 `wx` 独占创建；已存在时检查持有者是否存活，持有者已死则移走遗留锁后重试一次。
 * PID 复用会让遗留锁被误判为存活：此时宁可拒绝启动，由用户确认后手动删除。
 */
export function acquirePidLock(dataRoot: string, pid = process.pid): LockResult {
  const path = join(dataRoot, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(pid), { flag: 'wx' });
      return {
        acquired: true,
        release: () => {
          if (readHolder(path) === pid) rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readHolder(path);
      if (holder !== undefined && isAlive(holder)) return { acquired: false, holderPid: holder };
      removeStaleLock(path, holder, pid);
    }
  }
  return { acquired: false, holderPid: readHolder(path) ?? -1 };
}
