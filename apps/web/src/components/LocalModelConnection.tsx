import { Alert, Button } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useQueryScope } from '../hooks/useQueryScope';
import { ApiClientError, request } from '../lib/api/client';

interface Connection {
  connectionId: string;
  providerType: 'ollama' | 'openai-compatible';
  baseUrl: string;
  modelId: string;
  lastVerifiedAt?: string;
}

interface Verification {
  status: 'usable' | 'unavailable' | 'incompatible';
  models: string[];
  message?: string;
}

const DEFAULTS: Pick<Connection, 'providerType' | 'baseUrl' | 'modelId'> = {
  providerType: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  modelId: '',
};

const fieldClass =
  'w-full min-h-11 py-2 px-3 rounded-sm border border-border-default bg-inset text-fg-primary text-sm box-border';

/** Spec 036 T028: the local model service OpenCode uses when set to "Model on this computer". */
export function LocalModelConnection() {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const queryKey = ['auth', scope, 'local', 'models', 'connection'];
  const [form, setForm] = useState(DEFAULTS);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const connectionQuery = useQuery({
    queryKey,
    enabled: Boolean(scope),
    queryFn: async () => {
      try {
        return await request<Connection>('/api/local/models/connection');
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 404) return null;
        throw err;
      }
    },
  });
  const saved =
    typeof connectionQuery.data?.baseUrl === 'string' &&
    typeof connectionQuery.data.modelId === 'string'
      ? connectionQuery.data
      : null;

  useEffect(() => {
    if (saved) {
      setForm({ providerType: saved.providerType, baseUrl: saved.baseUrl, modelId: saved.modelId });
    }
  }, [saved?.providerType, saved?.baseUrl, saved?.modelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveAndCheck = useMutation({
    mutationFn: async () => {
      const connection = await request<Connection>('/api/local/models/connection', {
        method: 'PUT',
        body: JSON.stringify(form),
      });
      queryClient.setQueryData(queryKey, connection);
      return request<Verification>('/api/local/models/connection/verify', {
        method: 'POST',
        body: JSON.stringify({ connectionId: connection.connectionId }),
      });
    },
    onMutate: () => setResult(null),
    onSuccess: (check) => {
      setResult({ ok: true, text: `Connected. ${check.models.length} model(s) available.` });
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) =>
      setResult({ ok: false, text: err instanceof Error ? err.message : 'Could not save' }),
  });
  const loadError = connectionQuery.error ? 'Could not load the local model settings.' : null;

  return (
    <section
      aria-labelledby="local-model-heading"
      className="rounded-lg border border-border-default bg-surface p-4 space-y-3"
      data-testid="local-model-connection"
    >
      <div>
        <h2 id="local-model-heading" className="text-base font-semibold">
          Local model
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          Used by agents set to “Model on this computer”. It must run on this computer.
        </p>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Service</span>
        <select
          className={fieldClass}
          value={form.providerType}
          onChange={(e) =>
            setForm({ ...form, providerType: e.target.value as Connection['providerType'] })
          }
        >
          <option value="ollama">Ollama</option>
          <option value="openai-compatible">OpenAI-compatible</option>
        </select>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Address</span>
        <input
          className={fieldClass}
          value={form.baseUrl}
          onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          inputMode="url"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Model</span>
        <input
          className={fieldClass}
          value={form.modelId}
          placeholder="e.g. qwen2.5-coder:7b"
          onChange={(e) => setForm({ ...form, modelId: e.target.value })}
        />
      </label>
      {loadError && !result && <Alert variant="error">{loadError}</Alert>}
      {result && <Alert variant={result.ok ? 'success' : 'error'}>{result.text}</Alert>}
      {saved?.lastVerifiedAt && !result && (
        <p className="text-xs text-fg-muted">
          Last checked {new Date(saved.lastVerifiedAt).toLocaleString()}
        </p>
      )}
      <Button
        type="button"
        className="min-h-14 w-full sm:w-auto"
        loading={saveAndCheck.isPending}
        disabled={!form.baseUrl.trim() || !form.modelId.trim()}
        onClick={() => saveAndCheck.mutate()}
      >
        Save and check
      </Button>
    </section>
  );
}
