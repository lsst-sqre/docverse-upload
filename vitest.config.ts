import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '#generated': resolve(import.meta.dirname, 'generated'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    setupFiles: ['tests/setup.ts'],
  },
});
