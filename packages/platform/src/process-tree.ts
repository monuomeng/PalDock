import { execFile, type ChildProcess } from 'node:child_process';

/**
 * 结束子进程及其所有后代。Windows 上 npm 安装的执行器是「node → codex.exe」两层，
 * 只 kill 外层 node 时内层进程仍持有管道和工作目录句柄（P0-01 实测）。
 * P0 先用 taskkill /T；Job Object 方案需原生模块，留到 P1 评估。
 * posix 要求以 `detached: true` 启动，使子进程成为进程组组长。
 */
export function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  return exited;
}
