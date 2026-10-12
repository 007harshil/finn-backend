import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: { FINN_LOG_SILENT: '1', AUTH_JWT_SECRET: 'test-secret-test-secret-test-secret-0123' },
    pool: 'forks',
  },
});
