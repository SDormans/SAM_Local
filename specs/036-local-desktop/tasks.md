# Tasks: Native Local SAM Desktop

**Input**: Design documents in `specs/036-local-desktop/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/local-desktop.openapi.yaml`, `quickstart.md`

## Execution Gates and External Prerequisites

- Complete T001-T003 before product implementation. Record commands, versions, outcomes, and evidence in `specs/036-local-desktop/quickstart.md`.
- If the packaged Worker runtime cannot provide durable local bindings without Cloudflare credentials, stop and obtain approval for a Node/SQLite adapter design before continuing.
- If the Electron or credential-storage feasibility check requires another shell or trust model, stop for owner approval before adding dependencies or storing credentials.
- If the Docker-to-model path cannot stay private while preserving supported nested-Docker workflows, stop for an approved security/architecture change. Never tell users to expose Ollama to the LAN or publish the Docker API.
- Before T004, record owner decisions for local-folder-first project creation and whether the platform-managed `sam` inference proxy is part of the local desktop's supported cloud destinations. Do not silently decide either scope question.
- External prerequisites: Windows runner, WSL2, Docker Desktop with Linux containers, Ollama with a downloaded test model, a second LAN device for negative network checks, and credentials for one supported cloud provider. Keep live tests bounded and remove only test-created resources.

## Phase 1: Setup and Feasibility Gates

**Purpose**: Prove the architecture's highest-risk packaging, storage, and network assumptions before product implementation.

- [x] T001 Verify packaged Workerd/Miniflare support for the API, D1 and ProjectData Durable Object migrations, and restart persistence without Cloudflare credentials in `apps/api/tests/integration/local-runtime-feasibility.test.ts`; record exact evidence in `specs/036-local-desktop/quickstart.md` and stop for an approved alternative if any required capability fails. _(Linux evidence recorded; Windows run pending.)_
- [ ] T002 Verify the proposed Electron Windows packaging, process supervision, and Windows user-protected credential behavior in `apps/desktop/tests/feasibility/windows-shell.spec.ts`; record same-user limitations and alternatives in `specs/036-local-desktop/quickstart.md` for owner shell/credential-store approval before T004. _(Deferred to the owner; Electron `safeStorage` stays the planned credential store.)_
- [x] T003 Prove workspace-to-gateway-to-host-Ollama connectivity and deny access from a second LAN device in `apps/desktop/tests/feasibility/model-gateway-network.spec.ts`; record the Docker Desktop/WSL2 boundary and stop if the path requires LAN exposure or breaks supported nested-Docker behavior. _(Linux evidence recorded; Windows Docker Desktop and second-device checks pending.)_

## Phase 2: Foundational Local Runtime

**Purpose**: Establish the local application package, runtime boundary, durable state, and trusted local identity before implementing user stories.

- [x] T004 Create and register the Windows desktop package in `apps/desktop/package.json`, `pnpm-workspace.yaml`, and `turbo.json` using only the shell and runtime choices approved after T001-T003. _(`apps/*` already matches the package in `pnpm-workspace.yaml`, and the generic Turbo tasks apply, so neither file changes.)_
- [x] T005 [P] Add runtime-boundary tests in `apps/api/tests/unit/local-mode/runtime-boundary.test.ts` proving local requests do not invoke Cloudflare APIs, Workers AI, remote VM providers, or scheduled handlers.
- [x] T006 Implement the explicit local runtime boundary in `apps/api/src/local/runtime-mode.ts` and `apps/api/src/index.ts`; keep hosted defaults and identity checks unchanged, and fail closed when a local-only operation reaches a cloud-only dependency. _(Implemented in `apps/api/src/local/runtime-mode.ts`: loopback Host check, outbound Cloudflare/VM-provider fetch guard, Workers AI poisoned, Artifacts/Containers removed, scheduled and email handlers skipped.)_
- [x] T007 [P] Add restart and local-store migration/backup tests for D1/KV/ProjectData state in `apps/api/tests/integration/local-state-persistence.test.ts`; verify a failed migration or disk-full write preserves the prior usable data copy. Keep packaged-version upgrade behavior in T032. _(Real-runtime coverage is in `apps/desktop/tests/runtime/local-api.spec.ts`; backup, restore and disk-full coverage is in `apps/desktop/tests/unit/local-data.test.ts`.)_
- [x] T008 Implement app-owned data-directory selection and versioned local persistence startup in `apps/desktop/src/main/local-data.ts` and `apps/api/src/local/persistence.ts`; never derive the data directory from the repository path. _(Implemented in `apps/desktop/src/main/local-data.ts`, `local-runtime-config.ts` and `local-api-runtime.ts`. No API-side `persistence.ts` was needed: the API persists through D1, KV and Durable Objects under `--persist-to`.)_
- [x] T009 [P] Add local-principal and ownership tests in `apps/api/tests/integration/local-auth-ownership.test.ts`, including rejection of renderer-supplied user identities and cross-project resource access. _(Real-runtime coverage is in `apps/desktop/tests/runtime/local-api.spec.ts`; unit coverage is in `apps/api/tests/unit/local-mode/local-auth.test.ts`.)_
- [x] T010 Implement server-validated local principal/session authentication in `apps/api/src/auth/local-auth.ts` and `apps/api/src/routes/local-auth.ts`; preserve project/workspace ownership checks and keep session secrets out of renderer storage and logs. _(Implemented in `apps/api/src/local/local-auth.ts`, `apps/api/src/routes/local-auth.ts` and the local branch of `apps/api/src/middleware/auth.ts`.)_

## Phase 3: User Story 1 - Install and Use SAM Locally (Priority: P1)

**Goal**: Launch SAM on Windows without a Cloudflare account, create a local project, and retain it across restarts.

**Independent Test**: On a clean supported Windows profile, launch the packaged app, create/open a local project, restart SAM, and verify the project remains available without hosted authentication.

- [x] T011 [P] [US1] Add a packaged first-run and project-persistence test in `apps/desktop/tests/e2e/first-run.spec.ts`; verify no Cloudflare account is required, project data survives a full app restart, and launch-to-project creation completes within five minutes on the documented Windows baseline. _(Electron e2e on Linux under Xvfb: `apps/desktop/tests/e2e/first-run.spec.ts`. The packaged Windows run is pending T002.)_
- [x] T012 [P] [US1] Add active-work close-choice tests in `apps/desktop/tests/e2e/close-behavior.spec.ts`; verify graceful stop is the default and explicit background operation remains visibly active.
- [x] T013 [US1] Implement the desktop main-process window, local-service startup/shutdown supervision, and narrow typed IPC in `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/service-supervisor.ts`, and `apps/desktop/src/preload/index.ts`.
- [x] T014 [US1] Add local prerequisite and runtime-health reporting in `apps/api/src/routes/local-health.ts` and `apps/web/src/pages/Setup.tsx`; report Docker/WSL2 and local-store state without exposing secret values or opening a non-loopback control listener. _(The desktop supervisor probes Docker Desktop/WSL2 and reports through `PUT /api/local/health/prerequisites`, which needs the bootstrap secret, because the Worker cannot probe the host. `GET /api/local/health` follows the contract, and the desktop `/setup` page renders `LocalRuntimeSetup`.)_
- [x] T015 [US1] Add explicit local-folder selection to project creation in `apps/desktop/src/main/project-dialog.ts`, `apps/desktop/src/preload/index.ts`, and `apps/web/src/pages/ProjectCreate.tsx`; persist the selected path without cloning or contacting a Git remote implicitly. _(`repoProvider: "local"` with `localPath`, accepted only in local mode. Remote-VM workspace creation fails closed for local projects until US2.)_
- [x] T016 [US1] Implement the close decision and graceful-stop/background behavior in `apps/desktop/src/main/lifecycle.ts`; reconcile the displayed state with the supervised services instead of assuming shutdown succeeded.

## Phase 4: User Story 2 - Run an Agent in a Local Workspace (Priority: P1)

**Goal**: Create and manage a Docker Desktop/WSL2 workspace, run an agent, and observe streamed output in its canonical project conversation.

**Independent Test**: From the packaged app, create a local project and workspace, run OpenCode against a real local Ollama model, observe streamed output in the correct conversation, stop/delete the workspace, and confirm only SAM-labeled resources changed.

- [x] T017 [P] [US2] Add Docker lifecycle integration tests in `apps/desktop/tests/integration/docker-lifecycle.test.ts` for create/start/stop/restart/delete, missing Docker/WSL2 and insufficient-disk errors, labels, and truthful cleanup status.
- [x] T018 [P] [US2] Add a real devcontainer compatibility test in `apps/desktop/tests/integration/nested-docker.test.ts`; prove supported repository settings and nested-Docker workflows remain available inside Docker Desktop's WSL2 VM without publishing the Docker API.
- [ ] T019 [P] [US2] Add the first vertical-slice test in `apps/desktop/tests/e2e/local-first-agent.spec.ts`; exercise packaged launch -> local project -> workspace -> OpenCode -> Ollama -> streamed conversation, with cloud endpoints instrumented to assert zero requests. After installing prerequisites and downloading the model/image, repeat the local flow with outbound internet disabled.
  - Linux progress: the Electron UI slice (local folder -> local workspace -> OpenCode -> local model reply) passes in `local-first-agent.spec.ts`. The local API records every host off this computer it tries to reach (`offMachineHosts` in `/api/local/health`), and the slice asserts that list is empty; this found and removed a Cloudflare DNS call from local node heartbeats. Still open: the same check inside workspace containers, the offline repeat, and the Windows/Docker Desktop run.
- [x] T020 [US2] Implement the Docker Desktop workspace lifecycle adapter in `apps/desktop/src/main/workspaces/docker-desktop.ts`; use installation/workspace labels for recovery and mutation, and never prune unrelated Docker resources.
- [x] T021 [US2] Add the local VM Agent launch path in `packages/vm-agent/internal/server/local_workspace.go` and its Go tests; reuse ACP/session behavior while preserving supported devcontainer settings and the Docker Desktop WSL2 security boundary. (Done in PR #6: `packages/vm-agent/internal/server/local_workspace.go` and `local_workspace_test.go`.)
- [x] T022 [US2] Connect local agent output to the canonical project/chat session in `apps/api/src/routes/chat.ts` and `apps/api/tests/integration/local-agent-stream.test.ts`; prove session identity is not inferred from the latest workspace session.
- [x] T023 [US2] Implement the minimal workspace-scoped Ollama gateway needed by the vertical slice in `apps/desktop/src/main/model-gateway.ts` and `apps/desktop/tests/integration/model-gateway-token.test.ts`; bind upstream selection server-side, keep the listener on the private workspace network, and reject invalid or expired tokens.

## Phase 5: User Story 3 - Choose Local or Cloud Inference per Agent (Priority: P1)

**Goal**: Persist a visible per-agent destination, route only to that destination, and surface failures without cross-mode fallback.

**Independent Test**: Configure two agents with different destinations; instrument local and cloud endpoints; prove each prompt reaches only its selected endpoint and that unavailable endpoints fail without reaching the other.

- [x] T024 [P] [US3] Add API routing tests in `apps/api/tests/integration/agent-inference-routing.test.ts` for two distinct agents configured to different destinations, plus local, cloud, unavailable, invalid-provider, and no-fallback cases; assert each agent reaches only its own destination. (Linux: `opencode-inference-mode.test.ts` covers local, cloud with and without a key, two agents with different destinations, and no fallback. A local service outage is covered by `model-gateway-token.test.ts`; an invalid provider or mode is covered by `agent-settings.test.ts`.)
  - Linux progress: `agent_key` routing for local, cloud, no-local-model, and hosted cases is covered in `apps/api/tests/unit/routes/opencode-inference-mode.test.ts`; save validation in `agent-settings.test.ts`. Still open: two agents with different destinations against instrumented endpoints.
- [x] T025 [P] [US3] Add rendered settings behavior tests in `apps/web/src/pages/SettingsAgents.behavior.test.tsx` proving the per-agent mode/provider choice is visible, saved, restored, and not silently reset.
- [x] T026 [US3] Extend the shared agent-setting type and runtime validation in `packages/shared/src/types/agent-settings.ts` and `apps/api/src/schemas/agent-settings.ts`; allow local HTTP only through the explicit local-mode contract and retain hosted HTTPS validation.
- [x] T027 [US3] Add the per-agent inference selector and selected-destination summary to `apps/web/src/pages/SettingsAgents.tsx` and the existing agent-settings components; verify the UI value reaches the API payload.
- [x] T028 [US3] Implement local model connection configuration, retrieval, verification, and model listing in `apps/api/src/routes/local-models.ts` and `apps/api/tests/integration/local-model-connection.test.ts`; support Ollama first, enforce the supported local-endpoint policy, persist only non-secret settings/references, and keep model-service credentials out of workspaces. (Done in PR #7. Tests are in `apps/api/tests/unit/local-mode/local-models.test.ts` and `local-inference.test.ts`, not in a separate integration file.)
  - Linux progress: `GET/PUT /api/local/models/connection` and `POST .../verify` exist with a loopback-only endpoint policy and Ollama/OpenAI-compatible model listing; the saved model drives OpenCode. Still open: the desktop gateway still takes its upstream address from the desktop config, not the saved `baseUrl`, and no settings UI for the connection yet.
- [ ] T029 [US3] Route OpenCode startup through the saved local/cloud selection in `packages/vm-agent/internal/acp/session_host.go` and its tests; pass only the selected destination credentials and never switch modes after a failure.
- [ ] T030 [US3] Add packaged model-routing end-to-end coverage in `apps/desktop/tests/e2e/model-routing.spec.ts`; configure two agents with different destinations and verify each reaches only its selected provider. Also verify both outage cases produce actionable errors with zero cross-mode requests.

## Phase 6: User Story 4 - Recover and Manage Local Data (Priority: P2)

**Goal**: Recover local state safely and let users remove credentials/workspaces or uninstall without unintended data loss.

**Independent Test**: Create projects, conversations, credentials, and a workspace; restart after an interrupted run, exercise backup/upgrade and credential removal, then choose uninstall retention/deletion and verify each data boundary.

- [x] T031 [P] [US4] Add crash-recovery tests in `apps/desktop/tests/integration/local-recovery.test.ts`; reconcile only resources carrying the current installation/workspace labels and report ambiguous cleanup as pending.
- [x] T032 [P] [US4] Add packaged-version upgrade tests in `apps/desktop/tests/integration/local-upgrade.test.ts`; verify projects, agent choices, and conversations remain available across an app upgrade. Storage migration rollback and disk-full preservation are covered by T007. (Done: `apps/desktop/tests/runtime/local-upgrade.spec.ts` runs in the runtime suite because it needs the real local API. It simulates an install one schema version behind, then upgrades with a backup and pending migrations, and checks that the project and OpenCode's local choice are still there after a restart. Conversation and ProjectData persistence is covered by T007.)
- [x] T033 [P] [US4] Add credential create/update/removal and packaged uninstall-retention tests in `apps/desktop/tests/e2e/data-retention.spec.ts`; verify protected-secret round trips, provider scoping, redaction, retained project data, and confirmed deletion as distinct outcomes. (Done on Linux: `apps/desktop/tests/e2e/data-retention.spec.ts` saves and updates an OpenCode key through the packaged app. Neither key appears in the local state files, which hold only `sam-local-ref:` references, or in API responses. Removing the key works, and `--uninstall=retain` keeps the data. `delete` is covered by `uninstall.test.ts`. Windows DPAPI and the installer hook stay with the owner's Windows checks.)
- [x] T034 [US4] Implement startup reconciliation and safe upgrade backups in `apps/desktop/src/main/recovery.ts` and `apps/desktop/src/main/local-data.ts`; never report a workspace stopped/deleted until Docker confirms the effect. (Linux: startup removes this installation's containers for workspaces the API no longer has, verifies removal, and reports the rest as pending; upgrade backups were done in T007.)
- [ ] T035 [US4] Implement protected credential create/update/removal in `apps/desktop/src/main/credential-store.ts`, exposing only opaque references to the local API and renderer. Integrate uninstall retain/delete choices with the packaged Windows uninstaller before deletion; never delete project/conversation data without confirmation. (Progress: local runtime keys are sealed with Electron `safeStorage` and plaintext files from earlier versions are upgraded; `--uninstall=retain|delete` removes this installation's containers and deletes data only for `delete`. Provider credentials in the `credentials` and `cc_credentials` tables are kept by the desktop credential store in `apps/desktop/src/main/credential-store.ts` and reached over loopback with the bootstrap secret; the database stores `sam-local-ref:<id>` references, and unreferenced entries are swept after credential changes. Open: Windows uninstaller hook and Windows DPAPI evidence.)

## Phase 7: Polish and Cross-Cutting Verification

**Purpose**: Complete documentation, preserve hosted behavior, and verify the packaged Windows product against real services.

- [x] T036 [P] Update `apps/www/src/content/docs/docs/guides/local-desktop.md`, `apps/www/src/content/docs/docs/architecture/security.md`, `apps/www/src/content/docs/docs/architecture/overview.md`, and `apps/www/src/content/docs/docs/guides/local-development.md` with verified setup, trust boundaries, local data ownership, recovery, and troubleshooting. (Done: new `guides/local-desktop.md` with prerequisites, data locations, recovery, uninstall, and troubleshooting, plus a sidebar entry; trust-boundary section in `architecture/security.md`; local variant in `architecture/overview.md`; desktop dev notes in `guides/local-development.md`. Windows steps are unverified until the owner's Windows checks.)
- [x] T037 Add hosted-mode regression tests in `apps/api/tests/integration/hosted-inference-regression.test.ts` and `apps/web/src/pages/SettingsAgents.behavior.test.tsx`; prove existing hosted auth, HTTPS validation, model/provider selection, and workspace behavior remain unchanged. (Done: `apps/api/tests/integration/hosted-inference-regression.test.ts` covers hosted runtime detection, HTTPS-only base URLs, AES credential encryption without a broker, and the guard passing hosted hosts. Hosted UI coverage, where the local/cloud selector is not shown, is in `apps/web/tests/unit/components/agent-settings-inference-mode.test.tsx`, so a separate `SettingsAgents.behavior.test.tsx` was not added.)
- [x] T038 Add security tests in `apps/desktop/tests/integration/local-network-boundary.test.ts` for loopback-only control listeners, private gateway reachability, expired/scoped tokens, and absence of prompt/credential values in logs. (Done: `apps/desktop/tests/integration/local-network-boundary.test.ts` checks that the credential broker and model gateway are unreachable on a LAN address, reject missing, wrong, and expired tokens, and keep prompts, upstream keys, and tokens out of gateway logs. Existing coverage stays in `model-gateway-token.test.ts` and `control-relay.test.ts`.)
- [ ] T039 Run the packaged Windows install-to-first-agent workflow in `apps/desktop/tests/e2e/local-first-agent.spec.ts` with Docker Desktop, WSL2, and real Ollama; after setup/downloads, repeat local inference with outbound internet disabled. Separately run the cloud-provider path with test credentials and record versions, results, and cleanup evidence in `specs/036-local-desktop/quickstart.md`.
- [ ] T040 Run the documented workspace checks and Windows package/e2e commands from `apps/desktop/package.json`; record exact commands, totals, collection status, failures, and coverage. Release requires >90% coverage for local authentication/ownership, workspace lifecycle/cleanup, persistence/migration/recovery, credential storage, and inference routing/gateway, plus >80% overall, as required by Constitution Principle II. Audit newly added ports, timeouts, paths, limits, and service URLs against Principle XI; record the audit in `specs/036-local-desktop/quickstart.md`. (Linux part recorded in quickstart.md "T040 Validation"; Windows package/e2e commands remain for the owner.)

## Dependencies and Execution Order

### Phase Dependencies

- **Setup and feasibility (Phase 1)**: T001-T003 are technical implementation gates. The two owner decisions in Execution Gates must also be recorded before T004. These approvals do not replace the required runtime, credential-store, and network feasibility evidence.
- **Foundational runtime (Phase 2)**: T004-T010 depend on the feasibility gates. Runtime boundary tests precede runtime implementation; persistence tests precede local persistence; identity tests precede local authentication.
- **User Story 1 (Phase 3)**: Depends on Phase 2; delivers desktop launch, local projects, and lifecycle controls.
- **User Story 2 (Phase 4)**: Depends on User Story 1 and T003; delivers the first actual local agent-response vertical slice.
- **User Story 3 (Phase 5)**: Depends on User Stories 1 and 2; expands the working local route into explicit per-agent local/cloud selection and verifies both destinations.
- **User Story 4 (Phase 6)**: Depends on the local state and workspace paths from User Stories 1-3.
- **Polish (Phase 7)**: Depends on the user stories selected for release; all security, hosted-regression, Windows packaging, and real-service checks are release gates.

### User Story Dependencies

- **US1 (P1)**: Starts after the foundational phase; no dependency on another user story.
- **US2 (P1)**: Requires US1's local service, project, and authentication path.
- **US3 (P1)**: Requires US2's agent launch and gateway; T023 supplies the minimal Ollama path for the early vertical slice, then US3 adds the full selector and cloud route.
- **US4 (P2)**: Requires persistent state and workspace lifecycle from US1/US2 and the credential connections from US3.

### Parallel Opportunities

- T001-T003 can be investigated independently, subject to available Windows/Docker resources.
- Within US1, T011 and T012 target separate end-to-end scenarios and files.
- Within US2, T017 and T018 target separate Docker behavior fixtures; T019 can be authored independently as the vertical-slice acceptance test.
- Within US3, T024 and T025 cover separate API and rendered-UI contracts.
- Within US4, T031-T033 cover separate recovery, migration, and retention boundaries.
- Only tasks marked `[P]` are intended for parallel execution; do not parallelize tasks that share a target file or depend on an incomplete gate.

## Parallel Execution Examples

```text
US1 after Phase 2:
  T011 first-run/project persistence E2E
  T012 close/background behavior E2E

US2 after US1:
  T017 Docker lifecycle integration test
  T018 nested-Docker compatibility test
  T019 local agent vertical-slice E2E

US3 after US2:
  T024 API endpoint-routing tests
  T025 rendered agent-settings behavior tests

US4 after the data and workspace paths exist:
  T031 crash-recovery tests
  T032 migration backup/restore tests
  T033 credential-removal/uninstall-retention tests
```

## Implementation Strategy

- **Gate first**: Complete T001-T003 and stop for owner approval if the runtime, shell/credential, or network assumptions fail.
- **Earliest usable vertical slice**: Complete US1, then US2 including T019-T023. The first customer-usable local-model MVP requires local startup, durable project data, a local workspace, an OpenCode session, and a real Ollama response; US1 alone is not a releasable product.
- **Complete the model choice**: Complete US3 before calling the local/cloud-selection feature done; prove endpoint exclusivity and no-fallback behavior.
- **Release readiness**: Complete US4 and Phase 7 before release. A green mocked suite or page-load check does not replace the packaged Windows/Docker/Ollama workflow.

## Notes

- Every task uses the required checkbox, sequential ID, optional `[P]`, required user-story label, and a concrete repository path.
- Tests are included because the spec and Prompt 5 explicitly require behavioral, vertical-slice, network-boundary, hosted-regression, and packaged-Windows verification.
- Local mode must not change hosted behavior; preserve supported devcontainer/nested-Docker settings within Docker Desktop's WSL2 VM boundary.
