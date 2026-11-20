import { Alert, Button } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';

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
  const [form, setForm] = useState(DEFAULTS);
  const [saved, setSaved] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    request<Connection>('/api/local/models/connection')
      .then((c) => {
        if (typeof c?.baseUrl !== 'string' || typeof c.modelId !== 'string') return;
        setSaved(c);
        setForm({ providerType: c.providerType, baseUrl: c.baseUrl, modelId: c.modelId });
      })
      .catch((err: unknown) => {
        if (!(err instanceof ApiClientError && err.status === 404)) {
          setResult({ ok: false, text: 'Could not load the local model settings.' });
        }
      });
  }, []);

  const saveAndCheck = async () => {
    setBusy(true);
    setResult(null);
    try {
      const connection = await request<Connection>('/api/local/models/connection', {
        method: 'PUT',
        body: JSON.stringify(form),
      });
      setSaved(connection);
      const check = await request<Verification>('/api/local/models/connection/verify', {
        method: 'POST',
        body: JSON.stringify({ connectionId: connection.connectionId }),
      });
      setResult({ ok: true, text: `Connected. ${check.models.length} model(s) available.` });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : 'Could not save' });
    } finally {
      setBusy(false);
    }
  };

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
      {result && <Alert variant={result.ok ? 'success' : 'error'}>{result.text}</Alert>}
      {saved?.lastVerifiedAt && !result && (
        <p className="text-xs text-fg-muted">
          Last checked {new Date(saved.lastVerifiedAt).toLocaleString()}
        </p>
      )}
      <Button
        type="button"
        className="min-h-14 w-full sm:w-auto"
        loading={busy}
        disabled={!form.baseUrl.trim() || !form.modelId.trim()}
        onClick={() => void saveAndCheck()}
      >
        Save and check
      </Button>
    </section>
  );
}
