import { existsSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve, sep } from 'node:path';

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
