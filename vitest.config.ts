import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** 每个 packages|apps/<name>/src/index.ts 自动映射为 @paldock/<name>，新增包不用再登记。 */
const packageAliases = Object.fromEntries(
  ['packages', 'apps'].flatMap((group) =>
    readdirSync(root(`./${group}/`))
      .filter((name) => existsSync(root(`./${group}/${name}/src/index.ts`)))
      .map((name) => [`@paldock/${name}`, root(`./${group}/${name}/src/index.ts`)]),
  ),
);

/** 真实执行器测试（*.live.test.ts）会消耗额度，只在显式开启时运行。 */
const live = process.env.PALDOCK_LIVE_CODEX === '1' || process.env.PALDOCK_LIVE_P3 === '1';

export default defineConfig({
  resolve: { alias: packageAliases },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', ...(live ? [] : ['**/*.live.test.ts'])],
    environment: 'node',
    testTimeout: 20_000,
  },
});
