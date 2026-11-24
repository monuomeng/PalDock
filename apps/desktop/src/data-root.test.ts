import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultDataRoot, installDirOf, rejectDataRoot } from './data-root.js';

const base = process.platform === 'win32' ? 'D:\\software' : '/opt/software';
const install = join(base, 'PalDock');

describe('数据目录', () => {
  it('默认放在安装目录旁边；开发模式没有默认值', () => {
    expect(installDirOf(join(install, 'PalDock.exe'), true)).toBe(install);
    expect(defaultDataRoot(install)).toBe(join(base, 'PalDockData'));
    expect(defaultDataRoot(installDirOf('electron.exe', false))).toBeUndefined();
  });

  it('拒绝安装目录及其子目录，旁边的目录可用', () => {
    expect(rejectDataRoot(install, install)).toMatch(/安装目录/);
    expect(rejectDataRoot(join(install, 'data'), install)).toMatch(/安装目录/);
    expect(rejectDataRoot(join(base, 'PalDockData'), install)).toBeUndefined();
    expect(rejectDataRoot(join(base, 'PalDockCache'), install)).toBeUndefined();
    // 名字前缀相同的兄弟目录不算在安装目录里
    expect(rejectDataRoot(`${install}Data`, install)).toBeUndefined();
  });

  it('拒绝系统与程序目录', () => {
    const programFiles = process.platform === 'win32' ? 'C:\\Program Files' : '/Applications';
    expect(rejectDataRoot(join(programFiles, 'PalDockData'), undefined, { ProgramFiles: 'C:\\Program Files' })).toMatch(/系统或程序目录/);
  });
});
