import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RENDERER = fileURLToPath(new URL('../renderer/src', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : [],
  );
}

/** import 语句里去掉 `type X` 之后还剩下的名字（有就是值导入）。 */
function valueNames(clause: string): string[] {
  const braces = /\{([^}]*)\}/.exec(clause)?.[1] ?? '';
  const outside = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
  return [...braces.split(',').map((n) => n.trim()).filter((n) => n && !n.startsWith('type ')), ...(outside ? [outside] : [])];
}

describe('渲染进程的导入', () => {
  // 渲染进程按 ES 模块直接从 paldock://app 加载，没有打包器：从 @paldock/* 导入值，浏览器解析不了，
  // 整个页面脚本加载失败，界面停在「本地服务启动中…」（0.3.0 安装包实测）。只能导入类型。
  it('只从 @paldock/* 导入类型', () => {
    const offenders: string[] = [];
    for (const file of sources(RENDERER)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/^import\s+(?!type\s)([\s\S]*?)\s+from\s+'(@paldock\/[^']+)'/gm)) {
        const names = valueNames(m[1]!);
        if (names.length > 0) offenders.push(`${relative(RENDERER, file)}: ${names.join(', ')} from ${m[2]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
