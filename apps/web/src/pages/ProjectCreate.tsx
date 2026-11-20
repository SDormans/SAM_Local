import { Breadcrumb, PageLayout } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';

import { LocalFolderProjectForm } from '../components/LocalFolderProjectForm';
import { ProjectOnboardingWizard } from '../components/project-onboarding';
import { useLoginProviders } from '../hooks/useLoginProviders';
import { useQueryScope } from '../hooks/useQueryScope';
import { getDesktopBridge } from '../lib/desktop-bridge';
import {
  githubInstallationsQueryOptions,
  projectArtifactsEnabledQueryOptions,
} from '../lib/query-options';

export function ProjectCreate() {
  const desktop = getDesktopBridge();
  const providers = useLoginProviders();
  const queryScope = useQueryScope();

  const installationsQuery = useQuery({
    ...githubInstallationsQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });
  const artifactsEnabledQuery = useQuery({
    ...projectArtifactsEnabledQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });

  const loading =
    Boolean(queryScope) &&
    [installationsQuery, artifactsEnabledQuery].some(
      (query) => query.isPending && query.data === undefined
    );
  const loadError =
    installationsQuery.data === undefined && installationsQuery.error
      ? installationsQuery.error instanceof Error
        ? installationsQuery.error.message
        : 'Failed to load installations'
      : artifactsEnabledQuery.data === undefined && artifactsEnabledQuery.error
        ? artifactsEnabledQuery.error instanceof Error
          ? artifactsEnabledQuery.error.message
          : 'Failed to load installations'
        : null;
  const retry = () => {
    void installationsQuery.refetch();
    void artifactsEnabledQuery.refetch();
  };

  return (
    <PageLayout title="New Project" maxWidth="xl">
      <Breadcrumb
        segments={[
          { label: 'Home', path: '/dashboard' },
          { label: 'Projects', path: '/projects' },
          { label: 'New Project' },
        ]}
      />

      {desktop && (
        <div className="mt-4">
          <LocalFolderProjectForm bridge={desktop} />
          <h2 className="mt-6 text-base font-semibold text-fg-primary">Or connect a Git remote</h2>
        </div>
      )}

      <div className="mt-4">
        <ProjectOnboardingWizard
          installations={installationsQuery.data ?? []}
          artifactsEnabled={artifactsEnabledQuery.data ?? false}
          gitlabEnabled={providers.gitlab}
          loading={loading}
          loadError={loadError}
          onRetryInstallations={retry}
        />
      </div>
    </PageLayout>
  );
}
