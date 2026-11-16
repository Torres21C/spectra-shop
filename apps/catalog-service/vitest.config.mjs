import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Las suites comparten el esquema catalog real; se ejecutan en serie para evitar interferencias.
    fileParallelism: false,
  },
});
