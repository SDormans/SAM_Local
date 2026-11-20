import { defineConfig } from 'vitest/config';

// Feasibility gates need real Docker and a real local model service; they are run explicitly.
export default defineConfig({
  test: {
    include: ['tests/feasibility/**/*.spec.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
