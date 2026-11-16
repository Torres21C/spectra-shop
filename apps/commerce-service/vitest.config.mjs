import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Las suites comparten PostgreSQL, Identity y Catalog reales: se ejecutan en serie.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: [
        'src/cart/**/*.ts',
        'src/checkout/**/*.ts',
        'src/catalog/inventory-client.service.ts',
      ],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        statements: 60,
        branches: 60,
        functions: 60,
        lines: 60,
      },
    },
  },
});
