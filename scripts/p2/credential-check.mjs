// P2 系统凭据库自检：在 Windows 凭据管理器 / macOS 钥匙串里写入、读取、覆盖、删除一条临时凭据。
// 只用随机生成的假秘密，名称带 paldock-selftest 前缀，结束时删除；结果写到 p2-credential-check.json，不输出秘密本身。
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { deleteCredential, readCredential, writeCredential } from '../../packages/platform/dist/index.js';

const target = `paldock-selftest/${randomBytes(4).toString('hex')}`;
// 含引号、反斜杠、空格和中文，覆盖钥匙串命令的转义
const secrets = [`a"b\\c d ${randomBytes(8).toString('hex')}`, `第二个 ${randomBytes(8).toString('base64url')}:x`];
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

try {
  await writeCredential(target, { user: 'bot', secret: secrets[0] });
  let read = await readCredential(target);
  check('写入后能读回', read?.secret === secrets[0] && read?.user === 'bot', read ? `user=${read.user}` : '读不到');
  await writeCredential(target, { user: 'cli_app', secret: secrets[1] });
  read = await readCredential(target);
  check('覆盖写入', read?.secret === secrets[1] && read?.user === 'cli_app', read ? `user=${read.user}` : '读不到');
  await deleteCredential(target);
  check('删除后读不到', (await readCredential(target)) === undefined);
  await deleteCredential(target);
  check('重复删除不报错', true);
} catch (error) {
  check('未预期的异常', false, error instanceof Error ? error.message : String(error));
  await deleteCredential(target).catch(() => {});
}

const failed = checks.filter((c) => !c.ok).length;
const result = { platform: process.platform, target, checks, failed };
writeFileSync('p2-credential-check.json', `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(failed === 0 ? 0 : 1);
