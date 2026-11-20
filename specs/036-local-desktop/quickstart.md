# Local Desktop Architecture Validation Quickstart

This is a planning-stage verification checklist, not a claim that the packaged local desktop exists. Complete and record these checks before implementation is approved.

## Required Environment

- Supported Windows version with WSL2 and Docker Desktop using Linux containers.
- A clean SAM checkout with the repository's existing Node/pnpm and Go toolchains.
- Ollama installed on the Windows host with a small test model available.
- A second device on the local network for negative network-exposure checks.
- No Cloudflare account credentials in the test environment.

## Feasibility Sequence

1. **Worker runtime**: Start the pinned local Worker runtime with all bindings local. Confirm it does not attempt remote bindings or require Cloudflare secrets.
2. **Durability**: Create a project and chat record, stop and restart the runtime, and confirm D1 and ProjectData Durable Object state remains intact in an app-owned data path.
3. **Migrations**: Run the full migration chain against an empty local store, upgrade a populated store, verify a pre-upgrade backup, and prove a failed migration preserves the prior copy.
4. **Local mode isolation**: Exercise project/chat paths with network egress instrumentation. Confirm no Cloudflare API, Workers AI, DNS, provider VM, or cron path is called.
5. **Docker lifecycle**: Through the proposed desktop control path, create, start, stop, restart, and delete one SAM-labeled workspace. Verify supported repository devcontainer and nested-Docker behavior. Restart the app mid-run and reconcile only that workspace; verify no unrelated Docker resource changes.
6. **Model bridge**: From the workspace container, reach the configured Ollama model through the SAM gateway. Verify the gateway cannot be pointed at an arbitrary host/URL and that a second LAN device cannot reach the UI, API, gateway, or model service.
7. **Routing controls**: Instrument both local and cloud endpoints. A local-mode prompt must hit only the local endpoint; a cloud-mode prompt must hit only the configured cloud endpoint; unavailable endpoints must fail without reaching the other endpoint.
8. **Desktop lifecycle**: Package the shell, launch it on a clean Windows profile, test the default graceful-stop prompt, explicitly choose background mode, and verify visible running status and subsequent shutdown behavior.
9. **Data cleanup**: Remove a model credential and delete a workspace while verifying project/conversation data and unrelated Docker resources remain. Exercise uninstall retain/delete choices separately.

## Stop Conditions

- Stop the local-runtime path if it cannot support persistent D1/DO state and migrations without Cloudflare credentials or remote bindings.
- Stop if local control or model ports can be reached from a LAN device by default.
- Stop if the local path cannot preserve supported repository devcontainer and nested-Docker behavior within Docker Desktop's WSL2 Linux VM security boundary, or requires publishing the Docker API beyond that boundary. Seek owner approval before changing the established trust model.
- Stop if a local-mode failure causes a cloud/remote-VM fallback or a cloud-mode failure causes local routing.
- Do not substitute Miniflare unit tests or a page-load check for the packaged Windows workspace-to-agent-to-model path.

Record Windows/build/runtime versions, exact commands, endpoint-routing evidence, Docker resource IDs/labels, persistence results, and cleanup outcomes. Any failed stop condition requires an architecture decision before implementation continues.

## Feasibility Evidence (Linux pre-check, 2026-11-20)

Run on an Ubuntu 22.04 VM (kernel 6.8, Docker Engine 29.9.2, Node 24.22.2, pnpm 9.15.9, Ollama 0.40.16 with `qwen2.5:0.5b`). Wrangler 4.149.0 / workerd 1.20261006.1 (pinned via the pnpm catalog). No Cloudflare credentials were present; the T001 test also strips `CLOUDFLARE_*`/`CF_*` from the child environment. **These results do not replace the Windows Docker Desktop/WSL2 checks below, which remain open.**

### T001 — local Worker runtime: PASS on Linux (Windows run pending)

```bash
pnpm turbo run build --filter=@simple-agent-manager/api^...
cd apps/api
SAM_LOCAL_RUNTIME_FEASIBILITY=1 pnpm exec vitest run tests/integration/local-runtime-feasibility.test.ts
```

- `tests/fixtures/local-runtime/` serves the real `ProjectData` Durable Object (SQLite-backed, its own schema migrations) and D1 through `wrangler dev --local --persist-to <dir>`.
- `wrangler d1 migrations apply DATABASE --local` applies the full chain (`0000`…`0205`) to an empty local store.
- A D1 row and `ProjectData` sessions written in one runtime process are read back after 3 restarts.
- The full `apps/api/wrangler.toml` also starts locally (`wrangler dev --local`, `/health` returns `healthy`; D1, KV, R2 and all DO bindings are local), but Wrangler reports `AI` and `ARTIFACTS` as remote-only bindings, Containers need a local Docker build, and crons are not triggered locally. The local runtime therefore needs its own config without `AI`, `ARTIFACTS`, Containers and crons, plus API-side rejection of those paths in local mode (T007). No Node/SQLite adapter is required.

### T003 — private model path: PASS on Linux (Windows run pending)

```bash
cd apps/desktop
SAM_FEASIBILITY_DIND_IMAGE=docker:27-dind pnpm test:feasibility
```

`tests/feasibility/model-gateway-network.spec.ts` (7 tests) proves:

- Ollama listens on `127.0.0.1:11434` only; it is not reachable on LAN-facing or Docker-network addresses.
- The SAM gateway (`apps/desktop/src/main/model-gateway.ts`) binds only to loopback or an explicitly verified private-network address (here, the SAM Docker network gateway).
- A workspace container on that network, using `--add-host sam-model-gateway:<gateway-ip>`, lists the scoped model and receives a streamed (SSE) completion from Ollama through the gateway with a workspace-scoped `samgw_` token.
- Requests without a valid token get 401; the workspace cannot reach Ollama directly; the gateway port is not reachable on LAN-facing addresses or loopback.
- A privileged `docker:27-dind` workspace on the same network (the supported nested-Docker shape) reaches the gateway, with no Docker API port published on the host.

Windows differences to verify: Docker Desktop routes `host-gateway`/`host.docker.internal` to the Windows host loopback, so the gateway should bind `127.0.0.1` there. Check that workspaces reach it through `--add-host sam-model-gateway:host-gateway`, that Ollama stays on `127.0.0.1`, and that a second LAN device cannot reach the gateway, the control port or Ollama. On Docker Desktop, workspaces can probably also reach other host-loopback services (including Ollama) directly through `host.docker.internal`. Record whether that holds; it is not LAN exposure, but it does mean the gateway is the credential boundary rather than a network boundary.

## Foundational Local Runtime Evidence (Linux, 2026-11-20)

Same VM as above. Build the API's workspace dependencies first:

```bash
pnpm turbo run build --filter=@simple-agent-manager/api^...
pnpm --filter @simple-agent-manager/desktop test:coverage   # 42 tests; 93.8% statements, 89.7% branches, 92.6% functions, 95.3% lines
pnpm --filter @simple-agent-manager/desktop test:runtime    # 5 tests; real apps/api under workerd
cd apps/api && pnpm exec vitest run tests/unit/local-mode tests/unit/middleware
```

`test:runtime` starts the real `apps/api` Worker from the generated local config. It is an app-owned data directory with no Cloudflare credentials in the child environment. The test proves:

- The full D1 migration chain applies through `LocalDataStore.upgrade`, which records the schema version and writes a backup first.
- `/health` serves on `127.0.0.1`. A request with `Host: attacker.example` (DNS rebinding) gets `403 LOCAL_HOST_REJECTED`.
- `POST /api/local/session` issues an HttpOnly, `SameSite=Strict` `sam_local_session` cookie, but only to a caller holding the per-installation bootstrap secret.
- Requests to `/api/projects` get 401 when they carry a forged local cookie, a BetterAuth cookie, an `x-user-id` header, or a bearer token.
- Another user's project does not appear in the local principal's list, and a direct request for it returns 404.
- The principal and session survive a full runtime restart; `DELETE /api/local/session` revokes the session.

Unit tests cover the rest:

- **Data store:** restore after a failed migration; disk-full before and during an upgrade, with the prior data kept and no partial backup left; backup pruning.
- **Supervisor:** loopback binding, credential stripping, port-in-use, early exit and readiness timeout, process-group stop.
- **Runtime boundary and local sessions:** the outbound guard, Workers AI poisoning, and Host parsing; local sessions store only a token hash and reject expired, revoked, cross-installation and malformed sessions.

**Known limitation (to resolve with T002 on Windows):** the generated `.dev.vars` and `runtime/secrets.json` are owner-only files (`0600`) in the per-user data directory. They are not yet encrypted with Electron `safeStorage`. They hold installation signing, encryption and bootstrap secrets, never provider credentials.

## Desktop Shell Evidence (Linux, 2026-11-20)

```bash
pnpm turbo run build --filter=@simple-agent-manager/api^... --filter=@simple-agent-manager/web^...
VITE_API_URL=http://127.0.0.1:8790 pnpm --filter @simple-agent-manager/web build
node apps/desktop/node_modules/electron/install.js   # only if pnpm skipped Electron's binary download
cd apps/desktop && pnpm build && xvfb-run -a pnpm exec playwright test --config playwright.config.ts
```

The Electron app (`apps/desktop/src/main/index.ts`) has these protections:

- The renderer runs with `contextIsolation`, `sandbox` and no `nodeIntegration`. All permission requests are denied, and the window cannot navigate off `http://127.0.0.1:8790`.
- The preload bridge exposes only folder selection and runtime status. IPC calls are accepted only from the local origin.
- The local session cookie is set by the main process as HttpOnly, so the renderer never sees the bootstrap secret.

The e2e suite (3 tests) proves:

- **First run:** no Cloudflare credentials are needed, and a local-folder project is created without cloning. It survives a full app restart, and launch to project took well under 5 minutes.
- **Close with active work:** the prompt's default button is "Stop work and quit". Choosing background hides the window while the API keeps running; choosing stop shuts the API down before the process exits.
- **Close without active work:** SAM stops and quits without a prompt.

The web UI is the normal `apps/web` build, served same-origin by the local Worker through wrangler `[assets]`.

**Still open for the owner on Windows (T002):** an installer package, the tray icon artwork, and Windows process-tree stop.
