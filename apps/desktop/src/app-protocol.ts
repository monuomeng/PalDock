import { extname, join, normalize, sep } from 'node:path';
import { readFile } from 'node:fs/promises';
import { protocol } from 'electron';

/**
 * 管理界面经自定义协议 `paldock://app/` 加载，而不是 file://：
 * 浏览器 ES 模块需要标准、安全的来源；协议处理器只返回打包目录内的静态文件，其余一律 404。
 */
const SCHEME = 'paldock';
export const APP_ORIGIN = `${SCHEME}://app`;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** 必须在 app ready 之前调用。 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } }]);
}

export function serveRenderer(staticDir: string): void {
  const base = normalize(staticDir + sep);
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const file = normalize(join(staticDir, decodeURIComponent(url.pathname)));
    const type = TYPES[extname(file)];
    if (url.host !== 'app' || !file.startsWith(base) || !type) return new Response('not found', { status: 404 });
    try {
      return new Response(await readFile(file), { headers: { 'content-type': type } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}
