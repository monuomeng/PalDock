import { dirname, join } from 'node:path';
import { isInside } from '@paldock/platform';

/**
 * 数据目录的默认位置与校验（不依赖 Electron，便于测试）。
 * 默认放在安装目录旁边（同一个盘，例如装在 D:\software\PalDock 时为 D:\software\PalDockData），
 * 不放进安装目录里：卸载会删除整个安装目录，升级时安装程序也会先卸载旧版本，数据会一起被删。
 */
export const DATA_DIR_NAME = 'PalDockData';

/** 打包后的安装目录是可执行文件所在目录；开发模式没有安装目录。 */
export function installDirOf(exePath: string, packaged: boolean): string | undefined {
  return packaged ? dirname(exePath) : undefined;
}

export function defaultDataRoot(installDir: string | undefined): string | undefined {
  return installDir && join(dirname(installDir), DATA_DIR_NAME);
}

/** 不能选的位置：安装目录及其子目录、系统与程序目录。返回拒绝原因，可用时返回 undefined。 */
export function rejectDataRoot(chosen: string, installDir: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (installDir && isInside(installDir, chosen)) {
    return '数据目录不能放在安装目录里：卸载或升级时安装目录会被整个删除，数据会一起丢失。请选择安装目录旁边或其他位置。';
  }
  const system = process.platform === 'win32'
    ? [env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData]
    : ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/Applications'];
  if (system.some((dir) => dir && isInside(dir, chosen))) {
    return '数据目录不能放在系统或程序目录里（通常没有写权限）。请选择其他位置，例如 D 盘。';
  }
  return undefined;
}
