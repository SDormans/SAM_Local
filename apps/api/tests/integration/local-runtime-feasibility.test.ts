/**
 * T001 feasibility gate (spec 036): the pinned Wrangler/workerd runtime serves the real
 * ProjectData Durable Object and D1 (full migration chain) from a local persistence directory,
 * with no Cloudflare credentials, and state survives runtime restarts.
 *
 * Spawns `wrangler dev`, so it only runs when SAM_LOCAL_RUNTIME_FEASIBILITY=1.
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

const enabled = process.env.SAM_LOCAL_RUNTIME_FEASIBILITY === '1';
const FIXTURE = resolve(__dirname, '../fixtures/local-runtime');
const WRANGLER = resolve(__dirname, '../../node_modules/.bin/wrangler');
const PORT = Number(process.env.SAM_LOCAL_RUNTIME_FEASIBILITY_PORT ?? 8898);
const persistDir = mkdtempSync(join(tmpdir(), 'sam-local-runtime-'));
const run = promisify(execFile);

// Strip any Cloudflare credentials so the gate proves none are needed.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('CLOUDFLARE_') && !k.startsWith('CF_'))
);
Object.assign(env, { CI: '1', WRANGLER_SEND_METRICS: 'false' });

async function withRuntime<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const base = `http://127.0.0.1:${PORT}`;
  if (
    await fetch(base).then(
      () => true,
      () => false
    )
  ) {
    throw new Error(`port ${PORT} is already in use; stop the other runtime first`);
  }
  const child: ChildProcess = spawn(
    WRANGLER,
    ['dev', '--local', '--persist-to', persistDir, '--port', String(PORT), '--ip', '127.0.0.1'],
    { cwd: FIXTURE, env, stdio: 'ignore' }
  );
  try {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const ok = await fetch(`${base}/read`).then(
        () => true,
        () => false
      );
      if (ok) break;
      if (Date.now() > deadline) throw new Error('local runtime did not become ready');
      await new Promise((r) => setTimeout(r, 1000));
    }
    return await fn(base);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  }
}

afterAll(() => rmSync(persistDir, { recursive: true, force: true }));

describe.skipIf(!enabled)('T001 local Worker runtime feasibility', () => {
  it('applies the full D1 migration chain locally without credentials', async () => {
    const { stdout } = await run(
      WRANGLER,
      ['d1', 'migrations', 'apply', 'DATABASE', '--local', '--persist-to', persistDir],
      { cwd: FIXTURE, env, maxBuffer: 32 * 1024 * 1024 }
    );
    expect(stdout).not.toMatch(/❌/);
    expect(stdout).toMatch(/✅/);
  }, 300_000);

  it('persists D1 rows and ProjectData sessions across runtime restarts', async () => {
    const first = await withRuntime(async (base) => (await fetch(`${base}/write?v=one`)).json());
    expect(first).toHaveProperty('sessionId');
    const afterFirstRestart = await withRuntime(async (base) =>
      (await fetch(`${base}/read`)).json()
    );
    expect(afterFirstRestart).toEqual({ d1: { v: 'one' }, total: 1, topics: ['feasibility one'] });
    await withRuntime(async (base) => fetch(`${base}/write?v=two`));
    const afterSecondRestart = await withRuntime(async (base) =>
      (await fetch(`${base}/read`)).json()
    );
    expect(afterSecondRestart).toMatchObject({ d1: { v: 'two' }, total: 2 });
  }, 600_000);
});
