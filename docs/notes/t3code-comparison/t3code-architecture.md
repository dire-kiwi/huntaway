# T3 Code: architecture, capability surface and gap sweep

Part of the T3 Code inventory: [t3code-overview.md](t3code-overview.md) has the summary and links the other areas.

Source: shallow clone of `github.com/pingdotgg/t3code` at commit `9b1d351` (2026-10-30), package
version `0.1.5`. Paths are relative to the repository root. "(from code)" marks facts read from
source rather than docs. "(beta)", "(alpha)", "(Labs)" or "(experimental)" mark features the repo
itself labels that way. Areas covered in depth by the other research notes (providers/orchestration,
threads/composer UI, source control/review/terminal/previews, remote/devices/mobile/install) appear
here only as one-line pointers.

## 1. Project status and stated goals

### Stated goals

- Self-description: an "agent harness control surface" that controls the agents already installed on
  your machine from a mobile app (iOS, Android), a web app (`app.t3.codes`) and an Electron desktop
  app. `README.md`
- "Bring-your-own-subscription" alternative to Claude Desktop, Codex App, Cursor Glass and Conductor;
  it uses the user's existing Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity (plus Pi,
  Muse Code, fx and ACP agents) logins. `README.md`, `AGENTS.md`, `docs/user/faq.md`
- Four non-negotiables listed for contributors: (1) open at the core, (2) performance without
  compromise, (3) remote ready, (4) multi-surface (web hosted + web served by `npx t3`, desktop,
  mobile). `AGENTS.md` ("What makes T3 Code special?")
- Not a harness itself: "T3 Code uses those harnesses. It is not a harness" (chef/kitchen/restaurant
  analogy). `docs/user/faq.md`
- Price: free, MIT; T3 Connect free "for now", 3 machines per account (10/100 with a linked paid
  T3 Chat plan). `docs/user/faq.md`
- No local-model support, stated as a deliberate choice. `docs/user/faq.md`
- Claimed user base: "over 500,000 users". `AGENTS.md`

### Maturity signals

- Version `0.1.5` across `apps/server/package.json` (npm package `t3`), `apps/desktop`, `apps/web`,
  `packages/contracts`; mobile app has its own version (`2.2.0` default in `apps/mobile/app.config.ts`).
- "We are very very early in this project. Expect bugs." `README.md`
- Product label is "Beta" (stable) or "Nightly"; Beta is "the product label, not a release channel".
  `docs/operations/release.md`, `apps/desktop/src/app/DesktopEnvironment.ts` (from code)
- Explicitly labelled pre-release features: guest links (beta, Settings → Labs), linked environments
  (beta), review guides (beta), "Before the cache expires" idle compaction (beta), fold working
  threads (beta), group threads by project (beta), Simlock device hosts (alpha).
  `docs/user/guest-links.md`, `docs/user/remote-access.md`, `docs/user/source-control.md`,
  `docs/user/providers-claude.md`, `docs/user/thread-sidebar.md`, `docs/user/devices.md`,
  `packages/contracts/src/settings.ts`
- Orchestration was rewritten ("V2"); V1 data is imported lazily and partially (no checkpoints,
  tool calls, approvals or provider session identity carried over). `docs/internals/legacy-orchestration-migration.md`
- Very high change volume: the head commit references PR `#27711`; 75 numbered SQL migrations plus a
  V2 migration set. `git log`, `apps/server/src/persistence/Migrations/`
- "There's no docs site yet"; docs live in `docs/` (`user/`, `internals/`, `operations/`,
  `orchestration-v2/`). `README.md`

### Contribution policy

- "(mostly) not accepting contributions yet. Small fixes may be considered. Big features will not
  be." `README.md`
- Features need prior maintainer approval in an Ideas discussion; one underlying problem per PR;
  focused bug/reliability/perf fixes most likely accepted. `CONTRIBUTING.md`
- "Most T3 Code contributions will come from T3 Code itself, often controlled remotely"; `AGENTS.md`
  is written for coding agents (rules on not killing processes by pattern, not touching
  `~/.t3/userdata`, etc.). `AGENTS.md`
- A two-way synced GitCafe mirror exists for higher API rate limits when many agents work at once.
  `docs/operations/development.md`

### Release cadence and channels

- Channels: stable, nightly, and a maintainer-only `preview` train. `docs/operations/release.md`
- Nightly: scheduled release check every 30 minutes (`cron: "8,38 * * * *"`). `.github/workflows/release.yml`
- Stable is promoted from the latest published nightly commit (not `main` HEAD); manual dispatch
  or `vX.Y.Z` tag. `docs/operations/release.md`
- Artifacts: 6 desktop builds (macOS arm64/x64 DMG, Linux x64/arm64 AppImage + `.deb`, Windows
  x64/arm64 NSIS), self-contained CLI archives (Node single-executable) for 5 targets with
  `SHA256SUMS`, npm launcher package `t3` (dist-tags `latest`/`nightly`/`preview`), hosted web app
  on Vercel aliased to `latest`/`nightly` channels, AUR packages, Discord announcement.
  `docs/operations/release.md`, `.github/workflows/publish-aur.yml`
- Release notes body includes a model-written summary (`scripts/generate-release-notes.ts`).
  `docs/operations/release.md`
- Users switch Stable/Nightly in Settings → About → Update track (moves all connected machines).
  `docs/user/updating.md`
- Mobile ships through EAS workflows (`mobile-eas-production.yml`, `mobile-eas-preview.yml`),
  plus Android beta APK releases. `.github/workflows/`, `docs/user/install.md`

### Licence

- MIT, "Copyright (c) 2026 T3 Tools Inc." `LICENSE`; third-party notices generated into
  `third-party-licenses/` (`scripts/sync-third-party-license-notices.ts`, `docs/user/open-source-licenses.md`).

## 2. Stack

### Languages and runtimes

- TypeScript everywhere (type-checked with `@tsc-rs/typescript` 0.8.0, a Rust `tsc` drop-in,
  aliased as `typescript`). `pnpm-workspace.yaml` catalog
- Node pinned exactly: `engines.node` `26.12.1`; package manager `pnpm@12.14.0`. `package.json`
- Rust for native helpers (`native/resource-monitor`, `native/hyprland-snap-shot`,
  `native/kde-snap-shot`); C for `native/browser-secret` (libsecret lookup of Chromium's cookie key on
  Linux); vendored `libghostty-vt` C ABI headers (terminal emulation). `native/*`
- SQL (SQLite) for persistence; GraphQL only as a *client* of Expo's API (see 7.12).

### Frameworks and key libraries

- **Effect 4** (`effect` 4.0.5, the "effect-smol" line vendored read-only in `.repos/effect-smol`)
  for the server, contracts (Effect Schema), RPC (`effect/rpc`), SQL (`effect/sql`), HTTP
  (`effect/http`, `HttpApi`), CLI (`Command`/`Flag`), and client state (`@effect/atom-react`).
  `pnpm-workspace.yaml`, `apps/server/package.json`, `AGENTS.md`
- **Server** (`apps/server`, npm package `t3`): Node HTTP + WebSocket; `@anthropic-ai/claude-agent-sdk`
  (Claude), Codex app-server protocol (`packages/effect-codex-app-server`), ACP
  (`packages/effect-acp`, `packages/provider-acp`), `@cursor/sdk`, `@muse-code/sdk`, `node-pty`,
  `playwright-core` (server-side headless browser), `@napi-rs/keyring`, `node:sqlite`. `apps/server/package.json`
- **Web** (`apps/web`): React 19.3, Vite (Vite+ core), TanStack Router, Tailwind 4, Base UI,
  Tiptap (composer), `@pierre/diffs`/`@pierre/trees`, dnd-kit, Legend List, zustand,
  KaTeX/remark/rehype markdown pipeline, pdf.js, `@betteroffice/{docx,pptx,xlsx}` (document
  previews), Clerk (T3 Connect sign-in), `sql.js`. `apps/web/package.json`
- **Desktop** (`apps/desktop`): Electron 44.10.0, electron-updater, electron-builder; wraps the web
  UI and bundles/launches the server. `apps/desktop/package.json`, `AGENTS.md`
- **Mobile** (`apps/mobile`): Expo 58, React Native 0.88, React Navigation 7, uniwind (Tailwind for
  RN); iOS and Android. `apps/mobile/package.json`
- **Marketing site** (`apps/marketing`): Astro 7; also serves `install.sh`/`install.ps1`.
  `apps/marketing/package.json`, `docs/operations/release.md`
- **Hosted relay** (`infra/relay`, T3 Connect control plane): Cloudflare Workers + Durable Objects,
  PlanetScale Postgres via drizzle, Clerk, Axiom, deployed with Alchemy. `infra/relay/package.json`,
  `infra/relay/README.md`, `docs/internals/t3-connect.md`
- **Tooling**: Vite+ (`vp`) as the single CLI for install/dev/test/lint/fmt/run; Vitest
  (`vp test`), oxlint with a custom plugin (`oxlint-plugin-t3code/`) and `@shadcn/lint`, oxfmt,
  knip (unused exports/deps fail CI), CodeRabbit and Macroscope review bots.
  `package.json`, `vite.config.ts`, `knip.jsonc`, `.coderabbit.config.ts`, `.macroscope/`

## 3. Monorepo layout

### `apps/*`

- `apps/server` – the environment server: WebSocket RPC, HTTP API, orchestration, providers,
  checkpointing, persistence, MCP server, CLI (`bin.ts`, `cli/`). `AGENTS.md`
- `apps/web` – React/Vite UI, served by the server and hosted at `app.t3.codes`.
- `apps/desktop` – Electron shell (also a GNOME Shell extension under `apps/desktop/gnome-extension`
  for SnapShot capture, `package.json` script `dist:gnome-extension`).
- `apps/mobile` – React Native app.
- `apps/marketing` – Astro site.

### `packages/*` (31 packages)

- `contracts` – Effect Schema contracts for everything on the wire (RPC, HTTP, IPC, settings,
  events). "No heavy runtime logic." `AGENTS.md`
- `client-runtime` – connection supervisor, RPC sessions, state sync and commands shared by web and
  mobile. `docs/internals/connection-runtime.md`
- `shared` – shared runtime utilities (subpath exports, no barrel), including the `node:sqlite`
  Effect SQL client (`packages/shared/src/nodeSqliteClient.ts`).
- Provider integrations: `provider-core`, `provider-acp`, `provider-acp-registry`, `provider-cursor`,
  `provider-fx`, `provider-grok`, `provider-muse`, `provider-opencode`, `provider-pi`,
  `provider-testing` (replay fixtures), plus protocol libraries `effect-acp`,
  `effect-codex-app-server`. Claude, Codex and Antigravity live in `apps/server/src/provider`.
- Source control: `source-control-core`, `-definitions`, `-github`, `-gitlab`, `-bitbucket`,
  `-azure-devops`, `-forgejo`, `-gitcafe`, `-testing`.
- Secrets: `secret-provider-core`, `secret-provider-definitions`, `secret-provider-onepassword`.
- Networking helpers: `ssh`, `tailscale`.

### `native/*`, `infra/*` and other top-level

- `native/resource-monitor` (Rust, `sysinfo`-based process sampler run as a child process),
  `native/{hyprland,kde}-snap-shot` (Linux screen capture), `native/browser-secret` (C),
  `native/libghostty-vt` (pinned upstream revision in `VERSION`). `docs/internals/resource-telemetry.md`,
  `docs/internals/terminal-runtime.md`
- `infra/relay` – T3 Connect relay; `infra/task-cache` – shared remote build cache for Vite+ tasks
  (Cloudflare Worker + D1 + R2), maintainer infrastructure only. `infra/*/README.md`
- `evals/` – paid-model evals for model-facing text (MCP tool use, thread titles, test-signal).
  `evals/README.md`
- `.repos/` – vendored read-only references (`effect-smol`, `alchemy-effect`). `AGENTS.md`
- `packaging/aur`, `scripts/` (dev runner, release, smoke tests, install scripts), `patches/`.
- `t3.json` at the root is the repo's own T3 project file (worktree setup script). `t3.json`

### Size (from code, non-test `.ts/.tsx` file counts and total lines incl. tests)

- `apps/server/src`: 811 source files, 430 test files, ~489k lines.
- `apps/web/src`: 1,290 / 440 / ~366k; `apps/mobile/src`: 1,000 / 249 / ~191k;
  `apps/desktop/src`: 158 / 95 / ~69k; `packages/client-runtime/src`: 233 / 142 / ~90k;
  `packages/contracts/src`: 74 / 29 / ~29k; `infra/relay/src`: 60 / 36 / ~29k.

## 4. Core concepts (glossary)

From `docs/internals/glossary.md` and `AGENTS.md`:

- **Environment** – one running server plus the machine, credentials, workspace access and state it
  owns. **Client** – a web, desktop or mobile UI connected to an environment (desktop can also host
  one). **T3 home** – base data dir (`~/.t3`); runtime state under `userdata/`.
- **Project** – environment-local workspace record rooted at a directory; **workspace root** its
  base dir; **worktree** – separate git checkout a thread can use.
- **Thread** – durable conversation and work history for a project; survives provider process exits.
  Threads can also have no project (scratch folder under `~/.t3/scratch`). `docs/user/thread-sidebar.md`
- **Turn** – one user-to-agent cycle, a V2 **run**; provider work can end before checkpoint/diff
  work settles. **Activity** – non-message timeline item (tool action, approval, failure).
- Orchestration terms: **command**, **event**, **orchestrator** (serializes commands, decides
  events without I/O), **projection/read model**, **command receipt** (idempotent retries),
  **outbox effect**, **effect worker**.
- Provider terms: **provider**, **driver** (integration for a provider kind), **provider instance**
  (one configured provider/account; several per driver), **adapter**, **session** (stoppable,
  resumable runtime attached to a thread), **runtime mode** (permission policy:
  `approval-required`, `auto-accept-edits`, `auto`, `full-access`; default `full-access` in
  `packages/contracts/src/providerPolicy.ts`), **interaction mode** (`default` or `plan`).
- Checkpoint terms: **checkpoint** (hidden git ref), **checkpoint baseline**, **turn diff**.
- PR terms: **pull request link** (host+repo+number, can cross projects), **pull request sync**
  worker, **current pull request**.
- Composer terms: **context record**, **context reference** (`t3-context://v1/<kind>/<id>` links in
  message text), **attachment binding**, **attachment inventory**.
- V2 graph (from `docs/orchestration-v2/README.md`): AppThread → Run → root ExecutionNode → child
  nodes (tool, approval, subagent) → ProviderThread; "App ids are primary. Provider ids are refs."
  Forks, provider handoffs, merge-back and subagents share one "context transfer" primitive.

## 5. Runtime architecture

### Ownership and process model

- Execution stays in the environment that owns the workspace; clients only control it over
  authenticated RPC. Provider processes, terminals, git and project files belong to the server.
  `docs/internals/overview.md`
- The desktop app bundles and launches a server but its renderer uses the same RPC boundary;
  remote clients (web, mobile, another desktop) connect to any environment. `docs/internals/overview.md`,
  `docs/internals/remote.md`
- One server per T3 home: `server-owner.sqlite` is an ownership lock; a second server exits with a
  distinct exit code. `apps/server/src/serverOwnership.ts` (from code)
- A desktop-launched backend shuts itself down if its launcher process disappears (parent PID poll
  every 2 s). `apps/server/src/launcherWatch.ts` (from code)
- At startup the server hydrates `PATH` (and `__MISE_DIFF`, `JAVA_HOME`) from the user's login shell
  or `launchctl`, so provider CLIs installed by version managers are found. `apps/server/src/os-jank.ts` (from code)

### Client ↔ server transport

- **WebSocket RPC**: Effect RPC (`effect/rpc`) over a single `/ws` socket, JSON serialization
  (`RpcSerialization.layerJson`). One `WsRpcGroup` with request/response and streaming methods.
  `packages/contracts/src/rpc.ts`, `apps/server/src/ws.ts`, `packages/client-runtime/src/rpc/session.ts`
- **Protocol gate**: clients append `orchestrationProtocol=2`; `/ws` rejects a missing/mismatched
  version with HTTP 426 `orchestration_protocol_incompatible` before auth. `docs/internals/legacy-orchestration-migration.md`
- **Auth at upgrade, scopes per method**: the socket authenticates once (cookie, bearer, DPoP or a
  one-time websocket ticket); a `RpcScopeAuthorization` middleware checks each method's required
  scope. "Authentication of a socket does not authorize every method on it." `apps/server/src/auth/RpcAuthorization.ts`,
  `docs/internals/overview.md`
- **HTTP API alongside**: an Effect `HttpApi` (`EnvironmentHttpApi`) for descriptor, auth, MCP OAuth,
  bounded thread snapshots/history pages, projects, PR diffs, T3 Connect, webhooks; plus raw routes
  for assets, uploads, guest links, preview streaming, device hub proxy and the static web app.
  `packages/contracts/src/environmentHttp.ts`, `apps/server/src/server.ts`
- **Capability flags in server config** let clients and servers of different versions interoperate
  (`shellThreadFamilies`, `shellOlderSettled`, `threadSnapshotPagination`, `threadFind`,
  `secretProviderSettings`, ...). `packages/contracts/src/server.ts`
- **MCP**: the server also exposes an MCP endpoint at `/mcp` (with its own OAuth server) so agents
  inside and outside T3 Code can drive it (see 7.13). `apps/server/src/mcp/McpHttpServer.ts`
- **Desktop IPC**: Electron preload exposes a `DesktopBridge` to the renderer for OS-level things
  (see 7.14). `packages/contracts/src/ipc.ts`

### Client connection runtime

- One connection owner per environment in `packages/client-runtime`; a supervisor owns retries
  (jittered exponential backoff capped at 5 minutes), offline/auth states wait for wakeups; probes on
  foreground/network change replace dead sockets (500 ms probe, 3 s on loopback/LAN, 15 s elsewhere).
  `docs/internals/connection-runtime.md`
- Transport health and data freshness are tracked separately: a session is "ready" only after the
  initial server config; shell and thread data sync independently; cached projections remain
  readable offline. `docs/internals/connection-runtime.md`
- Two subscription levels: the **shell** (navigation rows across projects/threads) and **thread
  detail** streams; idle subagent children and settled threads beyond the newest 25 are left out of
  shell snapshots and loaded on demand. Thread streams are cached 5 idle minutes for back navigation.
  `docs/internals/connection-runtime.md`
- Desktop keeps every running thread's stream mounted ("keep-alive"); web and mobile do not.
  `docs/internals/connection-runtime.md`
- Mutations go through `createEnvironmentRpcCommand` with a client-side permission atom; the server
  stays authoritative (`CLIENT_GUARDED_RPC_SCOPES`). `AGENTS.md`, `packages/contracts/src/clientRpcPermissions.ts`

### Server code organisation (Effect services)

- Every capability is a method on an Effect service in its domain folder; transports (WS handlers,
  HTTP routes, MCP tools, scheduled tasks, CLI) only decode, call one method, map errors. Rationale:
  "Users trigger a capability from the WebSocket, agents reach it through MCP tools, and scheduled
  tasks and the CLI run it too." `docs/internals/effect-services.md`
- Conventions enforced by review bots and lint: `Context.Service` tags, `Effect.fn("Service.op")`
  named spans, `Schema.TaggedError` with bounded attributes (no secrets/payloads), no
  `ManagedRuntime` inside services. `docs/internals/effect-services.md`, `.macroscope/`

### Orchestration V2 (event-sourced core)

- Pipeline: client command → orchestrator (`apps/server/src/orchestration-v2/Orchestrator.ts`)
  serializes commands and decides events with no I/O → `EventSink` commits events, projections,
  command receipt and outbox effects in **one SQLite transaction** → `EffectWorker` runs effects after
  commit and feeds results back as commands. `docs/internals/overview.md`, `AGENTS.md`
- A command acknowledgement means "intent committed", not that the provider work finished.
  `docs/internals/overview.md`
- Outbox effect kinds (from code): `provider-runtime.continue`, `provider-session.detach`,
  `provider-turn.start|interrupt|steer|restart`, `runtime-request.respond`,
  `provider-thread.rollback`, `checkpoint.capture`, `thread-title.generate`,
  `delegated-tasks.stop`, and cleanup of scheduled tasks, terminals, previews and attachments.
  `apps/server/src/orchestration-v2/EffectWorker.ts`
- Provider adapters translate native protocols into normalized events; provider ids never become
  app ids. `docs/orchestration-v2/README.md`, `docs/internals/providers.md`
- Turn completion and run finalization (checkpoint, diff, PR discovery) are separate milestones; a
  late checkpoint must not extend the recorded provider duration. `docs/internals/overview.md`
- Thread settlement (auto-archiving finished work by PR merge or inactivity) is server-owned and
  runs without a connected client. `apps/server/src/orchestration-v2/ThreadSettlementService.ts`
- Turn item types in the timeline (from code): user/assistant message, reasoning, proposed plan,
  todo list, user-input request, file change, command execution, file search, web search, approval
  request, checkpoint, run interrupt request/result, system notice, error, compaction, handoff, fork,
  thread created, subagent, dynamic tool, secret request, link request, notification.
  `packages/contracts/src/orchestrationV2.ts`

### Persistence

- SQLite through Node's built-in `node:sqlite` wrapped as an Effect SQL client, with a reader worker
  and a checkpoint worker off the event loop. `packages/shared/src/nodeSqliteClient.ts`,
  `apps/server/src/persistence/Sqlite.ts`
- Pragmas: WAL, `synchronous=NORMAL`, `busy_timeout=5000` (CLI and server write from separate
  processes), `auto_vacuum=INCREMENTAL` for new DBs, `journal_size_limit` 32 MiB,
  `temp_store=MEMORY`. `apps/server/src/persistence/Sqlite.ts`
- Database file: `<T3 home>/userdata/statev2.sqlite`; V1 `state.sqlite` is copied once on first V2
  launch and imported lazily. `apps/server/src/config.ts`, `docs/internals/legacy-orchestration-migration.md`
- Migrations: 75 numbered files (`001_`…`075_`) plus an `OrchestrationV2/` set; the migrator fails
  hard on name clashes from id 55 up. `apps/server/src/persistence/Migrations/`,
  `apps/server/src/persistence/Migrations.ts`
- Table families (from code): `orchestration_v2_events`, `orchestration_v2_command_receipts`,
  `orchestration_v2_effect_outbox`, ~18 `orchestration_v2_projection_*` tables (threads, runs, run
  attempts, nodes, provider sessions/threads/turns, runtime requests, messages, plans, turn items,
  checkpoints, context handoffs/transfers, subagents), FTS5 `orchestration_v2_message_search`,
  `auth_sessions`, `auth_pairing_links`, `scheduled_tasks` + webhook delivery/replay/pending tables,
  `peer_environment_links`, `pull_request_files_viewed`, `pull_request_review_guides`,
  `mcp_app_model_context`, legacy V1 `projection_*` tables. `apps/server/src/persistence/Migrations/`
- Files beside the DB (from code): `settings.json` (server settings), `keybindings.json`, `themes/`,
  `secrets/` (one `0600` file per secret, dir `0700`), `attachments/`, `browser-artifacts/`,
  `logs/` (`server.trace.ndjson`, `provider/events.log`, `terminals/`), `environment-id`,
  `server-runtime.json`; worktrees default to `<T3 home>/worktrees`. `apps/server/src/config.ts`,
  `apps/server/src/auth/ServerSecretStore.ts`
- Offline maintenance: `t3 doctor [--fix|--dry-run]` inspects and repairs the data dir (VACUUM, auto-vacuum
  conversion); clients show reclaimable bytes via `server.getDatabaseStorage`. `apps/server/src/cli/doctor.ts`,
  `packages/contracts/src/settings.ts`, `docs/user/background-service.md`
- No whole-thread export API; recovery is a read-only copy of `userdata`. `docs/internals/legacy-orchestration-migration.md`

### Checkpoints

- Each turn ends with a checkpoint stored as a hidden git ref under
  `refs/t3/orchestration-v2/checkpoints`, never as commits on the user's branch; used for diffs and
  restore. Revert must coordinate with the provider conversation; providers that cannot roll back
  reject before touching files. `apps/server/src/orchestration-v2/CheckpointService.ts`, `docs/internals/overview.md`

### Agent process supervision and server restarts

- Provider CLIs run as subprocesses of the server; per-provider adapters speak their native
  protocol (Claude Agent SDK, Codex app-server, ACP, Cursor SDK, OpenCode server, Pi RPC).
  `AGENTS.md`, `docs/internals/providers.md`
- Agent processes do **not** survive a server exit by design (from code): Claude is spawned in its
  own process group with a watcher that kills the group on EOF from a pipe only the server holds,
  "including when the server crashes". `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`
- On Linux with systemd, agents and terminals are wrapped in transient `systemd-run --user` scopes;
  agents get `oom_score_adj` 800 so the kernel kills them before the server; terminal scopes use a
  slice that is not reaped as orphans ("Terminals may survive restarts; agents must remain eligible
  for orphan cleanup"). `packages/shared/src/AgentScope.ts`, `apps/server/src/process/agentScope.ts` (from code)
- `t3 service protect` (Linux) reserves memory and OOM protection for the server (and optionally
  Tailscale/SSH). `docs/user/background-service.md`, `apps/server/src/cloud/serviceProtection.ts`
- Recovery on restart: startup selects candidates (queued runs, pending requests, live sessions,
  background work, unfinished delegations) from projections, retires effects tied to lost processes,
  then, if **Continue threads after restarts** is on (default), resumes supported active threads
  with the prompt "Continue where you left off." (max 3 automatic resumes in a row within 5 minutes;
  not while awaiting approval/answer/secret, archived, snoozed or settled). Queued messages are kept
  and held. `apps/server/src/orchestration-v2/RestartContinuation.ts`,
  `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts`, `docs/user/updating.md`,
  `docs/user/composer.md`
- Idle provider sessions are detached/unloaded and resumed later via provider-native resume state.
  `apps/server/src/orchestration-v2/ProviderSessionManager.ts` (from code)

### Background work policy

- Clients send activity leases (`server.reportClientActivity`) for scopes such as a thread, a cwd's
  VCS status or provider status; the server runs polling work only for leased scopes and can pause it
  when the host is locked, on low power, on battery, or the client is on low power.
  `apps/server/src/background/BackgroundPolicy.ts`, `apps/server/src/background/HostPowerMonitor.ts`,
  `packages/contracts/src/background.ts` (from code)
- Profiles `performance` / `balanced` (default) / `battery-saver` / `custom` set git fetch interval
  (15 s / 30 s / off), provider health refresh (1 / 5 / 15 min) and pause rules.
  `packages/shared/src/backgroundActivitySettings.ts` (from code)
- A generic in-process `Scheduler` ticks every 5 s for registered due-work sources: scheduled
  tasks, webhook coalescing, usage-limit recovery. `apps/server/src/scheduling/Scheduler.ts` (from code)

### Settings ownership

- Client preferences stay on the client (`ClientSettingsSchema`); environment defaults live in the
  server's `settings.json`; project overrides live on the owning server
  (`projectSettingsOverrides`); repo-declared defaults in a project's `t3.json`. Resolution order:
  project override → environment setting → `t3.json` → built-in default. "All environments" is a
  bulk edit of connected servers, not a global default. `docs/internals/overview.md`,
  `docs/user/project-settings.md`, `packages/contracts/src/settings.ts`, `packages/contracts/src/t3ProjectFile.ts`

### Observability

- Local trace file `logs/server.trace.ndjson` (async, rotated); `t3 trace summary` summarises span
  counts/latency. Optional OTLP export of traces/metrics/logs to a user endpoint (settings or env),
  and a renderer → server OTLP proxy route. `apps/server/src/config.ts`, `apps/server/src/cli/trace.ts`,
  `docs/user/telemetry.md`, `apps/server/src/http.ts`
- Process/resource telemetry from the Rust monitor child, sampled only while diagnostics has live
  subscribers. `docs/internals/resource-telemetry.md`
- Product analytics to `ingest.t3.codes` → PostHog (no prompts/content); relay traces to Axiom;
  opt-out `T3CODE_TELEMETRY_ENABLED=false`. Each RPC call can record an anonymous feature-usage
  signal. `docs/user/telemetry.md`, `apps/server/src/ws.ts`

### Performance work

- Pinned by `vp run test:perf:v2-wire`: cold opens/history pages capped ~1 MiB of encoded rows
  (10 user turns or 500 rows per window), resume catch-up ≤128 events / 1 MiB before falling back
  to a snapshot, raw command output and tool result bodies omitted at the wire, live command output
  only through `orchestration.subscribeCommandOutput` (bounded tail via `CommandOutputHub`), shell
  resume sends deltas. `docs/internals/performance-regressions.md`, `package.json`
- A transfer-budget integration test caps decoded bytes/rows for a 900-row turn and a cold-connect
  sidebar. `apps/server/integration/transferBudgetV2.integration.test.ts`
- Assistant text streams by paragraph/code block (default) or only at turn end, never per token
  (`responseStreamingMode`). `packages/contracts/src/settings.ts`, `apps/web/src/components/settings/SettingsPanels.tsx` (from code)
- Event-store queries seek indexes; startup recovery avoids loading completed history; trace and
  provider-log writes are async so slow disks don't stall the event loop. `docs/internals/performance-regressions.md`
- UI rules: no continuously repainting animations; mobile looping animations must use native-driver
  `Animated`. `AGENTS.md`, `docs/internals/performance-regressions.md`
- `report:renders` script measures React render counts. `package.json`

### Security model (summary)

- Environment-issued scoped sessions; scopes: `orchestration:read|operate`, `settings:write`,
  `providers:manage`, `environment:maintain`, `preview:operate`, `diagnostics:read`,
  `terminal:read|operate`, `filesystem:read|write`, `source-control:write`, `access:read|write`,
  `relay:read|write`. `packages/contracts/src/auth.ts`
- Pairing delegates scopes and can only narrow; browser cookies, bearer and DPoP tokens all map to
  the same session model. `docs/internals/environment-auth.md`
- Guest-link tokens are HMACs and never become sessions; MCP clients use OAuth with user approval.
  `docs/internals/environment-auth.md`, `apps/server/src/auth/McpOAuth.ts`
- T3 Connect relay brokers bootstrap credentials bound to the client's DPoP key; it does not proxy
  normal traffic (Cloudflare tunnel via `cloudflared`), except webhook forwarding. `docs/internals/t3-connect.md`

## 6. Testing strategy

- Unit/integration tests with Vitest via `vp test`; `@effect/vitest` `it.effect` runs on a
  `TestClock`, `it.live` only for subprocess/network fixtures. `docs/internals/testing.md`
- Hard rules, enforced by custom lint rules: no sleeps, polling loops, wall-clock deltas, per-test
  timeouts or retries; wait by draining the effect worker (`OrchestrationEffectWorkerV2.drain`) or
  awaiting persisted events/`Deferred`s; skips need a tracking issue. `docs/internals/testing.md`,
  `oxlint-plugin-t3code/`
- Orchestration is tested with replay-backed integration tests: real orchestrator, adapter,
  normalizer, event store and projections; only the provider transport is replayed. Recording scripts
  exist per provider (`record:codex-replay`, `record:claude-replay`, cursor, pi, grok, fx, muse).
  `docs/orchestration-v2/testing-strategy.md`, `apps/server/package.json`, `packages/provider-testing`
- A free `Replay (dev)` provider replays turns in dev so UI work doesn't spend tokens. `AGENTS.md`
- Web browser tests (`*.browser.test.tsx`) run in Chromium via Playwright with disposable renders.
  `apps/web/vite.config.ts`, `docs/internals/testing.md`
- Mobile: `mobile:behavior`, `mobile:e2e`, native static checks, fingerprint checks in CI.
  `package.json`, `.github/workflows/mobile-fingerprint-check.yml`
- Release smoke tests open packaged AppImage/DMG against an old seeded DB and run every CLI archive.
  `docs/operations/release.md`
- Evals score model behaviour on MCP tool descriptions and generated titles (not run in CI).
  `evals/README.md`
- CI: `ci.yml`, `windows-tests.yml`, `agent-context-budget.yml` (checks the size of agent-facing
  context, `apps/server/src/provider/agentContextBudget.json`), `pr-size.yml`, `pr-vouch.yml`.
  `vp run check:changed` runs the fast subset locally. `.github/workflows/`, `AGENTS.md`

## 7. Capability surface: the client ↔ server API

Counts (from code): 187 methods in `WS_METHODS` plus 19 `ORCHESTRATION_V2_WS_METHODS` = 206
WebSocket RPC methods; 55 client-dispatchable orchestration command types (plus 14 server-only); 68 MCP tools; 38
`EnvironmentHttpApi` endpoints plus raw routes. Sources: `packages/contracts/src/rpc.ts`,
`packages/contracts/src/orchestrationV2.ts`, `packages/contracts/src/environmentHttp.ts`,
`apps/server/src/mcp/toolkits/*/tools.ts`.

### 7.1 Orchestration (threads, runs, history)

- `orchestration.dispatchCommand` – single entry point for all thread mutations (command list in 7.2).
- `orchestration.launchThread` – create and start a thread (workspace strategy: root, existing
  worktree, new worktree).
- Streams: `orchestration.subscribeShell` (sidebar), `orchestration.subscribeThread` (detail),
  `orchestration.subscribeCommandOutput` (live output of one expanded command).
- Reads: `getThreadProjection`, `getTurnItem`, `getTurnDiff`, `getFullThreadDiff`,
  `getArchivedShellSnapshot`, `getThreadFamily`, `getWorktreeThreadIds`, `getOlderSettledThreads`.
- Search: `searchThreads` (across threads), `searchThread` and `searchThreadStream` (find in thread).
- Control: `forceStopThread` (outcomes `killed`/`released`/`releasing`/`shared`), `stopWorkflow` and
  `getWorkflowScript` (Claude subagent "workflow" runs with phases and agents).
  `apps/server/src/orchestration-v2/Adapters/claudeWorkflowProgress.ts` (from code)

### 7.2 Orchestration commands (`OrchestrationV2Command` union)

- Thread lifecycle: `thread.create`, `thread.stop`, `thread.archive`/`unarchive`, `thread.delete`,
  `thread.settle`/`unsettle`/`auto-settle`/`auto-settle.set`, `thread.snooze`/`unsnooze`,
  `thread.pin`/`unpin`/`pin.reorder`, `thread.active.reorder`, `thread.visit`,
  `thread.mark-unread`, `thread.metadata.update`, `thread.title.regeneration.complete`.
- Thread configuration: `thread.runtime-mode.set`, `thread.interaction-mode.set`,
  `thread.model-selection.set`, `provider.switch`, `provider-session.detach`.
- Messaging: `message.dispatch` with dispatch modes `start_immediately`, `queue_after_active`,
  `steer_active`, `restart_active`, `defer_start`; carries attachments, context records, model
  selection, plan reference, continuation markers (restart, usage-limit, manual).
- Queue: `queued-run.start`/`reorder`/`cancel`/`edit`, `queued-message.promote-to-steer`,
  `queue.resume`; prepared runs: `prepared-run.release`/`progress`/`fail`/`retry`.
- Control and requests: `run.interrupt`, `subagent.stop`, `runtime-request.respond` (approvals,
  questions), `thread.user-input.dismiss`, `notification.delivery.accept`.
- History: `checkpoint.rollback`, `thread.fork`, `thread.merge_back`.
- Pull requests: `thread.pull-request.link`/`unlink`/`watch`/`sync`, `thread.pull-request-link.sync`.
- Delegation: `delegated_task.request`, `delegated_task.wake-policy`,
  `delegated_task.completion-delivery.acknowledge`/`dispose`, `thread.created.record`.
- Guest links: `thread.guest-share.close`, `thread.guest-message.dismiss`.
- Server-only (not accepted from clients): `thread.guest-share.open|redeem`,
  `thread.guest-message.submit`, `thread.project.adopt-folder`, `thread.pull-request-watch.sync`,
  `delegated_task.remote.request|complete|stop`, `checkpoint.rollback.fail`,
  `runtime-request.delivery.fail`, `thread.interrupt.unresponsive`,
  `thread.background-work.settle`, `secret_request.record`, `link_request.record`.
  `packages/contracts/src/orchestrationV2.ts`

### 7.3 Projects, files and filesystem

- `projects.listEntries`, `listIgnoredFiles`, `readFile`, `writeFile` (used e.g. to save a proposed
  plan to a file, `apps/web/src/components/chat/ProposedPlanCard.tsx`), `searchEntries`,
  `searchContents`, `mutate` (`project.create|update|delete`), `ensureScratch`, `createNew` (new
  folder project), `createFromThread` (turn a project-less thread into a project).
- `filesystem.browse`, `filesystem.getMetadata` (server-side folder picker for remote clients).
- `shell.openInEditor` (open path in an editor on the host; `availableEditors`/`remoteOpenTargets`
  in server config).
- `agentSessions.scan` / `agentSessions.import` – find and import existing Claude/Codex/Pi sessions
  (welcome wizard). `docs/user/welcome-wizard.md`

### 7.4 Assets, attachments, MCP apps

- `assets.createUrl`, `assets.persistChatAttachments`, `attachments.createUploadUrl`,
  `attachments.delete` (uploads go over HTTP, not the socket).
- `mcpApps.callTool`, `toolInfo`, `readResource`, `updateModelContext` – host side of the MCP Apps
  standard for interactive tool results. `docs/user/html-renders.md`

### 7.5 Providers (one line each; see providers note)

- Status/config: `server.refreshProviders`, `server.updateProvider` (update a provider CLI).
- Sign-in: `provider.auth.start|complete|respond|cancel|logout|subscribe`; ChatGPT handoff for
  Codex: `provider.chatgpt.reconnect-profile|import-profile|handoff.subscribe`.
- Install: `provider.install.start|cancel|subscribe|remove` (managed runtimes, e.g. Antigravity).
- ACP registry: `server.searchAcpRegistry`, `prepareAcpRegistryAgent`,
  `uninstallAcpRegistryManagedBinary`, `acceptAcpRegistryUrlAuth`, `list|import|deleteAcpRegistrySession(s)`,
  `list|set|disableAcpRegistryProvider(s)`, `logoutAcpRegistry`.
- `provider.uploadFeedback` (Codex feedback to OpenAI), `provider.consumeResetCredit` (spend a
  usage-limit reset credit).

### 7.6 VCS, git and review (see source-control note)

- `vcs.pull`, `refreshStatus`, `listRefs`, `createWorktree`, `removeWorktree`, `createRef`,
  `switchRef`, `init`; streams `subscribeVcsStatus`, `subscribeWorktreeSetup`
  (+ `worktreeSetup.cancel`).
- `git.runStackedAction` (`commit`, `push`, `create_pr`, `commit_push`, `commit_push_pr`),
  `git.resolvePullRequest`, `git.preparePullRequestThread`.
- `review.getBranchCommits`, `getDiffPreview`, `getDiffFileContents`.

### 7.7 Pull requests (29 methods) and source control

- Read: `pullRequests.list`, `listStats`, `filterOptions`, `summary`, `routing`,
  `routingIdentity`, `stack`, `linkedThreads`, `detail`, `preview`, `checks`, `activity`,
  `threadComments`, `diffFileContents`, `filesViewed`, `changeBreakdown`, `reviewGuide`,
  `reviewerCandidates`, `labelCandidates`, `subscribeRefreshes`.
- Write: `runAction` (`merge`, `ready`, `draft`, `close`, `reopen`, `delete-branch`,
  `update-branch`, `enable-/disable-auto-merge`, `revert`, `approve-workflows`), `update`, `comment`,
  `updateComment`, `submitReview`, `replyToThread`, `setThreadResolution`, `setReaction`,
  `setFilesViewed`, `requestReviewers`, `setLabels`, `generateReviewGuide`, `invalidate`,
  `reportState`. `packages/contracts/src/pullRequest.ts`
- Source control: `sourceControl.lookupRepository`, `cloneRepository`, `publishRepository`,
  `signInStart|Wait|Cancel`, `appAccess`; `server.discoverSourceControl`; project clones:
  `projectClone.start|cancel|retry`, `subscribeProjectClones`.

### 7.8 Terminal, preview browser, devices (see other notes)

- Terminal: `terminal.open|attach|observe|write|resize|clear|close`, `subscribeTerminalMetadata`.
- Preview: `preview.open|resize|adjust|close|list|clearProfile|reportProfiles|reportStatus|stopLocalServer`,
  `subscribePreviewEvents`, `subscribeDiscoveredLocalServers`.
- Devices (iOS Simulator / Android Emulator): `device.configure|list|testHost|easAccount|simlockIdentity|open|close|shutdown|detail|action`,
  `subscribeDeviceState`.

### 7.9 Server config, maintenance and diagnostics

- Config: `server.probe`, `server.getConfig`, `subscribeServerConfig`, `subscribeServerLifecycle`,
  `server.updateSettings`, `server.upsertKeybinding`, `server.removeKeybinding`.
- Updates: `server.updateServer`, `server.updateServerWithProgress`, `server.commitDesktopUpdate`.
- Storage: `server.runStorageCleanup`, `getStorageCleanupReport`, `getDatabaseStorage`.
- Diagnostics: `server.getTraceDiagnostics`, `getProcessDiagnostics` (process tree with CPU/RSS),
  `signalProcess` (`SIGINT`/`SIGKILL` a listed process), `getHostResources`,
  `getProcessResourceHistory`, `getResourceTelemetryHistory`, `retryResourceTelemetry`,
  `subscribeResourceTelemetry`, `checkOtlpEndpoint`. `packages/contracts/src/server.ts`
- Triage: `server.prepareTriage` (writes a triage playbook and clones T3 Code source for an agent).
- Usage: `server.getUsageSummary`, `server.refreshUsageRates`.
- Client activity: `server.reportClientActivity` (background leases; see section 5, Background work policy).
- Auth/access: `subscribeAuthAccess` (live list of paired clients/sessions).

### 7.10 Automation, secrets, sharing, linking, cloud

- Scheduled tasks: `scheduledTasks.subscribe|upsert|setEnabled|delete|runNow|rotateWebhookToken|listWebhookDeliveries|getWebhookDelivery`.
  Schedules: `interval` (min 60 s), `fixed_time` (HH:MM + optional weekdays, environment time
  zone), `webhook` (signed or unsigned, filters, replay key, coalesce window). Each task targets a
  project, optionally an existing thread, with model, runtime and interaction mode.
  `packages/contracts/src/scheduledTask.ts`
- Secrets: `secrets.answerRequest` (save or decline a secret an agent asked for).
  `packages/contracts/src/secretRequest.ts`
- Guest links: `guestShare.create`. Peer links (linked environments, beta):
  `peerLinks.list|link|unlink|answerRequest`.
- T3 Connect: `cloud.getRelayClientStatus`, `cloud.installRelayClient` (install the tunnel client
  with progress stages; T3 Connect tunnels run `cloudflared`, `apps/server/src/cloud/ManagedEndpointRuntime.ts`). `packages/contracts/src/relayClient.ts`

### 7.11 HTTP API and raw routes

- `GET /.well-known/t3/environment` (environment descriptor).
- Auth: `GET /api/auth/session`, `POST /api/auth/browser-session`, `POST /oauth/token`,
  `POST /api/auth/websocket-ticket[/:use]`, `POST /api/auth/pairing-token`,
  `POST /api/auth/pairing-links/revoke`, `POST /api/auth/clients/revoke`, `.../revoke-others`.
- MCP OAuth: `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server`,
  `/oauth/mcp/register|authorize|approval|decision|token`.
- Orchestration reads: `GET /api/orchestration/shell`, `/threads/:id`, `/threads/:id/transcript`,
  `/threads/:id/bounded`, `/threads/:id/history`.
- Projects: `GET /api/projects`, `POST /api/projects/mutate`; PRs: `POST /api/pull-requests/diff`.
- T3 Connect: `/api/connect/link-proof|relay-config|link-state|reachability|unlink|preferences`,
  `/api/t3-connect/health|mint-credential`.
- Webhooks: `GET|POST|PUT|PATCH /api/hooks/:hookId/:token`.
- Raw: assets (`GET`), attachment upload (`POST`), OTLP traces proxy, guest routes under
  `/api/guest/*` (redeem, messages, stream, session, render, item, history, command-output,
  attachment, media), `/api/preview-stream/*`, `/api/device-hub/*`, `/mcp`, `/ws`, static web app.
  `packages/contracts/src/environmentHttp.ts`, `packages/contracts/src/guestShare.ts`, `apps/server/src/server.ts`

### 7.12 GraphQL

- There is no GraphQL API between client and server. `apps/server/graphql.config.ts` generates a
  typed client for Expo's `api.expo.dev` schema (`apps/server/schema/expo.graphql`) used by the EAS
  Simulator device host (`apps/server/src/device/ExpoApi.graphql`); the comment notes these
  operations are undocumented by Expo.

### 7.13 MCP server tools (68, for agents in and outside T3 Code)

- Orchestrator: `orchestrator_capabilities`, `delegate_task`, `task_status`, `task_cancel`,
  `t3_workflow_stop`, `t3_background_wait`, `schedule_task`, `list_scheduled_tasks`,
  `delete_scheduled_task`, `request_secret`, `create_threads`, `t3_thread_list|read|update|send|wait|interrupt`,
  `t3_environment_links|link|unlink`.
- Thread: `t3_thread_organize`, `t3_queue`, `t3_pending_request`, `t3_thread_configure`,
  `t3_thread_transfer` (fork / merge_back / status), `t3_thread_search`, `run_scheduled_task_now`.
- Project: `t3_project_list|read|create|update|delete|clone`, `t3_thread_launch`.
- Worktree: `t3_worktree_handoff|status|list`. Attachments: `t3_attachment_prepare_upload|discard`,
  `t3_thread_send_attachments`. Environment: `t3_environment_read`,
  `t3_environment_preferences_update`.
- PRs: `link_pull_request`, `unlink_pull_request`, `list_thread_pull_requests`,
  `watch_pull_request`, `unwatch_pull_request`, `write_pull_request_guides`, `read_pull_request_guide`.
- Preview browser: `preview_status|open|dialog|navigate|resize|set_appearance|snapshot|act|evaluate|wait_for|recording_start|recording_stop`,
  `t3_preview_list|close`. HTML: `html_preview`, `html_render`. Devices:
  `device_list|open|screenshot|close`. `apps/server/src/mcp/toolkits/*/tools.ts`
- The same endpoint is offered to outside agents (Claude Code, Codex, ChatGPT) via OAuth, and to ACP
  agents through `t3 acp-mcp-bridge`. `docs/user/outside-agents.md`, `apps/server/src/cli/acpMcpBridge.ts`

### 7.14 Desktop IPC bridge (`DesktopBridge`, Electron only)

- Local environment bootstrap/bearer token, client-settings persistence, connection catalog.
- SSH environments: discover hosts from `~/.ssh/config`/known_hosts, ensure/disconnect, password
  prompts. Server exposure (`local-only`/`network-accessible`), Tailscale Serve toggle, advertised
  endpoints. WSL backend/distro selection (Windows).
- SnapShot screen capture (permissions, shortcut, pending captures). Folder/theme/favicon pickers,
  context menus, notification badge, system settings deep links, provider OAuth callback capture.
- Updates: channel (`latest`/`nightly`), check/download/install; install/uninstall the `t3` CLI;
  web-link and app-activation handoff.
- `DesktopPreviewBridge`: in-app browser tabs (navigate, zoom, colour scheme, devtools, cookies,
  browser-cookie import, element picker/annotations, screenshot, screen recording,
  picture-in-picture). `packages/contracts/src/ipc.ts`

### 7.15 CLI (`t3`)

- Server: `t3` (start the server and open the local web app), `t3 start` ("Run the T3 Code server."),
  `t3 serve` (headless, prints pairing details),
  `t3 app [dir]` (open in running desktop app). `apps/server/src/cli/server.ts`, `apps/server/src/cli/app.ts`
- Access: `t3 pair` (QR pairing token), `t3 auth pairing create|list|revoke`,
  `t3 auth session issue|list|revoke`, `t3 connect login|link|status|publish|unlink|logout`,
  `t3 environment link|list|unlink`. `apps/server/src/cli/{pair,auth,connect,environment}.ts`
- Work: `t3 project add|remove|rename`, `t3 thread list|start|send|show`. `apps/server/src/cli/{project,thread}.ts`
- Ops: `t3 service install|update|restart|uninstall|status|protect`, `t3 update`, `t3 uninstall`,
  `t3 doctor`, `t3 triage`, `t3 trace summary`, `t3 theme set|clear|show`, `t3 browser setup`.
  `apps/server/src/cli/*.ts`

## 8. Server settings (`ServerSettings` in `packages/contracts/src/settings.ts`)

The task brief's `serverSettings.ts` is the server-side store (`apps/server/src/serverSettings.ts`);
the schema is in `packages/contracts/src/settings.ts`. Stored in `userdata/settings.json` with
defaults stripped; secret fields are kept in the secret store (`apps/server/src/settingsSecrets.ts`).
Keys marked **[P]** can be overridden per project (`PROJECT_SCOPED_SERVER_SETTING_KEYS`).

### Models and agents

- `defaultModelSelection` **[P]** – model (provider instance + model + options) for new threads; null = none set.
- `fallbackModelSelection` – "Used for new threads when the default model's provider is out of usage." (UI text, `apps/web/src/components/settings/ProjectDefaultsSettings.tsx`)
- `defaultRuntimeMode` **[P]** – permission mode for new threads (default `full-access`).
- `favorites`, `providerModelPreferences` – favourite models; per-instance hidden models and order.
- `providerInstances` – configured provider instances (driver, display name, accent colour, env, enabled, driver config).
- `textGenerationModelSelection` **[P]** – model for app-owned text (titles, branch names); default Codex `gpt-6-luna`, effort `low`.
- `threadTitleInstructions` **[P]** – extra instructions for generated thread titles.
- `enableProviderUpdateChecks` – check for provider CLI updates (default on).
- `providerHealthRefreshInterval` – provider status poll interval (default 5 min).
- `compactIdleThreads` (legacy boolean) / `idleCompaction` – idle-thread compaction: `onReturn` (default), `beforeCacheExpires` (beta), `off`.
- `responseStreamingMode` **[P]** – `paragraph` (default) or `turn`.
- `continueThreadsAfterServerUpdate` **[P]** – resume active threads after a restart (default on).
- `snoozeLimitedThreads` / `autoResumeLimitedThreads` – snooze until, or auto-resume at, a usage-limit reset (default off).

### Workspace and worktrees

- `defaultThreadEnvMode` **[P]** – `local` or `worktree` for new threads (null inherits `t3.json`, then local).
- `newWorktreesStartFromOrigin` **[P]** – branch new worktrees from the remote (default on).
- `worktreeSubmodules` **[P]** – `recursive` / `top-level` / `none` (null inherits `t3.json`, then recursive).
- `worktreesDirectory`, `previousWorktreesDirectories` – where worktrees go; old locations stay eligible for cleanup and diffs.
- `worktreeCleanup` **[P]** – `off` or custom rules (keep-when, after N days, after settle, on merge, on delete, unchanged).
- `storageCleanup` – environment cleanup rules for worktrees, browser artifacts and logs (retention days).
- `addProjectBaseDirectory` – starting folder for "Add project".
- `defaultAutoPull` **[P]**, `projectAutoPullOverrides` – keep the default branch current by pulling.
- `automaticGitFetchInterval` – background `git fetch` interval (default 30 s).
- `defaultProjectScripts` **[P]**, `projectScriptOverrides` – project action scripts (name, command, icon, run on worktree create / on settle, async, preview URL).
- `projectSettingsOverrides`, `projectSettingsFolded` – per-project overrides and a one-time migration flag.

### Source control and review

- `branchNamingMode` **[P]** (`static`/`semantic`/`custom`), `branchNamePrefix` **[P]** (default `t3`), `branchNameInstructions` **[P]**.
- `sourceControlWritingStyle` **[P]** – commit/PR text style (`repo_conventions`, `conventional_commits`, `custom` + instructions, follow PR templates).
- `sourceControlWriterModelSelection` **[P]** – model for commit messages and PR descriptions.
- `removeAgentCreditsOnMerge` **[P]** – strip agent co-author lines from merge/squash commits.
- `pullRequestMergeMethod` **[P]** – `merge`/`squash`/`rebase`.
- `reviewGuidesEnabled`, `reviewGuideModelSelection` **[P]**, `reviewGuideInstructions` **[P]** – AI review guides for PRs (beta).
- `sourceControlHosts` – per-forge host settings (tokens in secret store).

### Thread lifecycle (sidebar)

- `sidebarAutoSettleAfterDays` **[P]** – auto-settle after 1–90 idle days (default 3; null off).
- `sidebarAutoSettleOnMerge` **[P]** – settle when the linked PR merges (default on).
- `sidebarAutoSettleKeepPullRequests` **[P]** – keep threads with open PRs out of auto-settle.
- `snoozePresets` – up to 8 snooze menu entries (default 1 h, 3 h, today 18:00, tomorrow 09:00, Monday 09:00).

### Browser, devices, sharing, linking

- `enableAgentBrowserAccess` **[P]**, `projectAgentBrowserAccessOverrides` – whether agents may drive the preview browser.
- `enableDeviceSupport`, `enableAgentDeviceAccess` **[P]**, `deviceOnboardingCompleted`, `deviceHosts` (SSH), `easDeviceHosts` (Expo EAS Simulator), `simlockDeviceHosts` + `simlockDeviceHostsEnabled` (alpha).
- `guestSharingEnabled` – guest links (beta, default off).
- `linkedEnvironmentsEnabled` – links to the user's other machines (beta, default off).

### Appearance and identity

- `defaultTheme`, `defaultThemeSetAt` – environment default theme pushed to clients.
- `environmentIcon` – machine kind icon (`server`, `cloud`, `linux`, …) overriding the detected one.

### Background, observability, usage, secrets

- `backgroundActivity` (profile + overrides) and `backgroundActivityProfile` – see section 5, Background work policy.
- `observability` – OTLP URLs for traces, metrics and logs.
- `usageLimitSources` – CLIProxyAPI hubs (URL, management key) for pooled limits.
- `usagePriceOverrides`, `usageModelAliases` – custom per-model prices and model-name aliases for usage cost.
- `cursorKeychainUsageEnabled` – read Cursor usage via the OS keychain (default off).
- `secretProviders` – external secret providers (built-in kind: 1Password).

Client-only settings (`ClientSettingsSchema`, not on the server) cover notifications, diff layout,
fonts/sizes, glass/contrast, browser defaults and profiles, confirmations, sidebar grouping/sorting,
load balancing across machines, plan mode, context meter, rich-text composer, send shortcut,
SnapShot, math rendering, word wrap. `packages/contracts/src/settings.ts`

## 9. Gap sweep: user-facing behaviour with little or no coverage in `docs/user/`

Checked by grepping `docs/user/*.md` for each feature. Items fully documented (triage, storage
cleanup, MCP apps, visual replies, usage/CLIProxyAPI, guest links, devices, webhooks, welcome-wizard
import, idle compaction, usage-limit resume) are not repeated here.

- **Background activity profiles and power-aware pausing** – `performance`/`balanced`/`battery-saver`/custom,
  pause when host locked, low power or on battery; git fetch and provider health intervals.
  No user doc mentions them. `apps/server/src/background/`, `packages/shared/src/backgroundActivitySettings.ts` (from code)
- **Response streaming mode** – paragraph vs whole-turn rendering; settings UI only.
  `apps/web/src/components/settings/SettingsPanels.tsx` (from code)
- **Fallback model** – model used when the default provider is out of usage; settings UI only.
  `apps/web/src/components/settings/ProjectDefaultsSettings.tsx` (from code)
- **Merge-back of forks** – bring a fork's work back into its source thread as a context transfer
  (`thread.merge_back`, `t3_thread_transfer action: merge_back`); exposed in web
  `ThreadRelationshipsControl.tsx` and mobile thread header/git controls. Design in
  `docs/orchestration-v2/feature-lifecycles.md`; nothing in `docs/user/`. (from code)
- **Agent secret requests and secret providers** – agents call `request_secret` to show a private
  card; the value is stored server-side and the agent gets a one-use `secretRef` or a private file
  path; Settings has a Secrets page with a 1Password provider. User docs only mention "waits for
  your secret" in passing. `packages/contracts/src/secretRequest.ts`,
  `apps/server/src/mcp/toolkits/orchestrator/tools.ts`, `apps/web/src/components/settings/SecretsSettings.tsx`,
  `packages/secret-provider-onepassword/` (from code)
- **Process diagnostics and kill** – Settings → Diagnostics lists the server's process tree with
  CPU/RSS, resource history and trace span summaries, and can send `SIGINT`/`SIGKILL` to a process.
  User docs mention the Diagnostics page only for crash reports and OTLP export.
  `packages/contracts/src/server.ts`, `apps/web/src/components/settings/DiagnosticsSettings.tsx` (from code)
- **Force stop** – `orchestration.forceStopThread` kills a thread's agent processes when Stop is
  ignored (refuses if a newer run started; reports when the process is shared with other threads).
  No user doc. `apps/web/src/components/chat/useForceStopThread.ts` (from code)
- **Claude workflow runs** – subagent "workflows" with phases and per-agent state, a script viewer
  (`getWorkflowScript`) and stop (`stopWorkflow`, MCP `t3_workflow_stop`). No user doc.
  `packages/contracts/src/orchestrationV2.ts`, `apps/server/src/orchestration-v2/Adapters/claudeWorkflowProgress.ts` (from code)
- **Scheduled tasks outside mobile/webhooks** – interval and fixed-time schedules, per-task model and
  permission mode, posting into an existing thread or a new thread each run, MCP tools
  `schedule_task`/`list_scheduled_tasks`/`delete_scheduled_task`/`run_scheduled_task_now`. The user
  doc section is titled "Scheduled tasks on mobile" plus "Webhook automations".
  `docs/user/project-settings.md`, `packages/contracts/src/scheduledTask.ts`
- **CLI commands with no user doc**: `t3 project add|remove|rename`, `t3 trace summary`; `t3 thread
  ...` appears only in the outside-agents and ACP pages. `apps/server/src/cli/project.ts`,
  `apps/server/src/cli/trace.ts`
- **Single-server lock** – a second server on the same T3 home exits; message tells the user to use
  a separate T3 home and pair. Not in user docs. `apps/server/src/serverOwnership.ts` (from code)
- **Login-shell PATH hydration** – the server copies `PATH` from the login shell (or `launchctl` on
  macOS); FAQ only says "not on the PATH". `apps/server/src/os-jank.ts` (from code)
- **Desktop backend self-shutdown** when its launcher dies (orphan prevention). `apps/server/src/launcherWatch.ts` (from code)
- **Thread housekeeping commands** – mark unread, manual reorder of active threads; only partly
  visible in docs (`thread-sidebar.md` covers pins). `packages/contracts/src/orchestrationV2.ts` (from code)
- **Environment icon** – choose the machine icon shown for an environment; not documented.
  `packages/contracts/src/settings.ts` (from code)
- **Agent-to-thread notifications** – messages can carry a `notification` (completed/failed/…)
  and `senderThreadId`, used for delegated-task completion and thread-to-thread sends; covered only
  indirectly via the activity-log page. `packages/contracts/src/orchestrationV2.ts`, `docs/user/activity-log.md` (from code)

One-line pointers to areas owned by other notes: T3 Connect relay and Live Activities
(`infra/relay`, `apps/server/src/relay/AgentAwarenessRelay.ts`); peer links / remote delegation
(`apps/server/src/peer/`); preview browser and HTML render headless Chrome (`apps/server/src/preview/`,
`apps/server/src/htmlRender/`); usage cost scanning of provider transcripts (`apps/server/src/usage/`);
text generation for titles, branch names, commits, PR text and review guides
(`apps/server/src/textGeneration/`, `apps/server/src/pullRequest/`); triage (`apps/server/src/triage/`,
documented in `docs/user/triage.md`); attachment store with pending-upload sweep on startup
(`apps/server/src/attachmentStore.ts`, `apps/server/src/config.ts`).
