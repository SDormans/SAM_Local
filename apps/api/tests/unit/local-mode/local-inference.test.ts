import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import {
  buildLocalOpencodeInferenceConfig,
  LOCAL_MODEL_GATEWAY_PATH,
  resolveLocalOpencodeInferenceConfig,
} from '../../../src/local/local-inference';
import {
  readLocalModelConnection,
  writeLocalModelConnection,
} from '../../../src/local/local-models';

function kv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
  };
}

function env(overrides: Record<string, unknown> = {}, store = kv()): Env {
  return { SAM_RUNTIME_MODE: 'local', KV: store, ...overrides } as unknown as Env;
}

describe('local OpenCode inference config', () => {
  it('is null outside the local runtime or without a model', async () => {
    expect(buildLocalOpencodeInferenceConfig(env({ SAM_RUNTIME_MODE: undefined }), 'm')).toBeNull();
    expect(buildLocalOpencodeInferenceConfig(env({ LOCAL_DEFAULT_MODEL: '  ' }))).toBeNull();
    await expect(
      resolveLocalOpencodeInferenceConfig(env({ SAM_RUNTIME_MODE: 'hosted' }))
    ).resolves.toBeNull();
  });

  it('routes through the gateway with the workspace callback token', () => {
    expect(buildLocalOpencodeInferenceConfig(env({ LOCAL_DEFAULT_MODEL: 'qwen2.5:0.5b' }))).toEqual(
      {
        provider: 'openai-compatible',
        baseURL: `{controlPlaneUrl}${LOCAL_MODEL_GATEWAY_PATH}`,
        model: 'qwen2.5:0.5b',
        apiKeySource: 'callback-token',
      }
    );
  });

  it('prefers the saved model over the desktop default', async () => {
    const e = env({ LOCAL_DEFAULT_MODEL: 'default-model' });
    await expect(resolveLocalOpencodeInferenceConfig(e)).resolves.toMatchObject({
      model: 'default-model',
    });
    await writeLocalModelConnection(e, {
      connectionId: 'ollama',
      providerType: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      modelId: 'saved-model',
    });
    await expect(resolveLocalOpencodeInferenceConfig(e)).resolves.toMatchObject({
      model: 'saved-model',
    });
  });
});

describe('local model connection storage', () => {
  it('ignores missing, malformed, and invalid stored settings', async () => {
    const store = kv();
    await expect(readLocalModelConnection(env({}, store))).resolves.toBeNull();
    store.store.set('local-runtime:model-connection', '{not json');
    await expect(readLocalModelConnection(env({}, store))).resolves.toBeNull();
    store.store.set('local-runtime:model-connection', JSON.stringify({ baseUrl: 1 }));
    await expect(readLocalModelConnection(env({}, store))).resolves.toBeNull();
  });
});
