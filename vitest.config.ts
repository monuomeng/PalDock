import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@paldock/contracts': pkg('contracts'),
      '@paldock/domain': pkg('domain'),
      '@paldock/storage-sqlite': pkg('storage-sqlite'),
      '@paldock/platform': pkg('platform'),
      '@paldock/runtime-codex': pkg('runtime-codex'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
