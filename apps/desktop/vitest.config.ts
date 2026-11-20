import { defineConfig } from 'vitest/config';

import { coverageConfig } from '../../vitest.coverage';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    coverage: coverageConfig(['src/**/*.ts'], {
      statements: 90,
      branches: 80,
      functions: 90,
      lines: 90,
    }),
  },
});
