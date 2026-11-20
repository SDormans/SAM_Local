import { Alert, Button, Input } from '@simple-agent-manager/ui';
import { FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { createProject } from '../lib/api';
import type { SamDesktopBridge, SelectedProjectFolder } from '../lib/desktop-bridge';

interface LocalFolderProjectFormProps {
  bridge: SamDesktopBridge;
}

/**
 * Desktop-only, local-folder-first project creation (spec 036 T015). Picking a folder never
 * clones or contacts a Git remote; cloning stays a separate, explicit action.
 */
export function LocalFolderProjectForm({ bridge }: LocalFolderProjectFormProps) {
  const navigate = useNavigate();
  const [folder, setFolder] = useState<SelectedProjectFolder | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chooseFolder = async () => {
    setError(null);
    try {
      const selected = await bridge.selectProjectFolder();
      if (!selected) return;
      setFolder(selected);
      setName((current) => current || selected.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the folder picker');
    }
  };

  const submit = async () => {
    if (!folder) {
      setError('Choose a project folder first.');
      return;
    }
    if (!name.trim()) {
      setError('Project name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = await createProject({
        name: name.trim(),
        repoProvider: 'local',
        localPath: folder.path,
      });
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="local-folder-project-heading"
      className="flex flex-col gap-4 rounded-lg border border-border-default p-4"
    >
      <div>
        <h2 id="local-folder-project-heading" className="text-lg font-semibold text-fg-primary">
          Use a folder on this computer
        </h2>
        <p className="text-sm text-fg-muted">
          SAM works on the folder in place. Nothing is cloned or uploaded.
        </p>
      </div>
      <Button
        type="button"
        variant="secondary"
        onClick={() => void chooseFolder()}
        className="min-h-14 w-full sm:w-auto"
      >
        <FolderOpen aria-hidden size={18} />
        {folder ? 'Choose a different folder' : 'Choose folder'}
      </Button>
      {folder && (
        <p className="break-all text-sm text-fg-primary" data-testid="local-folder-path">
          {folder.path}
        </p>
      )}
      <label className="flex flex-col gap-1 text-sm text-fg-primary">
        Project name
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      {error && <Alert variant="error">{error}</Alert>}
      <Button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="min-h-14 w-full sm:w-auto"
      >
        {busy ? 'Creating…' : 'Create project'}
      </Button>
    </section>
  );
}
