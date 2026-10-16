import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@weaver-art/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@weaver-art/wasm': fileURLToPath(new URL('./packages/wasm/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
