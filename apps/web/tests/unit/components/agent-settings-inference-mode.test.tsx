/** Spec 036 T025: OpenCode's local/cloud choice in the desktop app is visible, saved, and restored. */
import type { AgentInfo, AgentSettingsResponse } from '@simple-agent-manager/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSettingsCard } from '../../../src/components/AgentSettingsCard';
import { getAgentModelCatalog } from '../../../src/lib/api/agents';
import { getDesktopBridge } from '../../../src/lib/desktop-bridge';

vi.mock('../../../src/lib/api/agents', () => ({ getAgentModelCatalog: vi.fn() }));
vi.mock('../../../src/lib/desktop-bridge', () => ({ getDesktopBridge: vi.fn() }));

const openCode = {
  id: 'opencode',
  name: 'OpenCode',
  description: 'OpenCode agent',
  supportsAcp: true,
  configured: true,
} as AgentInfo;

function settings(overrides: Partial<AgentSettingsResponse> = {}): AgentSettingsResponse {
  return {
    agentType: 'opencode',
    model: null,
    permissionMode: null,
    allowedTools: null,
    deniedTools: null,
    additionalEnv: null,
    opencodeProvider: null,
    opencodeBaseUrl: null,
    providerMode: null,
    inferenceMode: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  } as AgentSettingsResponse;
}

function renderCard(saved: AgentSettingsResponse, onSave = vi.fn().mockResolvedValue(undefined)) {
  const view = render(
    <AgentSettingsCard agent={openCode} settings={saved} onSave={onSave} onReset={vi.fn()} />
  );
  return { ...view, onSave };
}

const radio = (mode: 'local' | 'cloud') =>
  screen.getByTestId(`inference-mode-${mode}`) as HTMLInputElement;

describe('AgentSettingsCard inference mode', () => {
  beforeEach(() => {
    vi.mocked(getAgentModelCatalog).mockResolvedValue({
      agentType: 'opencode',
      source: 'dynamic',
      updatedAt: '2026-11-20T00:00:00.000Z',
      groups: [],
    });
    vi.mocked(getDesktopBridge).mockReturnValue({} as ReturnType<typeof getDesktopBridge>);
  });

  it('is not shown in the hosted web app', () => {
    vi.mocked(getDesktopBridge).mockReturnValue(null);
    renderCard(settings());
    expect(screen.queryByTestId('inference-mode')).toBeNull();
    expect(screen.getByTestId('opencode-provider-select')).toBeTruthy();
  });

  it('starts with no destination chosen instead of a silent default', () => {
    renderCard(settings());
    expect(radio('local').checked).toBe(false);
    expect(radio('cloud').checked).toBe(false);
    expect(screen.getByTestId('inference-mode-summary').textContent).toMatch(/Not chosen yet/);
  });

  it('saves the local choice and hides the cloud provider fields', async () => {
    const user = userEvent.setup();
    const { onSave } = renderCard(settings());
    await user.click(radio('local'));
    expect(screen.queryByTestId('opencode-provider-select')).toBeNull();
    expect(screen.getByTestId('inference-mode-summary').textContent).toMatch(
      /Nothing is sent to a cloud provider/
    );
    await user.click(screen.getByTestId('save-settings-opencode'));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        'opencode',
        expect.objectContaining({ inferenceMode: 'local' })
      )
    );
  });

  it('restores a saved choice and keeps it when settings refresh', () => {
    const saved = settings({ inferenceMode: 'cloud', opencodeProvider: 'opencode-go' });
    const { rerender } = renderCard(saved);
    expect(radio('cloud').checked).toBe(true);
    expect(screen.getByTestId('inference-mode-summary').textContent).toMatch(/OpenCode Go/);

    rerender(
      <AgentSettingsCard
        agent={openCode}
        settings={{ ...saved }}
        onSave={vi.fn()}
        onReset={vi.fn()}
      />
    );
    expect(radio('cloud').checked).toBe(true);
    expect(radio('local').checked).toBe(false);
  });
});
