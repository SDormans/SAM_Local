import { describe, expect, it } from 'vitest';

import {
  localEndpointProblem,
  type LocalModelConnection,
  verifyLocalModelConnection,
} from '../../../src/local/local-models';

const ollama: LocalModelConnection = {
  connectionId: 'ollama',
  providerType: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  modelId: 'qwen2.5:0.5b',
};

function respond(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe('local model connection policy', () => {
  it('accepts plain HTTP on this computer', () => {
    expect(localEndpointProblem('http://127.0.0.1:11434')).toBeNull();
    expect(localEndpointProblem('http://localhost:11434/v1')).toBeNull();
    expect(localEndpointProblem('http://[::1]:8080')).toBeNull();
  });

  it('rejects addresses off this computer, other schemes, and embedded credentials', () => {
    expect(localEndpointProblem('http://192.168.1.10:11434')).toMatch(/this computer/);
    expect(localEndpointProblem('https://api.openai.com/v1')).toMatch(/this computer/);
    expect(localEndpointProblem('http://host.docker.internal:11434')).toMatch(/this computer/);
    expect(localEndpointProblem('file:///etc/passwd')).toMatch(/http or https/);
    expect(localEndpointProblem('http://user:pw@127.0.0.1:11434')).toMatch(/credentials/);
    expect(localEndpointProblem('not a url')).toMatch(/valid URL/);
  });
});

describe('verifyLocalModelConnection', () => {
  it('is usable when Ollama lists the saved model', async () => {
    const fetcher = respond({ models: [{ name: 'qwen2.5:0.5b' }, { name: 'llama3:8b' }] });
    const result = await verifyLocalModelConnection(ollama, fetcher);
    expect(result).toEqual({
      connectionId: 'ollama',
      status: 'usable',
      models: ['qwen2.5:0.5b', 'llama3:8b'],
    });
  });

  it('reads OpenAI-compatible model lists from /models', async () => {
    let requested = '';
    const fetcher = (async (url: string) => {
      requested = url;
      return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }));
    }) as unknown as typeof fetch;
    const result = await verifyLocalModelConnection(
      {
        ...ollama,
        providerType: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8080/v1/',
        modelId: 'local-model',
      },
      fetcher
    );
    expect(requested).toBe('http://127.0.0.1:8080/v1/models');
    expect(result.status).toBe('usable');
  });

  it('reports a missing model with a pull hint', async () => {
    const result = await verifyLocalModelConnection(
      ollama,
      respond({ models: [{ name: 'llama3:8b' }] })
    );
    expect(result.status).toBe('incompatible');
    expect(result.message).toContain('ollama pull qwen2.5:0.5b');
  });

  it('reports an unreachable service as unavailable', async () => {
    const fetcher = (async () => {
      throw new TypeError('connection refused');
    }) as typeof fetch;
    const result = await verifyLocalModelConnection(ollama, fetcher);
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('Check that it is running');
  });

  it('reports a service without a model list as incompatible', async () => {
    const result = await verifyLocalModelConnection(ollama, respond({ error: 'nope' }, 404));
    expect(result.status).toBe('incompatible');
  });
});
