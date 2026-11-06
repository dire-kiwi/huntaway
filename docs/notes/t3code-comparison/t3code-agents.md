# T3 Code: agents, providers and orchestration

Part of the T3 Code inventory: [t3code-overview.md](t3code-overview.md) has the summary and links the other areas.

Feature inventory of how T3 Code runs and talks to coding agents. Source: shallow clone of
`pingdotgg/t3code` at commit 9b1d351 (2026-10-30, latest release v0.1.5). Paths are relative to the
repository root. "(from code)" marks facts read from source rather than docs; "(design doc)" marks
statements from `docs/orchestration-v2/`, which describes the *target* architecture and is not
always a description of shipped behaviour.

Vocabulary used below (from `docs/internals/glossary.md`): an **environment** is one running T3 server
and its machine; a **thread** is a durable conversation; a **run** is one user-visible turn; a
**driver** is a provider integration (e.g. `codex`); a **provider instance** is one configured
account/configuration of a driver; **runtime mode** = permission mode; **interaction mode** =
default/plan.

## 1. Overall shape

- **Agents run on the server, never on the client.** Web, desktop (Electron) and mobile clients
  drive an environment over authenticated RPC; provider processes, terminals, git and files belong
  to the server. Provider install, login and config are per environment machine, even when you
  connect from a phone. `docs/internals/overview.md`, `docs/user/install.md#providers`
- **Driver vs instance.** Work is routed by provider instance so two accounts on the same driver
  never share session or catalog state. `docs/internals/providers.md`
- **Ten built-in drivers** registered in `apps/server/src/provider/builtInDrivers.ts`: Codex, Claude,
  Cursor, Grok, fx, OpenCode, Antigravity, Pi, Muse, and the generic ACP Registry driver. Usage
  readers exist for all but fx and the ACP Registry (from code).
- **One adapter contract.** Each driver implements `ProviderAdapterV2`
  (`packages/provider-core/src/server/ProviderAdapter.ts`) and reports a capability object; the
  orchestrator reads capabilities, never the driver name. ACP agents are "flavors" of one shared ACP
  adapter (`packages/provider-acp/src/server/adapter.ts`). `docs/internals/adding-a-provider.md`
- **Provider packages.** Newer drivers live in `packages/provider-<name>` (Pi is the reference
  layout: `./settings`, `./client`, `./server`, `./testing` exports); Codex, Claude and Antigravity
  still live in `apps/server/src/provider/Drivers`. Protocol clients are separate packages:
  `packages/effect-codex-app-server` (Codex app-server JSON-RPC) and `packages/effect-acp` (ACP).
- **New providers are off by default**; settings live in `providerInstances` in the server's
  `settings.json`. `docs/internals/adding-a-provider.md`

## 2. Supported providers (harnesses)

### Summary

| Provider | How T3 connects (from code unless noted) | Auth | Permission modes offered | Plan mode | Native rollback / fork |
| --- | --- | --- | --- | --- | --- |
| Codex | `codex app-server` JSON-RPC over stdio | ChatGPT sign-in via T3 (managed runtime) or existing `codex login` | all four | yes (proposed plan) | yes / yes (`thread/fork`) |
| Claude | `@anthropic-ai/claude-agent-sdk` `query()` driving the installed `claude` binary | `claude auth login` per `CLAUDE_CONFIG_DIR` | all four | yes (`plan` permission mode) | yes / yes (`forkSession`, `resumeSessionAt`) |
| Cursor | `@cursor/sdk` local-agent runtime (not ACP) | browser sign-in from T3 or `CURSOR_API_KEY`; paid plan | all four (sandbox-based) | emits plans | no / no (portable handoff) |
| Grok Build | ACP: `grok agent stdio` | `grok login` or `XAI_API_KEY` | Supervised, Auto, Full access | no proposed-plan card (ACP base, from code) | no native fork; files-only rollback |
| OpenCode (1.x / 2.x) | `opencode` HTTP server (local per thread on 1.x, per instance on 2.x) or external server URL | `opencode auth login`; server password | all four, Auto behaves as Supervised | OpenCode `plan` agent | yes / yes |
| Antigravity | Google's ACP agent, T3-managed runtime | Google account, Gemini Enterprise, Gemini API key, Vertex AI | asks in Auto (no reviewer) | no (use native `/plan`) | no rewind |
| Pi | `pi --mode rpc` plus a T3 extension | Pi's own `/login` | Supervised, Auto-accept edits, Full access | no | yes / yes (Pi session files) |
| Muse Code (Meta) | `muse serve` (MSP protocol) | `muse login` or `META_API_KEY` | Supervised, Full access | no | no / no |
| fx (Vercel Labs) | ACP: `fx acp` | `fx login` (shared per machine) | Supervised, Auto | no | n/a |
| ACP Registry / local ACP | generic ACP v2 preview, negotiates v1 | agent's own (browser, terminal, env API key) | answered by T3 per mode | follows Plan/Build toggle if agent has modes | conversation rewind no (fresh session after rollback) |

Sources: `apps/server/src/provider/codexLaunchArgs.ts`, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`,
`packages/provider-grok/src/server/acpSupport.ts`, `packages/provider-muse/src/server/sdk.ts`,
`packages/provider-fx/src/server/acpSupport.ts`, `docs/user/providers-*.md`, `docs/user/cursor.md`,
`docs/user/permission-modes.md`.

### Codex

- **Connect with ChatGPT**: during onboarding or in Settings → Providers; T3 installs and manages the
  Codex runtime and the sign-in (no `PATH` entry needed). Disconnect stops running threads but keeps
  history. Remote sign-in can paste back the final localhost URL. A remote environment's ChatGPT
  sign-in can complete on a local "primary" and the tokens are transferred to the destination.
  `docs/user/providers-codex.md`, `apps/server/src/provider/CodexChatGptHandoff.ts`, `CodexManagedRuntime.ts`
- **Existing CLI login**: uses installed `codex` and `codex login`. `docs/user/providers-codex.md`
- **Multiple accounts**: add more ChatGPT accounts or more Codex instances; pick the account from the
  thread's model picker. **Shadow homes** let two CLI logins share one `CODEX_HOME` (sessions, config)
  while keeping separate `auth.json`, so work and personal accounts can continue the *same* thread.
  Settings: Binary path, `CODEX_HOME` path, Shadow home path, Launch arguments (passed to
  `codex app-server`). `docs/user/providers-codex.md`, `packages/contracts/src/settings.ts`
- **Switch accounts mid-thread** among instances sharing the thread's `CODEX_HOME`.
  `docs/user/providers-codex.md`
- **Async questions**: Codex can ask a question and keep working; the answer becomes a new message
  (steers the active turn or starts a new one); unanswered questions survive reconnects and restarts;
  questions can be dismissed. `docs/user/providers-codex.md`, `docs/internals/providers.md`
- **App-access approvals** (tool requests access to another app; once / session / permanently) and
  MCP elicitations. `docs/user/providers-codex.md`, `apps/server/src/provider/CodexMcpElicitation.ts`
- **Usage-limit stops** name the exhausted window and reset; workspace-plan messages say whether the
  owner must add credits. `docs/user/providers-codex.md`
- **`/feedback [text]`** uploads the conversation and Codex logs to OpenAI. `docs/user/providers-codex.md`
- **`/goal`** supported (incl. `/goal pause`/`resume`); one T3 run can own several native goal turns.
  `docs/user/composer.md#goals`, `docs/internals/providers.md`
- **Portable handoff into Codex** uses `thread/inject_items` to insert historical messages natively
  when the Codex version supports it (from code: `CodexAdapterV2.ts`).
- **Diffs come from T3 checkpoints**, not Codex's `turn/diff/updated` (opted out at init).
  `docs/internals/providers.md`
- **MCP apps** (interactive UI from MCP tool results) are only supported on Codex today.
  `docs/user/html-renders.md#mcp-apps`

### Claude (Claude Code)

- Uses Claude Code's own login and configuration; launched through the Claude Agent SDK with
  `pathToClaudeCodeExecutable` pointing at the configured binary (from code). `docs/user/providers-claude.md`
- **Separate accounts/presets** via one instance per `CLAUDE_CONFIG_DIR`; no shared/shadow-home
  arrangement, so threads can only switch between Claude instances with the same config dir. Settings:
  Binary path, `CLAUDE_CONFIG_DIR` path, Auto-compact after, Compact idle threads, Launch arguments
  (e.g. `--chrome`), Environment variables. `docs/user/providers-claude.md`, `packages/contracts/src/settings.ts`
- **Routers**: OpenRouter (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, empty `ANTHROPIC_API_KEY`) and
  Claude Code Router via per-instance env vars; custom model IDs via "Add custom model".
- **Compaction**: Auto-compact after 100,000–1,000,000 tokens; `/compact`; "Compact context" from the
  context meter; a **Compact** chip appears when you return to a >200k-token thread after the prompt
  cache expired (1h subscription, 5m API key); idle-compaction modes "When you return" (default),
  "Before the cache expires (beta)" (T3 sends a `/compact` turn just before expiry), "Never".
  `docs/user/providers-claude.md`, `apps/server/src/orchestration-v2/IdleCompaction.ts`
- **Usage limits**: Claude holds the turn until the window reopens; thread shows the limit and wait.
- **Skills** from config-dir `skills`, project `.claude/skills` and enabled plugins (`plugin:review`),
  invoked with `$`. **Task lists** shown when `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is set on the instance.
- **`/goal`**: goal state read from synthetic command output and Stop-hook feedback (from code/docs).
- **Claude workflows**: Claude `local_workflow` tasks are projected as a subagent "workflow" with
  phases and per-agent states; `t3_workflow_stop` MCP tool stops one (from code:
  `apps/server/src/orchestration-v2/Adapters/claudeWorkflowProgress.ts`). The manifest's
  **Ultracode** effort is "xhigh effort plus multi-agent workflow orchestration".
- **Background tasks and Monitors**: background Bash, Monitor and agent tasks are tracked; the agent is
  told to call `t3_background_wait` so the thread stays "Working" until they finish (Claude only).
  Web servers started by Claude are listed in the thread details card with a Stop button.
  `ClaudeAdapterV2.ts`, `docs/user/thread-sidebar.md`
- **Decline with feedback**: while a Claude approval is pending, typing a reply declines that request
  and sends the text to the agent (or subagent) that asked. `docs/user/permission-modes.md`
- Device-tool instructions are injected into native Claude subagents via a `SubagentStart` hook
  (from code).

### Cursor

- Runs through the official `@cursor/sdk` TypeScript package in its **local-agent** runtime (cloud
  agents not exposed). Requires Node 22.13+, a paid Cursor plan, browser sign-in from T3 (per-instance
  login) or `CURSOR_API_KEY`. `auto` maps to the SDK's `default` model. `docs/user/cursor.md`
- Supports create/resume, model and parameter changes between turns, text/reasoning/tool/plan/todo
  streaming, thread-scoped T3 MCP tools, images, interruption, queued messages, `task` subagents shown
  as read-only child threads.
- **Not supported by the SDK**: native fork, conversation rollback, active steering, interactive
  approval callbacks. Steering uses interrupt-and-restart; same-provider forks use portable handoff.
- Permission modes map to the SDK sandbox (Full access disables it); on Windows restricted modes need
  Cursor Auto-review because the SDK has no filesystem sandbox there.

### Grok Build (xAI)

- ACP over `grok agent stdio`; mode is passed on argv (`--permission-mode default|auto`,
  `--always-approve`) so Supervised cannot inherit always-approve from Grok config (from code:
  `packages/provider-grok/src/server/acpSupport.ts`).
- No Auto-accept edits; Auto uses Grok's review and blocked commands come to you; file-change
  approvals offer "Allow all edits this session", command approvals have no session-wide choice.
  `docs/user/permission-modes.md`
- xAI ACP extensions add structured user questions, prompt-complete and subagent session updates
  (from code: `xaiAcpExtension.ts`); subagent child sessions are exposed. No native `session/fork`,
  so forks are portable. `docs/orchestration-v2/orchestrator-mcp-server.md`
- Status probes avoid auth and session creation (they could start MCP servers or hooks).
  `docs/internals/providers.md`

### OpenCode

- Requires 1.14.19+ (1.x shows "Limited support") or 2.0.18+ (`@opencode/cli`); version detected
  automatically; threads started on 1.x continue on 2.x. `docs/user/providers-opencode.md`
- Local server started by T3 (Server URL empty) or an **external OpenCode server** (Server URL +
  password). 1.x: one T3-managed server per thread; 2.x: one server per instance with a per-thread
  `t3-code-<thread>` MCP entry and permission rules denying other threads' entries.
  `docs/internals/providers.md`
- Plan mode uses OpenCode's `plan` agent. **Allow for workspace** applies to other OpenCode sessions on
  the same workspace; automatic full-access replies use `once` so they never widen a supervised
  thread. `.env`/`.env.local` reads need approval in restricted modes.
- Refresh provider status reloads models, commands, skills; native config may stay cached ~30 s.

### Antigravity (Google)

- Runs Google's official Antigravity ACP agent from a **T3-managed runtime** (Apple Silicon macOS,
  Linux x64/ARM64, Windows x64/ARM64; several GB) or a manual binary. Installs survive client
  disconnects; releases are immutable with leases held by running processes.
  `docs/user/providers-antigravity.md`, `apps/server/src/provider/AntigravityInstallation.ts`
- Sign-in methods: Google account, Gemini Enterprise (GCP project/location), Gemini API key, Agent
  Platform / Vertex AI. Remote sign-in pastes back the `127.0.0.1` return URL. Per-instance profiles
  isolate accounts (file credential storage, ambient Google credentials stripped).
  `docs/internals/providers.md`
- Model list comes from the account (incl. Claude and GPT models if the plan has them); thinking
  level from the effort menu. No T3 Plan mode, no conversation rewind (revert and edit-resubmit
  unavailable), subagents shown only as batches. `/logout` alone signs the instance out.
- Usage → Limits shows Gemini and shared Claude/GPT five-hour and weekly allowances.

### Pi

- Uses the user's own `pi` install (0.80.5+) in RPC mode; T3 writes a T3-owned extension
  (`pi-t3-mcp-extension.ts`) that bridges T3's MCP tools; Pi keeps native extensions, skills, trust and
  session files. `docs/user/providers-pi.md`, `docs/orchestration-v2/orchestrator-mcp-server.md`
- Launch args that change execution mode or session are rejected; `--provider` must pair with `--model`.
- Thinking levels discovered per model; native resume, rollback and same-instance forks via Pi
  session files; provider switches use portable context.
- Permission modes enforced through Pi's blocking tool hook (not an OS sandbox); changing mode
  restarts the session and resumes the same conversation; no Auto.
- Extension dialogs (`select`, `confirm`, `input`, `editor`) appear in the T3 composer; Pi's example
  `subagent` extension's results are shown as task cards with no child thread.

### Muse Code (Meta)

- Disabled by default; `muse serve` with `--trust-workspace` (and `--disable-sandbox` in Full access);
  permission profile `:ask-me` vs `:unrestricted` set explicitly so Muse's AI reviewer never decides
  (from code: `packages/provider-muse/src/server/sdk.ts`).
- Only Supervised and Full access; no Plan mode; forks start a new session with copied context; no
  rewind; skills not shown in `$` menu; inherited `META_API_KEY` ignored unless set on the instance.
  `docs/user/providers-muse.md`

### fx (Vercel Labs)

- ACP via `fx acp`; one machine-wide `fx login`; model picker lists **Default** (what `fx status`
  reports) plus `fx models`; Effort control starts at Medium; backend choice (Codex, Grok, Vercel AI
  Gateway) is made with `fx provider` outside T3. `docs/user/providers-fx.md`
- Modes: Supervised and Auto only; steering a running turn stops it and answers the new message.
- Sub-agents open as their own child thread (task + shortened reply); fx does not forward a
  sub-agent's permission requests, so it waits until Stop.
- Not supported: Plan mode, Full access, Auto-accept edits, text generation (titles, commits, PRs).

### ACP Registry agents and local ACP commands

- **Add provider → Show more** searches the official ACP Registry (only agents runnable on the
  connected server); or add a **Local ACP command** (executable + literal args, no shell expansion),
  e.g. DeepSeek Harness `dsh --profile acp`. `docs/user/providers-acp.md`
- Registry installs go under `tools/<agent-id>/<version>/` in T3 home with SHA-256 checks when
  declared; `npx`/`uvx` packages install at the exact registry version into T3-owned prefixes.
  Settings: ACP source, Registry agent ID, Executable override, Authentication method, Custom models.
  `packages/provider-acp-registry/src/settings.ts`
- Prefers the **ACP v2 preview** (richer messages, usage, plans, config, compaction, agent-terminal
  updates) and negotiates v1; Claude Agent ACP can be forced to v1 with
  `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=0`.
- Sign-in: browser flow (URL shown, opened on your device) or terminal flow in an in-app terminal on
  the environment; sign-out if advertised.
- Models and options (effort, approval mode) come from ACP config options and update live; agent
  slash commands appear under **Provider** in `/`; `$`-prefixed ones in the skill menu.
- **Native sessions**: if the agent supports ACP session listing/import, **List sessions** imports one
  into a deterministic T3 thread (idempotent across clients).
- Agents run their own tools under their own sandbox; T3 answers their approval requests by the
  thread's permission mode. Devin's commands run through T3 terminals. Registry agents can schedule
  work and use T3 MCP tools. Not used for T3 text generation.
- T3 MCP tools are bridged via a stdio `acp-mcp-bridge` subcommand because some ACP agents
  (codex-acp 1.2.0, pi-acp) drop injected HTTP MCP servers; a terminal `acp-mcp-call` fallback is
  described to the agent in its instructions (from code: `packages/provider-acp/src/server/adapter.ts`,
  `packages/provider-core/src/server/orchestrationInstructions.ts`).
- Capabilities are negotiated from what the agent advertises (load, fork, model switching) (from code).

## 3. Provider instances, setup and maintenance

- **Multiple instances per driver**, each with display name, accent color, enabled flag, environment
  variables (sensitive values redacted after save; values may be secret references), and
  driver-specific config. `packages/contracts/src/providerInstance.ts`, `docs/user/install.md`
- **Instance isolation rule**: drivers strip ambient credentials the instance did not configure, so two
  instances cannot silently share an account or billing. `docs/internals/adding-a-provider.md`
- **In-app install and sign-in flows** with typed phases; auth methods of kind `agent`, `terminal` or
  `credentials`; callback completion on server or client. `packages/contracts/src/providerSetup.ts`
- **Welcome wizard** checks each machine for Claude Code and Codex and opens a terminal with the
  install/login command. `docs/user/welcome-wizard.md`
- **Version compatibility**: a model manifest lists per-driver supported/graceful/unsupported/broken
  version ranges and a recommended range; Settings warns and can install the recommended version.
  `apps/server/src/provider/model-manifest.json`, `docs/user/install.md`
- **Update now** runs the installer that provably owns the CLI (Homebrew, npm, pnpm, Yarn, Bun, Volta,
  Vite+), else the CLI's own updater (`claude update`, `codex update`, `opencode upgrade`,
  `pi update --self`, `grok update`); mise installs stay manual. `docs/internals/providers.md`
- **Refresh provider status** re-probes; background health checks must not open sessions, start MCP
  servers, run hooks or launch logins. `docs/internals/adding-a-provider.md`
- **Restart agent session** (command palette) restarts the provider session after skill/plugin/MCP
  changes while keeping the conversation; **Disconnect agent session** in the Lineage card stops the
  live session. `docs/user/composer.md`, `apps/web/src/components/chat/ThreadRelationshipsControl.tsx`
- **Import existing CLI history**: the welcome flow scans directories Claude Code, Codex or Pi used,
  proposes projects (git repos active in last 30 days with ≥3 conversations by default) and imports
  conversations (first prompt + newest messages, 200 messages max, no tool activity; per attempt 100
  files / 4 GiB / 100,000 records). `docs/user/welcome-wizard.md`, `packages/contracts/src/agentSessions.ts`

## 4. Models, effort and the model manifest

- **Model picker per thread** lists models per provider instance; provider, model and options are
  remembered for new threads; a project's configured model wins. `/model` switches the thread's
  model. `docs/user/composer.md`, `apps/web/src/components/chat/useComposerMenuItems.ts`
- **Model selection** is `{instanceId, model, options}`; options are generic descriptors (from code:
  `packages/contracts/src/modelSelection.ts`). Descriptors seen in the manifest: `effort`
  (Low/Medium/High/Extra High/Max plus **Ultrathink**, which is prompt-injected, and **Ultracode**,
  mapped to xhigh plus workflow orchestration), `fastMode`, `contextWindow` (200k / 1M, mapped to a
  `[1m]` model suffix), `thinking`; Codex also has a `serviceTier` (fast) (from code).
- Unset reasoning level or service tier means "use the provider's own configuration".
- **Custom models**: Settings → Providers → Models adds unlisted model IDs with names/options (not for
  Antigravity); built-in models can be renamed for every client in server `settings.json`.
- **Model manifest**: bundled JSON plus a copy fetched from `main`, so model metadata changes between
  releases; newer `updatedAt` wins; invalid data keeps the last good copy. Claude's whole built-in
  catalog comes from it (capability profiles per model family); Codex gets its list from its app
  server and the manifest only classifies current vs legacy. Models needing a newer CLI are announced
  with `minVersion` and reported as `updateRequiredModels`, so the picker says which update unlocks
  them. `docs/internals/model-manifest.md`, `apps/server/src/provider/ModelManifest.ts`
- **Send one prompt to several models**: Shift-click models in a new thread's picker; each selection
  starts its own thread and worktree (git projects only). `docs/user/thread-sidebar.md`
- **Default model sentinel** is never sent to the provider; stored options the live session doesn't
  advertise are skipped, not failed. `docs/internals/adding-a-provider.md`

## 5. Provider capability system

- Each adapter emits `OrchestrationV2ProviderCapabilities` with groups: sessions, threads, turns,
  streaming, tools, approvals, planning, subagents, context, checkpointing, identity, runtimePolicy.
  `packages/contracts/src/orchestrationV2.ts`, `docs/orchestration-v2/provider-capability-system.md`
- Examples of flags: `supportsModelSwitchInSession`, `canRollbackThread`, `canForkThread`,
  `canForkFromTurn`, `supportsActiveSteering`, `activeSteeringInterruptsTools`,
  `supportsSteeringByInterruptRestart`, `terminalStatusQuality`, `supportsMcpTools`,
  `approvalsCanOriginateFromSubagents`, `emitsProposedPlan`, `supportsStructuredQuestions`,
  `exposesSubagentThreadIds`, `supportsDeltaHandoff`, `providerCanRollbackConversation`, native id
  strength (strong/weak/none), and `runtimePolicy.enforcement` = `native` or `client-boundary`.
- **Degradation policies** (design doc): no active steering → interrupt and restart as a new attempt of
  the same run; no fork → portable context fork; no rollback → restore files, restart provider
  context; no structured approvals → provider runs under its sandbox with no approval UI.
- **Per-provider values (from code)**: Codex and Claude: rollback, fork, fork-from-turn, active
  steering, proposed plans, structured questions, subagents, native enforcement. OpenCode (1.x and
  2.x): rollback, fork, active steering, questions, subagent thread IDs. Pi: rollback, fork, active
  steering, questions, no proposed plans, client-boundary enforcement. Cursor: no rollback, no fork,
  no active steering, proposed plans, no structured questions. Muse: no rollback/fork, active
  steering, questions. Generic ACP: no fork unless advertised, no active steering, questions, no
  subagents; Grok/fx/Antigravity add subagents and model switching.
- **UI is capability-driven**: fork, interrupt, rewind and plan affordances shown only when the
  provider supports them; unsupported stored permission modes run as Supervised
  (`apps/server/src/orchestration-v2/RuntimePolicy.ts`). `docs/internals/adding-a-provider.md`

## 6. Permission modes and approvals

- **Four modes** (`RuntimeMode`): `approval-required` (**Supervised**), `auto-accept-edits`
  (**Auto-accept edits**), `auto` (**Auto**: provider's automatic reviewer approves routine actions),
  `full-access` (**Full access**). Default for new threads is **Full access**
  (`DEFAULT_RUNTIME_MODE`). `packages/contracts/src/providerPolicy.ts`, `docs/user/permission-modes.md`
- Chosen per thread in the composer (`mod+shift+a` opens Permissions); default in Settings → Threads →
  New threads → Permissions; projects can override the environment default.
- **How modes map to providers (from code)**:
  - Codex: Supervised = `approvalPolicy: untrusted` + read-only sandbox; Auto-accept edits =
    `on-request` + workspace-write; Auto = `on-request` + `approvalsReviewer: auto_review`; Full access =
    `never` + danger-full-access (`CodexAdapterV2.ts`).
  - Claude: `default` / `acceptEdits` / `auto` / `bypassPermissions`; Plan = `plan`; if Claude settings
    disable bypass, Full access downgrades to `auto` (or `default`) and approvals can still appear
    (`ClaudeAdapterV2.ts`).
  - Grok: argv `--permission-mode` / `--always-approve`; Muse: `:ask-me` vs `:unrestricted`; Pi: blocking
    tool hook; Cursor: SDK sandbox; OpenCode: native permission rules; ACP Registry: T3 answers the
    agent's requests per mode.
- **Approval decisions**: `accept`, `acceptForSession`, `acceptAlways`, `decline`, `cancel`, with
  provider option IDs passed through unchanged; request kinds `command`, `file-read`, `file-change`,
  `mcp-elicitation`, `permission`. An approval shown in Full access carries a reason (`ask_rule` or
  `provider_check`). `packages/contracts/src/providerPolicy.ts`
- Approvals are answered inline in the conversation on web, desktop and mobile; approvals from
  subagents are shown on the parent thread. Pending requests are respondable only while the provider
  callback is live (`responseCapability`). `docs/user/thread-sidebar.md`,
  `docs/orchestration-v2/core-graph-and-data-model.md`
- **Secrets**: agents call `request_secret`; the user types the secret into a private card; the agent
  gets a one-use `secretRef` or a private file path, never the value. `apps/server/src/mcp/toolkits/orchestrator/tools.ts`
- **Privilege ceiling for agent-driven work**: children and threads an agent creates or messages may
  not run with broader runtime or interaction modes than the caller (`runtime_mode_escalation_denied`).
  `docs/orchestration-v2/orchestrator-mcp-server.md`

## 7. Plan mode, questions, goals and task lists

- **Interaction modes** `default` and `plan`; composer Plan/Build toggle; `/plan` and `/default`
  commands. Providers whose plan output doesn't become a proposed-plan card hide the toggle.
  `packages/contracts/src/providerPolicy.ts`, `docs/internals/adding-a-provider.md`
- **Proposed plan card** with **Refine**, **Implement**, **Implement in a new thread**, copy, download
  as markdown, save to workspace (from code: `apps/web/src/components/chat/ProposedPlanCard.tsx`,
  `ComposerPrimaryActions.tsx`). A run can carry `sourcePlanRef` (design doc).
- **Structured questions** from the agent (header, options with descriptions, multi-select, custom
  answer, required) answered in a question panel; files can be attached to custom answers (up to 100
  files); questions can be dismissed. `docs/user/question-attachments.md`, `apps/server/src/mcp/toolkits/thread/tools.ts`
- **Goals**: `/goal <done criteria>` on Codex and Claude keeps the agent working across turns; `/goal`,
  `/goal clear`, and (Codex) `/goal pause`/`resume`. `docs/user/composer.md#goals`
- **Todo lists** stream as a live task list (Codex `turn/plan/updated`, Claude with the env flag,
  Cursor, ACP plans). `docs/orchestration-v2/core-graph-and-data-model.md`, `docs/user/providers-claude.md`
- **`/usage-limits`** shows the current model's limits above the composer without running the agent.
  `docs/user/usage.md`

## 8. Turn control: queue, steer, interrupt, recover

- **Follow-up behaviour** (Settings → Chat): new messages either **queue** (separate run after the
  active one) or **steer** the running turn; the opposite action is one shortcut away;
  `thread.steerQueuedMessage` sends the oldest queued message as a steer. `docs/user/composer.md`
- **Queued messages are server-side**: shown as dashed messages, editable (text and attachments),
  reorderable, cancellable, **Send now**; held after Stop or restart until **Resume**. Mobile can queue
  offline. MCP equivalent: `t3_queue` (list/read/edit/cancel/reorder/promote_to_steer).
- **Steering strategies**: native active steering where supported, otherwise interrupt-and-restart as a
  new attempt within the same run; dispatch modes `start_immediately`, `queue_after_active`,
  `steer_active`, `restart_active`. `docs/orchestration-v2/feature-lifecycles.md`, `packages/contracts/src/orchestrationV2.ts`
- **Stop** interrupts the turn, holds queued turns, ends PR watches and stops delegated subagents. If
  the agent ignores Stop, a banner "Agent not responding to Stop" offers **Force stop** (kills its
  processes) (from code: `apps/web/src/components/chat/ThreadActivityBanners.tsx`).
- **Continue threads after restarts** (Settings → Maintenance, on by default): after an update, crash
  or reboot, supported active threads resume; threads waiting on subagents/background tasks are woken
  and told that work stopped; not resumed while waiting for approval/answer/secret or when archived,
  snoozed or settled; max three automatic resumes in a row. `docs/user/updating.md`,
  `apps/server/src/orchestration-v2/RestartContinuation.ts`
- **Usage-limit handling**: the thread shows **Limited**; **Resume** continues manually; **Resume at
  reset** schedules a continuation (Settings → Threads "Resume after usage limits" makes it default);
  **Snooze until reset**. Usage-limit errors are classified as `usage_limit` with a reset time.
  `docs/user/thread-sidebar.md`, `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts`
- **Edit from here** rewinds the conversation before a message (**Revert and keep changes** or **Revert
  files too**, files only for worktree threads not shared with other sessions); only offered when the
  provider supports rewind. `docs/user/composer.md`

## 9. Subagents and parallel agents

- **Native subagents** are shown as child execution nodes and, where the provider exposes IDs, child
  threads: Claude `Agent`, Codex `spawn_agent`, Cursor `task` (read-only child threads), Grok and
  OpenCode child sessions, fx sub-agents (own thread, steps not shared), Pi example `subagent`
  extension (task cards), Antigravity (batches only). `docs/user/*.md`, adapters
- **T3-owned subagents (`delegate_task`)**: any agent can start a child on **any provider instance and
  model** T3 has (e.g. Claude delegating to Codex). The child gets only the task prompt plus optional
  role (`implementation`, `research`, `review`, `design`, `test`, `general`), no parent history.
  `docs/orchestration-v2/orchestrator-mcp-server.md`, `packages/contracts/src/orchestratorMcp.ts`
- **Isolation**: `isolation: "shared"` (parent checkout, default) or `"worktree"` (new prepared
  checkout from the parent commit; uncommitted edits excluded) for a separate checkout/PR per child
  (from code).
- **Async by default**: the parent ends its turn and the child's completion **wakes the parent
  thread**; `mode: "wait"` blocks up to `timeoutMs` (default 10 min) without cancelling on timeout;
  wake policy `always` or `settled_only` (from code). A child question notifies the parent, which can
  answer with `t3_pending_request` or ask the user; approvals are not routed to the parent agent.
- **Agents panel** (web/desktop) and mobile cards follow delegated work; Stop on a parent stops its
  subagents; agent-started subagent threads can't take user messages (message the parent); their
  approvals and questions surface on the parent. `docs/user/thread-sidebar.md`
- **Lineage card** lists parent, forks, active and "Previous agents" with running counts and per-child
  stop (from code: `ThreadRelationshipsControl.tsx`).
- **Injected guidance** tells agents when to use native subagents (same provider, finishes this turn)
  vs `delegate_task` (other provider/model, separate worktree, background work), to call
  `orchestrator_capabilities` once, never poll a running delegate, and that a subagent must not spawn
  further subagents unless told. `packages/provider-core/src/server/orchestrationInstructions.ts`
- **Cross-machine delegation (beta)**: with **Linked environments** enabled (off by default), agents
  can list linked machines (`t3_environment_links`), ask the user to link one (`t3_environment_link`
  shows a card; never asks for pairing codes in chat), and delegate with `target.environmentId`; the
  result carries `remoteChild` (from code: `packages/contracts/src/settings.ts`
  `linkedEnvironmentsEnabled`, `apps/server/src/orchestration-v2/RemoteDelegatedTask.test.ts`).
- **Ordinary parallel threads by agents**: `create_threads` (1–20 top-level threads in the same
  checkout) and `t3_thread_launch` (one thread with `workspaceStrategy` `root`, `worktree` + `baseRef`,
  or `existing_worktree`; `scratch: true` for no project; `startFromOrigin: false` for stacked PRs).

## 10. Forks, provider switching, handoffs and lineage

- **Fork from this response** (assistant message action) creates a new thread with fork lineage; no
  provider is chosen at fork time; the first message resolves the source point lazily: native fork
  for same-provider forks with support (Codex `thread/fork`, Claude `forkSession`, Pi CLI, OpenCode),
  otherwise a portable context handoff. Active runs can't be forked from explicitly; `latest_stable`
  uses the latest completed checkpointed run. `docs/orchestration-v2/thread-lineage-and-context-transfer.md`
- **Merge back to source conversation** button in the Lineage card injects a delta of the fork's work
  into the source thread's next message (from code: `ThreadRelationshipsControl.tsx`,
  `thread.merge_back` command; MCP `t3_thread_transfer` actions `fork`, `merge_back`, `status`).
- **Switch provider mid-thread**: changing the model picker to another provider keeps the same app
  thread; the next run starts or reuses a provider thread for the new provider and receives a context
  handoff. Returning to an earlier provider can resume its old provider thread with a delta of runs
  that happened elsewhere. `docs/orchestration-v2/provider-switching-and-context.md`,
  `apps/server/src/orchestration-v2/ProviderSwitchService.ts`
- **Portable handoff content**: a budgeted selection, not an agent summary. Short conversations go
  intact; long ones favour recent turns, the original request and command outcomes; selected messages
  keep full text and roles; the new request is never shortened; omitted history is referenced and
  readable through T3's thread-reading tool. Reasoning, tool state and attachments are not copied.
  `docs/user/portable-handoffs.md`
- **Budget**: `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` default 16,000 tokens (clamped 1,024–64,000), 64,000-byte
  ceiling for imported history, assumed 128k window when unknown, reserve ≥16k or a quarter of the
  window, images 8,192 tokens each, other attachments 4,096; if the target has no room T3 starts a
  fresh provider conversation automatically. `docs/user/portable-handoffs.md`,
  `packages/provider-core/src/server/handoffBudget.ts`
- Fork merge-back deltas and legacy imports use a compact line-per-item summary (text compacted to
  240 characters) (from code: `apps/server/src/orchestration-v2/ContextHandoffService.ts`;
  `docs/internals/context-handoffs.md` describes this too but predates the budgeted provider handoff).
- **Lineage data**: threads carry `lineage {parentThreadId, relationshipToParent: fork|subagent,
  rootThreadId}`; `ContextTransfer` rows of type `fork`, `provider_handoff`, `merge_back`,
  `subagent_spawn`, `subagent_result` with status `pending`, `resolved_native`, `resolved_portable`,
  `failed`, `consumed`, `superseded`. `docs/orchestration-v2/core-graph-and-data-model.md`
- **Worktree handoff of the current thread**: `t3_worktree_handoff` moves the calling thread into a
  new worktree on a new branch (runs setup script; optional `continuationPrompt`).
  `apps/server/src/mcp/toolkits/worktree/tools.ts`
- **Thread migration V1 → V2**: first V2 launch copies `state.sqlite` to `statev2.sqlite` and imports
  threads (title, project, provider/model, modes, worktree, archive/settle/snooze/pin, PR link, messages);
  not runs, checkpoints, tool activity or approvals. Continuing starts a fresh provider session seeded
  with the handoff budget plus a separate 32,000-character recovery excerpt. No whole-thread export
  command exists. `docs/user/thread-migration.md`, `docs/internals/legacy-orchestration-migration.md`

## 11. Orchestration V2 internals

- **Event-sourced**: the orchestrator serializes commands and decides events without I/O; `EventSink`
  commits events, projections, the command receipt and outbox effects in one SQLite transaction; an
  **effect worker** performs provider/checkpoint side effects afterwards and feeds results back as
  commands. Duplicate command IDs return the same receipt. `docs/internals/overview.md`,
  `apps/server/src/orchestration-v2/{Orchestrator,EventSink,EffectOutbox,EffectWorker}.ts`
- **Entities**: AppThread → Run (counted turn; statuses queued…rolled_back) → RunAttempt (initial,
  steering_restart, retry, provider_recovery) → ExecutionNode tree (root_turn, assistant_message,
  reasoning, plan, todo_list, tool_call, approval_request, user_input_request, subagent, hook, system);
  ProviderSession, ProviderThread, ProviderTurn, RuntimeRequest, CheckpointScope/Checkpoint,
  ContextTransfer, ContextHandoff. Only the root node completes a run; child completion never closes
  the parent. `docs/orchestration-v2/core-graph-and-data-model.md`
- **App IDs are primary**; provider IDs are refs with strength strong/weak/none; weak providers get
  deterministic ordinal/fingerprint IDs. `docs/orchestration-v2/entity-ids-and-correlation.md`
- **Projections** stream as snapshot + sequence cursor; an ordered `turnItems` projection drives the
  timeline. Raw provider frames go to bounded rotating NDJSON diagnostic logs (64 KiB payload budget),
  not the database. `docs/internals/providers.md`, `apps/server/src/provider/EventNdjsonLogger.ts`
- **Command vocabulary** (from code, `packages/contracts/src/orchestrationV2.ts`) includes
  `thread.create/fork/merge_back/stop/settle/snooze/pin/archive`, `thread.model-selection.set`,
  `thread.runtime-mode.set`, `thread.interaction-mode.set`, `message.dispatch`, `run.interrupt`,
  `queued-run.edit/reorder/cancel/start`, `queued-message.promote-to-steer`, `runtime-request.respond`,
  `delegated_task.request`, `provider.switch`, `provider-session.detach`, `checkpoint.rollback`,
  `thread.pull-request.watch`, `thread.guest-message.submit`.
- **Session lifecycle**: provider sessions are durable metadata; live processes can be reaped when idle
  and recreated from stored resume refs; `hasPendingBackgroundWork` keeps a session alive.
  `docs/orchestration-v2/core-graph-and-data-model.md`, `docs/internals/adding-a-provider.md`
- **Testing**: replay fixtures recorded from real providers (`apps/server/scripts/record-*-replay-fixture.ts`)
  run through the real orchestrator, adapters and projections; shared scenarios `simple`, `multi_turn`,
  `queued_turn`, `turn_interrupt`, `message_steering`, `provider_thread_resume`, `tool_call_*`.
  `docs/orchestration-v2/testing-strategy.md`, `docs/internals/adding-a-provider.md`

## 12. T3 MCP server given to agents

- **Endpoint** `http://127.0.0.1:<port>/mcp`, server key `t3-code`, registered into every provider
  session with a **per-session bearer credential** scoped to environment, parent thread, provider
  instance and session; expires on idle/max lifetime and is revoked when the session ends.
  `docs/orchestration-v2/orchestrator-mcp-server.md`, `apps/server/src/mcp/McpSessionRegistry.ts`
- **Injection per provider**: Codex `-c mcp_servers.t3-code.url=…` with `T3_MCP_BEARER_TOKEN`; Claude
  SDK `mcpServers` + `allowedTools: mcp__t3-code__*`; Cursor SDK `mcpServers`; ACP `mcpServers` on
  `session/new|load|fork` (stdio bridge where HTTP is dropped); Pi extension; OpenCode per-thread entry.
  A turn must survive when the server is unreachable.
- **Tool groups (from code: `Tool.make` names in `apps/server/src/mcp/toolkits/`)**:
  - Orchestration: `orchestrator_capabilities`, `delegate_task`, `task_status`, `task_cancel`,
    `create_threads`, `t3_workflow_stop`, `t3_background_wait`.
  - Threads: `t3_thread_launch`, `t3_thread_list`, `t3_thread_read`, `t3_thread_search`,
    `t3_thread_update` (rename, regenerate title, link/unlink PR), `t3_thread_send` (modes `auto`,
    `queue`, `steer`, `restart`), `t3_thread_wait`, `t3_thread_interrupt`, `t3_thread_configure`
    (read/set provider, model, options), `t3_thread_organize` (pin, snooze, settle, archive, mark
    unread), `t3_thread_transfer` (fork, merge_back, status), `t3_queue`, `t3_pending_request`,
    `t3_thread_send_attachments`.
  - Scheduling: `schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task`, `run_scheduled_task_now`.
  - Pull requests: `link_pull_request`, `unlink_pull_request`, `list_thread_pull_requests`,
    `watch_pull_request` (wakes the agent on failed checks, passed required checks, new comments or
    reviews, conflicts), `unwatch_pull_request`, `write_pull_request_guides`, `read_pull_request_guide`.
  - Worktrees: `t3_worktree_handoff`, `t3_worktree_status`, `t3_worktree_list`.
  - Projects and environments: `t3_project_list/read/create/update/delete/clone`,
    `t3_environment_read`, `t3_environment_preferences_update`, `t3_environment_links/link/unlink`.
  - Browser/preview, visuals and devices: `preview_*` (open, navigate, act, snapshot, evaluate, wait_for,
    resize, dialog, set_appearance, recording start/stop, status), `t3_preview_list/close`,
    `html_preview`, `device_list/open/screenshot/close`; attachments `t3_attachment_prepare_upload/discard`;
    `request_secret`.
- **Typed failures**: `capability_denied`, `parent_not_active`, `provider_unavailable`,
  `model_unavailable`, `runtime_mode_escalation_denied`, `interaction_mode_escalation_denied`,
  `task_not_found`, `task_not_cancellable`, `thread_not_found`, `run_not_found`, `thread_not_sendable`,
  `thread_not_interruptible`, `invalid_request`, `orchestration_error`.
- **Idempotency**: `clientRequestId` derives stable command/thread/message IDs within a provider
  session, so retries return the same work.
- **Capability listing is kept short** (custom, favourite and own models plus current models; first 8
  for big catalogs like OpenCode) with `search` for the rest.
- **Thread links**: agents mention threads as `t3-thread://v2/<environmentId>/<threadId>` links that
  clients render with the current title; outside OAuth clients get web URLs instead.
- **Provenance**: thread/message results carry `createdBy` (agent vs user) and `creationSource`
  (`mcp`, `provider`), so agent-authored user-role messages are distinguishable.
- **Activity summaries** in the timeline describe orchestration calls, e.g. "Ran 2 commands and sent
  messages to 3 threads". `docs/user/activity-log.md`
- **Injected instructions**: a shared "T3 Code orchestration" block (plus browser and device sections
  when those tools are available) is added to every provider's system/developer context; Codex gets it
  as `additionalContext` split into ≤4,000-byte entries. `packages/provider-core/src/server/orchestrationInstructions.ts`,
  `apps/server/src/provider/CodexDeveloperInstructions.ts`

## 13. Outside agents over MCP

- External agents (Claude Code or Codex in your terminal, ChatGPT, MCP bots) connect to
  `https://<environment-address>/mcp` (Settings → Environments → **Copy MCP URL**) with **OAuth**; the
  first connection opens a sign-in page on the environment approved with a pairing code (Settings →
  Sharing & access, or `t3 auth pairing create`). `docs/user/outside-agents.md`
- Scopes: **Read only** (default: read projects/threads, providers, models) or a permission level from
  **Supervised** to **Full access** that also allows start/message/stop threads in every project; a
  thread it starts or steers can't exceed the chosen mode.
- Setup commands: `claude mcp add --transport http t3 …` + `claude mcp login t3`; `codex mcp add t3 --url …`
  + `codex mcp login t3`; ChatGPT custom MCP app with OAuth via the T3 Connect address. Only `https`
  or `localhost` completes sign-in. Sign-ins last 30 days; revoke under Sharing & access.
- **`t3 thread` CLI on the host** uses the same tools without sign-in: `t3 thread start <project> <msg>
  [--worktree <base>] [--branch] [--provider --model] [--title]`, `t3 thread send <id> <msg> [--wait]
  [--json]` (exit 1 on failure, 2 when waiting on the user; `-` reads stdin; never interrupts), `t3
  thread show [--messages N]`, `t3 thread list`. `docs/user/outside-agents.md`, `apps/server/src/cli/thread.ts`
- **Prompt links** (`https://app.t3.codes/new?prompt=…&repo=…&provider=…&model=…` or `?pr=`) open a
  draft only; they can't change permission mode, branch or worktree. `docs/user/prompt-links.md`

## 14. MCP apps

- Interactive apps returned by MCP tools (MCP Apps standard) render in the thread in place of the tool
  call on web, desktop and mobile; **Codex only** today. `docs/user/html-renders.md#mcp-apps`
- An app can call tools on its own server (T3 asks first unless the tool is marked read-only), read
  resources, post a message (always asks), go full screen, and update "model context" that is sent with
  your next message (max 16 KiB per app; latest note per app). Using an app needs the thread's agent
  session running; T3 never starts a provider turn to serve an app. `apps/server/src/mcpApps/McpAppRequests.ts`,
  `apps/server/src/mcpApps/McpAppModelContext.ts`, `packages/contracts/src/mcpApps.ts`
- Error reasons: `not-an-app`, `provider-unsupported`, `session-stopped`, `tool-not-callable`,
  `unsupported-content`, `request-failed` (from code).

## 15. Usage and limits

- **Usage page** (`mod+u`, sidebar, palette; mobile nav) aggregates Codex, Claude Code, Grok, OpenCode,
  Antigravity, Pi, Muse and Cursor history across connected environments: tokens, cache savings, per
  model breakdown, estimated API-equivalent cost split by token type and speed (standard / fast /
  ultrafast, "Premium"), periods 24h/7d/30d/90d. Reads each tool's local history (custom homes via
  `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `OPENCODE_DATA_DIR`, `ANTIGRAVITY_DATA_DIR`,
  `PI_CODING_AGENT_DIR`); Cursor from its dashboard API. `docs/user/usage.md`
- **Custom model prices** (USD per million input/output, optional cache read/write), **Map to** another
  model, applied per environment with retry for offline ones.
- **Limits tab** pools all subscription accounts per provider across environments and hubs (one
  segment per account, ordered by next 5-hour refill), shows reset times, hatched "what the reset
  restores", banked **reset credits** with **Use reset** (Codex and Claude; not for Claude on macOS).
  Window kinds: session, weekly, monthly, other. Automatic checks at most every 5 minutes per client.
  `packages/contracts/src/providerUsageLimits.ts`
- **Thread details card** can show remaining limit windows and context-window usage for the thread's
  account; **context meter** in the composer.
- **CLIProxyAPI hub** (Settings → Providers → Usage providers → Add hub) feeds pooled accounts.
- **Mobile widgets** (iOS/Android "Subscription usage") for Codex and Claude quotas.
- Provider-specific limit sources: OpenCode Go (local only, API key), Cursor monthly allowance
  (Auto vs API), Grok billing period, Antigravity five-hour and weekly groups.

## 16. Checkpointing and rollback

- **Per-turn checkpoints as hidden git refs**: a baseline before each root run and a checkpoint after
  it settles, stored under `refs/t3/orchestration-v2/checkpoints/<hash(scope)>/ordinal/<n>`, never as
  commits on the user's branch or a stash. `docs/internals/glossary.md`, `apps/server/src/orchestration-v2/CheckpointService.ts`
- **Capture mechanics (from code)**: copy the index to a scratch `GIT_INDEX_FILE`, `git add -A`
  (untracked included, ignored excluded), `write-tree`, `commit-tree` (author "T3 Code"), `update-ref`;
  the real index and branch are untouched. `apps/server/src/vcs/GitVcsDriver.ts`
- **Nested scopes**: subagent/child nodes get their own checkpoint scopes that don't advance the
  parent's run count; stopped or interrupted runs still checkpoint. Non-git workspaces → `missing`.
  `docs/orchestration-v2/feature-lifecycles.md`, `apps/server/src/orchestration-v2/CheckpointCaptureService.ts`
- **Diffs per turn** (Diff pane: Latest turn, Turn N, Changes vs base, Uncommitted, Commits, per tool
  call); a turn's file list excludes files git brought in via pull/merge/rebase unless the turn
  touched them; patch output capped at 10,000,000 bytes. `docs/user/source-control.md`,
  `apps/server/src/checkpointing/CheckpointDiffQuery.ts`
- **Edit from here / rollback** order: validate the checkpoint and that the provider thread/instance is
  unchanged → isolation check → provider conversation rollback → optional file restore
  (`git restore --source <ckpt> --worktree --staged`, `git clean -fd`, `git reset`) → later refs
  deleted and marked `stale` → runs marked `rolled_back` (kept for audit).
  `apps/server/src/orchestration-v2/CheckpointRollbackService.ts`
- **Restore safety**: file restore only for an isolated worktree; refused when another live thread,
  scope or provider session uses the same directory, a child or a parent of it.
  `apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts`
- **Provider conversation rollback (from code)**: Codex `thread/revert`; Claude `resumeSessionAt`;
  OpenCode `session.revert`; Pi forks from a session entry; ACP agents restore files but the next turn
  starts a fresh agent session; unsupported on Cursor, Muse, Antigravity (rejected before touching
  files via `CommandPolicy.ensureRollback`).
- Interrupt the turn and reconnect the environment before reverting; guests can't revert.

## 17. Scheduled tasks and webhook automations

- **Settings → Scheduled tasks** (web, desktop, mobile) lists tasks across environments with Enabled
  switch, Edit, Run now, Deliveries, Delete; a thread's details panel has an **Automations** section
  for tasks bound to that thread. `docs/user/project-settings.md`,
  `apps/web/src/components/settings/ScheduledTasksSettings.tsx`, `apps/web/src/components/chat/ThreadAutomationsPanel.tsx`
- **Schedule kinds** (exactly three; no cron, no one-shot type, from code): `interval {everyMs}`
  (minimum 60 s), `fixed_time {timeOfDay "HH:MM", weekdays?}` in the server's time zone, and
  `webhook` (one run per HTTP request). `packages/contracts/src/scheduledTask.ts`
- **Execution**: an unbound task launches a **new thread** per run (stored title, model, modes, workspace
  strategy: new worktree from `main` by default, project checkout, or a specific checkout); a task
  bound to a thread **queues** its prompt into that thread and follows the thread's current provider.
  "Success" means dispatched, not finished. The web editor always saves `full-access` / `default`
  modes (from code). `apps/server/src/scheduledTasks/ScheduledTaskService.ts`
- **Missed runs**: no backfill; a fixed-time run more than 10 minutes late is skipped; an overdue
  interval runs once; runs interrupted by a restart are marked failed. A shared scheduler ticks every
  5 s (also used by usage-limit "Resume at reset"). `apps/server/src/scheduledTasks/Schedule.ts`,
  `apps/server/src/scheduling/Scheduler.ts`
- **Agent-created schedules**: MCP `schedule_task` (create/update; binds to the caller's thread by
  default; model from the caller; modes capped at the caller's), `list_scheduled_tasks`,
  `delete_scheduled_task`, `run_scheduled_task_now`. Deleting a thread deletes its bound tasks.
- **Webhooks**: endpoint `/api/hooks/<taskId>/<token>`; public URL only through the T3 Connect relay
  (`<relay>/v1/hooks/…`), rotatable; optional **Hold webhooks while offline** (relay queues up to 24 h).
  Prompt templating with `{{body.path}}`, `{{headers.name}}`, `{{query.name}}`, values wrapped as
  untrusted data and defanged (`$`, `@`, leading `/`); optional HMAC-SHA256 signature check (GitHub
  preset; secret via `request_secret`); up to 16 filters (`equals`, `notEquals`, `startsWith`, `in`,
  `exists`); replay-key dedupe (7 days) and coalescing window (10–3600 s, default 120); limits 60
  runs/min, 20 queued deliveries, 120,000-char prompt, 1 MiB body; a Deliveries log per task.
  `apps/server/src/scheduledTasks/{webhookRoute,webhookTemplate,webhookVerification,webhookFilter,webhookDedupe}.ts`

## 18. Text generation (titles, branches, commits, PRs)

- **Five app-owned generation tasks**: thread titles, worktree branch names, commit messages, PR/MR
  title and description, PR review guides. `apps/server/src/textGeneration/TextGeneration.ts`
- **Settings** (project-overridable): **Text generation model** (default Codex `gpt-6-luna`, effort
  low), **Source control writer model** (commits, PRs, branch names; falls back to the text model),
  review-guide model; **Thread title instructions**; branch naming `static` / `semantic` / `custom` with
  prefix (default `t3`); writing style `repo_conventions` / `conventional_commits` / `custom`; follow PR
  templates. `packages/contracts/src/settings.ts`, `packages/contracts/src/model.ts`
- **Regenerate title** from the thread menu or via MCP; titles resolve up to 2 linked issues/PRs as
  context. `apps/server/src/orchestration-v2/ThreadTitleRegenerationService.ts`
- **Runs as one-shot CLI calls** with a JSON schema and no tools (180 s timeout): Claude `claude -p
  --output-format json --tools "" --permission-mode dontAsk …`, Codex `codex exec --ephemeral -s
  read-only --output-schema …` (from code). Supported by Codex, Claude, Cursor, Grok, Muse, Pi,
  OpenCode, Antigravity; not fx or ACP Registry agents.
- **Automatic fallback** to another enabled, authenticated, text-capable instance when the chosen
  model's usage window is exhausted (from code).
- **Review guides (beta, off by default)**: a Codex or Claude model investigates a temporary read-only
  checkout and writes a "Guide" tour for a PR. `docs/user/source-control.md`

## 19. Triage

- **Command palette → Triage an issue** opens a project-less thread with a link to the triage
  playbook; you pick any provider and describe the problem; the server fetches the T3 Code source for
  its own version (shallow clone of tag `v<version>` or `main`) in the background.
  `docs/user/triage.md`, `apps/server/src/triage/TriageService.ts`
- **`npx t3 triage [--agent claude|codex] [--model]`** starts Claude Code or Codex in a terminal with the
  same instructions when the app won't start. `apps/server/src/cli/triage.ts`
- A context file lists machine facts and paths (DB, logs, traces, provider event log, provider status
  cache); the 10-step playbook covers investigation, searching existing issues, asking before applying
  a fix or filing an issue (`via-triage` template), and redaction. `apps/server/src/triage/triagePrompt.ts`,
  `.github/triage/PLAYBOOK.md`

## 20. Evals

- `evals/` runs real (paid) models against T3's real agent instructions, MCP tool schemas and generated
  text; not run in CI (CI only typechecks and unit-tests graders). `evals/README.md`
- **mcp-tool-use**: replays trimmed real Claude/Codex harness captures with T3's current instructions
  and tools; a cheap model simulates the shell; deterministic grading (`calls`, `callsMustNot`,
  `maxCalls`, `order`, `textMust`, `linked`). Areas: delegation/orchestration (36 cases), pull requests
  (28), visual preview (28), device manager (16), scheduling. Models: Claude Sonnet/Opus 5.5, GPT-6.1
  Sol, GPT-6 Astra. `evals/mcp-tool-use/README.md`
- **thread-titles**: generates titles for 8 real thread shapes with the server's own code; blind human
  A/B review. **test-signal**: checks a code-review bot prompt flags low-signal tests.
- Case rules: each case reproduces a real bad experience or guards a good one, is added before the fix,
  and imports prompts from source rather than copying them.

## 21. Notable gaps and caveats (as found)

- `docs/orchestration-v2/` is a target-architecture set; e.g. it describes the effect outbox as a
  follow-up, but `EffectOutbox.ts`/`EffectWorker.ts` exist and the internals overview treats them as
  current. The orchestrator MCP doc says "eleven orchestration tools" while the code registers many
  more (section 12).
- No whole-thread export command (`docs/user/thread-migration.md`).
- Linked environments (cross-machine delegation) and review guides are beta/off by default; Claude
  "Before the cache expires" idle compaction is beta.
- Agent-started subagent threads can't be messaged directly; approvals are never routed to a parent
  *agent*, only questions are.
- Permission enforcement is native for most providers but "client-boundary" for Pi and the generic ACP
  adapter (T3 answers the agent's approval requests), which is weaker than native enforcement.
