import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Windows 与 macOS 默认文件系统都不区分大小写，路径比较统一转小写；Linux 区分。 */
const normalize = (path: string) => {
  const full = resolve(path);
  return process.platform === 'linux' ? full : full.toLowerCase();
};

export function samePath(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

/** path（相对路径按 root 解析）是否位于 root 之内；前缀相同的兄弟目录不算。 */
export function isInside(root: string, path: string): boolean {
  const base = normalize(root);
  const target = normalize(resolve(root, path));
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * 真实路径（跟随符号链接）；还不存在的文件取最近一个已存在的上级的真实路径再接上余下部分（0.3.9）。
 * 例如 macOS 上 /var 是 /private/var 的链接，执行器报告的路径可能是任一种写法。
 */
export function realOrNearest(path: string): string {
  const rest: string[] = [];
  let cur = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(path);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** 同 isInside，但两边都按真实路径比较（软链的项目、macOS 的临时目录、Windows 盘符大小写不同时也判断正确）。 */
export function isInsideReal(root: string, path: string): boolean {
  return isInside(realOrNearest(root), realOrNearest(resolve(root, path)));
}

/** path 相对 root 的路径（两边按真实路径算）；不在 root 里时返回 undefined。 */
export function relativeReal(root: string, path: string): string | undefined {
  const base = realOrNearest(root);
  const target = realOrNearest(resolve(root, path));
  if (!isInside(base, target)) return undefined;
  return relative(base, target);
}

/** 在给定环境的 PATH 上查找可执行文件；Windows 按 PATHEXT 补扩展名（.EXE 先于 .CMD）。 */
export function resolveExecutable(executable: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  const extensions =
    process.platform === 'win32' && extname(executable) === ''
      ? (env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  if (isAbsolute(executable)) return extensions.map((ext) => executable + ext).find(isFile);
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    const found = extensions.map((ext) => join(dir, executable + ext)).find(isFile);
    if (found) return found;
  }
  return undefined;
}

/**
 * 不允许当作项目或数据目录的系统位置。比较时双方都应是真实路径：
 * macOS 的 /etc、/var、/tmp 都是 /private 下的链接，但用户的临时目录（/private/var/folders）是正常的可写位置，
 * 所以只列具体的系统目录，不能整个拦 /private（CI 实测）。
 */
export function systemDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform === 'win32') {
    return [env.SystemRoot, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData].filter((p): p is string => !!p);
  }
  return ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/boot', '/proc', '/sys', '/dev'];
}

export function isSystemDirectory(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return systemDirectories(env).some((dir) => isInside(dir, path));
}
