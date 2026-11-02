# Native Local SAM Desktop

## Problem

SAM currently runs as a Cloudflare-hosted control plane that provisions remote VM workspaces. Its documented local development mode is for contributors: it does not support agent sessions or workspace provisioning. Users need a native Windows desktop version that runs SAM and its agent workspaces on their own machine, and lets them choose local models or cloud models per agent.

## User-Confirmed Scope

- First release targets Windows; additional desktop platforms can follow.
- SAM itself must run locally as a native desktop application, not only as a browser app connected to the hosted control plane.
- Agent workspaces and the control plane run locally; remote VM provisioning is not the local mode.
- Users can choose a local model or a cloud model per agent.
- The user has not selected a workspace isolation runtime. Docker is the recommended default, subject to design validation.

## Research Findings

- `apps/www/src/content/docs/docs/guides/local-development.md` says the current Wrangler/Vite local development setup does not support agent sessions or VM provisioning.
- `specs/002-local-mock-mode/` describes an earlier, developer-only mock mode with in-memory state and a single local devcontainer. It does not describe a native, persistent, end-user desktop product.
- The API is a Cloudflare Worker and binds D1, KV, R2, and many Durable Objects in `apps/api/wrangler.toml`; a local desktop release must define how these services run and persist without a Cloudflare account.
- The existing workspace architecture places the Go VM Agent on a cloud VM and runs workspace containers under its Docker Engine. Local workspaces therefore need a supported local execution/agent path.
- OpenCode already has per-agent model/provider settings and a custom OpenAI-compatible endpoint, but its current schema requires HTTPS. Local inference needs a deliberate loopback/container networking and credential policy rather than reusing the hosted endpoint validation unchanged.
- The existing setup is multi-service and Cloudflare-specific. This is a new cross-component architecture, so create and review a feature spec and implementation plan before changing runtime code.

## Assumptions To Validate In The Feature Design

- The first release is single-user and local-only for control-plane data and workspace execution; cloud inference and repository hosting may require internet access.
- Docker Desktop is the initial workspace isolation prerequisite unless design research finds a safer, simpler supported Windows runtime.
- Local model support should accept a local OpenAI-compatible inference endpoint, with provider-specific defaults only where verified.
- The native desktop app should keep its local services bound to loopback and protect stored model/provider credentials.

## Implementation Checklist

- [ ] Create a feature specification and clarify any launch-blocking product decisions with the user.
- [ ] Map the current API, storage, Durable Object, desktop UI, and VM Agent paths; choose the smallest supported local runtime that can preserve workspace/chat behavior.
- [ ] Plan local persistent data, first-run setup, local-only authentication/security boundaries, service lifecycle, Docker integration, and supported model endpoint behavior.
- [ ] Implement the Windows native desktop entry point and local service startup/shutdown with clear prerequisite/error reporting.
- [ ] Implement persistent local control-plane storage and local workspace/agent execution without requiring Cloudflare or remote VM provisioning.
- [ ] Add per-agent local-model configuration and an end-to-end model call through a local endpoint; retain and test cloud-model selection.
- [ ] Add focused behavioral and vertical-slice tests for startup, workspace creation, model switching, local inference, persistence, and cleanup.
- [ ] Update user documentation, setup guidance, security boundaries, and troubleshooting for the local desktop release.
- [ ] Validate the packaged app on Windows with Docker and a real local model endpoint; verify cloud-model selection separately.

## Acceptance Criteria

- A Windows user can install and launch SAM as a native desktop application without configuring a Cloudflare account.
- SAM's local application data and agent workspaces persist across app restarts and can be removed through documented cleanup.
- A user can create a local workspace, start an agent, and observe its response in SAM without provisioning a remote VM.
- Per-agent settings allow selecting a reachable local model endpoint or an existing cloud model provider; changing the selection changes the model endpoint actually used by the agent.
- Local-model requests remain on the configured local endpoint; no local prompt or credential is silently sent to a different provider.
- Missing Docker, an unreachable local model endpoint, and invalid settings produce actionable errors without leaving orphaned workspaces or success-shaped failures.
- Local app services are not exposed to the network by default, and locally stored credentials are protected.
- A tested Windows install-to-first-agent workflow demonstrates the complete local path, including a real local-model response.

## References

- `apps/www/src/content/docs/docs/guides/local-development.md`
- `apps/www/src/content/docs/docs/architecture/overview.md`
- `specs/002-local-mock-mode/`
- `apps/api/wrangler.toml`
- `packages/vm-agent/`
- `packages/shared/src/types/agent-settings.ts`
- `.specify/memory/constitution.md`
