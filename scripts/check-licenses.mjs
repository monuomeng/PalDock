#!/usr/bin/env node
// 许可证检查：产品以 Apache-2.0 开源，只允许宽松许可的依赖（含传递依赖），不引入 GPL / AGPL 等 copyleft 依赖。
// 依赖清单来自 `pnpm licenses list --json`；按 SPDX 表达式判定：OR 有一支允许即可，AND 每一支都要允许。
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'Unlicense',
  'CC0-1.0',
  'Python-2.0',
]);

/** 允许的 `WITH` 例外（只放宽、不附加 copyleft 义务的）。 */
const ALLOWED_EXCEPTIONS = new Set(['LLVM-exception']);

/** 逐个登记的例外：包名 → 理由。没有理由不得加入。 */
const PACKAGE_EXCEPTIONS = new Map([]);

/** devDependencies 里会随安装包一起分发的包，同样要检查。 */
const DISTRIBUTED_DEV_PACKAGES = new Set(['electron']);

function tokenize(expression) {
  return expression.match(/\(|\)|[^\s()]+/g) ?? [];
}

/** 递归下降解析 SPDX 表达式；AND 优先级高于 OR。无法解析时抛错。 */
export function isAllowed(expression) {
  const tokens = tokenize(expression);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const primary = () => {
    const token = next();
    if (token === undefined) throw new Error('表达式不完整');
    if (token === '(') {
      const value = orExpr();
      if (next() !== ')') throw new Error('括号不匹配');
      return value;
    }
    if (['AND', 'OR', 'WITH', ')'].includes(token)) throw new Error(`意外的 ${token}`);
    let allowed = ALLOWED.has(token.replace(/\+$/, ''));
    if (peek() === 'WITH') {
      next();
      const exception = next();
      if (exception === undefined) throw new Error('WITH 后缺少例外名');
      allowed &&= ALLOWED_EXCEPTIONS.has(exception);
    }
    return allowed;
  };
  const andExpr = () => {
    let value = primary();
    while (peek() === 'AND') {
      next();
      value = primary() && value;
    }
    return value;
  };
  const orExpr = () => {
    let value = andExpr();
    while (peek() === 'OR') {
      next();
      value = andExpr() || value;
    }
    return value;
  };

  const value = orExpr();
  if (pos !== tokens.length) throw new Error(`多余的 ${tokens[pos]}`);
  return value;
}

function listPackages(prodOnly) {
  // 命令是固定文本，不含外部输入；Windows 上 pnpm 是 .cmd，只能经 shell 启动
  const output = execSync(`pnpm licenses list --json${prodOnly ? ' --prod' : ''}`, { encoding: 'utf8' });
  return Object.values(JSON.parse(output)).flat();
}

function main() {
  const packages = [
    ...listPackages(true),
    ...listPackages(false).filter((pkg) => DISTRIBUTED_DEV_PACKAGES.has(pkg.name)),
  ];
  const problems = [];
  for (const pkg of packages) {
    if (PACKAGE_EXCEPTIONS.has(pkg.name)) continue;
    const license = pkg.license ?? 'Unknown';
    try {
      if (!isAllowed(license)) problems.push(`${pkg.name}@${pkg.versions.join('/')}: ${license}`);
    } catch (error) {
      problems.push(`${pkg.name}@${pkg.versions.join('/')}: 无法解析「${license}」（${error.message}）`);
    }
  }
  const unique = [...new Set(problems)];
  if (unique.length > 0) {
    console.error(`许可证检查未通过（${unique.length} 项）：\n  ${unique.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`许可证检查通过：${new Set(packages.map((p) => p.name)).size} 个包`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
