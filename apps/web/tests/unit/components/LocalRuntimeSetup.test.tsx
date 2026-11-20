import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('../../../src/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/client')>()),
  request: mocks.request,
}));

import { LocalRuntimeSetup } from '../../../src/components/LocalRuntimeSetup';
import type { SamDesktopBridge } from '../../../src/lib/desktop-bridge';

function bridge(): SamDesktopBridge {
  return {
    selectProjectFolder: vi.fn(async () => null),
    getRuntimeStatus: vi.fn(async () => ({ state: 'running' as const })),
    refreshPrerequisites: vi.fn(async () => undefined),
    onRuntimeStatus: vi.fn(() => () => undefined),
  };
}

beforeEach(() => {
  mocks.request.mockReset();
});

describe('LocalRuntimeSetup', () => {
  it('shows each prerequisite with a text status and the fix message, then rechecks', async () => {
    mocks.request.mockResolvedValueOnce({
      status: 'degraded',
      dockerDesktop: 'stopped',
      wsl2: 'ready',
      dataStore: 'ready',
      message: 'Docker Desktop is not running. Start Docker Desktop and retry.',
    });
    const desktop = bridge();
    render(
      <MemoryRouter>
        <LocalRuntimeSetup bridge={desktop} />
      </MemoryRouter>
    );
    expect(await screen.findByText(/not running\. start docker desktop/i)).toBeInTheDocument();
    expect(screen.getByText(/Not running$/)).toBeInTheDocument();
    expect(screen.queryByText(/everything sam needs is ready/i)).toBeNull();

    mocks.request.mockResolvedValueOnce({
      status: 'ready',
      dockerDesktop: 'ready',
      wsl2: 'ready',
      dataStore: 'ready',
    });
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    expect(await screen.findByText(/everything sam needs is ready/i)).toBeInTheDocument();
    expect(desktop.refreshPrerequisites).toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledWith('/api/local/health');
    expect(screen.getByRole('link', { name: /continue to projects/i })).toHaveAttribute(
      'href',
      '/projects/new'
    );
  });

  it('reports load and recheck failures', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Local SAM is not reachable'));
    const desktop = bridge();
    desktop.refreshPrerequisites = vi.fn(async () => {
      throw new Error('probe failed');
    });
    render(
      <MemoryRouter>
        <LocalRuntimeSetup bridge={desktop} />
      </MemoryRouter>
    );
    expect(await screen.findByText(/not reachable/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    await waitFor(() => expect(screen.getByText(/probe failed/i)).toBeInTheDocument());
  });
});
