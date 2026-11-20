import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createProject: vi.fn() }));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  createProject: mocks.createProject,
}));

import { LocalFolderProjectForm } from '../../../src/components/LocalFolderProjectForm';
import type { SamDesktopBridge } from '../../../src/lib/desktop-bridge';

function bridge(overrides: Partial<SamDesktopBridge> = {}): SamDesktopBridge {
  return {
    selectProjectFolder: vi.fn(async () => ({ path: 'C:\\Users\\me\\code\\demo', name: 'demo' })),
    getRuntimeStatus: vi.fn(async () => ({ state: 'running' as const })),
    refreshPrerequisites: vi.fn(async () => undefined),
    onRuntimeStatus: vi.fn(() => () => undefined),
    ...overrides,
  };
}

function renderForm(desktop: SamDesktopBridge) {
  return render(
    <MemoryRouter initialEntries={['/projects/new']}>
      <Routes>
        <Route path="/projects/new" element={<LocalFolderProjectForm bridge={desktop} />} />
        <Route path="/projects/:id" element={<div data-testid="project-page">project</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mocks.createProject.mockReset();
});

describe('LocalFolderProjectForm', () => {
  it('creates a local project from the chosen folder without any remote fields', async () => {
    mocks.createProject.mockResolvedValue({ id: 'proj-local' });
    const desktop = bridge();
    renderForm(desktop);
    fireEvent.click(screen.getByRole('button', { name: /choose folder/i }));
    expect(await screen.findByTestId('local-folder-path')).toHaveTextContent(
      'C:\\Users\\me\\code\\demo'
    );
    expect(screen.getByRole('textbox')).toHaveValue('demo');
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));
    await screen.findByTestId('project-page');
    expect(mocks.createProject).toHaveBeenCalledWith({
      name: 'demo',
      repoProvider: 'local',
      localPath: 'C:\\Users\\me\\code\\demo',
    });
  });

  it('requires a folder and a name, and keeps a typed name when re-choosing', async () => {
    const desktop = bridge();
    renderForm(desktop);
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));
    expect(await screen.findByText(/choose a project folder first/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: /choose folder/i }));
    await screen.findByTestId('local-folder-path');
    expect(screen.getByRole('textbox')).toHaveValue('Mine');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));
    expect(await screen.findByText(/project name is required/i)).toBeInTheDocument();
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('shows picker cancel, picker errors, and API errors', async () => {
    const cancelled = bridge({ selectProjectFolder: vi.fn(async () => null) });
    const { unmount } = renderForm(cancelled);
    fireEvent.click(screen.getByRole('button', { name: /choose folder/i }));
    await waitFor(() => expect(cancelled.selectProjectFolder).toHaveBeenCalled());
    expect(screen.queryByTestId('local-folder-path')).toBeNull();
    unmount();

    const failing = bridge({
      selectProjectFolder: vi.fn(async () => {
        throw new Error('The selected project location is not a folder');
      }),
    });
    const second = renderForm(failing);
    fireEvent.click(screen.getByRole('button', { name: /choose folder/i }));
    expect(await screen.findByText(/not a folder/i)).toBeInTheDocument();
    second.unmount();

    mocks.createProject.mockImplementation(async () => {
      throw new Error('A project for this folder already exists');
    });
    renderForm(bridge());
    fireEvent.click(screen.getByRole('button', { name: /choose folder/i }));
    await screen.findByTestId('local-folder-path');
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });
});
