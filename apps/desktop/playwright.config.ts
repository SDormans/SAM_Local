import { defineConfig } from '@playwright/test';

// Drives the real Electron app against the real local API runtime. Needs the API workspace
// dependencies and `apps/web` built with VITE_API_URL=http://127.0.0.1:8790 (see quickstart).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 600_000,
  workers: 1,
  reporter: 'list',
});
