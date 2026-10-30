# T3 Code: deployment, remote access, devices, mobile and desktop apps

Part of the T3 Code inventory: [t3code-overview.md](t3code-overview.md) has the summary and links the other areas.

Scope: installation and distribution, the `t3` CLI, background service, updates, remote access
(T3 Connect, LAN pairing, Tailscale, SSH, WSL, linked environments), auth and pairing, guest links,
devices (simulators/emulators), the mobile and desktop apps, telemetry and diagnostics, licensing.
Source: shallow clone of `pingdotgg/t3code` at 9b1d351 (2026-10-30, latest release v0.1.5). Paths
are relative to the repo root. "(from code)" marks things found in source but not in the docs.

## 1. Deployment model in one paragraph

- An **environment** is one T3 Code server (Node, HTTP + WebSocket, SQLite) on one machine. It owns
  providers, agent execution, files, terminals, browser tabs, simulators and all durable state. Web,
  desktop and mobile apps are clients; one client can be connected to many environments at once.
  `docs/internals/remote.md`, `docs/internals/overview.md`
- Direct LAN, Tailscale, SSH and T3 Connect only change how a client reaches the server; there is no
  second execution model. An environment keeps a stable ID across restarts and address changes;
  saved connections live in each client. `docs/internals/remote.md`
- A project and its threads belong to one environment; agents reach another environment's threads
  only through a peer link. Clients group checkouts of the same repository across environments
  (repository identity via git remote, following `upstream` for forks). `docs/internals/remote.md`
- The desktop app normally runs its own local server (the "primary" environment) plus optional WSL
  backend; it can also run with no local server, as a pure remote. `docs/internals/remote.md`

## 2. Installation and distribution

### Command-line server (`t3`)
- `curl -fsSL https://t3.codes/install.sh | sh` (macOS/Linux), `irm https://t3.codes/install.ps1 | iex`
  (Windows). Installs `t3` into `~/.local/bin`; needs only sh, tar, sha256sum/shasum and curl/wget, no
  Node. `docs/user/install.md`, `scripts/install.sh`
- Installer env vars: `T3CODE_CHANNEL` (stable | nightly | preview), `T3CODE_VERSION` (pin exact
  version), `T3CODE_HOME` (default `~/.t3`), `T3CODE_INSTALL_BIN_DIR`, `T3CODE_RELEASE_BASE_URL`
  (mirror). Archives unpack to `$T3CODE_HOME/runtime/versions/<version>`, shared with the service and
  `t3 update`. `scripts/install.sh`
- The server ships as a Node single-executable archive per platform (`t3-<version>-<platform>-<arch>`
  tar.gz/zip + `SHA256SUMS`) for macOS arm64, Linux x64/arm64, Windows x64/arm64. No Intel-Mac CLI
  (Node SEA unsupported there); Intel Macs use the desktop app or build from source with `vp`.
  `docs/operations/release.md`, `docs/user/install.md`
- `npx t3@latest` runs it without installing (needs Node). The `t3` npm package is only a launcher that
  downloads and verifies the same release archive; nothing in the product installs from npm.
  `docs/operations/release.md`
- Supported provider CLIs must be installed and logged in on the server's machine (Codex, Claude,
  Cursor, Grok Build, OpenCode, Antigravity, Pi, Muse Code, fx). `docs/user/install.md`

### Desktop app (Electron)
- Artifacts per release: macOS arm64 and x64 DMG; Linux x64/arm64 AppImage and `.deb`; Windows
  x64/arm64 NSIS installer. Signed/notarized when secrets exist (Apple Developer ID, Azure Trusted
  Signing). `docs/operations/release.md`
- Package managers: `winget install T3Tools.T3Code`, `scoop install extras/t3code`,
  `brew install --cask t3-code`, `sudo apt install ./T3-Code-*.deb`, AUR `t3code-bin` /
  `t3code-nightly-bin`, nixpkgs `t3code` (`nix profile add …#t3code`, NixOS/Home Manager; launcher
  `t3code-desktop`, also ships `t3`). Nix installs must be updated through Nix, not in-app.
  `README.md`, `docs/user/install.md`, `packaging/aur/`
- The desktop app bundles the `t3` CLI; **Settings → About → t3 command → Install** links it onto
  `PATH` (Windows: adds the app's command folder to `PATH`). `docs/user/install.md`,
  `apps/desktop/src/app/DesktopCliShim.ts`

### Mobile app
- iOS App Store (listing `t3-code-remote-claude-more`, id6787819824) and Google Play (`com.t3tools.t3code`). Store and QR
  links in **Settings → About → Mobile app** on web/desktop. TestFlight is invite-only; Android beta
  APKs are on GitHub releases tagged `android-beta-*`. `docs/user/install.md`
- Note: `apps/mobile/README.md` still says "currently in development and is not distributed yet";
  the docs and root README link the store listings, so the README warning appears stale.
- Three variants installable side by side: development (`T3 Code Dev`), preview (`T3 Code Preview`),
  production (`T3 Code`). `apps/mobile/README.md`

### Hosted web app
- `https://app.t3.codes` (stable, Vercel alias `latest`) and `nightly.app.t3.codes`. It is a pure
  client: stores its connection catalog in the browser and connects directly to each environment; it
  holds no server-side pairing state and proxies nothing. Needs HTTPS endpoints (T3 Connect or
  Tailscale HTTPS), since browsers block plain HTTP from an HTTPS page. `docs/internals/remote.md`,
  `docs/operations/release.md`, `.env.example`
- A local server also serves the web UI itself; `t3` opens it in the browser. `docs/user/install.md`

### Release channels
- `stable` and `nightly` (nightly built from `main`, checked every 30 min; stable promotes the latest
  nightly commit). `preview` is a maintainer test train (never offered as an update; `npx t3@preview`,
  `T3CODE_CHANNEL=preview`, `t3 update --channel preview` with a warning). npm dist-tags `latest`,
  `nightly`, `preview`. "Beta" is a product label, not a channel. Release notes get a model-written
  summary. `docs/operations/release.md`
- Mobile store apps work with both stable and nightly servers. `docs/user/install.md`

## 3. The `t3` CLI

Defined in `apps/server/src/binCli.ts` and `apps/server/src/cli/*.ts` (Effect CLI). Default port
3773 (next free port is chosen if busy, from code). `t3 help` / `t3 --help`.

### Running a server
- `t3 [path]` / `t3 start`: run the server and open the web app in a browser. A bare non-existent
  directory name is rejected (use `t3 ./new-dir`). Refuses to start a second server on the same T3 home.
- `t3 serve`: headless; no browser; prints "Connection string", one-time token, pairing URL, a
  `t3code://pair?...` app link, and a QR code. `apps/server/src/startupAccess.ts`
- Shared server flags: `--mode` (`desktop` keeps loopback defaults), `--port`, `--host` (e.g.
  127.0.0.1, 0.0.0.0, tailnet IP), `--base-dir` (= `T3CODE_HOME`), `--dev-url`, `--no-browser`,
  `--bootstrap-fd`, `--auto-bootstrap-project-from-cwd`, `--log-websocket-events`,
  `--tailscale-serve`, `--tailscale-serve-port`. `apps/server/src/cli/config.ts`
- Env vars (from code): `T3CODE_PORT`, `T3CODE_HOST`, `T3CODE_HOME`, `T3CODE_NO_BROWSER`,
  `T3CODE_TAILSCALE_SERVE(_PORT)`, `T3CODE_LOG_LEVEL`, `T3CODE_TRACE_*`, `T3CODE_OTLP_*`,
  `T3CODE_TELEMETRY_ENABLED`, `T3CODE_RELAY_URL`, `T3CODE_CLOUDFLARED_PATH`, `T3CODE_DEV_AUTH_TOKEN`.

### Remote access and auth
- `t3 pair [--scope …] [--ttl 5m] [--label] [--tailscale] [--tailscale-serve-port]`: mint a one-time
  pairing token for the running server and print it as a QR code; `--tailscale` publishes via Tailscale
  Serve and pairs through the tailnet HTTPS URL. Default TTL 5 minutes. `apps/server/src/cli/pair.ts`
- `t3 auth pairing create|list|revoke <id>` (create: `--scope`, `--ttl`, `--label`, `--base-url` to
  print a ready `/pair#token=…` link, `--json`); `t3 auth session issue|list|revoke <session-id>`
  (issue: scoped bearer token for headless/remote clients, `--scope`, `--ttl`, `--label`, `--subject`,
  `--token-only`, `--json`). "Manage the local auth control plane for headless deployments."
  `apps/server/src/cli/auth.ts`
- `t3 connect [--headless]`: set up T3 Connect (sign in, link, offer background service, wait for
  reachability). Subcommands: `login` (authorize CLI without enabling remote access), `link
  [--publish-only]` (authorize this environment on next start; publish-only = push notifications only,
  no tunnel), `publish [--disable]` (toggle agent-activity publishing to mobile), `status [--json]`
  (setup + live reachability check), `unlink` (disable, keep login), `logout` (disable and clear
  login). `--headless` uses the OAuth device flow; auto-chosen inside SSH sessions. Hidden in builds
  without T3 Connect config. `apps/server/src/cli/connect.ts`
- `t3 environment link <url> --pairing-code <code> [--url <alt>…] [--access read-only|approval-required|
  auto-accept-edits|auto|full-access]`, `t3 environment list [--json]`, `t3 environment unlink <id>`:
  peer links so agents here can work there (default access `approval-required`).
  `apps/server/src/cli/environment.ts`

### Service, updates, maintenance
- `t3 service install [--allow-downgrade] | status | restart | uninstall | protect [--undo] [--yes]`;
  `t3 service update` is deprecated in favour of `t3 update`. `apps/server/src/cli/service.ts`
- `t3 update [version] [--channel stable|nightly|preview] [--allow-downgrade] [-y|--yes]`: download a
  newer `t3` and switch this machine (incl. the service) to it. `apps/server/src/cli/update.ts`
- `t3 uninstall [--yes]`: removes service, launcher and downloaded versions; keeps
  `~/.t3/userdata` and `service.env`. `apps/server/src/cli/uninstall.ts`
- `t3 doctor [--fix] [--dry-run] [--base-dir]`: report DB size and reclaimable space, run offline
  SQLite repairs (stops/restarts an installed service around it). `apps/server/src/cli/doctor.ts`
- `t3 browser setup`: on Linux, add an AppArmor profile for Chrome's sandbox and apt-install missing
  libs/fonts for the headless browser (run with sudo; without sudo it only reports).
  `apps/server/src/cli/browser.ts`

### Driving a running server from a terminal
- `t3 app [path]`: open a new thread for a directory in the running desktop app (adds the project).
- `t3 project add <path> [--title] | remove <project> [--force] | rename <project> <title>`.
- `t3 thread list [--project] | start <project> <message> [--title --provider --model --worktree
  <ref> --branch --wait --json] | send <thread> <message|-> [--wait --json] | show <thread>
  [--messages N]`. `--wait` exits 1 on failed run, 2 when the agent waits for an answer.
  `apps/server/src/cli/thread.ts`
- `t3 theme set <theme> [--id] | clear | show`: publish an environment-wide theme that connected clients
  switch to. `apps/server/src/cli/theme.ts`, `docs/user/appearance.md`

### Diagnostics and internal
- `t3 trace summary [--since 30m] [--limit N]`: summarize the local NDJSON trace file.
- `t3 triage [--agent claude|codex] [--model]`: have Claude or Codex investigate a T3 Code problem on
  this machine and help file an issue. `apps/server/src/cli/triage.ts`
- Internal/hidden: `acp-mcp-bridge`, `acp-mcp-call` (MCP bridge for ACP agents), `__service-launcher`,
  `__service-preflight`, `__ssh-helper pick-port|wait-ready|runtime-port`, `__claude-history`.

## 4. Background service

- `t3 service install` runs T3 Code as a per-user service: systemd user unit `t3code.service` on Linux
  (enables lingering so it starts at boot and survives logout; prints a recovery `loginctl` command if
  admin is needed), launchd agent `com.t3tools.t3code.service` on macOS (runs while logged in). Windows
  background services are not supported. `docs/user/background-service.md`
- `t3 service status` prints the log path and on Linux checks running/enabled/linger, with named
  problems (`linger-disabled`, `user-manager-unavailable`, `service-stopped`, `restart-pending`…).
  Reinstalling repairs a broken service. `docs/user/background-service.md`
- `~/.t3/service.env` holds literal `KEY=VALUE` overrides (e.g. `T3CODE_PORT`, `T3CODE_HOST`); survives
  reinstalls/updates; applied on `t3 service restart`. `docs/user/background-service.md`
- Default bind: listens on all IPv4 interfaces but drops any connection whose peer is not loopback,
  private-range or tailnet IPv4, so LAN/Tailscale devices connect directly while public addresses stay
  closed (not a firewall; proxies that rewrite source look private). `T3CODE_HOST=127.0.0.1` restricts to
  local. `docs/user/background-service.md`, `docs/internals/remote.md`
- `t3 service protect` (Linux/systemd): shows and applies systemd memory protection (e.g. `MemoryLow`,
  `OOMScoreAdjust=-900` for the server, optional protection for Tailscale/SSH units) via sudo;
  `--undo` removes it. Agents already run with lower priority (from code: a systemd scope with
  `CPUWeight=10`, `IOWeight=10`, `TasksMax=25%`). `docs/user/background-service.md`,
  `apps/server/src/cloud/serviceProtection.ts`, `apps/server/src/process/agentScope.ts`
- A stable launcher process owns the runtime the service manager starts; the server child requests
  updates over IPC. Updates are staged, preflighted, run as a trial, then committed; failure rolls back,
  including a SQLite snapshot (main/WAL/shm) taken before migrations, refused if disk space is short.
  `docs/internals/server-updates.md`, `apps/server/src/serviceLauncher.ts`
- Only one server can own a T3 home at a time. `docs/user/updating.md`

## 5. Updates and keeping versions in sync

- **Update everything** button (bottom of sidebar, web/desktop): updates outdated provider CLIs, then
  servers that are behind, then the desktop app in use, across every connected machine. Servers move to
  the version the desktop app is installing (or the web app's version). Shows progress per machine,
  Retry for failures, counts running threads that restarts will interrupt and how many can resume.
  `docs/user/updating.md`
- Per-server actions depend on how it runs (environment capability `serverSelfUpdate`:
  `boot-service`, `respawn`, `desktop-managed`): **Update server** (remote update of a background
  service; for a desktop-hosted server this closes and relaunches the desktop app on that host),
  **Update the desktop app**, **Copy update command** (npm-global installs), **Copy relaunch command**
  (npx/pnpm dlx/bunx). `docs/user/updating.md`, `packages/contracts/src/environment.ts`
- **Update track** (Settings → About, desktop): switch Stable/Nightly for every connected machine in one
  step; blocked per machine if its DB has migrations the target does not support; Macs running the
  desktop app must switch locally. `docs/user/updating.md`
- Version mismatch: client and server must speak the same orchestration protocol; mismatches are
  refused with a notice naming which side to update. Clients otherwise feature-detect server
  capabilities (long list of optional capability flags). `docs/user/updating.md`,
  `packages/contracts/src/environment.ts`
- Desktop auto-update via electron-updater (also for the `.deb`, which needs a password prompt);
  checks 15 s after start and every 4 min, download is user-initiated (from code); update popover shows
  short release notes. Desktop updates use a two-phase prepare/commit handoff because installing stops
  the bundled backend. "T3 Code could not start" window offers Update or a link to the last version that
  started. `apps/desktop/src/updates/DesktopUpdates.ts`, `docs/user/updating.md`
- **Continue threads after restarts** (on by default, Settings → Maintenance): resumes supported active
  threads after an update, crash or reboot; wakes threads that were waiting on subagents/background
  work; not while waiting on approval/answer/secret; max three automatic resumes in a row.
  `docs/user/updating.md`, `docs/internals/server-updates.md`
- Provider CLI updates: **Update now** / **Update all** run the CLI's installer (Homebrew, npm, pnpm,
  Yarn, Bun, Volta, Vite+) on each environment; then model discovery refreshes. `docs/user/updating.md`
- Mobile: update an environment from the phone (Settings → Environments → Check for updates), refresh
  provider status, update providers. The app itself updates from the stores plus Expo OTA updates that
  download in the background and apply when you leave the app (drafts/queue saved first).
  `docs/user/updating.md`, `apps/mobile/app.config.ts`

## 6. Remote access

### Environments, routes and multiple servers in one client
- Each saved environment has an ordered list of **routes** (LAN, Tailscale, other VPN, public URL, SSH,
  T3 Connect). The client connects over the first that answers; while on a later route it re-checks
  earlier ones on network change, foreground and every minute, and moves back. Routes can be added,
  dragged to reorder, removed (web/desktop: route count under the machine name; mobile: Edit).
  `docs/user/remote-access.md`, `packages/client-runtime/src/connection/driver.ts`
- **Learned routes**: once connected (e.g. via T3 Connect), the server reports its LAN and tailnet
  addresses and the client adds them automatically, reusing the credential; they follow DHCP changes.
  A token paired over HTTPS never learns a plain-HTTP non-tailnet route. Each direct route is checked
  with the server's public descriptor before any credential is sent. `docs/internals/remote.md`
- One shared connection runtime (`packages/client-runtime`) for web, desktop renderer and mobile:
  supervisor with jittered exponential backoff (cap 5 min), liveness probes on foreground/network
  change, cached projections readable offline, per-environment registry.
  `docs/internals/connection-runtime.md`
- Per-route **Permissions** view shows what the in-use connection may do. **Details** shows a
  connection diagnosis (device → T3 Connect → host tunnel → host server) with **Copy diagnostics** and a
  trace ID. Environments can be switched off/on per client; each has an icon (machine glyph) and a
  **Copy MCP URL** action. `docs/user/remote-access.md`, `docs/user/t3-connect-troubleshooting.md`,
  `apps/web/src/components/settings/SavedEnvironmentRows.tsx`
- Settings pages that hold server settings have an environment/project scope: edit one environment, or
  "All environments" (bulk edit of every connected one, shows **Mixed** on disagreement), with project
  overrides. `docs/user/project-settings.md`

### Direct pairing (LAN or private network)
- Desktop host: **Settings → Sharing & access → Network access** (desktop setting `serverExposureMode`
  `local-only` | `network-accessible`; changing it restarts the app), then create a pairing link for a
  reachable address (QR code, copyable URL, code, hosted-app link; per-link scopes).
  CLI host: `t3 serve --host <private-ip>`, then `t3 pair` for further links.
  `docs/user/remote-access.md`, `apps/web/src/components/settings/AuthorizedClientsSettings.tsx`
- Receiving side: scan the QR code or paste the URL/code into **Add environment** (mobile: address
  like `192.168.1.100:3773` + pairing code, or camera QR scan). `t3code://pair?...` app links open the
  desktop app with an address confirmation. `docs/user/remote-access.md`,
  `apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx`
- Pairing links are one-time; pairing authorizes the device for future connections. Custom CA
  certificates are trusted on Android when installed as a CA certificate. `docs/user/remote-access.md`

### Tailscale
- Plain tailnet IP: `t3 serve --host <tailnet-ip>`. Tailscale HTTPS: `t3 serve --tailscale-serve`
  (`--tailscale-serve-port`, default 443) or `t3 pair --tailscale` for a running server; desktop toggle
  **Tailscale HTTPS** in Sharing & access. Pairing links then use `https://machine.tailnet.ts.net/`.
  `docs/user/remote-access.md`, `packages/tailscale/src/tailscale.ts`
- The 100.64.0.0/10 range is shown as "VPN" unless the machine confirms it is on Tailscale.
  `docs/user/remote-access.md`
- Push notifications are not available over Tailscale/LAN alone (need T3 Connect). The FAQ recommends
  Tailscale as a fallback to T3 Connect. `docs/user/mobile-notifications.md`, `docs/user/faq.md`

### T3 Connect (hosted relay + managed tunnels)
- Purpose: reach an environment from anywhere without router forwarding. Host: desktop **Settings →
  Sharing & access → T3 Connect**, or `t3 connect` on a CLI host (offers to install the background
  service). Other devices sign in to the same account and pick the environment; app.t3.codes adds
  linked computers on sign-in. `docs/user/remote-access.md`
- How it works: `cloudflared` runs on the host (pinned version, auto-installed and hot-swapped by the
  server; a user-supplied `cloudflared` on `PATH` or `T3CODE_CLOUDFLARED_PATH` is never replaced) and
  creates a Cloudflare tunnel to the loopback HTTP origin. The relay (`relay.t3.codes`, a Cloudflare
  Worker deployed with Alchemy, Postgres via PlanetScale/Hyperdrive, Axiom) brokers links and
  credentials but does not proxy HTTP/WebSocket traffic, which goes client → tunnel hostname → host.
  `docs/internals/t3-connect.md`, `infra/relay/README.md`, `packages/shared/src/relayClient.ts`
- Trust chain: relay asks the environment to mint a one-time bootstrap credential bound to the client's
  DPoP key; client exchanges it directly with the environment for an environment session. Relay never
  sees the session token. Both sides sign/verify proofs; managed tunnels only expose a validated
  loopback origin. `docs/internals/t3-connect.md`, `docs/internals/environment-auth.md`
- Identity: Clerk. CLI uses PKCE loopback OAuth or the OAuth device-authorization grant over SSH/headless
  (shows a URL + short code to approve on any device). `docs/internals/t3-connect.md`
- Limits: 3 machines per account (phones/browsers don't count); linking a paid T3 Chat account raises it
  to 10 (Pro) or 100 (Premier). T3 Connect is "free, for now". `docs/user/remote-access.md`,
  `docs/user/faq.md`
- Lifecycle: CLI hosts release the tunnel on normal shutdown (hostname kept) and recreate it on start;
  idle-tunnel reaper (relay, off by default, configurable) deletes tunnels offline ≥5 min for hosts that
  registered recovery; hosts recreate them under the same hostname. Old-version hosts offline 7 days lose
  their tunnel until updated. **Deregister** from the account's T3 Connect page frees the slot even for a
  wiped host. `docs/user/remote-access.md`, `docs/internals/t3-connect.md`
- **Publish agent activity** (per environment) sends agent state to the relay for mobile push
  notifications and Live Activities; `t3 connect link --publish-only` gives notifications without a
  tunnel (reach the host via Tailscale etc.). `apps/server/src/cli/connect.ts`
- **Hold webhooks while offline** (opt-in): the relay's stable `/v1/hooks/...` URL forwards automation
  webhooks to the environment; when enabled it stores requests (≤1 MiB, up to 24 h) in a per-environment
  Durable Object and redelivers in order when the host returns, with dedupe via
  `x-t3-relay-delivery-id`. `docs/internals/t3-connect.md`, `docs/user/project-settings.md`
- Troubleshooting: `t3 connect status` checks the host's public address from the host; a four-part
  diagnosis on clients; documented causes (port 7844 TCP/UDP blocked, Tailscale exit node, clock skew,
  wrong account, tunnel limit). `docs/user/t3-connect-troubleshooting.md`
- Self-hosting the relay is possible via `infra/relay` (Alchemy: Cloudflare, PlanetScale, Axiom, your own
  Clerk, Firebase/APNs for push); a fresh source clone has T3 Connect disabled until `.env` public
  config is set. `docs/operations/connect-setup.md`, `docs/operations/android-notifications.md`

### Desktop-managed SSH
- Desktop **Settings → Environments → Add environment → SSH** with a host or SSH alias (host picker reads
  `~/.ssh/config`; "Use local SSH config, agent, and tunnels"). T3 starts or reuses a server on the
  remote host, downloads its runtime to `~/.t3/runtime`, and opens the port forward; projects, provider
  credentials and agents stay remote. Remote must be Linux or Apple Silicon macOS with curl/wget, tar,
  sha256sum/shasum; provider CLIs must be on a non-interactive login shell's `PATH`.
  `docs/user/remote-access.md`, `packages/ssh/src/tunnel.ts`
- Password/passphrase prompts are shown in the desktop UI via an askpass helper (3 min timeout) (from
  code). Removing the connection stops only a server T3 launched. Each desktop keeps one session per host,
  revocable on the host (`t3 auth session list|revoke`). Remote logs at
  `~/.t3/ssh-launch/<state>/server.log`. `apps/desktop/src/ssh/DesktopSshPasswordPrompts.ts`,
  `docs/operations/observability.md`

### WSL (Windows)
- Desktop on Windows can run a second backend inside a chosen WSL distro (**WSL backend**, "Run the
  selected WSL distro alongside Windows"), or **WSL only**. T3 installs its own server runtime inside the
  distro (Windows packages embed the Linux CLI archive); provider CLIs must be installed in the distro.
  `docs/user/install.md`, `apps/desktop/src/wsl/`, `apps/web/src/components/settings/ConnectionsSettings.tsx`
- Native process telemetry is unavailable for the WSL backend. `docs/internals/resource-telemetry.md`

### Desktop as remote only
- **Settings → Environments → Local environment** off: restarts with no local server, agents, terminals
  or WSL backends; works only through pairing, T3 Connect or SSH; data kept.
  `docs/user/remote-access.md`, `apps/desktop/src/settings/DesktopAppSettings.ts`

### Outside agents over MCP (related)
- Each environment serves `/mcp`; Claude Code, Codex, ChatGPT or bots sign in via OAuth (PKCE, loopback or
  HTTPS redirect) with a pairing code; owner grants read-only or a runtime-mode ceiling; listed and
  revocable in Sharing & access. Hosted agents need the T3 Connect address. `docs/user/outside-agents.md`,
  `docs/internals/environment-auth.md`

## 7. Auth, pairing, tokens, accounts

- Server auth policies (from code): `desktop-managed-local`, `loopback-browser`, `remote-reachable`
  chosen from mode and bind host. Session methods: browser session cookie, bearer token, DPoP-bound
  token; short-lived WebSocket tickets keep long-lived tokens out of URLs.
  `packages/contracts/src/auth.ts`, `apps/server/src/auth/EnvironmentAuthPolicy.ts`
- Scopes (repeat `--scope`; default grant = all): `orchestration:read`, `orchestration:operate`,
  `settings:write`, `providers:manage`, `environment:maintain`, `preview:operate`, `diagnostics:read`,
  `terminal:read`, `terminal:operate`, `source-control:write`, `filesystem:read`, `filesystem:write`,
  `access:read`, `access:write`, `relay:read`, `relay:write`. Docs note `terminal:operate` or
  `orchestration:operate` can mint a full session anyway, so a restricted client needs neither.
  Changing a client's permissions = re-pair with a fresh link. `docs/user/remote-access.md`,
  `packages/contracts/src/auth.ts`
- Defaults (from code): one-time pairing token 5 min; sessions 30 days; WebSocket tickets 5 min; MCP
  client sessions 30 days. Pairing secrets are never recoverable from listings; the hosted pairing URL
  carries the secret in the URL fragment. `apps/server/src/auth/PairingGrantStore.ts`,
  `apps/server/src/auth/SessionStore.ts`, `docs/internals/remote.md`
- **Sharing & access** (host): create pairing links, list connected clients/sessions with labels,
  revoke one or "Revoke others", list MCP clients and linked environments. A session with an open
  connection stays listed after its credential expires. `docs/user/remote-access.md`
- Reusable dev credential `T3CODE_DEV_AUTH_TOKEN` (dev servers only). `docs/internals/environment-auth.md`
- Accounts: T3 Connect uses Clerk (desktop via system-browser callback to `t3code://app/`, macOS
  passkeys; mobile Clerk native with Sign in with Apple; CLI OAuth). T3 Chat account linking uses WorkOS on
  the T3 Chat side, linked by consent. Account menu pages: T3 Connect (environments, Deregister), T3 Chat
  (Link T3 Chat), **Mobile clients** (devices receiving push/Live Activities).
  `docs/operations/connect-setup.md`, `docs/internals/t3-connect.md`,
  `apps/web/src/components/clerk/MobileClientsUserProfilePage.tsx`
- Secret storage: server secrets as files in a 0700 secrets dir (0600 files); desktop saved-environment
  credentials encrypted with Electron `safeStorage` (OS keychain; Linux backend selectable
  `auto|gnome-libsecret|kwallet|kwallet5|kwallet6` in the desktop settings file, no UI found); mobile
  uses `expo-secure-store`. Provider instances can mark env vars as sensitive; 1Password secret provider
  exists (other area). (from code) `apps/server/src/auth/ServerSecretStore.ts`,
  `apps/desktop/src/settings/DesktopSavedEnvironments.ts`, `apps/desktop/src/linuxSecretStorage.ts`

## 8. Multi-machine features

- **Load balancing** (off by default; Settings → Environments, shown with ≥2 machines on): auto-picks
  a machine for new threads in projects grouped across environments (from code: score = CPU count × idle
  CPU × free-memory share × weight; skips hosts ≥95% CPU or ≤5% free memory); per-machine preference Prefer / Normal / Less often / Manual only (per client).
  Existing threads stay put; mobile keeps manual selection. `docs/user/remote-access.md`,
  `packages/client-runtime/src/load-balancing.ts`
- **Linked environments (beta, Settings → Labs on both machines)**: link e.g. laptop and VPS so agents on
  one launch, message, wait on, stop threads, answer questions, manage queues/projects/scheduled tasks on
  the other. Link via Settings → Environments → Linked environments, `t3 environment link`, or by asking
  an agent ("delegate this to my vps", approve a card). Access ceiling per link; below full access the
  link's agents can only touch threads it started and skip setup scripts; threads marked **From
  <machine>**; links last 30 days; `delegate_task` can run a task on a linked machine and wake the parent
  with the result. Implemented as an OAuth MCP client of the other side's `/mcp` with mode limits in
  `T3-Mode-Limit`. `docs/user/remote-access.md`, `docs/internals/remote.md`, `apps/server/src/peer/`
- **Pull request sharing** (off by default): per environment **Read PRs** or **Read and act**, letting
  another connected environment's source-control credentials answer PR reads/actions.
  `docs/user/source-control.md`
- One client aggregates threads, PRs, usage and settings across all connected environments; projects
  can be grouped across environments. `docs/user/project-settings.md`, `docs/internals/remote.md`

## 9. Guest links (beta)

- Share one thread with one person, no account: **Share with guest** (thread context menu, thread menu,
  command palette). Requires **Settings → Labs → Guest links** on that machine and T3 Connect (link
  points at the machine's T3 Connect address); machine must stay online. `docs/user/guest-links.md`
- Read-plus-propose, not interactive control: the guest sees recent history and the live stream
  (messages, files, replies, reasoning, plans, questions, work with command output; from code: last
  20 user turns / 600 rows of history), no diffs, cannot fork/revert/open files/answer for you or change
  the model. Guest messages appear as **Request**; the owner chooses **Send** (runs as a normal turn) or
  **Dismiss**, also from mobile. `docs/user/guest-links.md`, `apps/server/src/guest/GuestShareService.ts`
- Limits: one browser per link, 24 h expiry, **Stop sharing** / archive / new link / unlinking revokes;
  attachments ≤4 files and 10 MB per message (PNG/JPEG/GIF/WebP images), 20 MB pending. Tokens are
  HMACs, never sessions, so no RPC/WebSocket/MCP path accepts them. `docs/user/guest-links.md`,
  `docs/internals/environment-auth.md`

## 10. Devices (iOS Simulator / Android Emulator)

In T3 Code "Devices" means simulators/emulators (and physical Android devices) driven by the
environment server, not client devices.

- **Device panel** in a thread's right panel: live, interactive iOS Simulator or Android Emulator
  screen (touch, type, Home/Back/Recents, rotate, power off), tabs per device, **Float device over chat**,
  3D view (incl. foldable posture controls), **Tools** drawer (appearance, text size, accessibility
  toggles and overlays, fake location, app permissions; iOS: Liquid Glass, color filters, VoiceOver,
  test push; Android: orientation, network). First-run setup installs the hub; nothing downloads until
  then. `docs/user/devices.md`
- Runs on the environment's machine (iOS needs macOS + Xcode; Android needs SDK tools, an AVD, and
  ffmpeg/libx264 for emulator video); streams through the environment so it works over LAN, Tailscale and
  T3 Connect (live video needs HTTPS or localhost). `docs/user/devices.md`
- Device sources (Settings → Devices → Add source): **Machine over SSH** (key-based; Node 22+ on host;
  Test connection), **EAS Simulator** (billed Expo cloud sessions with session/idle/concurrency limits)
  (UI from code; internals doc), **Simlock pool (alpha, behind Labs)**. `docs/user/devices.md`,
  `docs/internals/devices.md`, `apps/web/src/components/settings/DeviceSourcesSettings.tsx`
- Agents: `device_list/open/screenshot/close` tools plus the `agent-device` CLI, only when **Agents can
  use devices** is on; an agent-opened device auto-floats over chat on web/desktop; mobile shows a device
  button above the composer. Components: expo-device-hub (streams) and agent-device (drives), pinned
  versions installed into the T3 home; the hub is only reachable through an authenticated allowlisting
  proxy. `docs/user/devices.md`, `docs/internals/devices.md`
- Client-device management (separate concept): the account menu's **Mobile clients** page lists phones
  registered for push/Live Activities; mobile settings control per-device notifications.
  `apps/web/src/components/clerk/MobileClientsUserProfilePage.tsx`

## 11. Mobile app (iOS / Android)

### Platform and connection
- React Native/Expo app; iOS 18.0+ (iPhone and iPad), Android 7.0+ (API 24). The phone is a remote only:
  the computer runs the agents and must stay on. `apps/mobile/app.config.ts`, `docs/user/faq.md`
- Connect via T3 Connect sign-in ("Reach your machines from anywhere, no network setup"), QR scan
  (camera), or address + pairing code. Many environments at once; Settings has an environment filter.
  Local-network permission prompt covers LAN/tailnet servers; arbitrary HTTP loads allowed for LAN
  (from code).
  `apps/mobile/src/features/connection/`, `apps/mobile/app.config.ts`

### Feature inventory (from routes and feature folders; most also in user docs)
- Threads: list with filters/search (incl. message matches), swipe actions, archive/undo, snooze,
  arrange/drag, pinning, new-task flow (project/environment/branch/worktree/files/attachments/settings),
  queued messages and steering, subagents sheet, background-work sheet, proposed-plan cards.
  `apps/mobile/src/Stack.tsx`, `apps/mobile/src/features/threads/`, `docs/user/thread-sidebar.md`
- Approvals and input: pending approval cards, user-input/question cards (with attachments), secret
  request cards, link-request cards (linked environments). `apps/mobile/src/features/threads/`
- Diffs and review: native review-diff module, review comments, full pull-request views (files, viewed
  state, discussion, inline comments, reviewers, labels, edit, merge controls, stacks, review guides).
  Previously loaded PR lists/diffs stay readable offline. `apps/mobile/modules/t3-review-diff`,
  `apps/mobile/src/features/pull-requests/`, `docs/user/source-control.md`
- Git: overview, commit, branches screens. `apps/mobile/src/Stack.tsx`
- Terminal: native terminal per thread built on libghostty (iOS/Android). `apps/mobile/modules/t3-terminal`
- Files: workspace file tree and previews (code, markdown, images, video, audio, CSV, PDF, ZIP).
  `apps/mobile/src/features/files/`
- Browser preview stream of the environment's browser tabs, with system picture-in-picture ("Pop into
  separate window"); device preview stream; MCP Apps and HTML renders in WebViews.
  `docs/user/remote-access.md`, `apps/mobile/src/features/browser/`, `apps/mobile/src/features/devices/`
- Settings mirror server settings (environments, new threads, source control, agent behavior,
  worktrees, labs, provider accounts, maintenance incl. DB repair hint, scheduled tasks, notifications,
  appearance with Material You on Android 12+, keyboard, microphone, usage, archive, client storage,
  diagnostics, licenses). `apps/mobile/src/Stack.tsx`, `docs/user/appearance.md`
- Usage screen (limits, daily chart), triage start, prompt links/handoffs. `apps/mobile/src/features/usage/`
- iPad: split layout, hardware-keyboard shortcuts (`Cmd+1…9`, `Cmd+K` palette, `Cmd+Shift+H` moves a
  draft to the next machine). `docs/user/keybindings.md`
- Voice input (iPhone, iOS 26+ only): on-device Apple transcription into the draft, ≤5 min recordings,
  ranked microphone list (built-in/wired/Bluetooth/CarPlay). Web, desktop and Android lack it.
  `docs/user/composer.md`, `docs/internals/voice-input.md`

### Notifications, Live Activities, widgets
- Push requires T3 Connect + environment **Publish agent activity**; enable **Device Notifications** in
  Settings → Notifications. Alerts for finished, failed, needs approval, asks for input; tap opens the
  thread; grouped alerts ("2 agents need attention"). Foreground alerts suppressed only for the thread on
  screen. Phone needs no live connection to the environment. `docs/user/mobile-notifications.md`,
  `docs/operations/android-notifications.md`
- iOS **Live Activity Updates** (Lock Screen + Dynamic Island layouts, `AgentActivity` live activity,
  push-updated via APNs); Android **Ongoing Agent Activity** card, promoted to a Live Update status-bar
  chip ("Working" / "Approve" / "Answer") on Android 16+. Finished results visible up to 15 min.
  Delivery: relay → APNs or FCM HTTP v1 (no Expo push account), queued with retries and per-device
  preference checks (approval/input/completion/failure flags). `docs/user/mobile-notifications.md`,
  `apps/mobile/src/widgets/AgentActivity.tsx`, `infra/relay/src/agentActivity/`,
  `packages/contracts/src/relay.ts`
- Home-screen widget **Subscription usage** (iOS small–extra-large + Lock Screen; Android resizable):
  remaining Codex and Claude session/weekly quotas; tap opens Usage → Limits. `docs/user/usage.md`,
  `apps/mobile/app.config.ts`
- App shortcuts (long-press icon): New task plus the 3 most recent threads (from code).
  `apps/mobile/src/features/shortcuts/appShortcuts.ts`
- Share extension / share target: share text, a URL, up to 8 images/videos/files from other apps into a
  T3 draft (iOS); Android accepts any MIME type (from code). `apps/mobile/app.config.ts`,
  `apps/mobile/src/features/sharing/`
- Deep links: `t3code://` scheme (variants `t3code-dev`, `t3code-preview`) and universal links;
  `t3code://pair` links for pairing. `apps/mobile/app.config.ts`, `packages/shared/src/remote.ts`

### Offline behaviour
- Drafts and queued messages (with local copies of attachments) work offline and survive restarts;
  uploads resume on reconnect; signing out of T3 Connect keeps queued work for that account.
  `docs/user/composer.md`
- Cached projections (thread list, thread detail, PR data) stay readable offline but are marked as not
  live; mobile does not keep threads alive in the background (desktop does). SQLite-backed client
  caches can be inspected/cleared in **Client Storage**. `docs/internals/connection-runtime.md`,
  `apps/mobile/src/connection/`

### Diagnostics
- **Settings → Diagnostics** lists startup crashes from the last 7 days with error and component stack
  (copyable for issues); **Send crash reports** toggle. `docs/user/install.md`, `docs/user/telemetry.md`

## 12. Desktop app (Electron)

### Shell and local server management
- Main window with persisted bounds (from code); app menu with Check for Updates, Settings, Paste as
  Text, zoom, reload/devtools. **Quit shortcut** setting: `hold` (default), `double-click` (press twice)
  or `direct` for Cmd/Ctrl+Q. `apps/desktop/src/window/`, `apps/desktop/src/window/QuitHold.ts`,
  `packages/contracts/src/settings.ts`
- The renderer is served from disk via the `t3code://` scheme, not by the backend, which is what
  allows running without a local server. `docs/internals/remote.md`
- Desktop-only settings (file `DesktopAppSettings`): local environment on/off, server exposure mode,
  Tailscale Serve + port, update channel, WSL backend/distro/WSL-only, Linux password store, window
  state. `apps/desktop/src/settings/DesktopAppSettings.ts`
- Sharing & access on a desktop host: Network access, Tailscale HTTPS, T3 Connect, Publish agent
  activity, Hold webhooks while offline, pairing links, authorized clients. `docs/user/remote-access.md`,
  `apps/web/src/components/settings/settingsSearch.ts`

### OS integration
- `t3 app [path]` opens a project in the running app over a local socket. `docs/user/install.md`,
  `apps/desktop/src/app/DesktopAppActivation.ts`
- Deep links: `t3code://pair` (add a server after confirming the address), `t3code://app/` OAuth callbacks
  (Clerk, Codex/ChatGPT); Linux AppImage registers its URL handler via a hidden `.desktop` entry (from
  code). `docs/user/remote-access.md`, `apps/desktop/src/app/DesktopLinuxUrlHandler.ts`
- Default web browser (macOS): links from other apps open in the thread's browser panel or a new
  project-less thread; HTML files from Finder and app.t3.codes prompt links open in the app.
  `docs/user/default-browser.md`
- Notification badge: dock/launcher badge count on macOS/Linux, taskbar overlay icon on Windows (from
  code). `apps/desktop/src/ipc/methods/notificationBadge.ts`
- SnapShots (off by default): global shortcut (default both Shift keys) captures the focused window plus
  optional accessibility text into the current draft; macOS, Windows, Linux Wayland (GNOME via bundled
  "T3 Code SnapShots" GNOME Shell extension for shells 45–51; KDE, Hyprland, Niri helpers; X11 not
  supported). `docs/user/snap-shot.md`, `apps/desktop/gnome-extension/metadata.json`, `native/*-snap-shot`
- macOS permission helper window for Screen Recording, Accessibility and Full Disk Access (drag the app
  into System Settings). `apps/desktop/src/permissions/MacPermission.ts`
- Desktop browser panel extras: per-tab picture-in-picture window (~12 fps JPEG frames), screencast
  recording, element picker, annotation, passkeys bridge on macOS, browser-session import (from code;
  feature area likely covered elsewhere). `apps/desktop/src/preview/`, `apps/desktop/src/preload.ts`
- Desktop keeps every running thread's stream mounted so opening a running thread needs no replay (web and
  mobile do not). `docs/internals/connection-runtime.md`

### Startup and recovery
- Single-instance lock; "T3 Code could not start" window when the bundled server fails, with Update or a
  link to the last version that started, and **Copy details**. `docs/user/updating.md`,
  `apps/desktop/src/app/DesktopStartupRecovery.ts`
- macOS PR preview builds: label a PR `preview:mac` to get a signed, notarized Apple Silicon DMG
  (maintainer-gated). `docs/operations/release.md`

## 13. Client notifications and background policy (web/desktop)

- **Thread notifications**: Off / Notifications / Sound / Notifications and sound; system alerts when a
  thread finishes, fails, or needs input/approval, on this device while T3 Code is open (browser needs
  HTTPS). Separate **In-app notifications** setting. `apps/web/src/components/settings/NotificationSettings.tsx`
- **Background activity** policy (from code): Balanced / Performance / Battery saver / custom, with
  toggles "Pause when host is locked", "Pause on host low power", "Pause on client low power", "Pause on
  battery", and intervals for git fetch, provider health and host power polling. Server-side
  `BackgroundPolicy` + `HostPowerMonitor` (Electron power feed). 
  `apps/web/src/components/settings/BackgroundActivitySettings.tsx`, `apps/server/src/background/`

## 14. Telemetry, analytics, diagnostics, observability

- Product analytics: the **server** sends events to `ingest.t3.codes` (archived, forwarded to PostHog);
  clients never load PostHog. Includes provider, model, effort, permission mode, turn result, duration,
  channel, main-agent token totals, `feature.used` counts; hashed IDs (install, T3 Connect account,
  OpenAI/Claude account ids, per-device id). Excludes prompts, responses, file contents, tokens,
  conversation IDs. Opt out: `T3CODE_TELEMETRY_ENABLED=false` in the server env (desktop reads it from
  the shell profile on macOS/Linux, user env var on Windows). `docs/user/telemetry.md`,
  `docs/internals/product-analytics.md`
- Relay connection traces go to Axiom (also off with the telemetry switch or `OTEL_SDK_DISABLED`).
  Mobile crash/error reports and startup timings go via the relay (`/v1/mobile/observe`) to Axiom, with
  server-side source-map symbolication; toggle **Send crash reports**. `docs/user/telemetry.md`,
  `docs/operations/relay-observability.md`
- Own OTLP export: **Settings → Maintenance → Diagnostics → OpenTelemetry export** per environment
  (traces/metrics/logs OTLP HTTP endpoints, **Test** button) or `T3CODE_OTLP_*_URL`,
  `T3CODE_OTLP_HEADERS`, `T3CODE_OTLP_PROTOCOL`, standard `OTEL_EXPORTER_OTLP_*`. `docs/user/telemetry.md`
- Local observability: completed spans to `~/.t3/userdata/logs/server.trace.ndjson` (rotated,
  `T3CODE_TRACE_*`), pretty logs to stdout, `t3 trace summary`; maintainer runbook for Grafana LGTM, event
  loop stall detection, heap snapshots. `docs/operations/observability.md`
- Diagnostics settings page (web/desktop): **Live Processes** (process tree with SIGINT/SIGKILL buttons),
  **Resource History**, **Trace Diagnostics** (latest/most common failures, slowest spans, span logs, top
  span names). `apps/web/src/components/settings/DiagnosticsSettings.tsx`,
  `apps/web/src/components/settings/ProcessSignalActions.tsx`
- Resource telemetry: a standalone Rust monitor (`native/resource-monitor`, `sysinfo`) samples processes
  only while diagnostics has subscribers (or once a minute when OTLP metrics export is on); bounded
  in-memory history, no telemetry DB; Electron adds host power and app metrics. Also feeds load-balancing
  resource snapshots. `docs/internals/resource-telemetry.md`
- Connection diagnostics: per-environment **Details** with failing stage, **Copy diagnostics**, trace ID;
  `t3 connect status`; `t3 triage` hands a problem to Claude/Codex. `docs/user/t3-connect-troubleshooting.md`
- `t3 doctor` / Settings → Maintenance reclaim database space (suggested at ≥1 GiB reclaimable).
  `docs/user/background-service.md`

## 15. Licensing, cost, notable FAQ items

- MIT license, © 2026 T3 Tools Inc. Third-party notices viewable in Settings → About → Open source
  licenses (also on mobile), including on-demand device tools. `LICENSE`, `docs/user/open-source-licenses.md`
- Free; "no way to pay us"; users bring their own provider subscriptions. T3 Connect free "for now"
  (3 machines; more via paid T3 Chat). `docs/user/faq.md`
- Code and prompts go from the host to the provider, not to T3 servers; T3 Connect traffic rides a
  Cloudflare tunnel and the relay does not proxy sessions. `docs/user/faq.md`
- Claude runs through Anthropic's Agent SDK; FAQ notes SDK usage drains the 5-hour limit faster (Anthropic
  bug). No local-model support by design. One-account-per-provider-instance stance (no auto-switcher;
  suggests CLIProxyAPI for pools). `docs/user/faq.md`
- Windows, macOS and Linux supported for desktop and CLI (no Intel-Mac CLI); WSL for agents on Windows.
  `docs/user/faq.md`
- Welcome wizard: on a new install selects computers (local, T3 Connect, Add a computer), checks Claude
  Code/Codex on each, and imports recent Claude/Codex/Pi conversations (last 30 days, best effort, 200
  messages each) grouped by computer; app.t3.codes asks for T3 Connect sign-in then `npx t3 connect`.
  `docs/user/welcome-wizard.md`
