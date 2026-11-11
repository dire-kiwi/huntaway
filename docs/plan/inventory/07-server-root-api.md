# 07 — Server root, HTTP API and top-level modules (`apps/server`)

Sources read: `bin/huntaway`, `bin/issue-agent`, `src/main.ts`, `serve.ts`, `state.ts`, `http.ts`, `api.ts`, `api/*.ts`,
`util.ts`, `proc.ts`, `worker.ts`, `lag.ts`, `crash.ts`, `memory.ts`, `backup.ts`, `disk.ts`, `attachments.ts`, `demo.ts`,
`analytics.ts`, `telemetry.ts` + `telemetry/*`, `testing.ts` + `testing/*`, `tests/*`, `README.md`, `PORTING.md`,
`package.json`, tsconfigs, `docs/guide/server.md`, `docs/development.md`, `docs/telemetry/grafana/`. Also read for the
surface only: `hosts/hub/endpoints.ts` (`/api/ws`, proxy), `devices.ts` (device auth), `wire/events.ts`, `wire/server.ts`.

## 1. Purpose

The process shell of the board: a POSIX-sh launcher that supervises one Node process, a CLI with ~14 subcommands, the
`serve` startup sequence, the shared in-memory state object, a hand-written HTTP router with ~183 JSON routes plus four
websocket routes, static serving of the built web UI, and small host-wide services (database backups around version
changes, disk-usage report, attachments store, prompt/token analytics, ClickHouse telemetry with a durable outbox,
event-loop lag measurement, crash containment, memory trimming). Everything else in the server (agents, git, hosts,
integrations, MCP) is reached through the route table and the startup list here.

## 2. Capabilities

### Launcher and process (`bin/huntaway`, `bin/issue-agent`, `main.ts`)
- Find Node: `$IA_NODE`, package's `node/bin/node`, PATH, then `/usr/local/bin`, `/usr/bin`, `/opt/homebrew/bin`, volta, mise, `~/.local/bin`, newest nvm.
- Pick sources: package `server-ts/src/main.js` (precompiled), `server-ts/src/main.ts`, else checkout `../src/main.ts`.
- Node flags: `--disable-warning=ExperimentalWarning --expose-gc`, `--max-semi-space-size=2` and `--max-old-space-size=1024` unless `NODE_OPTIONS` already sets them; `MALLOC_MMAP_THRESHOLD_=131072` (+ marker `IA_MALLOC_MMAP=1`) for node only.
- `approval-hook` runs `agent/approval_rules/hook_main.{ts,js}` directly (cheap start; exits 2 on any failure so the tool call is refused).
- Any subcommand other than `serve`/none: `exec node main "$@"`.
- `serve`: re-exec itself once with SIGINT at default (GNU `env --default-signal=INT` or perl), run node as a child, forward TERM/INT/HUP as TERM, reap children, hand stdin through fd 3.
- Restart-by-exec emulation: server writes `next=<path>` (sh syntax) to `$IA_RESTART_FILE` and exits 75; wrapper sources the file and `exec "$next" "$@"` (same pid, same args).
- Crash restart (HA-182): after `started` marker exists, restart node on non-zero exit other than 75, or on ABRT/SEGV/BUS/ILL/FPE/TRAP/SYS; waits 1,2,4,8,16 s, gives up after 5 in a row; a run of ≥600 s resets the count; `$IA_CRASH_BACKOFF` replaces the first second.
- One-shot env: `IA_SKIP_DB_BACKUP_ONCE`, `IA_RECOPY_DB` go only to the first node started.
- `bin/issue-agent`: execs the `huntaway` beside it (old name; SSH `authorized_keys` and desktop configs still call it).
- `main.ts`: strips `IA_TS_EXE` (keeps it in `globalThis.huntaway_exe`), strips malloc vars, lazy-imports one module per subcommand.

### `serve` (`serve.ts`)
- Parse flags with env fallbacks; default data dir; create/realpath data dir; make it private (0700, db files 0600).
- Load or create `auth_token`, `hub_token`, `host_id` files (0600); host name from `--name`, `/proc/sys/kernel/hostname`, `$HOSTNAME`, `"host"`.
- Take over to a newer installed release before opening the db (`release.exec_installed`, only with `--release-updates`).
- Backup-before-open on version change (`backup.on_start`); emit `IA_BACKUP_FAILED {json}` on stdout when it fails.
- Open database (`huntaway-2.db`, copying from the older file on first start; or older file with `IA_NEW_DB_FILE=0`).
- Bind HTTP server before state is built; queue requests/upgrades until ready.
- Build `AppState`; `--demo` seed; `--profile NAME=DIR` profiles; build router; debug routes.
- Answer requests: CORS preflight, `/api/open-token`, `/api/mcp/…`, `/api/otlp/…`, `/api/…` routes, else static UI.
- Websocket upgrade handling with auth, device revocation, hub relay.
- Start ~28 background services in a fixed order (section 6).
- Print `IA_READY {"port":N,"token":…}`; write supervisor `started`; gzip backups in the background.
- Graceful shutdown on SIGINT/SIGTERM/supervisor gone.
- Timestamp every `console.*` line and tee it to telemetry logs.

### HTTP plumbing (`http.ts`, `api.ts`, `api/extract.ts`)
- Router with `{param}` and `{*rest}` segments, static-beats-param scoring, per-route body limit and auth flag, websocket routes with a pre-upgrade check.
- Auth by board token or paired-device token; device allowlist; in-process trusted dispatch (`local_request`) used by hub proxy/tunnels.
- Body reading with limit, drain and 413; JSON parse; handler result → JSON 200, `Reply` → custom, `ApiError` → `{error}`.
- serde/axum-compatible rejections: 422 text for wrong body shape, 400 text for bad query.
- Per-route on-thread time accounting (`lag.record`).

### API handlers (`api/*.ts`)
- `profiles.ts`: list/create/update profiles; GitHub accounts/repos; Asana token check and task search; validators for reviewers/summarizers, base branch, agent access, tint, clone dir, config ids.
- `claude_configs.ts`: CRUD of agent configs (Claude/Codex, proxy fields); delete profile (cascade by hand); Codex models; export/import a config folder as base64 tar.gz.
- `projects.ts`: list/create/clone/create-on-GitHub/get/update/delete/branches; key rules; archive; relocate; cleanup of data-dir folders.
- `tasks.ts`: list (project/profile/group/scratch), get, update (the status state machine), stack title edit, delete (cascade by hand), preview-status probe, reminder/star checks.
- `new_task.ts`: create project task / scratch task / group task; `start_from` and `merges_into` parsing; external links; fanout id; labels.
- `thread.ts`: messages list/page, items thread snapshot/page/events/commands, send, assistant get/send, approval rules/log, answer question, unqueue, stop, stop background/server, review/extend/summary/fix_checks, worktree setup/teardown, system prompt preview, remove merged worktrees, setup thread, diff/unmerged, terminal status/kill/keepalive/ws, permissions list/resolve, project approvals.
- `host.ts`: settings get/patch, settings-sync get/merge/resolve, telemetry status/patch/test, remote tool call, server status/restart/update/release check/update/rollback/recopy db/install service, threads batch, folder browser.
- `docs.ts`: documents list/get/version render/move/relabel/delete, folder rename, label tree, image, hosted docs connect/publish, comments CRUD and send.
- `pens.ts`: pens list/create/update/delete, pens thread, per-pen thread, `pen`/`pen_id` on task update.
- `incoming.ts`: retargeting when `merges_into` changes; flagging tasks whose target closed/deleted; `POST /tasks/{id}/merge-target` choices.
- `stack_merge.ts`: `POST /tasks/{id}/merge-stack` (move a whole stack to Ready for merge as one run).
- `desktop.ts`: computer-use status/enable/install/uninstall/stop/check/frame/task ops.

### Small services
- `backup.ts`: `VACUUM INTO` backups in `<data>/backups`, naming, pruning (keep 2 + newest pre-major), gzip later, room check, failure classification, `server_version` file.
- `disk.ts`: per-profile disk report (repo, .git, worktrees incl. stray, scratch, runs, database, backups, filesystem) computed in a worker thread.
- `attachments.ts`: upload/download as base64 JSON, reference scan, per-task dirs for `--add-dir`, pruning.
- `analytics.ts`: prompt/run timeline, context stats, token/review report.
- `telemetry.ts` + `telemetry/`: outbox exporter to ClickHouse, metrics sampler, logs tee, settings/status/test, OTLP receiver for agents, schema, `telemetry` CLI (init/test/backfill).
- `lag.ts`: event-loop delay histogram, per-route thread time, stall log, `GET /api/debug/event-loop`.
- `crash.ts`: keep running on unhandled rejection / uncaught exception; `POST /api/debug/fault` with `IA_DEBUG_FAULTS=1`.
- `memory.ts`: full GC every 30 s when RSS grew ≥32 MB since last GC.
- `worker.ts`: run one exported function of a module in a throwaway worker thread.
- `proc.ts`: `run_cmd`/`run_ok` (execFile, 256 MB buffer, optional timeout/stdin).
- `util.ts`: ids, tokens, constant-time compare, tilde expansion, slug/key derivation, git-root/has-commits checks without git, truncate, `background()`, `err_str`, robust recursive delete, test race hooks, `make_private`.
- `demo.ts`: seed "Default" profile + "Demo" project + sample tasks/documents/doc versions (only on a host with no profiles).

## 3. Data

### Data dir layout (`--data-dir`, default `$XDG_DATA_HOME/huntaway` or `~/.local/share/huntaway`; `…/issue-agent` if only that exists)
| Path | What | Owner module |
|---|---|---|
| `auth_token` | API token, 64 hex chars, mode 0600, created on first use (ignored when `--token`/`IA_TOKEN` given) | serve.ts |
| `hub_token` | token other hosts use to dial in (`/api/hub/connect`) | serve.ts |
| `host_id` | this host's id (same generator as tokens: two UUIDs without dashes) | serve.ts |
| `server_version` | version string of the server that last opened the db (`<v>\n`) | backup.ts |
| `huntaway-2.db` (+`-wal`,`-shm`) | the database (current file) | db/file.ts |
| `huntaway.db` / `issue-agent.db` | older builds' database; read-only source of the first copy; used when `IA_NEW_DB_FILE=0` | db/file.ts |
| `huntaway-2.db.partial`, `huntaway-2.db.replaced`, `recopy-db` | copy in progress; previous file kept after a recopy; marker asking next start to recopy | db/file.ts |
| `backups/huntaway-<from>-to-<to>-<YYYY-MM-DDTHH-MM-SSZ>.db[.gz]` (+`.partial`) | backups | backup.ts |
| `attachments/<32-hex id>/<clean name>` | uploaded files | attachments.ts |
| `runs/<run_id>/` | each agent run's shim files (output, pid, exit) kept 14 days | agent/runs.ts |
| `projects/<project_id>/scratch`, `/worktrees`, `/agent`, `/agent-threads/<thread_id>` | per-project folders (scratch and worktrees root are settings and may be moved elsewhere) | api/projects.ts, agent_tools |
| `profiles/<profile_id>/scratch`, `/agent` | per-profile scratch folder (scratch/group tasks) and profile-scope agent tools | state.ts, agent_tools |
| `documents/<task_id>/` | task documents (plan/artifact/diagram) | agent/documents.ts |
| `skill-sources/` | cloned skill sources | agent_tools/sources.ts |
| `app/<version>/`, `app/<v>.partial/`, `app/state.json` | downloaded releases and their state | update/staging.ts, release.ts |
| `ssh/` | hub's SSH key etc. | hosts/ssh.ts |
| `gh-shim/` | gh wrapper for waits | mcp/wait.ts |
| `cua-driver/<version>/` | computer-use driver install | desktop.ts |
| `outgoing.bundle`, `incoming.bundle` | git bundles for hub→host updates | update/admin.ts |
| `demo/README.md` | demo project's folder (`--demo`) | demo.ts |
| `task-tmp/` | only in tests; in production task temp folders are under the OS tmpdir | agent/task_tmp.ts |

Outside the data dir: `$TMPDIR/huntaway-serve.XXXXXX/{next,started}` (launcher's restart file and started marker).

### Key in-code types
- `ServeArgs`: `host, port, data_dir, ui_dir, source_dir, update_from, release_updates, name, hubs[], hub_token, access_token, demo, open_token, recopy_db, discovery, telemetry_url, profiles[[name,dir]|null]`.
- `Identity`: `host_id, host_name, token, hub_token, internal_url` (`http://127.0.0.1:<port>`).
- `ServerMeta` (update/admin): `boot_id, started_at, source_dir, running_commit, update_from, release, args`.
- `Req`: `method, path, params, query (last value wins), query_string, headers, body (parsed JSON; {} when empty; null when not JSON), raw, pre?, incoming?, device?`.
- `Route`: `segs, methods (GET/POST/PATCH/DELETE/ANY → handler), ws?, pre?, limit (default 2 MiB), auth (default true)`.
- `Answer`: `status, headers, body Buffer`. `Reply(status, body, headers)`; `ApiError(status, message)` with `.bad` 400, `.not_found` 404 "`<what> not found`", `.conflict` 409.
- `CreateTask` (new_task.ts): section 7.
- `Health`: `{ok:true, commit, api_version, capabilities[], host_id}`. `HostInfo`: `{host_id, host_name, build_id, api_version, api_compat, capabilities, commit, updates_from, agents (bool), agent_clis[], version, data_dir, hostname, home}`.
- `HostSettings`: `default_model, default_effort, default_permission_mode, scratch_host, terminal_tools[], public_url, release_prereleases, thread_items, settings_sync`.
- `TaskDetail`: `{task, last_message (last assistant text), pending_permissions (count)}`.
- Disk `Report`: `{projects:[{id,name,key,repo_path,repo:{bytes,files}|null,git,worktrees:[{task_id|null,kind,number,title,status,path,size}],other,runs}], scratch, runs, runs_kept_days:14, database (bytes of db + wal), backups, filesystem:{total,free}, elapsed_ms}`.
- Analytics `Report`: `{events:[{at,task_id,kind: prompt|start|merge,text (≤280 chars, prompts only)}], runs:[{task_id,kind: prompt|compact|review,started_at,ended_at}], tasks:[TaskInfo], projects:[{id,name,key}]}`; review threads count toward their parent task.
- `ContextReport`: `{stats:[{at,task_id,kind: turn|compact,tokens,start_tokens,post_tokens,max_tokens,model,source: auto|user|idle,cost_usd,duration_ms}], tasks, projects}`.
- `TokenReport`: `{usage:[UsageRow], reviews:[ReviewRow], rounds:[RoundRow], follow_ups:[{task_id,created_by,at}], tasks:[UsageTask], projects, pending}` (UsageRow: `run_id|null, call_id|null, task_id, kind (prompt|compact|review|title|window), at, model, runtime, input/output/cache_read/cache_write(+_1h,_5m)/reasoning tokens, cost_usd, estimated`).
- Backup record: `{f, from, to, t (mtime), gz}`; `BackupFailed {reason: space|permissions|other, why, dir}`.

### Tables this area reads/writes directly (most access goes through `db.*` helpers owned elsewhere)
- `tasks`, `projects`, `profiles`, `claude_configs`, `runs`, `messages`, `thread_items`, `thread_requests`, `permission_requests` (count pending), `links` (via hub), `pens`, docs tables (`db/docs.ts`), `device_tokens`.
- `settings` keys written here: `default_model`, `default_effort`, `default_permission_mode`, `scratch_host`, `public_url`, `terminal_tools` (JSON list `{id,name,command}`), `release_prereleases` (`"true"`|null), `thread_items` (`"false"`|null = on), `settings_sync` (`"true"`|null), `desktop_tools` (computer use on, `"true"`|null), `demo_todos_seeded`, and telemetry: `telemetry_url`, `telemetry_database`, `telemetry_user`, `telemetry_password` (stored untrimmed), `telemetry_logs` (`off|info`; null = `warn`), `telemetry_agents` (`"false"`|null = on), `telemetry_inflight` (JSON `{target, first, last, at}`), `telemetry_dropped` (count), `telemetry_since` (ISO time sending first began).
- `telemetry_outbox (id autoincrement, target, row JSON text, at)`.
- Analytics read: `runs`, `context_stats`, `token_usage`, `call_usage`, `review_stats`, thread items (user messages), `tasks.created_by`.
- Profile columns `telemetry`, `telemetry_titles` gate what is sent.

### ClickHouse schema (`telemetry/schema.ts`; MergeTree, `non_replicated_deduplication_window=1000`)
- `events` (TTL 2 y): `ts, inserted_at, host_id, host_name, version, profile, project_id, project_key, task_id, task_key, task_title, run_id, session_id, event, kind, runtime, model, effort, tool, status, outcome, duration_ms, wait_ms, num_turns, input/output/cache_read/cache_write/reasoning tokens, cost_usd, estimated, exit_code, error, attrs Map`.
- `agent_events` (TTL 1 y): host/task columns + `runtime, agent_version, event, session_id, prompt_id, model, tool, decision, decision_source, success (1/0/-1), duration_ms, status_code, tokens…, cost_usd, error, attrs`.
- `logs` (TTL 30 d): `ts, host…, level, module, message, task_id, run_id, attrs`.
- `metrics` (TTL 90 d): `ts, host…, name, value, labels`.

## 4. In-memory state

`AppState` fields (every one):
| Field | Type | Purpose | Survives restart? |
|---|---|---|---|
| `conn` (private; `db()`) | SQLite connection | the one connection; single thread, no lock | file |
| `data_dir` | string | realpath of data dir | arg |
| `host_id`, `host_name`, `token`, `hub_token`, `internal_url` | strings | identity | files / args |
| `exe` | string | command that runs this server (for hooks and MCP helpers) | env `IA_TS_EXE` |
| `events` | `Broadcast<HostEvent>` | this host's events | no |
| `hub_events` | `Broadcast<BoardEvent>` | merged events of all hosts for UIs | no |
| `runs` | `Map<task_id, {run_id, cancel}>` | active runs | rebuilt from `runs` table by `runner.load_active` |
| `links` | `Map<host_id, link>` | connected linked hosts | reconnect from `links` table |
| `uplinks` | `Map<hub_id, Uplink>` | hubs taking our agents' board tool calls | re-registered on `hub_hello` |
| `link_tasks` | `Map<host_id, stop fn>` | outbound link loops | restarted |
| `local_router` | `Router` | route table, also for in-process requests | rebuilt |
| `perm_waiters` | `Map<request_id, callbacks[]>` | calls waiting on a permission decision | prompts are in the db; waiters re-attach |
| `calls_inflight` | `Map<call id, resolvers[]>` | MCP calls executing, with duplicate deliveries waiting | results recorded in db |
| `meta` | `ServerMeta` | boot id, commit, args | recomputed |
| `restart` | `RestartJob|null` | restart/update in progress (phase, log, error) | no |
| `deployed` | `Deployed|null` | last `--update-from` report | no |
| `release` | `Releases` | release check results | `app/state.json` partly |
| `usage` | `Map<config_id, usage>` | Claude usage limits cache | refetched |
| `project_changes` | `AsyncMutex` | serialises project create/update and setup-thread creation | n/a |
| `relocating` | `Relocations` | projects whose folders are moving | no |
| `deleting` | `Map<task_id, count>` | tasks being deleted; no child may be added meanwhile | no |
| `push` | `PushState` | web push state | db |
| `devices` | `Devices` | pairing codes (TTL 5 min, max 20, memory only) and a revocation counter | codes lost on restart by design |
| `telegram` | `TelegramState` | bot pollers | restarted |
| `cleanup` | fn[] | tests only | n/a |

`AppState` methods that matter: `emit`, `emit_task`, `emit_message`, `emit_message_updated`, `emit_thread_events`, `emit_delta`, `emit_delta_reset`, `add_message`, `add_event(task, level, text, detail)`, `update_task`, `update_task_if(id, fields, when)`, `sync_subproject`, `is_running`, `profile_scratch_dir`.
`update_task_if` side effects, in order: read old status; compute `preview_url` following a `pr_url` change (project `pr_preview_url` with `{pr}`); write; run status scripts + telemetry `task_status` if status changed; emit `task`; stack title follow-up; on becoming done, `worktree.keep_starts`; on `pr_url` set, link GitHub stacks; on status/running change, task temp folder cleanup; sync legacy subproject parent.

Module-level state: `lag.ts` (histogram, `routes` map, last 50 stalls, `busy` label), `crash.ts` (`recent` map of ≤100 error texts), `memory.ts` (RSS after last GC), `backup.ts` (`queue` promise chain serialising backups/compression), `telemetry.ts` (`active` Exporter: cfg, state, failures, timers, log window), `telemetry/otlp.ts` (`told` set), `api/desktop.ts` (`frames` cache, 400 ms), `util.ts` (`hooks` for tests), `serve.ts` (the `started` promise gate).

## 5. Outside the process

### Binaries spawned by this area
- `tar czf - -C <dir> <entries…>` / `tar xzf - -C <dir>` (config export/import).
- `git -C <dir> rev-parse --verify --quiet HEAD^{commit}` (reftable repos in `has_commits`); `git rev-parse HEAD` for the running commit.
- Worker threads (`node:worker_threads`) for disk report and pre-switch backup.
- Everything else (claude, codex, gh, tmux, ssh, ia-shim, systemctl…) is spawned by other areas.

### HTTP called
- Preview probe: `GET <url>` with 5 s timeout (server-side because browsers can't read cross-origin status).
- ClickHouse HTTP: `POST <url>/?database=…&query=…` with `X-ClickHouse-User`/`X-ClickHouse-Key`, gzip body ≥1 KB, 30 s timeout (10 s for test, 120 s for backfill).
- Asana (`asana.me`, `asana.search`) and GitHub via `gh` are called through integration modules.

### Ports and sockets
- One HTTP listener `--host:--port` (default `0.0.0.0:7878`; port 0 = pick free). Same port serves UI, API, websockets, MCP (`/api/mcp/`), OTLP (`/api/otlp/`).
- mDNS advertisement `_huntaway._tcp.local` unless loopback-only or `--no-discovery`.

### `serve` flags (each with env fallback)
`--host` (`IA_HOST`, `0.0.0.0`), `--port` (`IA_PORT`, 7878), `--data-dir` (`IA_DATA_DIR`), `--ui-dir` (`IA_UI_DIR`),
`--source-dir` (`IA_SOURCE_DIR`), `--update-from URL` (`IA_UPDATE_FROM`), `--release-updates OWNER/REPO`
(`IA_RELEASE_UPDATES`), `--name` (`IA_NAME`), `--hub URL[,URL]` repeatable (`IA_HUB`), `--hub-token` (`IA_HUB_TOKEN`),
`--token` (`IA_TOKEN`), `--demo` (`IA_DEMO`), `--open-token` (`IA_OPEN_TOKEN`), `--recopy-db` (`IA_RECOPY_DB`),
`--no-discovery` (`IA_DISCOVERY=0`), `--telemetry-url` (`IA_TELEMETRY_URL`), `--profile NAME=DIR[,…]` repeatable
(`IA_PROFILES`). Removed but tolerated with a warning (value consumed): `--broker`, `--broker-token`, `--broker-name`.
Forms `--flag value` and `--flag=value`. Unknown argument is an error. Boolean env: anything except `""`, `0`, `false`, `no`, `off`.

### Environment variables read by the server (name → meaning)
Serve configuration: `IA_HOST`, `IA_PORT`, `IA_DATA_DIR`, `IA_UI_DIR`, `IA_SOURCE_DIR`, `IA_UPDATE_FROM`,
`IA_RELEASE_UPDATES`, `IA_NAME`, `IA_HUB`, `IA_HUB_TOKEN`, `IA_TOKEN`, `IA_DEMO`, `IA_OPEN_TOKEN`, `IA_RECOPY_DB`,
`IA_DISCOVERY`, `IA_TELEMETRY_URL`, `IA_PROFILES` (as flags above).
- `IA_NEW_DB_FILE` → `0` keeps the board in the older db file (default on).
- `IA_SKIP_DB_BACKUP` / `IA_SKIP_DB_BACKUP_ONCE` → go ahead when a backup can't be made (always / this start only).
- `IA_LAG_LOG_MS` → stall threshold logged (default 250; 0 = none).
- `IA_DEBUG_FAULTS=1` → adds `POST /api/debug/fault`. `IA_DEBUG` → extra link/tool error logging.
- `IA_TELEMETRY_PASSWORD` → password for `huntaway telemetry …` when not in the URL.
- `IA_COMMIT` → commit a deployment without a checkout says it runs. (`IA_BUILD_COMMIT` is build-time, in `build.json`.)
- `IA_RELEASE_API` → GitHub API base for release checks (tests).
- `IA_DESKTOP_VERSION`, `IA_DESKTOP_SHELL`, `IA_DESKTOP_INSTALL`, `IA_BUNDLED_SERVER` → set by the desktop app that started the server.
- `IA_CLAUDE_BIN` (default `claude`), `IA_CODEX_BIN` (`codex`), `IA_SHIM_BIN` (ia-shim), `IA_GH_BIN` (`gh`), `IA_SSH_BIN` (`ssh`), `IA_TAILSCALE_BIN` (`tailscale`), `IA_SYSTEMCTL`, `IA_LOGINCTL`, `IA_SYSTEMD_BOOTED` (`1`/`0` override), `IA_CUA_DRIVER`, `IA_CUA_DRIVER_RELEASE`, `IA_DESKTOP_LOCKED` → program/behaviour overrides, mostly for tests.
- `IA_ASANA_URL`, `IA_TELEGRAM_API`, `IA_EXPO_PUSH_URL` → API base overrides (tests); `IA_EXPO_ACCESS_TOKEN`, `IA_PUSH_SUBJECT` → push config.
- `IA_CWD`, `IA_GH_ACCOUNT`, `IA_GH_GIT_TOKEN` → for the `gh-run`/`gh-hook` subcommands and git credential helper.
- `IA_KEEP_TEST_DIRS` → tests keep temp folders. `VITEST` → `IN_TEST` (shorter periods, stand-ins); the launcher unsets `VITEST` and `NODE_TEST_CONTEXT`.
- Launcher-only: `IA_NODE`, `IA_TS_EXE` (exported to node, removed by main.ts), `IA_RESTART_FILE`, `IA_SUPERVISOR_PID` (removed by `admin.take_supervisor`), `IA_SERVE_SIGNALS` (internal re-exec marker), `IA_CRASH_BACKOFF`, `IA_MALLOC_MMAP` + `MALLOC_MMAP_THRESHOLD_`, `NODE_OPTIONS`.
- Standard: `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`, `XDG_SESSION_ID`, `HOSTNAME`, `TMPDIR`, `TZ`, `SHELL`, `PATH`, `DISPLAY`, `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `SSH_ORIGINAL_COMMAND` (`link`), `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CLAUDE_CODE_ENABLE_TELEMETRY`/`OTEL_*` (presence = login has its own telemetry), `GH_*`/`GIT_*` (gh/git helpers).
- Variables the server *sets for children* (not read): `HUNTAWAY_TASK_ID`; status/setup script vars `IA_TASK_ID`, `IA_TASK_KEY`, `IA_TASK_NUMBER`, `IA_TASK_TITLE`, `IA_PROJECT_KEY`, `IA_REPO_PATH`, `IA_WORKTREE_PATH`, `IA_BRANCH`, `IA_PR_URL`, `IA_OLD_STATUS`, `IA_NEW_STATUS`, `IA_RESOLUTION`; terminal `IA_TOOL_NAME`, `IA_TOOL_COMMAND`; OTEL vars for agent runs.
- `agent_env()` (agent/runs.ts) removes all serve-config variables (`SERVE_ENV` list: the flags' env names plus `IA_RELEASE_API`, desktop vars, `IA_BUNDLED_SERVER`, `IA_TELEMETRY_URL`) and `HUNTAWAY_TASK_ID` from what agents and scripts inherit.

### Stdout protocol (read by the Electron shell and test scripts)
- `IA_READY {"port":N,"token":"…"|null}` (token null when it came from `--token`/`IA_TOKEN`). Never timestamped.
- `IA_BACKUP_FAILED {"reason","why","dir"}` before a failed start.
- Log lines go to stderr as `<ISO time>  INFO|WARN|ERROR <module>: …`.

## 6. Background work

### Startup order in `serve()` (exact)
1. `stamp_console()`; `crash.install()`; `lag.start()` (20 ms ticker + histogram); `memory.start()` (30 s).
2. `admin.take_supervisor()`; resolve data dir; `release.exec_installed` (if `--release-updates`); tokens; host name.
3. `backup.on_start`; delete `IA_SKIP_DB_BACKUP_ONCE`, `IA_RECOPY_DB` from env; open db; `thread_source.set_flips(conn, true)`; `make_private`; `backup.record_version`.
4. `createServer`, register request/upgrade handlers gated on `started`; `listen`.
5. Detect source dir, running commit, build `meta`, `AppState`; `demo.seed` (if `--demo`); `--profile` profiles (`db.ensure_profile` + scratch dir).
6. `api.router(state)`; `crash.debug_route`; `lag.debug_route`; find UI dir; `ready()`.
7. Start calls, in order:
   1. `telemetry.start(state, telemetry_url)` — exporter (before runs are caught up: their ends are events)
   2. `runner.load_active` — re-attach to runs that kept going while down
   3. `runner.auto_compact` — idle-session compaction loop
   4. `usage.resume_loop` — usage-limit waits
   5. `window.start` — usage window restarts
   6. `pr_watch.watch_in_review` — PR watcher for tasks in review
   7. `terminal.start_reaper` — idle terminal sessions
   8. `attachments.start_pruner` — now and every 6 h
   9. `runs.start_pruner` — run folders (hourly; 14 days) and old MCP calls
   10. `servers.start` — servers started by tasks' processes
   11. `task_tmp.start_sweeper` — task temp folders
   12. `permissions.start_sweeper` — expired permission prompts
   13. `automations.start` — schedules/webhooks
   14. `telegram.start` — bot pollers
   15. `workflows.move_all_review_settings` — one-off settings move
   16. `workflows.resume` — unfinished workflow runs
   17. `thread_batch.resume` — batch rebuild of threads as items
   18. `background(thread_source.flip_all)` — move threads onto items
   19. `merged.start` — detect merged PRs/branches
   20. `relocate.start_recording` — repo fingerprints
   21. `admin.start_update_check` — `--update-from` poll (5 min)
   22. `release.start` — release check (30 s after start, every 6 h)
   23. `push.start` — subscribe to events before links announce snapshots
   24. `settings_sync.start`
   25. `hub.start` — links to stored hosts
   26. `hub.dial_out` for each `--hub` (needs `--hub-token`)
   27. `discovery.respond` (if discovery on and not loopback-only)
   28. `staging.settle` — mark this release current
8. Install SIGINT/SIGTERM handlers; `admin.watch_supervisor(shutdown)` (1 s poll of ppid); telemetry `server_start`; print `IA_READY`; `admin.supervisor_started()`; `backup.compress_later`.

### Timers and limits in this area
| What | Value |
|---|---|
| Shutdown: `server.close()`, `closeAllConnections`, exit on next tick; hard exit | 2 s fallback |
| UI websocket tick | 25 s (`TICK_MS`) |
| UI websocket lag threshold → drop events then `resync` | `bufferedAmount` > 64 MiB |
| `/api/host/ws` ping / silence timeout | 20 s / 60 s (`relay.PING`, `relay.SILENCE`) |
| Body over limit: drain then 413 | up to 60 s (`drain_ms`) |
| Lag ticker / stall log | 20 ms / ≥250 ms (`IA_LAG_LOG_MS`), keep last 50 |
| Crash log de-dup | 60 s per identical text, map ≤100 |
| Memory GC check | 30 s, RSS growth ≥32 MiB |
| Attachment prune | every 6 h; unreferenced folders older than 7 days |
| Telemetry flush / batch | 10 s / 1000 rows (or immediately once 1000 added) |
| Telemetry backoff | `10 s × 2^(n-1)` capped 5 min, jitter ×0.5–1.0; setup errors 30 min |
| Telemetry outbox caps | 200 000 rows or 100 MiB → drop oldest down to 90% |
| Telemetry metrics sample | 60 s |
| Telemetry log tee cap | 100 lines/s; message cut 8192 chars; error cut 1024 |
| Preview probe timeout | 5 s |
| Desktop frame cache / driver calls | 400 ms / 15 s (check 30 s) |
| Pairing code TTL / max | 5 min / 20 |
| Backups kept | newest 2 + newest from before a major change |
| Backup connection busy timeout | 10 s |
| Launcher crash backoff | 1,2,4,8,16 s; 5 tries; reset after 600 s up |
| `remove_dir_all` retries | 10 |

## 7. Surface

### 7.1 Request pipeline
1. `OPTIONS /api…` → 200 with CORS and `access-control-max-age: 86400`.
2. `GET /api/open-token` (only with `--open-token`) → `{token}`; on a loopback-only server also requires a loopback `Host` header (else 404 no-route JSON) to defeat DNS rebinding.
3. `/api/mcp/…` → `mcp/http.ts` (runs' MCP servers, event streams, per-run secret). `/api/otlp/<run_id>/v1/(logs|metrics|traces)` → `telemetry/otlp.ts`.
4. `/api` or `/api/…`: set CORS headers on every answer (`access-control-allow-origin: *`, `-methods: *`, `-headers: *`, `vary: origin`); find route; **check auth before reading the body** (unauthorised or unknown routes never have their body read); read body up to the route's limit; `dispatch`.
5. Anything else → static UI; no UI dir → 404.
- `dispatch`: 404 `{error:"no such API route: METHOD /path"}`; 401 `{error:"unauthorized"}`; 403 `{error: why}` for a device; method lookup `METHOD` → `ANY` → (`HEAD` uses `GET`); 405 with the same no-route body; non-JSON body with `content-type` containing `json` on an authed route → 400 text `Failed to parse the request body as JSON`.
- Handler return → `200 application/json` (undefined → `null`). `Reply` with string/Buffer body → `text/plain; charset=utf-8` unless headers say otherwise. Unknown throw → 500 `{error: message with causes}` and logged.
- No CSP or other security headers are set by the server. No compression. No TLS (plain HTTP; meant for LAN/Tailscale/reverse proxy).

### 7.2 Auth
- Token sources per request: `Authorization: Bearer <t>` then every `?token=<t>` in the query. Compared with constant-time `same_secret`.
- Board token = `--token`/`IA_TOKEN` if given, else `<data>/auth_token` (created on first start; `huntaway token [--data-dir D]` prints it, `--hub` prints `hub_token`). Replacing it = delete the file and restart.
- Paired-device tokens (stored as SHA-256 in `device_tokens`) are accepted too but only for an allowlist of method+path patterns (`devices.HUB` / `devices.HOST`: ws, hosts, devices, push, profiles, projects, tasks, messages, thread, questions, stop, attachments, permissions, assistant). Paths with encoded `/ \ % ? #`, empty/`.`/`..` segments are refused. Sensitive handlers additionally call `devices.board_only(r.device, what)` (terminals, config export/import, desktop, host linking, join info).
- Routes without the board token: `GET /health`, `WS /hub/connect` (hub token as bearer, checked pre-upgrade → 401), `POST /hooks/{id}/{token}` (token in path), `POST /permissions/{id}/push-answer` (token in body), `POST /devices/pair` (one-time code), plus `/api/open-token`, `/api/mcp/*` and `/api/otlp/*` (per-run secret derived from the board token and run id).
- The UI reads `?token=` once and remembers it; with `--open-token` it fetches `/api/open-token` instead.
- In-process requests (`api.local_request`) are trusted and carry `Bearer <board token>`; a device identity can be passed along.
- `?token=` is stripped from the query before a websocket handler or a proxied host sees it.

### 7.3 Body limits and uploads
- Default 2 MiB. Overrides: `/h/{host_id}/{*rest}` 300 MiB; `/claude-configs/{id}/archive`, `/profiles/{id}/claude-config`, `/admin/update` 256 MiB; `/tasks/{id}/git/apply` 32 MiB; `/attachments` 16 MiB; `/hooks/{id}/{token}` 1 MiB; `/permissions/{id}/push-answer` 64 KiB; `/devices/pair` 16 KiB; OTLP 4 MiB (also after gunzip).
- Over the limit → 413 `{error:"length limit exceeded"}` with `connection: close`, sent only after the rest of the body is drained (or 60 s).
- All uploads are JSON with base64 (attachments, config archives, doc images) so they pass through the hub proxy/tunnel; an attachment is ≤10 MiB decoded (its base64 must fit a 16 MB tunnel frame). Base64 must be strict (padded, standard alphabet).

### 7.4 Static UI
- UI dir: a release this server updated to serves its own `ui/` beside the exe even if `--ui-dir` is set; else `--ui-dir`; else first with `index.html` of `<exe dir>/ui`, `apps/ui`, `apps/web/dist`.
- Path is percent-decoded and joined under the resolved root; outside root → `index.html`; directory → its `index.html`; missing → `index.html` (SPA fallback); no index → 404. Served to anyone (no token).
- `cache-control`: `/assets/*` non-HTML → `public, max-age=31536000, immutable`; everything else `no-cache`. Content types from a fixed extension map (html, js, mjs, css, json, svg, png, jpg, gif, ico, webp, woff, woff2, ttf, txt, wasm, webmanifest, map; else octet-stream); `text/*` gets `; charset=utf-8`. `HEAD` supported. No range requests, no ETag.

### 7.5 Websockets (all via `server.on("upgrade")`, `ws` package, `perMessageDeflate: false`)
- Only `/api/…` paths. Auth as `GET` on the path as sent; failure answers a raw HTTP error with `{error}` JSON.
- `/api/h/<host>/…`: if `<host>` is this host, rewritten to `/api/…` and trusted; otherwise relayed by `hub.proxy_ws` (503 offline, 502 can't open). A device's path is re-checked against the allowlist.
- Route `pre` check runs before the upgrade; its error becomes the HTTP answer.
- Every device socket is closed with code 1008 "this device was unpaired" when its device is revoked (terminate after 1 s).
- **`WS /api/ws`** (the UI's board socket, `hosts/hub/endpoints.ts`): client sends nothing. Server sends, as JSON text frames: `{type:"hello", host_id}` first; every `BoardEvent` from `hub_events` (a `HostEvent` plus `host_id`, or hub events `hosts_changed`, `resync` with optional `host_id`); `{type:"tick"}` every 25 s (not an event; a client that has seen one treats long silence as a dead connection and reconnects); when the socket's buffer passed 64 MiB events are dropped and the next delivered event is preceded by `{type:"resync"}` (no `host_id` = reload everything). No sequence numbers, no replay: a reconnecting client refetches.
- **`WS /api/host/ws`** (a hub linking to this host, `api.ts`): server sends `{type:"hello"}` then every `HostEvent`; pings every 20 s; terminates after 60 s without ping/pong/message. Client may send `{type:"hub_hello", hub_id, name, capabilities}` (registers an uplink so this host's agents' board tool calls go up; server then sends call frames) and `{type:"hub_result", …}` answers.
- **`WS /api/hub/connect`**: a host dialling in to this hub (tunnel protocol; hosts area).
- **`WS /api/tasks/{id}/terminal/ws?cols=&rows=&tool=`**: task terminal (tmux); pre-check 404 task / 503 no tmux / board only; cols/rows 2..1000 default 80×24.

### 7.6 Route table (183 router paths; all under `/api`; auth = board or device token unless noted)
Handler module in brackets (it carries on down the list until the next bracket). `{id}` is the id of the resource the
path starts with. Group sizes: 23 + 16 + 11 + 6 + 9 + 44 + 30 + 44 = 183, checked against `api.ts`'s `r.route`/`r.ws` calls.

**Hub-level routes (23)** — `api.router`
1. `GET /health` [api] no auth — `{ok, commit, api_version, capabilities, host_id}`.
2. `WS /hub/connect` [hosts/hub] hub token — a host dials in.
3. `POST /hooks/{id}/{token}` [integrations/automations] no auth, any body — automation webhook.
4. `POST /permissions/{id}/push-answer` [integrations/push_answers] no auth — `{token, decision: allow|deny}` from a notification.
5. `POST /devices/pair` [devices] no auth — `{code, name}` → `{token, device, host_id, host_name, api_version, capabilities}`.
6. `GET /hosts` — this host + linked hosts with live status; `POST /hosts` — link by `{url, token}` [hosts/hub].
7. `GET /hosts/join` — `{hub_token, host_token, command}` (board only).
8. `GET /hosts/discover` — LAN/Tailscale/mesh hosts with `linked`.
9. `GET /hosts/ssh-key` — hub's SSH public key.
10. `POST /hosts/ssh` — link a host over SSH.
11. `POST /hosts/copy-claude-config` — copy a config's login from one host to another.
12. `PATCH /hosts/{id}` — `{name?, uplink?}`; `DELETE /hosts/{id}` — forget a link.
13. `POST /hosts/{id}/update` — send this hub's code/version to a host.
14. `GET /preview-status?url=` [api/tasks] — `{up, status, error?}`.
15. `GET /push` [integrations/push] — push info (VAPID key etc.).
16. `POST /push/subscriptions` — subscribe.
17. `PATCH|DELETE /push/subscriptions/{id}` — change / unsubscribe.
18. `POST /push/subscriptions/{id}/test` — send a test push.
19. `GET /devices` [devices] — `{devices, current}`.
20. `POST /devices/pairing` — new one-time code `{code, expires_at, ttl_secs}`.
21. `PATCH|DELETE /devices/{id}` — rename / revoke.
22. `ANY /h/{host_id}/{*rest}` [hosts/hub] — proxy to any host's `/api/{rest}` (this host in-process; a linked host over its link; 503 offline, 502 error; refuses `.`/`..` segments; strips `?token=`; a `PATCH tasks/<id>` with `status` is noted so the mover isn't pushed a notification).
23. `WS /ws` [hosts/hub] — board events (7.5).

**Host info and settings (16)**
24. `GET /info` [api] — `HostInfo`.
25. `GET /default-prompts` [agent/prompts] — default start/review/merge prompts.
26. `GET /usage` [agent/usage] — usage limits of configs that show usage.
27. `GET|PATCH /settings` [api/host] — `HostSettings`; emits `settings_changed`.
28. `GET /settings-sync` — sync status and entries.
29. `POST /settings-sync/merge` — `{entries}` → `{merged}`; 409 when off.
30. `POST /settings-sync/resolve` — `{name, value?}`.
31. `GET|PATCH /telemetry` — status (never the password) / change `url, database, user, password, logs, agents`.
32. `POST /telemetry/test` — `{ok, error}` (empty insert into `events`).
33. `GET /fs/dirs?path=` — folder browser: `{path, parent, exists, is_git, entries:[{name,path,is_git,hidden}]}`; default home; missing absolute path listed as empty.
34. `POST /tools/{tool}` — board tool call forwarded from another host's agent: `{profile, args, task_fields?}` → `{result}` or 400 `{error}`.
35. `GET /permissions?task_id=&profile_id=` [api/thread] — pending prompts.
36. `POST /permissions/{id}` — `{decision: allow|allow_always|deny, message?, answers?, mode?, feedback?, automation?:{model,effort}, via?: "push"}` → `{ok, status: allowed|denied}`.
37. `GET /project-approvals?all=&automations=&workflows=` — approvals agents wait on.
38. `POST /attachments` [attachments] — `{name, data(base64)}` → `{id, name, path, size, mime}`.
39. `GET /attachments/{id}/{name}` — `{name, size, mime, data}`.

**Admin (11)** [api/host]
40. `GET /admin/server` — `ServerStatus` (+`service`).
41. `POST /admin/restart` — `{rebuild=true}` starts a restart job.
42. `POST /admin/update` — hub asks this host to update: `{commit, bundle?, branch?, version?}`.
43. `POST /admin/release/check` — check now.
44. `POST /admin/release/update` — `{version}`.
45. `POST /admin/release/rollback`.
46. `POST /admin/database/recopy` — copy the older db again (restart job).
47. `POST /admin/service` — install user systemd service and restart under it.
48. `GET /admin/threads` — `{pending, batch}`.
49. `POST /admin/threads/batch` — start or `{stop:true}`.
50. `WS /host/ws` [api] — this host's events for a hub (7.5).

**Computer use (6)** [api/desktop] (board only)
51. `GET|PATCH /desktop` — status / `{enabled}`.
52. `POST|DELETE /desktop/install` — install / uninstall driver.
53. `POST /desktop/stop`.
54. `POST /desktop/check` — start driver and report permissions.
55. `GET /desktop/frame?task_id=|pid=&window_id=` — `{frame:{mime,data,width,height,pid,window_id,at}}` or `{frame:null, reason}`.
56. `GET /tasks/{id}/desktop` — `{ops, target}`.

**Profiles and agent configs (9)**
57. `GET|POST /profiles` [api/profiles].
58. `PATCH /profiles/{id}` [api/profiles]; `DELETE /profiles/{id}` [api/claude_configs.delete_profile].
59. `GET /github-accounts` [api/profiles] — accounts `gh` is signed in to.
60. `GET /github-repos?account=&q=` — repos to clone.
61. `GET|POST /claude-configs` [api/claude_configs].
62. `PATCH|DELETE /claude-configs/{id}`.
63. `GET /claude-configs/{id}/models` — Codex models (empty for Claude).
64. `GET|POST /claude-configs/{id}/archive` — export `{archive, files, bytes}` / import `{archive, overwrite}` (board only).
65. `GET|POST /profiles/{id}/claude-config` — same for the profile's default config dir (legacy).

**Per-profile (44)**
66. `GET /profiles/{id}/projects?archived=`; `POST` create `{name?, repo_path, key?, base_branch?, use_worktrees?}` [api/projects].
67. `POST /profiles/{id}/projects/clone` — `{repo: OWNER/REPO, repo_path?, name?, key?}`.
68. `POST /profiles/{id}/projects/github` — `{repo_path, visibility: public|private, name?, key?, repo_name?, owner?}` → project + `github:{full_name,pushed,push_error}`.
69. `GET /profiles/{id}/tasks?include_assistant=` [api/tasks]; `POST` scratch task [api/new_task].
70. `GET /profiles/{id}/scratch` [api/tasks] — legacy scratch chats (always empty now).
71. `GET|POST /profiles/{id}/assistant[?local]` [api/thread] — get-or-create assistant task (+`host_id`) / send `{text}`; routed to the profile's assistant host unless `local`.
72. `GET /profiles/{id}/assistant/memory` [agent/assistant/memory] — overview.
73. `GET|POST /profiles/{id}/assistant/memory/file` — read / write a memory file.
74. `GET /profiles/{id}/assistant/memory/history`.
75. `GET /profiles/{id}/assistant/memory/diff`.
76. `POST /profiles/{id}/assistant/memory/restore`.
77. `POST /profiles/{id}/assistant/memory/import`.
78. `GET|POST /profiles/{id}/assistant/google` [agent/assistant/google] — status (`?check=1`) / set up Google server.
79. `POST /profiles/{id}/assistant/brief` [agent/assistant/brief] — add morning brief routine `{time?, weekdays?}`.
80. `POST /profiles/{id}/assistant/brief/feedback` — `{rating, kind?, topic?, text?}`.
81. `GET|POST /profiles/{id}/approval-rules` [api/thread] — `{rules, expiry_minutes, is_default, defaults, board_server, google_server, create_task_tools}` / `{rules?, expiry_minutes?}` or `{reset:true}`; emits `approval_rules`.
82. `GET /profiles/{id}/approval-log?limit=` (default 200).
83. `GET|PATCH /profiles/{id}/telegram` [integrations/telegram].
84. `POST /profiles/{id}/telegram/link`.
85. `DELETE /profiles/{id}/telegram/owner`.
86. `GET /profiles/{id}/group-tasks?include_assistant=&include_pens=&include_pen_threads=` [api/tasks]; `POST` group task `{group, …CreateTask}` [api/new_task].
87. `GET /profiles/{id}/analytics?from=&to=` [analytics].
88. `GET /profiles/{id}/context-stats?from=&to=`.
89. `GET /profiles/{id}/token-stats?from=&to=`.
90. `GET /profiles/{id}/disk-usage` [disk].
91. `GET /profiles/{id}/asana/tasks?q=` [api/profiles] — 409 when Asana off/not connected; 502 on Asana error.
92. `GET /profiles/{id}/automations`; `POST` — profile routines [integrations/automations].
93. `GET|POST /profiles/{id}/pens` [api/pens] — `{name, active=true, color?}`; 409 on duplicate name.
94. `GET /profiles/{id}/pens-thread` — profile's pens thread (created on demand).
95. `PATCH|DELETE /pens/{id}` — `{name?, active?|hidden?, color?, index?}` / delete (tasks leave the pen; its thread is deleted).
96. `GET /pens/{id}/thread` — the pen's own thread.
97. `GET /profiles/{id}/docs?label=` [api/docs].
98. `GET|PATCH|DELETE /profiles/{id}/docs/{slug}` — detail / `{folder?, labels?}` / delete.
99. `POST /profiles/{id}/doc_folders/rename` — `{from, to}` → `{moved}`.
100. `GET /profiles/{id}/doc_labels` — `{labels (tree), documents, unlabelled}`.
101. `GET /profiles/{id}/doc_images/{sha}` — `{sha256, mime:"image/avif", data}`.
102. `GET /profiles/{id}/docs/{slug}/versions/{n|latest}?base_url=&path=&first=1` — rendered pages (`html, toc, has_h1, warnings, error`), `nav`.
103. `POST /profiles/{id}/docs/{slug}/publish` — `{version?, slug?, ask?}` → `{published, warnings}` or `{exists}`.
104. `GET|POST /profiles/{id}/docs/{slug}/comments` — `{comments, task, can_send}` / `{version, page, quote, prefix?, suffix?, comment?}`.
105. `PATCH|DELETE /profiles/{id}/docs/{slug}/comments/{cid}`.
106. `POST /profiles/{id}/docs/{slug}/send_comments` → `{sent, task}`.
107. `GET|DELETE /profiles/{id}/hosted_docs` — status / disconnect.
108. `POST|DELETE /profiles/{id}/hosted_docs/device` — start `{site_url}` / cancel device sign-in.
109. `POST /profiles/{id}/hosted_docs/token` — `{site_url, token}`.

**Projects, automations, workflows, agent tools (30)**
110. `GET|PATCH|DELETE /projects/{id}` [api/projects].
111. `GET /projects/{id}/tasks?kind=task` [api/tasks]; `POST` create task [api/new_task].
112. `POST /projects/{id}/remove-merged-worktrees` [api/thread] → `{results:[{task_id,number,title,removed,detail}]}`.
113. `POST /projects/{id}/setup-thread` — `{message?}`; one per project.
114. `GET /projects/{id}/system-prompt?type=&labels=&worktree=&runtime=&permission_mode=` → `{text, runtime, permission_mode}`.
115. `GET /projects/{id}/branches` [api/projects] → `{branches:[{name, remote}]}`.
116. `GET|POST /projects/{id}/automations` [integrations/automations].
117. `GET|PATCH|DELETE /automations/{id}`.
118. `POST /automations/{id}/run`.
119. `GET /automations/{id}/runs`.
120. `GET|POST /projects/{id}/workflows` [integrations/workflows].
121. `GET|PATCH|DELETE /workflows/{id}`.
122. `POST /workflows/{id}/run`.
123. `GET /tasks/{id}/workflow-runs`.
124. `POST /workflow-runs/{id}/stop`.
125. `GET /agent-tools` [agent/agent_tools] — host-wide skills, MCP servers, switches.
126. `POST /agent-tools/switches`.
127. `POST /agent-tools/skill-sources`.
128. `DELETE /agent-tools/skill-sources/{source}`.
129. `POST /agent-tools/skill-sources/{source}/update`.
130. `POST /agent-tools/skills`.
131. `PATCH|DELETE /agent-tools/skills/{skill}`.
132. `POST /agent-tools/mcp-servers`.
133. `PATCH|DELETE /agent-tools/mcp-servers/{server}`.
134. `GET|PATCH /projects/{id}/agent-tools`.
135. `POST /projects/{id}/agent-tools/skills`.
136. `PATCH|DELETE /projects/{id}/agent-tools/skills/{skill}`.
137. `POST /projects/{id}/agent-tools/mcp-servers`.
138. `PATCH|DELETE /projects/{id}/agent-tools/mcp-servers/{server}`.
139. `GET /tasks/{id}/skills` — skills available to a task.

**Tasks (44)**
140. `GET /tasks/{id}` → `TaskDetail`; `PATCH` update; `DELETE ?delete_branch=` [api/tasks].
141. `PATCH /tasks/{id}/stack` — `{title?, description?}` (pins) or `{regenerate:true}`.
142. `GET /tasks/{id}/messages[?before=&after=&limit=]` — list or `{messages, more, subagents}`; `POST` `{text}` send [api/thread].
143. `GET /tasks/{id}/thread[?limit=]` — items snapshot `{thread, items, requests, seq}`.
144. `GET /tasks/{id}/thread/items?before=I[&limit=100]`.
145. `GET /tasks/{id}/thread/events?after=SEQ[&limit≤1000]` → `{events, more, seq}` or `resync`.
146. `POST /tasks/{id}/thread/commands` — a protocol command → `{ok, result}`.
147. `POST /tasks/{id}/questions/{message_id}` — `{choices[], text?}`.
148. `POST /tasks/{id}/stop` → `{stopped}` (agent, review, summary, workflow runs).
149. `POST /tasks/{id}/background/stop` — `{id?}` → `{stopping[]}`.
150. `POST /tasks/{id}/servers/{port}/stop`.
151. `DELETE /tasks/{id}/queue` — drop queued message.
152. `POST /tasks/{id}/wait-for-limit` [agent/usage] — wait in In progress until the usage limit resets.
153. `POST /tasks/{id}/review` [api/thread] — review now.
154. `POST /tasks/{id}/review/extend` — give as many fix rounds again.
155. `POST /tasks/{id}/summary` — summarise the changes now.
156. `POST /tasks/{id}/fix_checks` — send the agent its PR's failed checks.
157. `POST /tasks/{id}/worktree/setup` — 409 if an agent works in it.
158. `POST /tasks/{id}/worktree/teardown` — `{force?, delete_branch?}`.
159. `GET /tasks/{id}/diff` — the task's changes against its base.
160. `GET /tasks/{id}/unmerged` → `{unmerged}`.
161. `GET /tasks/{id}/fanout` [review/fanout].
162. `POST /tasks/{id}/fanout/pick`.
163. `POST /tasks/{id}/merge-target` [api/incoming] — `{to: "onward"|"close"|<task id>}` → `{tasks}`.
164. `POST /tasks/{id}/merge-stack` [api/stack_merge] → `{tasks}`.
165. `POST /tasks/{id}/tracked/remove` [agent/assistant/tracked] — `{ids}`.
166. `GET /tasks/{id}/git` [git/git_view] — status.
167. `GET /tasks/{id}/git/diff`.
168. `GET /tasks/{id}/git/show?rev=&stash=`.
169. `POST /tasks/{id}/git/stage` — `{paths}`.
170. `POST /tasks/{id}/git/unstage`.
171. `POST /tasks/{id}/git/discard` — `{paths, staged}`.
172. `POST /tasks/{id}/git/apply` — `{patch, cached, reverse}`.
173. `POST /tasks/{id}/git/commit` — `{message, amend, reword}`.
174. `POST /tasks/{id}/git/stash` — `{action: push|apply|pop|drop, mode?, index?, sha?}`.
175. `POST /tasks/{id}/git/reset` — `{rev, mode: soft|mixed|hard}`.
176. `GET /tasks/{id}/turns` [git/checkpoints] — per-turn checkpoints.
177. `GET /tasks/{id}/turns/diff` — a turn's changes.
178. `POST|DELETE /tasks/{id}/rewind` — rewind / cancel.
179. `GET /tasks/{id}/context` [agent/context] — context summary and latest breakdown.
180. `GET /tasks/{id}/document?label=&version=` [agent/documents].
181. `GET|DELETE /tasks/{id}/terminal?tool=` [api/thread] — status / kill.
182. `WS /tasks/{id}/terminal/ws`.
183. `POST /tasks/{id}/terminal/keepalive?tool=`.

Outside the router: `GET /api/open-token`, `/api/mcp/*`, `POST /api/otlp/{run}/v1/{logs|metrics|traces}`, and debug
`GET /api/debug/event-loop[?reset=1]` (always, authed) and `POST /api/debug/fault` (`IA_DEBUG_FAULTS=1`).

### 7.7 Task statuses and `PATCH /tasks/{id}` (`api/tasks.ts`)
Statuses: `todo`, `in_progress`, `needs_attention`, `in_review`, `ready_for_merge`, `done`, `backlog`. Resolutions (done only): `done`, `not_done`, `wont_fix`.
Updatable fields: `title, title_pinned, description, status, resolution, position, use_worktree, model, effort, base_branch, start_from, permission_mode, preview_url, pr_url, external_links, subproject, claude_config_id, depends_on, starred, remind_at, reminder, done_at` plus `labels`, `merges_into`, `pen`/`pen_id`, and control flags `todos_override`, `remerge`.

Field rules:
- `title` non-blank string (changing it sets `title_pinned=true` unless the request sets it); `description` string (null → ""); `position` number; `use_worktree` boolean; `model` string|null.
- `effort` null/"" or one of `minimal, low, medium, high, xhigh, max, ultra`; `permission_mode` null or `default, acceptEdits, auto, plan, dontAsk, bypassPermissions`.
- `preview_url`/`pr_url` null/blank or http(s).
- `claude_config_id` only before the agent has a session and while not running (409), must be one of the project's/profile's configs.
- `depends_on` list of task ids, checked for same project and cycles.
- `done_at` only on a done task, RFC 3339 → UTC ms.
- `starred` boolean; `remind_at` null/blank or RFC 3339; `reminder` ≤500 chars and needs a time; clearing the time clears the note.
- `start_from`/`base_branch`/`use_worktree` (worktree settings): 409 "tear down the worktree" unless the worktree is unmade (`worktree_state none`, or `error` with no branch and no folder, which is reset to `none`). A branch that exists fixes `start_from`. `start_from` and non-null `base_branch` are exclusive; setting one clears the other.
- `merges_into`: project code tasks with a worktree; target not done, not a subproject, no cycle through `merges_into`/`start_from`/`parent_id`; refused when the task is done (400) or merging (409). Start/base follow via `incoming.retarget_fields`.
- `subproject`: can only be turned off (new subprojects refused with a fixed message); 409 while it has tasks.
- Assistant, pens thread and pen threads can't go to `in_review`, `ready_for_merge`, `done`, `backlog`.
- Todo hold (HA-330): moving out of `in_progress` with unfinished agent todos → 409 unless `todos_override: true`.

What a status change writes besides `status`:
- not `needs_attention` → `attention_reason=null`.
- not `in_progress` and task was `waiting` → `waiting=false`.
- to `ready_for_merge` (from elsewhere, kind task) → `merging=true`, `merge_approval=null` unless already approved, `stack_run=<run>|null`, `position` = end of the merge queue if none given; any status other than `ready_for_merge`/`needs_attention` → `merging=false`.
- `remerge:true` (only while merging, running, and moving to `in_progress`; not while approval is pending) → `remerge=true`.
- `agent_wait` set and status changes → `agent_wait.moved_to=<status>` (ends the agent's wait).
- DB layer: done ⇒ `resolution` defaults `done` and `done_at` set (kept while done); not done ⇒ both null; done ⇒ `restack=null`; leaving the merge clears `stack_run`, `remerge`, `merge_approval`.

Refusals on moving to Ready for merge: agent running (409); PR approval required and missing on GitHub (409); nothing to merge (scratch, documents-only, no changes) → silently becomes `done` with an info event instead.

All preconditions are re-checked inside `update_task_if`'s `when` callback against the row as it is at write time (status moved meanwhile, running, worktree made, session started, PR changed, subproject gained tasks, merge target/branch changed) → 409/400.

After the write, in order: settle a replaced merge approval; info events (stepped out of queue; host can't run agents); `title.refresh` if unpinned; apply permission mode to pending prompts; if moved into `in_progress` with unmet dependencies → `runner.wait_for_dependencies`; `runner.config_changed`; `runner.start_unblocked` (status/resolution/depends_on); `incoming.on_task_changed` (closed without merge → flag dependants to Needs attention); `worktree.restack_stacked_on` when it became merged; stack-wait info event; retarget follow-up (`follow_base` + event); then for a status change: `runner.start_next_merge`, `review.on_in_review` (entering `in_review`), `workflows.on_status`, `terminal.kill_all` (entering `done`). Via `AppState.update_task_if` also: status scripts, telemetry `task_status`, `task` event, temp-folder cleanup, `keep_starts` on done.

`DELETE /tasks/{id}` (not the assistant): mark in `deleting`; for a subproject/assistant delete children first; per task: abort run, expire permission prompts, same for its review threads, kill terminals, collect attachments, wait for worktree lock then teardown (force, optional branch delete), compute orphans (`db.reaching`) and stack levels unless merged, move stack title, `worktree.unstack`, `incoming.follow_deleted`, forget start ref, delete row, remove finished run folders, review-thread skills, temp folder, expire deletion approvals, documents, flag orphans/levels, drop it from others' `depends_on` (emit each), remove unreferenced attachments, emit `task_deleted` for reviews then the task; finally sync subproject, `start_next_merge`, `start_unblocked`.

### 7.8 Creating tasks (`api/new_task.ts`)
Body `CreateTask` (all optional): `title`, `description`, `status` (default `todo`), `resolution` (only with done),
`use_worktree`, `model`, `effort`, `kind` (must be `task`), `start` (`true` or a string = start the agent now, string is an
extra prompt), `parent_id` (an existing legacy subproject in the same project), `subproject` (refused), `claude_config_id`,
`depends_on[]`, `task_type` (`scratch`; `subproject` refused; a label name is treated as a label), `labels[]`
(`plan|artifact|diagram`), `external_links[{provider:"asana", id ≤100 bytes, url http(s), title ≤500 chars}]` (≤20, deduped),
`fanout_id` (≤64 `[A-Za-z0-9_-]`), `start_from`, `merges_into`.
- Project task (`POST /projects/{id}/tasks`): project not archived; title or description required; no title → placeholder now and `title.generate` later (which then starts the agent, since the title names the branch); `use_worktree` = explicit, else project `use_worktrees && is_git`, forced true inside a subproject, false for task types; `merges_into` target → also `start_from: {type:"task"}` unless given; inherits `base_branch` from parent's branch.
- `start_from` text forms: `task:KEY-N|id`, `branch:name`, `pr:12|#12|PR URL`, `commit:<7–40 hex>`, or bare (task key/id → PR `#n`/URL → hex commit → branch); object form `{type: task|branch|pull_request|commit, …}`. Validated: branch name valid, task in same project with a branch, no cycle.
- Scratch task (`POST /profiles/{id}/tasks`): no project, no worktree/deps/subproject; default title "New scratch task".
- Group task (`POST /profiles/{id}/group-tasks`): `group` must name a group of the profile's projects; no worktree.
- Task keys: project key + number; `G-n` group, `S-n` scratch, `A-n` assistant (so project keys G/S/A are reserved).

### 7.9 Projects and profiles (rules worth keeping)
- Project key: 1–10 letters/digits, uppercased, unique per profile including every project's `former_keys` (old task keys keep resolving); derived from the name (initials of first 3 words or first 3 letters; `T` fallback; suffix numbers on clash).
- Create: folder created if absent (absolute only), canonicalised; `base_branch` = given or current branch; data-dir folders `projects/<id>/{scratch,worktrees}`; `repo_root` fingerprint.
- Update fields (`PROJECT_FIELDS`): name, key, repo_path (+`move_repo`), base_branch, setup/teardown/status scripts, `status_scripts{status: script}`, use_worktrees, permission_mode, model, worktrees_root (absolute, not the repo), auto_review, review_rounds (0–20), reviewers, auto_summary, summarizer(s), claude_config_ids, start/review/merge prompts, group_name (≤100), archived, merge_approval, require_pr_approval, github_account, done_when_merged, use_workflows, pull_requests, subproject_pull_requests, watch_pull_requests (`off|failures|all`), pr_preview_url (must contain `{pr}`), copy_files, link_folders.
- Archive refused (409) while any of its agents runs. Unarchive restarts merge queue and unblocked tasks.
- Delete project: abort runs, expire prompts, kill terminals, `git worktree remove --force` each (branches kept), prune, delete row, remove run folders/documents/attachments, remove `projects/<id>` unless something still in use lives inside it; emit `project_deleted`.
- Profile: name unique case-insensitively; `agent_access` list of profile names or `["*"]`; reviewers ≤6, each `{claude_config_id, model, effort, name?, skills[≤20]?, prompt ≤20000?}`; `summarizer` legacy mirror of `summarizers[0]`; `assistant_config_id`/`threads_config_id` must be among its configs; `asana_token` verified with Asana before saving; `tint` `#rrggbb`.
- Config: `agent` `claude|codex`; proxy fields `api_url` (http/https), `api_key`, `management_key` (write-only; Codex can't have a proxy); agent kind can't change once threads have sessions; can't delete while agents run with it.
- Config archive entries (Claude): `.credentials.json, .claude.json, settings.json, settings.local.json, CLAUDE.md, keybindings.json, agents, commands, skills, plugins, hooks, output-styles`; (Codex): `auth.json, config.toml, AGENTS.md, skills, rules, prompts`. Import refuses to overwrite a login without `overwrite`; dir chmod 0700.

### 7.10 CLI subcommands (`main.ts`)
`serve` (default), `gh-hook`, `approval-hook`, `gh-run`, `codex-run <dir>`, `google-auth`, `token [--hub] [--data-dir D]`,
`title-check`, `threads-import`, `threads-rebuild`, `ssh-host`, `install-service`, `telemetry init|test|backfill`,
`--version|-V` (`huntaway <version>`), `--help|-h|help`. Unknown → exit 2.

## 8. Events

Emitted by this area (on `s.events`; payloads in `wire/events.ts`):
- `task {task}` — every task write through `emit_task`/`update_task`.
- `task_deleted {id, project_id}`; `project {project}`; `project_deleted {id}`.
- `profiles_changed` — profile or config created/changed/deleted, a link removed that was an assistant host.
- `settings_changed`; `approval_rules {profile_id}`; `pens {profile_id}`.
- `docs {profile_id, slug, deleted?}`; `doc_comments {profile_id, slug}`.
- `message`, `message_updated`, `delta`, `delta_reset`, `thread_event` — via `AppState` helpers for all areas.
- Thread info lines via `add_event(task, level info|warn, text)`.
Consumed: `s.events` by `/api/host/ws`; `s.hub_events` by `/api/ws`; `devices.watch` for revocations.

Telemetry event names (ClickHouse `events.event`): `server_start` (attrs boot_id, build_id, node, platform), `server_update`, `error` (unhandled rejection/exception), `task_status` (attrs from), `run_start`, `run_end`, `run_usage`, `side_call`, `permission`, `review`, `merge` (requested/merged), `board_tool`, `automation_run`, `link_up`, `link_down`, `telemetry_dropped` (attrs rows). Metrics names: `event_loop_delay_p50_ms|p99_ms|max_ms`, `rss_bytes`, `heap_used_bytes`, `runs_running`, `tasks_needing_attention`, `telemetry_outbox_rows`, `route_ms{route}` (top 5 per minute).

## 9. Invariants and hard-won rules

- **Requests during startup wait.** The listener is bound before state exists; handlers await a `started` promise, so a client reconnecting after a restart isn't dropped (serve.ts).
- **Auth before body.** A request that fails auth or matches no route never has its body read, otherwise anyone could make the server buffer 300 MB (serve.ts comment).
- **413 after draining.** Closing early made clients see ECONNRESET/EPIPE instead of the 413 (HA-185, HA-233); the body is read and dropped, answer has `connection: close`.
- **Open routes take small bodies only** (64 KiB / 16 KiB / 1 MiB).
- **Open-token + loopback host check** against DNS rebinding.
- **Static files never leave the UI root**, and a relative `--ui-dir` must be resolved (it once served index.html for everything).
- **Device access is an allowlist**, because a deny list missed routes twice; plus a second check in sensitive handlers; decoded-path tricks are refused.
- **Proxy passes the path raw** but refuses `.`/`..` segments (a host linked under a URL path could be escaped) and never forwards the caller's `?token=`.
- **SQLite type safety at the edge**: wrong JSON types are refused with 400 rather than stored ("SQLite keeps a value of the wrong type… every list with the task in it would fail until repaired by hand", tasks.ts).
- **Check-then-write races**: every async precondition of a task update is rechecked synchronously at write time (`update_task_if`). `merge_stack_inner` recomputes the stack after its GitHub reads and refuses if it changed.
- **Project changes are serialised** by `project_changes` (key uniqueness, folder moves, former keys, setup thread creation). `preview_project_update` tries the DB change (rolled back) before a folder move; if the DB write fails after the move, the new paths are still stored.
- **Deleting flag** blocks adding tasks to a subproject being deleted (cascade would take them unstopped).
- **Deletes are by hand, not by FK cascade**: runs aborted, prompts expired, terminals killed, worktrees removed under the worktree lock, review threads first.
- **Clone/create-on-GitHub reserve the destination folder** so a repeated request waits and then finds the project; they continue even if the HTTP client goes away.
- **Data-dir folder removal is guarded**: a project's/profile's folder is kept if any repo, worktree, scratch path or work dir on the host still lies inside it.
- **Backups**: made before opening the db when another version last ran and opening could change it; written to `.partial` then renamed; no backup → no start (unless `IA_SKIP_DB_BACKUP[_ONCE]`); compress and prune are serialised (prune would delete the file being compressed); gz keeps the original mtime (pruning and `last_server` use it); `server_version` is also written before switching to a server that doesn't write it.
- **Telemetry never interferes**: every emit is wrapped in try/catch; exporter's own log lines are not teed (loop); in-flight batch identity is persisted so a retry reuses the same dedup token; rows from an unknown table (newer build) are deleted; password stored untrimmed and never returned; a task's rows/log lines go only if its profile opted in; titles only with `telemetry_titles`.
- **OTLP receiver**: run can only send as itself (secret bound to run id); fixed attribute allowlist; error text kept only for API events; metrics/traces accepted and dropped so agents don't retry; a login with its own OTEL config is left alone.
- **Children must not inherit server config**: launcher/`main.ts`/`take_supervisor`/`agent_env` strip `IA_TS_EXE`, malloc vars, restart file, supervisor pid, serve env, one-shot flags.
- **Carry on after uncaught errors** (crash.ts): single thread + synchronous transactions that roll back make continuing safe; exiting would drop every socket and may loop. Every promise must be awaited, caught or wrapped in `background()` (enforced by a test).
- **Server restarts keep the pid** (service managers, Electron and scripts track it); agents run under `ia-shim` and survive.
- **One thread**: anything slow (disk walk, VACUUM) goes to a worker with plain-data arguments and its own db connection.
- **`remove_dir_all`** re-checks and retries: `rmSync` can return success with the folder still there while git maintenance runs (HA-252), and async `rm` fails ENOTEMPTY when an agent still writes (HA-253).
- **Attachment references are found by scanning text** for `attachments/<32 hex>/` in task description, queued message, steering, messages, thread items and requests; prune only after 7 days so drafts survive.
- **Legacy client compatibility baked into handlers**: `summarizer` vs `summarizers`, `claude_config_dir` vs `claude_config_ids`, `hidden` vs `active` on pens, `task_type` as label, messages list vs page, proxied 404/405 with empty body rewritten.

## 10. How it is tested

- Vitest (`vite-plus/test`), forks pool (one process per file), 60 s timeouts; tests beside modules (`*.test.ts`) plus `tests/`.
- `testing.ts`: `state()` (AppState on `:memory:` db, temp data dir, empty token, host id `h`), variants `state_with/as/at/on`, `on_items`, `message(s)`, `temp_dir`, `free_port`, `until`, `error_of`, `fails`, `legacy_subproject`; `testing/git.ts` (`git`, `git_line`, `git_repo`), `testing/board.ts` (`new_task`, `project`, `git_project`, `task_with_work`, `last_prompt`, `reload`, `events`, `event_texts`), `testing/runs.ts` (`can_run`, `start_run`, `running_task`, `idle`, `run_ends`), `testing/stacks.ts` (`remote_project`, `level`, `squash_merge`, `own`, `restacked`).
- `api/testing.ts`: `req()`, `call(s, method, path, body)` through the router with `Bearer ` (empty token), `err()`, `new_project`, `git_project`; sets `IA_SHIM_BIN`, `IA_CLAUDE_BIN`, `IA_CODEX_BIN` to nonexistent paths.
- Seams: `IN_TEST` (from `VITEST`); `util.when(point, f)` / `reached(point)` race hooks; `runs.TEST_CAN_RUN`; `Exporter(timers=false)` and `limits`; `relay` test intervals (100 ms / 1 s); `IA_*_URL`/`*_BIN` overrides; `IA_DEBUG_FAULTS`; `IA_CRASH_BACKOFF`; `IA_KEEP_TEST_DIRS`; `admin.exec` observable at `reached("exec")`.
- Structural tests in `tests/`:
  - `bottom_layer` — `util, proc, worker, lag, http, db, db/*` import nothing above them except types.
  - `capabilities` — `API_VERSION=153`, `API_COMPAT=1`, `PROTOCOL=1` don't move; each capability is a file; every name a client gates on exists.
  - `code_size` — no code file over 1000 lines except a shrinking allowlist (`code_size.txt`).
  - `floating_promises` — no unhandled promise in `src/` (type-checker based).
  - `migration_numbers` — numbered migrations 1..130 closed and consistent.
  - `named_migrations` — file naming, self-containment, `after` references, run on a fresh db.
  - `migration_order` — recent named migrations commute.
  - `codex_subagents`, `task_titles` — run the real `bin/huntaway` (`codex-run`, `title-check`) against fake agents in `tests/fixtures/*.py`.
- Browser tests start real servers through `scripts/test-server.sh` and read `IA_READY`.

## 11. Dependencies

- Calls into: `db.*` (all tables), `agent/runner` (send, abort, stop, merge queue, dependencies), `agent/runs`, `agent/title`, `agent/stack_title`, `agent/documents`, `agent/assistant`, `agent/pens`, `agent/approval_rules`, `agent/agent_tools`, `agent/usage`, `git/worktree`, `git/relocate`, `git/checkpoints`, `git/git_view`, `mcp/permissions`, `mcp/questions`, `mcp/pr_watch`, `mcp/tools`, `mcp/docs_mcp`, `mcp/http`, `hosts/hub`, `hosts/terminal`, `hosts/uplink`, `hosts/relay`, `hosts/proto`, `hosts/capabilities`, `hosts/discovery`, `review`, `review/merge_gate`, `review/summary`, `review/merged`, `integrations/*`, `threads/*`, `update/admin`, `update/release`, `update/staging`, `update/service`, `devices`, `settings_sync`, `desktop/*`.
- Called by: hub proxy and tunnels (`api.local_request`, `dispatch`), MCP tools (reuse `create_task_inner`, `update_task_inner`, `update_stack_inner`, `delete_task_inner`, `create_project_inner`, `update_project_inner`, `check_todos`, pens helpers), automations/workflows (`create_task_inner`), every module (`AppState`, `util`, `proc`, `http.ApiError`, `telemetry.emit`, `lag.busy_with`, `backup.before_switch` from update code, `attachments.save/dirs_for/listed`).
- npm: `ws`, `sharp`, `@dire-kiwi/docs-render`; Node ≥24 built-ins (`node:sqlite`, `node:http`, worker threads, zlib).

## 12. Rewrite notes

Accidental (Rust-port shape or history):
- snake_case names, one file per former Rust file, free functions instead of methods, `Type_fn` naming, `Array<[column, value]>` field lists, `extract.ts` reproducing axum/serde error texts (422/400 plain text) and `debug_list` formatting, `path_str` no-op, `Cell`, `AsyncMutex` as tokio mutex, `Deleting` guard with `drop()`.
- The sh launcher that emulates `exec` (exit 75 + restart file), the INT-signal re-exec, malloc/V8 tuning flags: needed only because Node can't exec and to keep the pid; the *requirements* (same pid across restart, crash restart with backoff, agents survive, children don't inherit config) are essential.
- Two database files (`huntaway.db` → `huntaway-2.db`), `issue-agent.db`, `issue-agent` data dir and binary name, `server-ts/` package folder, `LAST_BEFORE_NAMED`, `FIRST_TS`, backup rules for Rust releases: compatibility with old installs; a new repo with a new data format needs only "back up before a schema-changing start" and an import path.
- Legacy API shapes: subprojects (creation refused, existing ones still handled everywhere), `/profiles/{id}/scratch`, `/profiles/{id}/claude-config`, `summarizer`, `claude_config_dir`, pens `hidden`, `task_type` as label, messages (non-items) thread endpoints, `--broker*` flags, numeric `API_VERSION` gates (frozen at 153; capabilities by name are the live mechanism).
- Stale comment: `/tools/{tool}` says its handler checks the token, but the route is authed like the rest.
- `GET /tasks/{id}` and `GET …/messages` have a write side effect (`thread_batch.opened` converts a thread to items on open).

Essential:
- Route semantics and JSON shapes (clients: web, mobile, hubs of other versions, agents' MCP tools reuse the inner functions).
- Token model (board token file, hub token, device tokens with allowlist, per-run secrets), open routes with tiny limits, auth-before-body.
- `/api/ws` contract: hello, events tagged with `host_id`, 25 s tick, `resync` on lag; no replay.
- Everything-as-JSON (base64 uploads) so requests can cross the hub tunnel; this drives the 10 MB attachment cap.
- Task status state machine and its ordered side effects; hand-written delete cascades.
- Durable telemetry outbox with persisted in-flight batch; opt-in per profile; fixed attribute allowlist.
- Backups before version changes with room check and "no backup, no start".
- `IA_READY` / `IA_BACKUP_FAILED` stdout lines (desktop app and scripts parse them).

Awkward today:
- One thread with synchronous SQLite: any slow handler stalls every socket; hence `lag.ts`, workers, statement cache.
- `AppState` is a god object passed everywhere; `update_task_if` hides many cross-area side effects behind a field write (status scripts, telemetry, stack titles, GitHub stacks, temp folders, subproject sync).
- `update_task_inner` is ~320 lines mixing validation, derivation, concurrency recheck and orchestration of six other areas.
- Module-level singletons (telemetry exporter, lag, crash, backup queue) make multi-instance tests awkward.
- Circular imports between api modules (`incoming.ts` lazily imports `tasks.ts`).
- Error contract is inconsistent: `{error}` JSON for most, plain text for shape rejections, and some handlers return 200 with `{ok:false,error}`.
