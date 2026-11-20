import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalModelConnection } from '../../../src/components/LocalModelConnection';
import { ApiClientError, request } from '../../../src/lib/api/client';

vi.mock('../../../src/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/client')>()),
  request: vi.fn(),
}));

describe('LocalModelConnection', () => {
  beforeEach(() => vi.mocked(request).mockReset());

  it('saves, then checks the connection and reports the result', async () => {
    const user = userEvent.setup();
    vi.mocked(request)
      .mockRejectedValueOnce(new ApiClientError('NOT_FOUND', 'not found', 404))
      .mockResolvedValueOnce({
        connectionId: 'ollama',
        providerType: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        modelId: 'qwen2.5:0.5b',
      })
      .mockResolvedValueOnce({ status: 'usable', models: ['qwen2.5:0.5b'] });
    render(<LocalModelConnection />);
    await user.type(screen.getByPlaceholderText(/qwen2.5-coder/), 'qwen2.5:0.5b');
    await user.click(screen.getByRole('button', { name: /save and check/i }));
    await waitFor(() => expect(screen.getByText(/Connected\. 1 model/)).toBeTruthy());
    expect(vi.mocked(request).mock.calls[1]![1]).toMatchObject({ method: 'PUT' });
  });

  it('shows the actionable verification error', async () => {
    const user = userEvent.setup();
    vi.mocked(request)
      .mockResolvedValueOnce({
        connectionId: 'ollama',
        providerType: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        modelId: 'llama3:8b',
      })
      .mockResolvedValueOnce({
        connectionId: 'ollama',
        providerType: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        modelId: 'llama3:8b',
      })
      .mockRejectedValueOnce(
        new ApiClientError(
          'BAD_GATEWAY',
          'Model "llama3:8b" is not available from this service.',
          502
        )
      );
    render(<LocalModelConnection />);
    await waitFor(() => expect(screen.getByDisplayValue('llama3:8b')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: /save and check/i }));
    await waitFor(() =>
      expect(screen.getByText(/is not available from this service/)).toBeTruthy()
    );
  });
});
