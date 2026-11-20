import { Alert, Button, Spinner } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { request } from '../lib/api/client';
import type { SamDesktopBridge } from '../lib/desktop-bridge';

export interface LocalRuntimeHealth {
  status: 'ready' | 'degraded' | 'unavailable';
  dockerDesktop: 'ready' | 'stopped' | 'unavailable';
  wsl2: 'ready' | 'unavailable';
  dataStore: 'ready' | 'migrating' | 'recovery-required' | 'unavailable';
  message?: string;
}

const LABELS: Record<string, string> = {
  ready: 'Ready',
  stopped: 'Not running',
  unavailable: 'Not available',
  migrating: 'Upgrading',
  'recovery-required': 'Needs recovery',
};

function StatusRow({ name, value }: { name: string; value: string }) {
  const ok = value === 'ready';
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border-default py-3 last:border-b-0">
      <span className="text-sm text-fg-primary">{name}</span>
      <span className={`text-sm font-semibold ${ok ? 'text-success-fg' : 'text-warning-fg'}`}>
        {ok ? '✓ ' : '! '}
        {LABELS[value] ?? value}
      </span>
    </li>
  );
}

/** Desktop first-run prerequisite and local-store status (spec 036 T014). */
export function LocalRuntimeSetup({ bridge }: { bridge: SamDesktopBridge }) {
  const [health, setHealth] = useState<LocalRuntimeHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    try {
      setHealth(await request<LocalRuntimeHealth>('/api/local/health'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read local SAM status');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const recheck = async () => {
    setChecking(true);
    try {
      await bridge.refreshPrerequisites();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check prerequisites');
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="min-h-screen bg-canvas px-4 py-8 text-fg-primary">
      <section className="mx-auto w-full max-w-2xl space-y-5">
        <div>
          <h1 className="text-2xl font-semibold">Set up SAM on this computer</h1>
          <p className="mt-1 text-sm text-fg-muted">
            SAM runs agents in local Docker Desktop containers. No cloud account is needed.
          </p>
        </div>
        {error && <Alert variant="error">{error}</Alert>}
        {!health && !error && <Spinner />}
        {health && (
          <>
            <ul
              aria-label="Local prerequisites"
              className="rounded-lg border border-border-default bg-surface px-4"
            >
              <StatusRow name="Docker Desktop (Linux containers)" value={health.dockerDesktop} />
              <StatusRow name="WSL2" value={health.wsl2} />
              <StatusRow name="Local data" value={health.dataStore} />
            </ul>
            {health.message && <Alert variant="warning">{health.message}</Alert>}
            {health.status === 'ready' && (
              <Alert variant="success">Everything SAM needs is ready.</Alert>
            )}
          </>
        )}
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            type="button"
            variant="secondary"
            className="min-h-14 w-full sm:w-auto"
            loading={checking}
            onClick={() => void recheck()}
          >
            Check again
          </Button>
          <Link
            to="/projects/new"
            className="inline-flex min-h-14 items-center justify-center rounded-md border border-border-default bg-surface px-4 text-sm font-semibold text-fg-primary hover:bg-surface-hover"
          >
            Continue to projects
          </Link>
        </div>
      </section>
    </main>
  );
}
