import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'mock-app/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'browser',
          environment: 'node',
          include: ['tests/browser/**/*.test.ts'],
          testTimeout: 15_000,
        },
      },
    ],
  },
});
