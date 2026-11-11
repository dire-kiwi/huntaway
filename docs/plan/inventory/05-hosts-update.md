# 05 — Hosts, the hub, terminals, updates, the desktop driver, devices and settings sync

Source: `the huntaway repository` (`apps/server/src/...` unless a path says otherwise).

## 1. Purpose

Every `huntaway serve` is a **host** (own SQLite database, own agents, own machine) and at the same time a **hub** (serves
the UI and shows other hosts on one board). This area is everything that makes "one board, several machines" work: links
between hosts (by URL+token, over SSH, or a host dialling in), the request/websocket/event relay, cross-host board tool
calls, host discovery, and settings sync between hosts. It also holds what belongs to "the server as an installed thing":
the API's authentication (board token, paired-device tokens, `--open-token`), browser terminals (tmux), self-update (from
a git checkout or from GitHub releases, restarting in place under running agents, the systemd user service), and computer
use (the Cua Driver and the `desktop` MCP server).

## 2. Capabilities

### 2.1 Identity and auth for the whole API (`serve.ts`, `api.ts`, `devices.ts`)
- Three identity files in the data dir, each made on first start, mode 0600, content `new_token()` (two UUIDs without dashes, 64 hex): `host_id` (public id of this host), `auth_token` (the board's access token), `hub_token` (what hosts that dial in present). `--token`/`IA_TOKEN` overrides `auth_token` without writing the file.
- `host_name` = `--name`/`IA_NAME`, else `/proc/sys/kernel/hostname`, else `$HOSTNAME`, else `"host"`.
- Every `/api/...` route needs a token unless registered `auth: false`. Tokens accepted: `Authorization: Bearer <t>` or any `?token=<t>` query value. Compared constant-time (`same_secret`). No cookies anywhere.
- Unauthenticated routes: `GET /api/health`, WS `/api/hub/connect` (checks hub token itself), `POST /api/hooks/{id}/{token}`, `POST /api/permissions/{id}/push-answer`, `POST /api/devices/pair`, `GET /api/open-token` (only with `--open-token`), plus the MCP (`mcp_http.PREFIX`) and OTLP prefixes which check per-run secrets. `POST /api/tools/{tool}` is a normal authed route.
- A request that fails auth (or hits no route) never has its body read (so an anonymous caller can't make the server buffer 300 MB).
- CORS: `access-control-allow-origin: *`, methods `*`, headers `*` on all `/api` answers; `OPTIONS /api*` → 200 with max-age 86400.
- `--open-token`: `GET /api/open-token` → `{token}` for anyone; on a loopback-only server it also requires a loopback `Host` header (DNS-rebinding guard), else JSON 404.
- UI token flow: the web UI takes `?token=` from the URL once, strips it, stores it in `localStorage["ia.token"]`; remembers in `ia.openBoard` ("1"/"0") whether the board hands out its token; a 401 shows the token screen. Server prints `listening on http://host:port/?token=<token>` and `IA_READY {"port","token"}` on stdout (token null when it came from `IA_TOKEN`).
- Paired devices (`devices.ts`): one-time pairing codes, per-device tokens stored only as SHA-256, a route **allowlist** for devices, a second `board_only` check in sensitive handlers, revocation that closes open websockets.
- Websocket upgrades (`serve.ts upgrade`): same token check (method "GET" on the path as sent); `/api/h/<this host>/...` is rewritten to the local route; `/api/h/<other>/...` goes to `hub.proxy_ws`; `?token=` is stripped from the query passed to handlers; a route's `pre` check runs before the upgrade so 404/503 are real HTTP answers.

### 2.2 The hub: links and relay (`hosts/hub.ts`, `hub/*.ts`, `relay.ts`, `db/links.ts`)
- Persist links (`links` table) and keep one live `LinkConn` per connected host in `s.links`.
- Link by URL+token (`POST /hosts`): probes `GET <url>/api/info` with the token (10 s), requires `host_id`, refuses self, upserts `mode='outbound'`, starts the connection loop.
- Link over SSH (`POST /hosts/ssh`): runs the target's forced command, stores `mode='ssh'` + `ssh` JSON target + the token it returned, starts the loop.
- Accept hosts that dial in (WS `/api/hub/connect`, bearer = `hub_token`): `mode='inbound'`, row auto-created/updated by `note_inbound_link` (keeps an existing row's mode/url/token).
- Dial out to hubs (`--hub URL[,URL] --hub-token T`, `hub/dial_out.ts`): this node as someone else's host, answering tunnelled requests from its own API.
- Proxy `ANY /api/h/{host_id}/{*rest}`: local host → in-process dispatch; linked host → `LinkConn.request`. Websockets under the same prefix are relayed (`proxy_ws`, used by terminals).
- Merge events from all hosts onto the UI socket `/api/ws`, each tagged `host_id`.
- `GET /hosts`: this host + every link with live status/version; rename a link / toggle `uplink` (`PATCH /hosts/{id}`); forget one (`DELETE /hosts/{id}`), which also clears `profiles.assistant_host` pointing at it.
- `GET /hosts/join`: `{hub_token, host_token, command}` for dialling in; the hub URL is built from `x-forwarded-proto`/`x-forwarded-host`/`host`.
- Copy a Claude/Codex config (login + settings archive) between two hosts (`POST /hosts/copy-claude-config`), creating the config/profile on the target if missing.
- Push the hub's code or version to a linked host (`POST /hosts/{id}/update`).
- Run board tools on a linked host (`call_tool` → `POST /api/tools/{tool}`), and take board tool calls **up** a link from a host's agents (`run_up_call`, `hosts/uplink.ts`).
- Route a profile's assistant to its "assistant host" (`agent/assistant.ts on_its_host`, uses `hub.host_request`).
- `scratch_host` setting: on a hub that can't run agents, the UI sends new scratch tasks to that link (client-side choice; server only stores/validates the link id).
- Hub side of settings sync (`hub/settings_sync.ts`).

### 2.2a How one board shows every host (the end-to-end path)
1. The UI opens `/api/ws` on the hub it was served from and calls `GET /api/hosts`.
2. For each host it wants data from, it calls that host's ordinary API through the hub: `/api/h/<host_id>/profiles`, `/api/h/<host_id>/profiles/<id>/projects`, `/api/h/<host_id>/tasks/<id>` … (client helper `on(hostId)`). The local host uses the same prefix with its own id. There is no aggregated "all projects" endpoint: the client fetches per host and merges profiles and agent configs **by name** in its store.
3. The hub answers a local-host request by dispatching it in process as a trusted caller (`api.local_request`, no token check, device carried along). For a linked host it re-issues the request: HTTP `<link.url>/api/<rest>?<query minus token>` with `Authorization: Bearer <link.token>` and a JSON body (300 s), or a `req` frame on the tunnel.
4. Live updates: each host's event bus is copied to the hub (its own bus directly; a dialled host's `/api/host/ws` frames; a dial-in host's `event` frames), each event object gets `host_id` added (`forward_event`), and all go out on every UI socket. Ids (tasks, projects, profiles) are only unique per host, so the client keys everything by `(host_id, id)`.
5. When a link (re)connects the hub emits `{type:"resync", host_id}` and the client refetches that host. When a link drops, `hosts_changed` fires and `GET /hosts` shows it `connected: false` with `last_seen`.
6. Agents' board tools take the same route server-side: a tool that can't be resolved locally is retried on each connected link via `POST /api/tools/{tool}` with the caller's profile **name**, then on up-links.

### 2.3 Protocol/versioning (`hosts/proto.ts`, `hosts/capabilities.ts` + `capabilities/*.ts`)
- `PROTOCOL = 1` (tunnel message format; hub refuses another number), `API_VERSION = 153` (frozen), `API_COMPAT = 1`, `BUILD_ID = ts-<start ms hex>`, `VERSION` from `package.json`, `BUILD_COMMIT` from `build.json` (release only).
- Named capabilities: the sorted names of the files in `hosts/capabilities/` (regex `^[a-z][a-z0-9_]*$`). Today: `approval_model_effort`, `background_work`, `capabilities`, `desktop`, `profile_tint`, `settings_sync`. Reported in `/api/info`, `/api/health`, pairing answer, both hellos, `hub_hello`, `GET /hosts`. Ask with `has_capability(link.version, NAME)`.

### 2.4 Discovery (`hosts/discovery.ts`, `hub/endpoints.ts discover_hosts`/`through_links`)
- mDNS responder (hand-written DNS encode/parse) for DNS-SD service `_huntaway._tcp.local` on UDP 5353, group 224.0.0.251; answers multicast queries and "legacy unicast" queries from private/Tailscale addresses.
- Browse: multicast query on each LAN interface + direct unicast query to each online Tailscale peer + HTTP probe of `http://<peer>:7878/api/health`.
- Mesh: ask each connected link for its `GET /api/hosts`, keep those linked by http(s) URL, not linked here, that answer here at the same URL with the same `host_id`.
- Mark each found host `linked` (by id or URL).

### 2.5 Terminals (`hosts/terminal.ts`, `hosts/pty.ts`, `api/thread.ts`, `wire/terminal.ts`)
- One tmux session per task shell and one per (task, terminal tool), on a private tmux server; sessions outlive browser and server.
- Websocket attaches `tmux attach-session` in a pty (Python helper), relays bytes, resize, flow control by acks, app-level ping/pong.
- Terminal tools (host setting `terminal_tools`): named TUI commands; tool sessions are leased and reaped.
- Status / kill / keepalive routes; `kill_all(task)` called on task delete/done-cleanup/worktree removal/project delete.

### 2.6 Self-update (`update/admin.ts`, `release.ts`, `staging.ts`, `service.ts`, `apps/server/bin/huntaway`)
- Restart in place (same PID) with or without rebuild from the source checkout; stream build log; abandon on build failure.
- Follow a deployment (`--update-from URL`): poll its `/api/health` commit, fetch it from `origin`, offer Update.
- Update from a hub: git bundle (fast-forward), or commit fetched from own origin, or release version.
- Release updates (`--release-updates OWNER/REPO`): check GitHub releases, background download + sha256 + tar safety + smoke test into `<data>/app/<v>/`, Update, Roll back, bad-version tracking, choose-at-startup for supervisor restarts, prune.
- Desktop-shell awareness (`release.shell`): whether the latest release needs a new Electron package and which asset.
- Supervisor wrapper `bin/huntaway`: finds node, memory flags, crash restart with backoff, exec-on-request.
- systemd user service: status, install unit, enable linger, hand over (`POST /admin/service`, `huntaway install-service`).
- Re-copy the old database file as a restart job (`POST /admin/database/recopy`; mechanics are in `db/file.ts`, another area).

### 2.7 Settings sync (`settings_sync.ts`, `hub/settings_sync.ts`, `wire/settings_sync.ts`)
- Fixed list of syncable fields with per-field version vectors; observe local changes; merge entries; keep "lost" values; resolve; hub exchange loop.

### 2.8 Computer use (`desktop.ts`, `desktop/driver.ts`, `desktop/install.ts`, `mcp/desktop_mcp.ts`, `api/desktop.ts`, `db/desktop.ts`)
- Install/uninstall a pinned Cua Driver release; find a driver (env, installed, PATH); host switch `desktop_tools`.
- One `cua-driver mcp` child per host, lazy start, idle stop; session env recovery; screen-lock detection.
- `desktop` MCP server for runs: 8 read tools, 3 write tools; one-task-at-a-time claim; op journal with at-most-once by `op_id`; plan-mode/reviewer refusal.
- Viewer: `GET /desktop/frame`, `GET /tasks/{id}/desktop`.

## 3. Data

### 3.1 Tables
- `links(id TEXT PK, name, mode, url, token, last_seen, created_at, ssh TEXT, uplink INTEGER)`. `id` = the other host's `host_id`. `mode` ∈ `outbound|inbound|ssh`. `token` = that host's full `auth_token` in plaintext (outbound; for ssh the last one `ssh-host` returned). `ssh` = JSON `Target {target: "user@host", ssh_port=22, remote_port=7878}`. `uplink` = "let this host's agents use this board". `last_seen` = last message time written on disconnect. `token` is never serialized (`hidden` non-enumerable property); `GET /hosts` also deletes `ssh` and shows `url: "ssh://user@host"`.
- `device_tokens(id PK, name, token_hash UNIQUE, created_at, last_used_at)`; `push_subscriptions.device_id` rows are deleted with the device.
- `setting_versions(name PK, value JSON, vv JSON {host_id: counter}, changed_at, changed_by, lost JSON [SyncLost], seen TEXT|NULL, since TEXT)`. All JSON written canonically (sorted keys, `canon`). `seen` = canonical JSON of what the host's own table held when last compared; NULL = the field's profile isn't on this host.
- `desktop_ops(id PK, task_id FK→tasks ON DELETE CASCADE, run_id, op_id, tool, summary, args JSON, status, result, boot, created_at, finished_at)`; unique `(task_id, op_id) WHERE op_id IS NOT NULL`; index `(task_id, created_at)`. `status` `running|ok|failed`; read as `interrupted` when `running` and `boot` ≠ this process's stamp.
- `profiles.assistant_host` (link id or NULL) is read here for trust decisions.

### 3.2 `settings` keys owned or read here
`default_model`, `default_effort`, `default_permission_mode`, `scratch_host` (link id), `terminal_tools` (JSON `[{id,name,command}]`, NULL when empty), `public_url`, `release_prereleases` ("true"|NULL), `settings_sync` ("true"|NULL), `settings_sync_since` (ISO time sync was switched on; cleared when off), `desktop_tools` ("true"|NULL).

### 3.3 Key types
- `Link {id, name, mode, url, token(hidden), ssh, last_seen, uplink, created_at}`.
- `Version {version, api_version, api_compat, capabilities[], commit|null, agents: bool (default true when unsaid), updates_from: "checkout"|"releases"|null}`.
- `LinkConn {id, name, mode ("outbound"|"ssh"|"inbound"), version, heard_at, pongs, kind, drop(reason)}`; `kind` = `{type:"http", url, token, agent}` or `{type:"tunnel", tx, pending: Map<id, resolver>, streams: Map<id, Chan<Frame>>, next}`.
- Tunnel messages (JSON text frames, tag `t`):
  - hub→host `Down`: `req {id, method, path, body}`, `ws_open {id, path}`, `ws_msg {id, text|null, data|null(base64)}`, `ws_close {id}`, `ping`, `hello {hub_id, name, api_version, capabilities?}`, `tool_answer {id, result, error, off}`.
  - host→hub `Up`: `hello {host_id, name, version, protocol, api_version, api_compat, capabilities?}`, `res {id, status, body}`, `event {event}`, `ws_msg {id, text, data}`, `ws_close {id, code, reason}`, `pong`, `tool_call {id, call_id, tool, profile, args, task_fields}`.
- On `/api/host/ws` (hub dialled the host): host sends `{type:"hello"}` then every `HostEvent`; hub sends `{type:"hub_hello", hub_id, name, api_version, capabilities}`; host may send `{type:"hub_call", ...ToolCall}`; hub answers `{type:"hub_result", ...ToolAnswer}`.
- `HostInfo` (`GET /info`): `host_id, host_name, build_id, api_version, api_compat, capabilities, commit, updates_from, agents, agent_clis[], version, data_dir, hostname, home`.
- `Health` (`GET /health`): `{ok: true, commit, api_version, capabilities, host_id}`.
- `GET /hosts` item: local `{id, name, local: true, connected: true, mode: "local", version, build_id, api_version, api_compat, capabilities, commit, updates_from, agents}`; linked = the `Link` fields (minus token/ssh) + `local: false`, `connected` (live **and** `push.link_ready(live)`), and when live: live `mode`, version fields, `last_message_at`.
- Discovery `Found {host_id|null, name, url, via: "lan"|"tailscale"|"mesh", through?, version|null, api_version|null, capabilities|null, linked}`; mDNS `Ad {host_id, host_name, port, address?, version, api_version}`.
- `TerminalTool {id, name, command}`; `TerminalStatus {available, running, cwd?, reason?, tool?}`.
- `ServerMeta {boot_id, started_at, source_dir, running_commit, update_from, release: Config|null, args[]}`; `RestartJob {phase, log, error}`, phases `starting|building_ui|building_server|downloading|verifying|installing|restarting|failed`.
- `ServerStatus` (`GET /admin/server`): meta fields + `running_agents`, `restart`, and when a checkout: `source_commit, source_branch, dirty, new_commits[]` (`<short sha> <subject>`, max 30); with `--update-from`: `update_from, deployed {commit, checked_at, error}, deployed_commits[]`; with release updates: `release: ReleaseStatus`; `database`; `service: ServiceStatus`.
- `ReleaseStatus {repo, running, exe, latest {version, prerelease, published_at, notes, url, asset{name,url,size,sha256}, newer}|null, prereleases, checked_at, error, rate_limit_reset, shell {version, install, path, outdated, package}|null, bundled_server, staged, download {version, phase, bytes, total, error}|null, previous, bad[], rollback_to: version|"bundled"|null}`.
- `Installed` (`app/state.json`): `{current, previous, staged, trying, bad[]}` + unknown keys preserved.
- `ServiceStatus {unit, path, installed, enabled, running, other, linger, user}`.
- `SyncEntry {name, value, vv, changed_at, changed_by, since, lost: SyncLost[]}`; `SyncLost {value, by, at, since?}`; `SettingsSync {enabled, host_id, entries}`. Entry names: `global/<setting>` or `profile/<encodeURIComponent(profile name)>/<field>`.
- Synced fields. Global: `default_model`, `default_effort`, `default_permission_mode`, `release_prereleases`, `terminal_tools` (the raw JSON string). Per profile: `default_model`, `github_account`, `limit_wait`, `limit_switch`, `merge_approval`, `require_pr_approval`, `agent_access` (list of profile names, own name filtered out), `approval_rules` (`{rules, expiry_minutes}` or null).
- `Device {id, name, created_at, last_used_at}`; pairing answer `{token, device, host_id, host_name, api_version, capabilities}`; code answer `{code, expires_at, ttl_secs: 300}`.
- Desktop: `Release {version, url, bytes, sha256}`; `DriverStatus {state: stopped|starting|running|failed, version, error, started_at, last_call_at, tools}`; `InstallJob {version, phase: downloading|verifying|unpacking|done|failed, received, total, error, started_at, finished_at}`; `DesktopOp` (table row + parsed args); `Target {pid, window_id, at}`.

### 3.4 The device allowlist (`devices.ts`, method + path after `/api`, `*` = one segment)
- `HUB` (the board's own routes): `GET ws`, `GET hosts`, `GET devices`, `DELETE devices/*` (itself only), `GET push`, `POST push/subscriptions`, `PATCH|DELETE push/subscriptions/*`, `POST push/subscriptions/*/test`, `POST permissions/*/push-answer`.
- `HOST` (a host's routes, also valid as `h/<host>/<route>`): `GET profiles`, `GET profiles/*/projects`, `GET profiles/*/tasks`, `GET|POST profiles/*/assistant`, `GET projects/*`, `GET|POST projects/*/tasks`, `GET|PATCH tasks/*`, `PATCH tasks/*/stack`, `GET|POST tasks/*/messages`, `GET tasks/*/thread`, `GET tasks/*/thread/items`, `POST tasks/*/questions/*`, `POST tasks/*/stop`, `POST attachments`, `GET attachments/*/*`, `GET permissions`, `POST permissions/*`.
- Under `h/<host>/` only `HOST` patterns match; without the prefix `HUB` + `HOST`. Anything else → 403 "a paired device can't use this part of the API…". `DeviceAuth {id, revoked}` rides on the request (`Req.device`) and through `local_request` for the hub's own host.

### 3.5 mDNS record layout
- Instance `<host_name with dots→spaces, ≤40 chars> <host_id first 8>._huntaway._tcp.local`; SRV target `huntaway-<host_id first 8>.local`, port = HTTP port; TXT keys `id`, `name`, `v` (version), `api` (API version), optional `address` (when `--host` is one IPv4 address); A records for that address or every LAN IPv4. Never the token. Capabilities are not in the record (no room), so `capabilities: null` for mDNS-only finds.
- LAN addresses exclude loopback, Tailscale (100.64.0.0/10) and interfaces matching `^(docker|br-|veth|virbr|vnet|cni|flannel|podman|lxc|lxd|vmnet|vboxnet)`. Unicast queries are answered only to loopback, RFC 1918, link-local and Tailscale sources.

### 3.6 The systemd unit as written (`service.ts unit_text`)
```
[Unit]
Description=Huntaway host on port <port>
[Service]
Environment="IA_X=..."            # every IA_* except one-shot ones and IA_DESKTOP_*
WorkingDirectory=-<cwd>
ExecStart="<login shell>" -lc "exec '<exe>' 'serve' '<flags…>' '--port' '<port>'"
Restart=on-failure
RestartSec=5
KillMode=process
[Install]
WantedBy=default.target
```
One-shot env left out: `IA_TS_EXE`, `IA_RESTART_FILE`, `IA_SUPERVISOR_PID`, `IA_SERVE_SIGNALS`, `IA_MALLOC_MMAP`, `IA_BUNDLED_SERVER`, `IA_SKIP_DB_BACKUP_ONCE`, `IA_RECOPY_DB`. Values with newline/NUL are refused; `%` doubled, `$` doubled in ExecStart.

### 3.7 Files and folders (in the data dir unless said)
- `host_id`, `auth_token`, `hub_token` (0600).
- `ssh/id_ed25519`, `ssh/id_ed25519.pub` (comment `huntaway-hub@<host_name>`), `ssh/known_hosts` (TOFU).
- `app/state.json`, `app/<v>/` (`huntaway`, `ia-shim`, `ui/index.html`, plus `server-ts/`, `node/`, `electron/`), `app/<v>.partial/download.tar.gz`, `app/state.json.<id>.tmp`. Shared with the desktop app (`apps/web/electron/versions.cjs`), hence temp-file+rename and unknown keys kept. `app/shell-state.json` is the Electron shell's own.
- `outgoing.bundle` / `incoming.bundle` (transient git bundles).
- `cua-driver/<version>/cua-driver`, work dir `cua-driver/.install-<v>-<pid>-<ms>/`.
- `server_version`, `backups/` (backup.ts, other area; update calls `backup.before_switch`/`record_version`).
- Outside: `~/.config/systemd/user/huntaway.service` (or `huntaway-<port>.service`, 0600), `default.target.wants/<unit>` symlink (read for `enabled`), `/var/lib/systemd/linger/<user>` (read), `/proc/self/cgroup` (read), `/run/systemd/system` (existence), `$TMPDIR/huntaway-serve.XXXXXX/{next,started}` (supervisor's restart file and started marker).
- tmux socket name `ia-<host_id first 12 chars>`; session names `ia-<task_id>` and `ia-<task_id>~<tool_id>`.

## 4. In-memory state

| State | Purpose | Across restart |
|---|---|---|
| `s.links: Map<host_id, LinkConn>` | live connections | rebuilt: outbound/ssh loops start from `links` rows; inbound hosts redial |
| `s.link_tasks: Map<host_id, stop()>` | stop function of each outbound/ssh loop (replacing one stops the old) | rebuilt |
| `s.uplinks: Map<hub_id, Uplink>` | hubs that said hello and take our tool calls; each has `pending` map + call channel | lost; pending calls fail with "may or may not have taken effect" |
| `s.events` / `s.hub_events` broadcasts | host events / merged board events | not persisted; clients get `resync` |
| tunnel `pending` and `streams` maps | in-flight requests and relayed websockets per tunnel | failed/closed on disconnect |
| `s.devices.codes: Map<code, expiry>` (max 20, monotonic clock) and `s.devices.revoked` counter + watchers | pairing codes; revocation signal | codes forgotten on restart (by design) |
| `leases: Map<session name, ms>` (terminal.ts) | when a board last kept a tool session | lost; sessions found after restart get a fresh 90 s lease |
| `found` (tmux availability, cached once) | | recomputed |
| `s.restart: RestartJob|null` | the one restart/update job; log tail capped (200k chars → keep last 150k) | lost (the restart is the point) |
| `s.deployed` | last `--update-from` check | rechecked at start |
| `s.release`: `last` (etag, releases list, latest, checked_at, error, rate_limit_reset), `checking` mutex, `download` watch value, `staging` mutex | release checks and the single download | recheck after 30 s; `.partial` dirs removed at next download/prune; durable part is `app/state.json` |
| `supervisor {file, pid}`; `EXEC_ENV/EXEC_ARGS` (tests) | how to ask the wrapper to exec | re-read from env each start |
| settings-sync hub `jobs: WeakMap<AppState, {timer, running, again}>`; host-side `busy` flag | debounce / single-flight exchange | n/a (exchange on reconnect) |
| desktop `holder {task_id, at}`, `targets: Map<task_id, Target>`, `drivers: WeakMap<state, Driver>`, driver `tools` map/`status`/idle timer, install `job`, `frames: Map<"pid:window", {at, frame}>`, `lock_cache` (2 s) | claim, viewer target, the one driver process | all lost; the journal (`desktop_ops`) is the durable part, `running` rows become `interrupted` |
| capabilities `OWN` | cached directory listing | recomputed |

## 5. Outside the process

Binaries spawned:
- `ssh` (`IA_SSH_BIN`) via `bash -c 'exec 3<&0 </dev/null; (read -r _ <&3; kill -KILL 0) & exec 3<&-; exec "$@"'`, detached (own process group) with a watchdog that kills the group when the server's pipe closes. Args: `-i <data>/ssh/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o UserKnownHostsFile=<data>/ssh/known_hosts -o StrictHostKeyChecking=accept-new -p <port> <user@host>` then either `ensure` / `link` (becomes `SSH_ORIGINAL_COMMAND` for the forced command) or `-N -o ExitOnForwardFailure=yes -L 127.0.0.1:<free local port>:127.0.0.1:<remote port>`.
- `ssh-keygen -q -t ed25519 -N "" -C huntaway-hub@<name> -f <key>`.
- `tailscale status --json` (`IA_TAILSCALE_BIN`, 3 s timeout).
- `tmux -L ia-<host12> ...`: `has-session -t =<name>`, `list-sessions -F "#{session_name} #{session_attached}"`, `new-session -d -s <name> -c <cwd> -x <cols> -y <rows> [-e K=V ...] [-- /bin/sh -c TOOL_WRAPPER]`, `set-option -t =<name>: status off ; set-option ... mouse on`, `kill-session -t =<name>`, and for attach: `set-option -q -s set-clipboard external ; set-option -t =<name>: detach-on-destroy on ; attach-session -t =<name>`.
- `python3 -I -c <HELPER> <cols> <rows> tmux ...` (pty helper: `pty.fork`, stdin→pty, pty→stdout, fd 3 takes `<cols> <rows>\n` resize lines, SIGWINCH, exits when either side closes).
- `git` in the source checkout: `rev-parse HEAD`, `symbolic-ref --short HEAD`, `status --porcelain --untracked-files=no`, `log --format="%h %s" -n 30 A..B`, `merge-base --is-ancestor`, `cat-file -e <c>^{commit}`, `fetch --quiet origin` (120 s cap in the deployed check), `bundle create <path> <branch> [^<since>]`, `fetch --quiet <bundle> refs/heads/<b>:refs/remotes/hub/<b>`, `merge --ff-only <commit>`.
- Build steps: `pnpm install --frozen-lockfile --filter huntaway-server... --filter huntaway-app...`, `pnpm --filter huntaway-app run build` (pnpm on PATH, else `npx --yes <packageManager pin>`), `cargo build --release -p ia-shim` (skipped when no cargo and a prebuilt `apps/server/bin/ia-shim` exists). Env = process env + `~/.cargo/bin` on PATH.
- `tar -tzf`, `tar -tvzf`, `tar -xzf <tarball> -C <partial> --strip-components=1 --no-same-owner` (300 s); `<partial>/huntaway --version` smoke test (30 s; output must contain the version).
- `systemctl --user daemon-reload|enable|start|restart|is-active|show-environment` (`IA_SYSTEMCTL`), `loginctl enable-linger` / `show-user` / `show-session` (`IA_LOGINCTL`), `sh -c` hand-over script, `pgrep -u <uid> -x "hyprlock|swaylock|gtklock|waylock|i3lock|xsecurelock|slock"`.
- `<cua-driver> mcp` (stdio, newline-delimited JSON-RPC).

HTTP called: other hosts' `/api/info`, `/api/health`, `/api/hosts`, `/api/tools/{tool}`, `/api/admin/update`, `/api/settings-sync[/merge]`, `/api/claude-configs...`, `/api/profiles...`; WS `/api/host/ws`, `/api/hub/connect`; `--update-from` URL `/api/health`; GitHub `GET <api>/repos/<repo>/releases?per_page=20` (headers `accept: application/vnd.github+json`, `x-github-api-version: 2022-11-28`, `if-none-match`, UA `huntaway/<v>`), asset `browser_download_url`s, the release manifest `huntaway-<v>-release.json`; `https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.41.3/<archive>`.

Ports/sockets: HTTP listen `--host`/`--port` (default `0.0.0.0:7878`, `0` = free port); UDP 5353 (reuseAddr, multicast TTL 255, joins 224.0.0.251 on each LAN IPv4 address); an ephemeral UDP port for unicast discovery; a free loopback TCP port per SSH tunnel.

Environment variables: `IA_HOST`, `IA_PORT`, `IA_DATA_DIR`, `IA_UI_DIR`, `IA_SOURCE_DIR`, `IA_UPDATE_FROM`, `IA_RELEASE_UPDATES`, `IA_NAME`, `IA_HUB`, `IA_HUB_TOKEN`, `IA_TOKEN`, `IA_OPEN_TOKEN`, `IA_DISCOVERY` (`0` off), `IA_DEBUG` (log link errors), `IA_SSH_BIN`, `IA_TAILSCALE_BIN`, `SSH_ORIGINAL_COMMAND` (`link` = don't wait), `IA_RELEASE_API` (GitHub API base), `IA_DESKTOP_VERSION` / `IA_DESKTOP_SHELL` / `IA_DESKTOP_INSTALL` (`pacman`, `appimage:<path>`, `mac:<path>`, `other`) / `IA_BUNDLED_SERVER` (set by the Electron shell or by an Update), `IA_COMMIT` (deployment's commit), `IA_RESTART_FILE` + `IA_SUPERVISOR_PID` (from `bin/huntaway`, removed from env at start), `IA_TS_EXE`, `IA_NODE`, `IA_CRASH_BACKOFF`, `IA_SERVE_SIGNALS`, `IA_MALLOC_MMAP`, `IA_SKIP_DB_BACKUP[_ONCE]`, `IA_RECOPY_DB`, `IA_SYSTEMCTL`, `IA_LOGINCTL`, `IA_SYSTEMD_BOOTED`, `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, `SHELL`, `IA_CUA_DRIVER` (driver path), `IA_CUA_DRIVER_RELEASE` (JSON Release, tests), `IA_DESKTOP_LOCKED` (`1`/`0`, tests), session vars copied for the driver (`WAYLAND_DISPLAY`, `DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_CURRENT_DESKTOP`, `XDG_SESSION_TYPE`, `XDG_SESSION_DESKTOP`, `HYPRLAND_INSTANCE_SIGNATURE`, `SWAYSOCK`, `NIRI_SOCKET`), `CUA_DRIVER_RS_ENABLE_WAYLAND=1` set when on Wayland. tmux env: `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=huntaway`, `TMUX`/`TMUX_PANE` removed; per session `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, the config's proxy env, `TMPDIR` (task temp dir unless done), `IA_TOOL_NAME`, `IA_TOOL_COMMAND`.

## 6. Background work

- Link keepalive (`relay.ts`): `PING = 20 s`, `SILENCE = 60 s`, `RETRY = 1 s` base, websocket connect timeout 30 s. Both ends ping; anything heard resets the silence timer.
- Outbound loop (`spawn_outbound`): reconnect after `backoff × RETRY`, doubling to max 30; reset to 1 after a connection that ran. SSH loop: same with 1 s units. Dial-out loop: backoff doubles to 30, reset only if the connection lasted > 60 s (a hub that refuses at once isn't redialled every second).
- Tunnel: hello must arrive within 10 s; hub pings at once and every 20 s with both a WS ping and `{t:"ping"}`; per-request timeout 300 s (both HTTP and tunnel); HEAD re-probe 30 s; `relay.close` waits 2 s for the peer's close.
- SSH: `ssh-host` waits up to 15 s (poll 250 ms, each GET 3 s) for a host that's restarting, 0 s when adding; tunnel readiness poll 100 × 100 ms.
- UI socket: `tick` every 25 s; lag threshold 64 MB buffered.
- Uplink call timeout 300 s.
- Discovery: responder socket renewed every 30 s; browse waits 1.5 s; mesh requests/probes 4 s each; mDNS TTL 120.
- Terminals: ping every 15 s (WS ping + `{type:"ping"}`); a board that has ever sent `pong` is dropped after 60 s without one; `MAX_UNACKED = 384 KiB`; tool lease 90 s; reaper every 30 s.
- Devices: code TTL 5 min; `last_used_at` written at most once a minute; revoked socket terminated 1 s after close.
- Update: deployed check every 5 min (HTTP 15 s); release check 30 s after start then every 6 h (requests 30 s); download stall 60 s; download progress event at most every 500 ms; restart waits 300 ms before exec so the last events are delivered; supervisor-gone poll 1 s; systemd `daemon-reload` retried 20 × 250 ms; hand-over script waits up to 30 s (150 × 0.2 s) for the old pid; unit `RestartSec=5`.
- Wrapper crash restart: waits 1, 2, 4, 8, 16 s (×`IA_CRASH_BACKOFF`), max 5 in a row, counter reset after 600 s up.
- Settings sync: hub exchange debounced 200 ms, single-flight with "again" flag.
- Desktop: driver idle stop 10 min, start 30 s, call 120 s (frame/check 15/30 s), stop = close stdin then SIGKILL after 5 s; claim lease 120 s; frame cache 400 ms; lock cache 2 s.
- Shutdown (`SIGTERM`/`SIGINT`/supervisor gone): close server, `closeAllConnections`, exit on next tick (2 s fallback).

## 7. Surface

HTTP (all under `/api`; "board-only" = refuses a paired device with 403):
- `GET /health` (no token) → `Health`.
- `GET /open-token` (no token, only with `--open-token`) → `{token}`.
- `GET /info` → `HostInfo`.
- `GET /hosts` → list; `POST /hosts` `{url, token}` (board-only) → the link; `GET /hosts/join` (board-only) → `{hub_token, host_token, command}`; `GET /hosts/discover` (board-only) → `{tailscale: bool, hosts: Found[]}`; `GET /hosts/ssh-key` → `{public_key}`; `POST /hosts/ssh` `{target, ssh_port?, remote_port?}` (board-only) → `{id, name, started}`; `POST /hosts/copy-claude-config` `{from_host, to_host, config | profile, config_dir?, overwrite?}` (board-only) → `{ok, files, target}`; `PATCH /hosts/{id}` `{name?, uplink?}`; `DELETE /hosts/{id}`; `POST /hosts/{id}/update` → host's `UpdateResult`.
- `ANY /h/{host_id}/{*rest}` (body limit 300 MB): proxy. 503 `host <name> is offline`; 502 on transport error or the host rejecting the link token; `?token=` stripped; `.`/`..` segments refused (400).
- `POST /tools/{tool}` `{profile, args, task_fields?}` → `{result}` or 400 `{error}`.
- `GET|PATCH /settings` → `HostSettings`; `GET /settings-sync` → `SettingsSync`; `POST /settings-sync/merge` `{entries}` → `{merged}` (409 when off, 400 on bad entries); `POST /settings-sync/resolve` `{name, value?}` → `SettingsSync`.
- `GET /admin/server` → `ServerStatus`; `POST /admin/restart` `{rebuild?: true}`; `POST /admin/update` `{commit?, bundle?, branch?, version?}` (limit 256 MB) → `UpdateResult`; `POST /admin/release/check` → `ServerStatus`; `POST /admin/release/update` `{version}`; `POST /admin/release/rollback`; `POST /admin/database/recopy`; `POST /admin/service`. A second job while one runs → 409 `a restart is already in progress`.
- `GET /devices` → `{devices, current}`; `POST /devices/pairing` (not from a device) → code; `POST /devices/pair` `{code, name?}` (no token, 16 KB limit) → token; `PATCH /devices/{id}` `{name}`; `DELETE /devices/{id}` (a device may delete only itself).
- `GET|DELETE /tasks/{id}/terminal[?tool=]`, `POST /tasks/{id}/terminal/keepalive?tool=` (all board-only).
- `GET|PATCH /desktop` (`{enabled}`), `POST|DELETE /desktop/install`, `POST /desktop/stop`, `POST /desktop/check` (→ status + `check` text), `GET /desktop/frame?task_id=|pid=&window_id=` → `{frame: {mime, data, width, height, pid, window_id, at}}` or `{frame: null, reason}`, `GET /tasks/{id}/desktop` → `{ops, target}`. All mutating/viewing ones board-only.

Websockets:
- `/api/ws` (UI): `{type:"hello", host_id}`, then every board event (host events with `host_id` added; `hosts_changed`; `resync` with or without `host_id`), `{type:"tick"}` every 25 s.
- `/api/host/ws` (a hub follows this host): see 3.3.
- `/api/hub/connect` (a host dials this hub): tunnel protocol; refusals close with code 1008 and a reason.
- `/api/tasks/{id}/terminal/ws?cols=&rows=&tool=` (cols/rows 2..1000, default 80×24): server→client binary = output, text `{"type":"ready"}` then `{"type":"ping"}`; client→server binary = input, text `{"type":"resize","cols","rows"}`, `{"type":"ack","bytes"}`, `{"type":"pong"}`. Closes 1000 "Session ended" or 1011 with the error (≤120 chars). Reached from the UI as `/api/h/<host>/tasks/<id>/terminal/ws`.

MCP server `desktop` (serverInfo `huntaway-desktop`, served over HTTP by `mcp/http.ts`): reads `health, apps, windows, read, screen, zoom, verify, op_status`; writes `act, launch, clipboard`. Mapped to Cua tools `list_apps, list_windows, get_window_state, get_desktop_state, zoom, verify_state, run_steps, launch_app, clipboard_read/clipboard_write, check_permissions`. Session name per task `huntaway-<KEY-N>`. `initialize` returns `INSTRUCTIONS` (system-prompt text); protocol versions `2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05`.

CLI: `huntaway serve [flags]` (2.1/server.md table; `--broker*` accepted and ignored), `huntaway token [--hub] [--data-dir D]`, `huntaway ssh-host [--port N] [--data-dir D]` (prints one JSON line `{info, port, started: false, token}`; `--name`/`--no-start` ignored), `huntaway install-service [serve flags…]`, `huntaway --version` (prints `huntaway <version>`; the staging smoke test depends on it).

## 8. Events

Emitted on the host bus: `settings_changed`, `profiles_changed`, `approval_rules {profile_id}` (settings sync applying values), `restart {phase, error}`, `restart_log {line}`, `release_checked`, `release_download {download}`. On the hub bus only: `hosts_changed`, `resync {host_id}` (a link connected), `resync` (a slow UI socket caught up). Consumed: hub forwards every local host event; hub settings sync reacts to `resync`, `settings_changed`, `profiles_changed`, `approval_rules` from any host; host-side sync observes on the last three; push (other area) watches `hub_events` and gates `connected` via `link_ready`. Telemetry rows: `link_up`, `link_down` (`kind` http|tunnel, host id/name), `server_update` (kind exec), `server_start`.

## 9. Invariants and hard-won rules

Links and trust
- Nothing about another host is stored on a hub except the `links` row. All data is fetched live through the proxy.
- A dialled link authenticates with the host's own token; a dial-in host is known **only** by the `host_id` it claims behind the shared `hub_token`. Therefore (`hub.ts register/misplaced/linked_via`): a tunnel is refused when that id is already connected (either way); a tunnel claiming the id of a profile's **assistant host** that the hub dials is refused even while the dialled link is down; a dialled connection replaces whatever is registered. Otherwise a host the hub dials may also dial in and "stands in for itself" while the dialled link is down.
- When a host becomes an assistant host, `drop_misplaced` drops a stand-in tunnel and redials. The proxy and `proxy_ws` re-check `misplaced` per request (503 with the reason).
- Up-calls (`run_up_call`) run only if `links.uplink` is on, the call came the way the host is linked, and the named profile exists here with `assistant_host == that host`. They run with that profile's access, at most once per `call_id` (record id `up:<host>:<call_id>`), never further up and never back down to the caller; thread tools (`permission_prompt`, `request_user_input`, `finish_work`, `submit_review`, `wait`, `background_wait`, `track_work`, …) are refused. A host only sends calls to a hub that said hello, and never to a hub it links itself (`uplink.hubs`).
- After a call went up, a lost link/timeout is reported as "may or may not have taken effect; check before calling again".
- The link's 401 is turned into 502 "didn't accept this hub's token; link it again" because the UI treats 401 as "my own token is wrong".
- The token goes in a header, not the WS URL ("proxies on the way log" URLs). A client's `?token=` is the hub's and is never forwarded.
- Proxied paths are passed on raw; `.`/`..` (also percent-encoded) are refused so a host linked at a URL with a path prefix can't be escaped.
- Each HTTP link has its own keep-alive agent, destroyed with the link: "a connection that died without closing would otherwise be kept for the next one, and hold up its requests".
- A websocket pong can come from a proxy, not the peer: once a tunnel host has answered a `{t:"ping"}` with `pong`, only its messages count as "heard" (`answers_pings`). The terminal does the same with its `pong`.
- Websockets are opened paused and resumed once listeners are attached (frames arriving with the handshake were lost otherwise); events arriving while the hub asks `/api/info` are buffered (`early`) and replayed after `resync`.
- Events from a connection are forwarded only while it is the registered connection for that id.
- On tunnel end: fail all pending requests, close all relayed streams, write `last_seen` = last time heard (not now).
- `ws_open` on the dialling host registers the stream before connecting (the hub's first messages can arrive first); it connects to its own `internal_url` with its own token.
- The proxy is JSON-only: bodies are parsed and re-serialized; a non-JSON answer becomes a JSON string; empty 404/405 from old hosts become the JSON no-route error.
- The SSH target must not start with `-` (option injection: `-oProxyCommand=…`), checked on input and again when building args.
- SSH tunnels die with the hub (process-group watchdog), and tunnel and websocket are raced so either ending ends both.
- `ssh-host` reads `auth_token` from the data dir (it can't see `IA_TOKEN`), so an SSH host run with `--token` can't be linked that way.

Devices
- Allowlist, not denylist ("that list missed routes twice"). Path is checked percent-decoded; refuse encoded `/ \ % ? #`, empty segments, `.`/`..`, invalid UTF-8. Checked at auth on the path as sent and again by the proxy on the forwarded path; sensitive handlers call `board_only` too. Through the hub, the local host sees the device; a **linked** host only sees the link token, so there the allowlist is the only guard.
- A pairing code is deleted on first use whether or not it was valid/expired. Revocation deletes push subscriptions, bumps the counter, and every device websocket (local or relayed) closes with 1008 "this device was unpaired".
- Revoking doesn't rotate `auth_token`; docs tell the user to delete the file and restart if the phone may have been misused.

Terminals
- Own tmux server per data dir so test servers never share the live sessions. Target with `=name` (exact match, not prefix).
- tmux gets the agent's scrubbed env (no server secrets), since shells inherit the tmux server's environment.
- Tools run as `/bin/sh -c WRAPPER` (more than one argv so tmux doesn't use a non-POSIX default shell); the wrapper runs `$SHELL -lc "$IA_TOOL_COMMAND"` and holds the screen on non-zero exit until Enter.
- `detach-on-destroy on` so a client whose session ended doesn't hop to another task's session; `set-clipboard external` + `mouse on` for OSC 52 copy and wheel scroll; status bar off.
- Flow control: stop reading the pty while ≥384 KiB is unacknowledged.
- Tool ids `[A-Za-z0-9_-]{1,32}` (they go into session names); invalid/duplicate ids get a new 8-char id.
- A removed tool's session can still be killed (kill takes the raw id).

Update
- Node can't exec, so the wrapper holds the PID: the server writes a shell fragment (`next='<exe>'`, `set -- <args>`, `K='v'; export K`) atomically to `IA_RESTART_FILE` and exits 75; the wrapper sources it (only if it owns the file) and `exec "$next" "$@"`. Desktop app, test scripts and service managers all track that PID.
- `IA_RESTART_FILE`/`IA_SUPERVISOR_PID` are taken out of the environment first thing so agents and child servers never see them; the supervisor counts only if it is this process's parent.
- The wrapper restarts a crashed server only after it wrote `started` (i.e. it was listening), and only for error exits or fault signals (ABRT, SEGV, BUS, ILL, FPE, TRAP, SYS), never for 0/75/outside signals.
- One-shot inputs (`--recopy-db`, `IA_RECOPY_DB`, `IA_SKIP_DB_BACKUP_ONCE`) are stripped from restarts ("an older build that Roll back starts wouldn't know the flag and would exit").
- Build uses `--frozen-lockfile` so it never dirties the checkout (a dirty checkout blocks the next hub Update). If a build step fails the old server keeps running.
- Hub→host update refuses: wrong branch, dirty checkout, non-fast-forward, commit not on `origin/<branch>`; bundles are incremental (`^<commit the host runs>`) because whole-branch bundles exceed body limits.
- Release pick: highest semver, not draft, prerelease only if enabled, not in `bad`, must have `huntaway-server-<v>-<os>-<arch>.tar.gz` **with** a sha256 digest. ETag is sent only together with the list it belongs to. A failed check keeps the previous result plus the error.
- Tarball safety: one top folder, no absolute/`..` entries, only files and directories (no links); must contain `huntaway`, `ia-shim`, `ui/index.html`; staged by renaming `<v>.partial` → `<v>` then writing `staged` in one synchronous step ("a dir that's staged is always there").
- One download at a time (mutex); a staged version no longer offered (prereleases off, release withdrawn) is unstaged and deleted unless it is current/previous/trying.
- Update sets `trying`, execs; the new server's `settle` makes it `current`, moves the old to `previous`, clears `trying`, prunes everything but current/previous/staged/trying. If exec fails, `trying` and the recorded version are put back. A `trying` still set at the next startup means it never came up → marked bad, tried once only.
- A server not started by the desktop app execs `current` (else `previous`) from `app/` at startup when newer than itself and not bad, passing itself as `IA_BUNDLED_SERVER` so Roll back can return to it. A server newer than what's in `app/` forgets older `current`/`previous` (`superseded`).
- Roll back marks the running version bad, goes to `previous` (if complete, not bad, not older than the desktop app's own version) else the bundled server; a backup (or room for one) is required first (`backup.before_switch`), else nothing changes.
- A release serves its own `ui/` and reports its own build commit, not the deployment's `IA_COMMIT`.
- Service unit: runs through the login shell (`<shell> -lc 'exec <exe> serve …'`) for the user's PATH, `KillMode=process` (agents under ia-shim and tmux survive), `Restart=on-failure`, `WorkingDirectory=-<cwd>`; written 0600 because env may hold tokens; names the release the host was installed as (`IA_BUNDLED_SERVER`), not the one it updated to; pins `--port` to the actual port; not offered under the desktop app (`IA_DESKTOP_VERSION`). Linger failure is reported, not fatal.

Settings sync
- Merge is idempotent, commutative, associative; a covering vector wins without conflict; concurrent → later `changed_at` wins, then (for untimed values) earlier `since`, then higher host id, then value; loser kept in `lost` (max 10, one per distinct value); any later local change clears `lost`.
- Values from before sync (or changed while off) have `changed_at = ""` and a vector with only this host's counter, so they lose to any real change and never count as having seen the board's value. On (re)joining, entries only this host ever touched are restamped the same way.
- `observe` runs inside a transaction and diffs each field against `seen`; a value the host can't accept (validator throws) leaves the local value and is retried on later passes; entries for profiles that don't exist here are kept (`seen = NULL`) and applied when a profile of that name appears. Sync never creates or deletes profiles. Duplicate profile names: only the first syncs.
- The hub must have sync on; only links with capability `settings_sync` and `enabled: true` take part; the hub sends each host only entries whose merge would change what that host has.
- Limits: 5000 entries per merge, 256 KiB per value, name ≤ 500, host id ≤ 200, times must match `YYYY-MM-DDTHH:MM:SS.mmmZ` or "".

Desktop
- Agents never get Cua's own MCP server. Writes: check `op_id` journal first (already ran → recorded answer), then lock, then claim, then journal `running`, then drive, then finish. Unique index makes two simultaneous calls with one `op_id` collide ("already running").
- Locked screen blocks everything except `health` and `op_status`; the agent is told not to unlock.
- Results are flattened: structured content is appended as a JSON text line (≤30k chars) because Claude Code shows `structuredContent` *instead of* text when present.
- The viewer never starts the driver and never shows a locked screen; it asks for a display-only capture so the agent's snapshot tokens stay valid.
- Turning computer use off stops the driver; runs already started get "turned off" errors. Feature-detect driver tool arguments (`d.has(tool, arg)`) because driver versions differ.
- Install: size and sha256 pinned in source; download aborted if larger than expected; unpack to a work dir then rename; older versions removed after.

## 10. How it is tested

- `relay.test_timing()` shrinks PING/SILENCE/RETRY/connect timeout (100 ms / 1 s / 250 ms / 5 s).
- `hosts/uplink/testing.ts`: `node(id, name)` (AppState with its own identity), `serve(s)` (real HTTP+WS server for a node), a hub linked to a host by URL, cleanup on `afterAll`. `hub.link_http(s, id, url, api_version)` registers a fake link without the event socket. `LinkConn.pongs` lets tests wait for a link to outlive a silence. `hub_settings_sync.settled(s)` waits for exchanges.
- Discovery: `respond({port, address, renew_ms})`, `discover({port, http_port, wait_ms, targets, peers})`, `send_out`/`serial_sender` take a fake socket; `parse_tailscale_status`, `hosts_in`, `lan_addresses(ifaces)` are pure.
- Update: `reached("exec")` hook plus `exec_args()`/`exec_env()` show what would have been exec'd (tests aren't run by the wrapper, so exec returns an error); `IA_RELEASE_API` fake GitHub; pure helpers (`pick_bundle_commit`, `builds_shim`, `pnpm_command`, `restart_args`, `check_entries`, `check_types`, `parse_version`/`compare`, `package_name`, `choose_at_startup`, `service_of`, `unit_text`, `kept_env`); `IA_SYSTEMCTL`/`IA_LOGINCTL`/`IA_SYSTEMD_BOOTED`/`XDG_CONFIG_HOME` fakes; `IA_CRASH_BACKOFF`. End-to-end: `scripts/release-update-e2e.sh`, `scripts/install-release-host-test.sh`.
- Desktop: `IA_CUA_DRIVER` (fake driver), `IA_CUA_DRIVER_RELEASE`, `IA_DESKTOP_LOCKED`, `install.reset()`, `release_claim()`, `claim(task, now)`.
- Capabilities: `apps/server/tests/capabilities.test.ts` fails if `API_VERSION` moves or a gate names a capability with no file.
- Settings sync: `settings_sync.test.ts` exercises `merge_entry` properties and observe/merge/resolve on in-memory states.

## 11. Dependencies

Calls out to: `api.ts` (`local_request`, `dispatch`, `no_route_error`), `db` (links, settings, profiles, tasks, runs), `mcp/tools` (`handle_up_call`, `handle_remote`), `integrations/push` (`note_move`, `link_ready`), `agent/runs` (`can_run_agents`, `agent_env`, `has_agent`), `agent/documents`, `agent/assistant/memory`, `agent/task_tmp` (terminal cwd/TMPDIR), `agent/approval_rules`, `mcp/gh_mcp` (account validation), `git/worktree.git`, `backup.ts`, `db/file.ts`, `telemetry`, `agent/runner` (task key prefix), `proc.run_cmd`.

Called by: `serve.ts` (startup order: `admin.take_supervisor` → `release.exec_installed` → tokens → backup → open db → listen → … → `admin.start_update_check`, `release.start`, `push.start`, `settings_sync.start`, `hub.start`, `dial_out`, `discovery.respond`, `staging.settle`, signal handlers, `IA_READY`, `supervisor_started`); `mcp/tools/dispatch.ts` (cross-host tool dispatch: `host` argument routes to a named link or up-link; `list_projects`/`list_pens`/`list_tasks` with `all` fan out over links then up-links with de-duplication by id; any other tool falls back link by link then up on "not found"; `too_old` numeric gates); `agent/assistant.ts` (assistant host); `api/profiles.ts` (`drop_misplaced`); `api/tasks.ts`, `api/projects.ts`, `git/worktree/remove.ts` (`terminal.kill_all`); `agent/runner/access.ts`+`launch.ts`+`codex/adapter.ts` (desktop server attach, read tools pre-allowed, writes disallowed for reviewers); the web/mobile clients (`packages/client/src/{http,hosts,terminal,devices,server,desktop}.ts`); the Electron shell (`state.json`, `IA_READY`, `IA_BACKUP_FAILED`, `IA_DESKTOP_*`).

## 12. Rewrite notes

Essential (keep the behaviour)
- The model: per-host database, hub stores only how to reach hosts, UI addresses a host by id, one merged event stream with `host_id`, `resync` on (re)connect, profiles/configs matched **by name** across hosts.
- Three link modes with their different trust levels and the register/misplaced/up-call rules; keepalive that doesn't trust transport-level pongs; request relay + websocket relay over a single dial-in connection.
- Restart in place under running agents with a stable PID, crash supervision, release staging state machine shared with the desktop app, backup-before-switch, `KillMode=process`.
- Device allowlist with double checking and websocket revocation.
- Settings sync semantics (they are subtle and tested as algebraic properties).
- Terminal flow control, leases, private tmux server, scrubbed env.

Accidental / could be simplified if every host runs the same version
- All numeric gates: `API_VERSION` (frozen at 153, a 200-line changelog comment), `API_COMPAT`, `too_old` and the `*_API` constants, `call_linked`'s legacy `get_task` shaping, `pen_active`, `UI_API_VERSION`/`hostCompat` in the client. A same-version fleet needs only: `PROTOCOL` (refuse at hello), the build/version string for "needs update", and optionally capabilities for platform differences (e.g. `desktop` only where a driver exists is really a *host state*, not a version).
- Compatibility probes for old hosts: `is_html` + empty-405 HEAD probe, empty 404/405 → JSON, "host too old to be linked (no host_id)", hubs that never say hello, dual ping (WS ping and `{t:"ping"}`), `Version.agents` defaulting to true, `Capabilities_from` tolerance, mesh discovery falling back to trusting loopback hosts with no id, Tailscale HTTP probe "finds a host from before API 135".
- But: the fleet is never atomically same-version. The hub updates hosts one by one through the link (`/api/info`, `/api/admin/update`, events), and the mobile app and Electron shell ship separately (`MIN_API`, `shell` stamp). A small stable core (hello, info, update, restart status) must tolerate version skew.
- Two wire formats for the same thing: outbound links use plain HTTP + an event websocket (`hub_hello`/`hub_call`/`hub_result` frames mixed into the event stream), inbound links use the `Up`/`Down` tunnel. One multiplexed protocol for both directions would remove `Kind`, `Via`, half of `LinkConn`, and the proxy's JSON-only body handling.
- Capabilities derived from a directory listing at runtime (a merge-conflict workaround for parallel PRs).
- Rust-port shapes: `Chan`, `Watch`, `AsyncMutex`, `Registered.drop`, tuple results `[status, body]`, serde-style 422 messages ("Failed to deserialize the JSON body into the target type: missing field …"), `exit_status` formatted like Rust's, log lines imitating `tracing`, `BUILD_ID = ts-<hex>`.
- Old-name and removed-feature leftovers: `IA_*` env prefix, `ia-` tmux names, `ia-shim`, `issue-agent` data dir fallback and second binary name, `--broker*` flags, `ssh-host --name/--no-start`, `started: false`, Rust-release rollback handling (pre-0.4.0), `huntaway.db`→`huntaway-2.db` recopy job.
- The pty via an inline Python script (no openpty in Node without a native module); the mDNS implementation written by hand; `tar` shelled out with listing-based safety checks.
- Tokens: links store the peer's full board token in plaintext; dial-in hosts share one hub token; no per-link credentials, no scopes, no TLS (left to Tailscale/proxy). Worth a deliberate decision rather than a port.
- Module-level singletons (desktop `holder`/`targets`/`frames`/install `job`, terminal `leases`, capabilities cache) are per process, not per AppState, which tests work around.

What a same-version rewrite could reduce the link protocol to (a reading of the above, not something the old code does)
- Hello both ways: `{host_id, name, version, protocol}` (+ `agents`, `updates_from`, `commit` so no follow-up `/api/info` call is needed; today the tunnel hello lacks them and the hub asks again).
- Request/response, stream open/message/close, event, ping/pong, tool call/answer: the existing seven message kinds, used for **both** link directions.
- Refuse on `protocol` mismatch with a reason; show "needs update" on `version` mismatch and still allow info/update/restart-status. Everything else in `proto.ts`'s history and the `*_API` constants is then dead.

Awkward today
- The comment above the `/tools/{tool}` route says "its handler checks the token: a run may use its own", but the route is registered with the default `auth: true` and `remote_tool` checks nothing itself: treat it as a plain board-token route.
- Routes guarded only by the device allowlist, with no `board_only` in the handler: `GET /hosts/ssh-key`, `PATCH|DELETE /hosts/{id}`, `POST /hosts/{id}/update`, `/settings*`, `/admin/*`, `PATCH|DELETE /devices/{id}` (uses `not_from_device`).
- `connected` in `GET /hosts` depends on push's readiness (`link_ready`), a cross-area coupling.
- `scratch_host` and assistant-host routing are half client-side, half server-side.
- `update_host` chooses among bundle / commit / version by what the hub happens to be (checkout, commit-only deployment, release), and the host chooses again by what *it* is; mixed fleets (release hub, checkout host) simply fail with an explanatory error.
- `ssh-host` can't see `IA_TOKEN`; an SSH link's stored token is refreshed only when the forced command runs again.
- The restart job doubles as the progress channel for unrelated things (service install, database recopy, release download mirroring).
