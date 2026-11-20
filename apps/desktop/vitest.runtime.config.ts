import { defineConfig } from 'vitest/config';

// Starts the real apps/api Worker under local workerd; run explicitly after building API deps.
export default defineConfig({
  test: {
    include: ['tests/runtime/**/*.spec.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
