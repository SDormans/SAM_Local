# Prompt Guide: Native Local SAM Desktop

Use these prompts in order to take the local-desktop idea from discovery to a
tested implementation. Run one prompt at a time and review its result before
continuing. The prompts define the work; they do not authorize skipping the
repository's normal quality, security, or review gates.

## Confirmed product direction

- SAM itself runs as a native desktop application on the user's computer.
- The first desktop release targets Windows.
- The control plane, saved application data, agent execution, and workspaces run
  locally; a Cloudflare account and remote VM are not prerequisites.
- Each supported agent can be configured to use local inference or cloud
  inference.
- OpenCode is the first local-inference path; retain cloud-model choices.
- The user has not selected a workspace isolation runtime. Investigate Docker
  Desktop/WSL2 and alternatives; recommend one with evidence instead of treating
  Docker as already approved.

## How to use

1. Start a fresh feature workflow from `main` and use the repository's Speckit
   commands for the spec, plan, and tasks.
2. Paste the prompts below one at a time, replacing bracketed values when
   needed.
3. Do not start implementation until the scope, security boundaries, and local
   runtime architecture have been reviewed.
4. If a tool rejects a file edit, stop and ask before retrying the same edit.
5. Keep the work single-user and local-first unless the product owner expands
   the scope.

## Prompt 1 — Research the existing system (read-only)

```text
Research how to deliver the confirmed Native Local SAM Desktop direction
without changing files.

Trace the real code paths and report evidence for:
- desktop/web entry points and current app packaging;
- API startup and every Cloudflare-specific binding or service used by the
  local agent/workspace/chat path (D1, KV, R2, Durable Objects, Workers AI,
  queues, cron, auth, and WebSockets as applicable);
- local development and mock-mode behavior, including what demonstrably does
  not work;
- workspace creation, agent process startup, ACP/chat streaming, and cleanup;
- model/provider selection and where OpenCode obtains and calls its inference
  endpoint;
- secrets, local data persistence, and network exposure boundaries.

Inspect the current implementation and its tests; do not infer working
behavior from old specs or documentation alone. Identify which existing pieces
can be reused, which depend on Cloudflare or remote VMs, and what must change.
For each claim, cite file paths and relevant symbols. End with the unresolved
product/architecture decisions that must be answered before planning. Do not
implement, scaffold a desktop shell, or rewrite existing files.
```

## Prompt 2 — Write the feature specification

```text
Use /speckit.specify for a feature named Native Local SAM Desktop.

Use the confirmed product direction in specs/036-local-desktop/prompt-guide.md
and the verified research findings from the previous step. Specify user-visible
outcomes only; do not choose frameworks, databases, IPC protocols, or a desktop
packager in the spec.

The spec must cover:
- Windows native installation, first run, start/stop, upgrade, and uninstall;
- local control-plane operation and durable local projects, settings, and chat;
- running and cleaning up an agent workspace on the same machine without a
  remote VM;
- per-agent local-vs-cloud inference choice, initially OpenCode for local
  inference and existing cloud paths where compatible;
- visible provider selection, explicit errors, and no silent local-to-cloud
  fallback;
- offline/local-only use, crash recovery, data cleanup, credentials, and
  loopback-only service exposure by default.

Bound the feature to a single local user and Windows first. Exclude hosted
sync, multi-user access, remote VM provisioning in local mode, and additional
desktop OSes unless research proves one is necessary. Turn unknown user-facing
decisions into a short, prioritized clarification list rather than silently
assuming them. Write the spec and its quality checklist only; do not edit
application code or other feature specs.
```

## Prompt 3 — Clarify product decisions

```text
Review the Native Local SAM Desktop spec and ask only questions whose answers
materially change the user experience, security, or scope. Use the project's
clarification workflow and ask no more than five focused questions at once.

In particular, resolve:
- whether a local workspace requires Docker Desktop/WSL2 or another supported
  isolation model, based on Windows feasibility and user burden;
- which local inference server/API formats the first release must support;
- whether the local model server must be reachable only from the host or also
  from an isolated workspace, and how the user configures that safely;
- what cloud-provider credentials the local app may retain and how the user
  removes them;
- what exact native-app behavior is expected when SAM is closed while an agent
  is running.

Offer a recommended answer with plain-language tradeoffs for each question.
Update the spec only after receiving my answers; do not begin implementation.
```

## Prompt 4 — Design the architecture

```text
Use /speckit.plan for the clarified Native Local SAM Desktop spec.

First map the end-to-end target data paths: desktop launch -> local API ->
durable local storage -> local workspace runtime -> agent process -> model
endpoint -> streamed chat response. Separately map the cloud-model path.

Compare the smallest viable architecture options for:
- a native Windows shell and supervised local services;
- replacing or adapting Cloudflare-only API/storage/DO dependencies for
  persistent single-user local operation;
- starting, monitoring, recovering, and stopping local isolated workspaces;
- reaching a host-local model server from an agent inside an isolated workspace;
- protecting local credentials and preventing LAN exposure;
- packaging, upgrades, logs, backups, and uninstall cleanup.

Recommend one design and explain what existing code can be reused versus
isolated behind a local adapter. Do not attempt to run Cloudflare production
services locally by assumption, add speculative cross-platform infrastructure,
or create a second implementation of existing behavior without justification.
Do not make the entire API trust a desktop client. Include threat boundaries,
data ownership, failure modes, tests, migration/compatibility impact, and
documentation updates. Stop and ask me before implementation if a choice could
delete data, expose a local service, materially change the existing hosted
product, or force a major technology commitment.
```

## Prompt 5 — Generate implementation tasks

```text
Use /speckit.tasks for the approved Native Local SAM Desktop spec and plan.

Create small, dependency-ordered, independently verifiable tasks. Put the
first real vertical slice early: launch the Windows app, start the local
control plane, create a local workspace, run one agent, and observe a streamed
response. Do not postpone the integration path until the end.

Include explicit tasks and tests for:
- Windows packaging and supervised service lifecycle;
- persistent local data and safe first-run initialization;
- local workspace creation, isolation, restart recovery, stop, and deletion;
- OpenCode local endpoint configuration and cloud provider selection;
- proving each model choice reaches only its intended destination;
- credentials, loopback/network access restrictions, failure reporting, and
  cleanup;
- user documentation and a real packaged-Windows end-to-end test.

Every research finding that requires a change must become a task. Acceptance
criteria must be observable. Mark external prerequisites (Windows runner,
Docker runtime, local model server, provider credentials) explicitly. Do not
create implementation code.
```

## Prompt 6 — Check spec/plan/task consistency

```text
Use /speckit.analyze on the Native Local SAM Desktop spec, plan, and tasks.
Check for contradictions, missing Cloudflare-to-local replacements, unstated
security assumptions, tasks without acceptance criteria, and any user-facing
requirement that is not covered by both an implementation task and a test.

Verify that the local-model path accounts for host-versus-container
networking, that cloud inference remains an explicit separate choice, and that
no error path silently falls back to cloud. Verify first-release scope is
Windows-only and local single-user operation. Report gaps with artifact and
section references. Do not edit code; propose the smallest spec/plan/task
corrections and apply only after I approve them.
```

## Prompt 7 — Implement the approved plan

```text
Use /speckit.implement to execute only the approved Native Local SAM Desktop
tasks. Follow the repository's /do workflow, create the required workflow
state, use a feature branch/worktree, and preserve unrelated user changes.

Before each code area, load its nearest AGENTS.md and routed scoped rules.
Trace existing call paths before adding helpers or abstractions. Implement in
small vertical slices; after each slice run its focused tests and update task
and workflow state. Do not replace hosted behavior for existing users: keep
the hosted and local runtime paths explicitly separated.

Never claim a local model is being used based only on a saved setting. Prove
the real agent request reaches the selected local endpoint and that the cloud
endpoint receives no request. Prove cloud selection still reaches the selected
cloud provider. Surface missing prerequisites and cleanup failures explicitly.
Do not weaken security to make loopback/container networking work. Stop and
ask me if implementation requires a scope or architecture change not approved
by the plan.
```

## Prompt 8 — Verify the actual Windows product

```text
Validate the packaged Native Local SAM Desktop as a Windows user would use it;
do not substitute page-load checks or component tests for the real workflow.

On a clean supported Windows environment:
1. Install and launch the packaged app without a Cloudflare account.
2. Complete first-run setup and create/open a local project.
3. Start an isolated workspace and run an agent through the desktop UI.
4. Configure OpenCode to use a real local model server and verify a real
   response. Capture evidence showing the local endpoint was called and the
   cloud provider was not.
5. Switch to a configured cloud model and verify its selected provider is
   called instead; verify the local endpoint is not used for that task.
6. Exercise unreachable local-model, missing workspace runtime, app restart
   during work, and workspace cleanup cases. Confirm truthful errors and no
   orphaned resources.
7. Close/reopen the app and verify required local state persists.
8. Confirm the local control interface is not reachable from another LAN
   device by default and confirm credentials are not exposed in logs.

Record the app version, Windows version, workspace-runtime version, local model
server/model, exact test steps, endpoint-routing evidence, and cleanup result.
Run all repository-required local checks and review gates separately. If a
real Windows package or local model endpoint is unavailable, state that
verification as incomplete; do not mark the feature ready or claim staging
proved the desktop workflow.
```

## Completion prompt — Report readiness, do not overclaim

```text
Compare the approved acceptance criteria with the actual diff, tests, Windows
package evidence, and local/cloud endpoint-routing evidence. List each
criterion as verified, failed, or not verified, with a specific test or
evidence reference. Identify unresolved blockers and reviewers. Do not archive
the task, merge, or say the feature is complete while any required criterion or
review gate is unverified.
```
