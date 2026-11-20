import { defineConfig } from 'vitest/config';

import { coverageConfig } from '../../vitest.coverage';

const coverage = coverageConfig(['src/**/*.ts'], {
  statements: 90,
  branches: 80,
  functions: 90,
  lines: 90,
});

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    coverage: {
      ...coverage,
      // Electron entry and preload wiring need a real Electron process; tests/e2e covers them.
      exclude: [...coverage.exclude, 'src/main/index.ts', 'src/preload/**'],
    },
  },
});
