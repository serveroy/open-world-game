import { defineConfig } from 'vitest/config';
import { swPlugin } from './scripts/swPlugin';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 5000,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-compat'],
        },
      },
    },
  },
  server: { host: true },
  plugins: [swPlugin()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
