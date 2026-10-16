import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@weaver-art/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@weaver-art/wasm': fileURLToPath(new URL('../../packages/wasm/src/index.ts', import.meta.url)),
    },
  },
  assetsInclude: ['**/*.wasm'],
  server: {
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'esnext',
  },
});
