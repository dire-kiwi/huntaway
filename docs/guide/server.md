# Running a server

## Server options

`huntaway serve` (or `huntaway` alone) runs the server; `huntaway serve --help` lists every flag. Each flag has a
`HUNTAWAY_*` variable that is used when the flag isn't given. (The old server's `IA_*` variables are not read: rename
them in service units and deploy scripts.)

| Flag / env                                       | Default                          |                                                                                                                                                                               |
| ------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--host` / `HUNTAWAY_HOST`                       | `0.0.0.0`                        | Use `127.0.0.1` to disable network access                                                                                                                                     |
| `--port` / `HUNTAWAY_PORT`                       | `7879`                           | `0` picks a free port (printed in the `HUNTAWAY_READY {"port": …}` line on stdout)                                                                                            |
| `--data-dir` / `HUNTAWAY_DATA_DIR`               | `~/.local/share/huntaway-effect` | DB, auth token, attachments, run folders, worktrees of projects made here (`$XDG_DATA_HOME/huntaway-effect` when that is set)                                                 |
| `--ui-dir` / `HUNTAWAY_UI_DIR`                   | auto                             | Built UI (`apps/web/dist`)                                                                                                                                                    |
| `--claude-bin` / `HUNTAWAY_CLAUDE_BIN`           | `claude`                         | Claude Code binary                                                                                                                                                            |
| `--codex-bin` / `HUNTAWAY_CODEX_BIN`             | `codex`                          | Codex binary                                                                                                                                                                  |
| `--gh-bin` / `HUNTAWAY_GH_BIN`                   | `gh`                             | The GitHub CLI the board's own GitHub calls and the agents' gh tools run                                                                                                      |
| `--shim-bin` / `HUNTAWAY_SHIM_BIN`               | auto                             | The `ia-shim` agents run under (the checkout's `target/release` or `target/debug`, else beside `bin/huntaway`)                                                                |
| `--token` / `HUNTAWAY_TOKEN`                     | generated                        | Use this access token instead of the one in the data dir (a secret shared by deployments)                                                                                     |
| `--name` / `HUNTAWAY_NAME`                       | hostname                         | Name this host shows on boards                                                                                                                                                |
| `--hub` / `HUNTAWAY_HUB`                         |                                  | Hub(s) to dial out to (comma-separated)                                                                                                                                       |
| `--hub-token` / `HUNTAWAY_HUB_TOKEN`             |                                  | Token for `--hub`, from that hub's Settings → Hosts                                                                                                                           |
| `--source-dir` / `HUNTAWAY_SOURCE_DIR`           | the checkout the server runs in  | Repository to rebuild from on restart                                                                                                                                         |
| `--update-from` / `HUNTAWAY_UPDATE_FROM`         |                                  | A deployment of the board (e.g. `https://board.example`) to offer updates to                                                                                                  |
| `--release-updates` / `HUNTAWAY_RELEASE_UPDATES` |                                  | A GitHub repository (`OWNER/REPO`, e.g. `dire-kiwi/huntaway`) whose releases to check for a newer server, for release installs                                                |
| `--demo` / `HUNTAWAY_DEMO`                       | off                              | On a fresh data dir, create a "Default" profile with a sample "Demo" project and tasks (used by PR previews)                                                                  |
| `--open-token` / `HUNTAWAY_OPEN_TOKEN`           | off                              | Give the access token to any browser that opens the board, so it signs in without `?token=`. Anyone who can reach the server gets full control (used by LAN-only PR previews) |
| `--profile NAME=DIR` / `HUNTAWAY_PROFILES`       |                                  | On start, make a profile `NAME` with the Claude config in `DIR`, unless there's a profile of that name already (repeatable, or comma-separated).                              |
| `--no-discovery` / `HUNTAWAY_NO_DISCOVERY`       | off                              | Neither advertise this host over mDNS (`_huntaway._tcp.local`) for other boards' Settings → Hosts → Nearby hosts nor look for others (see _Nearby hosts_ in `hosts.md`)       |
| `--no-agents` / `HUNTAWAY_NO_AGENTS`             | off                              | Run no agent at all (test servers)                                                                                                                                            |
| `--skip-db-backup` / `HUNTAWAY_SKIP_DB_BACKUP`   | off                              | Start even when the database can't be backed up before it's migrated (see _Release builds_ in `desktop.md`)                                                                   |
| `--telemetry-url` / `HUNTAWAY_TELEMETRY_URL`     |                                  | The ClickHouse this host sends telemetry to (`http://USER:PASSWORD@HOST:8123/DATABASE`) when its Telemetry settings have none; see _Telemetry_                                |

The other commands: `huntaway token` prints the board's token (`--hub` the hub token), `huntaway install-service`
runs the server as a service (see _Running a host as a service_ in `hosts.md`), `huntaway ssh-host` is the forced
command of a hub's SSH key (see `hosts.md`), `huntaway telemetry` sets up telemetry (below), `huntaway google-auth`
signs a headless host in to Google (see `assistant.md`), `huntaway import-legacy` moves a board over from the old
server (see `switching.md`), and `huntaway --version` prints the version. `huntaway rpc <method> [json]` calls a
test server's RPC (`huntaway rpc --list` names the methods); it refuses anything but a test server started by
`scripts/test-server.sh`.

This server has a data folder and a port of its own, so it can run beside an old Huntaway server (port 7878,
`~/.local/share/huntaway` or `~/.local/share/issue-agent`) without touching it. It doesn't read the old server's
database: `switching.md` has how to move a board over.

## Agents survive restarts

Each agent run is started under `ia-shim`, which detaches it from the server and records its
output, pid and exit status in `<data-dir>/runs/<run_id>/`. The server only follows those files,
saving how far it has read. When it starts again it picks every unfinished run back up from
that point, so stopping, crashing or rebuilding the server doesn't interrupt agents.

A run's folder keeps everything the agent printed (every streamed delta, tool result and image),
which the thread no longer needs once the run is over. The old server removed it 14 days after the run ended; this
one doesn't remove run folders yet, and Settings → Disk shows what they take up. Every hour the server removes the
recorded MCP calls of runs that ended over an hour ago.

The pieces that cross a restart are durable too:

- A Claude run calls the board's tools on its own output and gets their answers on its input
  (see _Agent tools (MCP)_): a call still going when the server restarts (a `wait`, an approval)
  is found again in the recorded calls and answered when it's done. Codex runs and compactions
  reach the board's tools over HTTP, and the gh server's over HTTP too, answered on an event
  stream: when a restart breaks it, the agent (Claude Code or Codex) reconnects for the call's
  answer, and the call carries on where it was. The server records each call's result, so a call
  is never executed twice.
- Permission prompts are stored with the call that raised them. A prompt pending across a
  restart reappears, and the decision reaches the agent once it's made.

The shim is deliberately small and rarely changes. Shims that are already running never pick
up new code.

One caveat under `systemd`: by default a service restart kills its whole process group,
shims (and the tmux server behind terminals) included. Use `KillMode=process` (or run the shims in their own scope) to keep agents
alive across service restarts. The user service a host installs (see _Running a host as a service_ in `hosts.md`) does.

## The database file

The board's database is `<data dir>/board.db`. Before a start that migrates it (a new version that changes the
schema), the server copies it to `<data dir>/backups/board-<from>-to-<to>-<time>.db` and keeps the newest two
copies; _Release builds_ in `desktop.md` has what happens when the copy can't be made.

This server never opens the old server's files (`huntaway-2.db`, `huntaway.db`, `issue-agent.db`), and the old
server's choice between them (`IA_NEW_DB_FILE`, `--recopy-db`, **Copy again**) is gone. A board is moved over once,
with `huntaway import-legacy` (see `switching.md`), which reads the old file and leaves it as it was.

## Restarting after a merge

When the source checkout has commits the running server doesn't (for example, a task branch
merged to `main`), the sidebar shows **N new commits · Restart**. The same action is under
Settings → Server. At the top of the checkout it runs `pnpm install --frozen-lockfile` for the server and the UI
(pnpm on PATH, else the version `package.json` pins, through npx), `pnpm --filter huntaway-web run build`, and
`cargo build --release -p ia-shim` (skipped when there's no cargo and a prebuilt `apps/server/bin/ia-shim`, as
`scripts/install.sh` leaves without Rust), streaming the log, then re-execs `apps/server/bin/huntaway` with the same
arguments, so the PID stays the same and Electron or a supervisor keeps tracking it. Running agents keep going and
the new process picks them up. If a build fails, the old server keeps running.

With `--update-from <url>`, the server also follows that deployment of the board. Every five
minutes it asks the deployment which commit it runs (its unauthenticated `/api/health` reports
it) and fetches it from the checkout's `origin`. When that commit is ahead of the running
one, the sidebar shows **N new commits · Update**. Update fast-forwards the checkout to the commit
(it refuses if the checkout is dirty, or has diverged from the commit), then rebuilds and restarts
as above. Settings → Server shows the commit the deployment runs and when it was last checked.

With `--release-updates <OWNER/REPO>`, for a server installed from a release rather than a
checkout, the server checks that repository's GitHub releases 30 seconds after it starts, every six
hours, and on **Check now** in Settings → Server. It picks the highest semver release (not drafts, and prereleases
only with **Include prereleases** on) that has a `huntaway-server-<v>-<os>-<arch>.tar.gz` for this machine with a
sha256 digest, and shows it, with any error, in Settings → Server. Requests send the last ETag, so a check when
nothing changed doesn't count against GitHub's limit of 60 unauthenticated requests an hour.

A release newer than the running server is downloaded in the background into
`<data-dir>/app/<v>.partial/`, checked against the sha256 GitHub lists for it, unpacked with the
system `tar` (refusing entries outside its folder, and links), and smoke-tested with
`huntaway --version`. It's then renamed to `app/<v>/` and staged; a failed download is tried again on the next check.
A staged version that a later check no longer offers (a prerelease once they're turned off, or a
release that was taken down) is unstaged and deleted, even while a newer release downloads.
Update restarts onto it in place (agents keep running, as with a rebuild), downloading it first if it isn't staged
yet, and Roll back marks the running version bad and restarts onto the one before
it (or the desktop app's own server, `HUNTAWAY_BUNDLED_SERVER`). `app/state.json` records `current`,
`previous`, `staged`, `trying` and `bad`, and is shared with the desktop app, which picks the version
to start from it. A server running from `app/<v>/huntaway` makes itself `current` on startup and
deletes the versions nothing needs (all but current, previous and staged).

On the board, a staged release shows in the sidebar as **v<version> · Update**, which opens its
release notes and restarts onto it (a download still running, or one that failed, shows only in
Settings). Settings → Server shows the version running and where from, the latest release and when
it was checked, the background download, **Check now**, **Include prereleases** and **Roll back**.
When the latest release needs a new desktop app too, it says how to
install it: the `sudo pacman -U` command, the AppImage's link, or the dmg on the release page. The
AppImage and the pacman package can also do it themselves: **Update app** downloads the new AppImage
beside the running one, checks its sha256 against GitHub's digest and renames it over the old file;
**Install** downloads and checks the `.pacman` the same way and runs `pkexec pacman -U --noconfirm`
on it, which asks for your password in polkit's dialog. Either then relaunches the app. The app
takes the version from its server's release check and the package from GitHub's API, never from the page.

## Network access

Every call needs the token in `<data-dir>/auth_token` (`huntaway token` prints it; the
UI picks it up from `?token=` once and remembers it). Settings → Network access shows a
ready-made link. The token lets anyone holding it run agents on your machine, and traffic is
plain HTTP, so expose the server only on a trusted network (Tailscale, VPN) or behind a TLS
reverse proxy.

A server started with `--host 127.0.0.1` can still be used from another computer that can SSH into
its machine, through a tunnel:

```sh
ssh -N -L 7879:127.0.0.1:7879 you@that-machine    # leave it running
```

Then open `http://localhost:7879/?token=<huntaway token>` there (`huntaway token`, or
`<data-dir>/auth_token`, on that machine), or point the desktop app at it with `"serverUrl":
"http://localhost:7879"` and the token (see _Desktop config_). To show that machine's board next to
the other computer's own, link it as a host over SSH instead (see _Hosts_).

## Telemetry

A host can send its telemetry to a [ClickHouse](https://clickhouse.com) of your own, to query and chart across hosts
and keep for longer than a board keeps it: what agents did and cost, how each server is behaving, and the servers'
logs. It's off until you set it up, and nothing goes anywhere you didn't configure. The plan behind it is the old
repository's
[docs/notes/telemetry-clickhouse.md](https://github.com/dire-kiwi/huntaway-legacy/blob/master/docs/notes/telemetry-clickhouse.md),
and Grafana dashboards for it are in its
[docs/telemetry/grafana/](https://github.com/dire-kiwi/huntaway-legacy/tree/master/docs/telemetry/grafana).

**Setting it up:**

1. Create the tables, with a ClickHouse login that can (an admin's), from any machine that reaches it:
   `huntaway telemetry init --url http://admin@HOST:8123/huntaway`. A password left out of the URL is read from
   `HUNTAWAY_TELEMETRY_PASSWORD`; it isn't asked for. Run it again after an update: it adds new columns and changes
   nothing else.
2. Give each host a login of its own that can only insert, so one host can be cut off:
   `CREATE USER huntaway_<host> IDENTIFIED BY '…'` and `GRANT INSERT ON huntaway.* TO huntaway_<host>`.
   `huntaway telemetry test --url http://huntaway_<host>@HOST:8123/huntaway` checks it.
3. On the board, Settings → the host's page → **Telemetry**: the URL, database, user and password, then **Test** and
   **Save**. A host without a UI can be given `--telemetry-url` instead (used while its settings have none).
4. Turn on **Send this profile's tasks to telemetry** on each profile whose tasks you want sent (Settings → the host →
   Profiles on this host → Edit). It's off for every profile until then, because one host's profiles may be different
   people's, or different employers', work.
5. To send the history from before you turned it on: `huntaway telemetry backfill` on the host (with `--data-dir` if
   it isn't the default), for the profiles that send. It reads the database read-only beside the running server, and
   sends only what the server didn't: runs counted, prompts decided and automations finished before sending started,
   and board tool calls begun before then. So a run that was going when you turned it on isn't counted twice.

**What's sent:**

- **The server's events** (table `events`): each run's start and end, with its cost by model from the board's own
  count (the run's share of its session, not its `result`'s running total); title and window-restart calls; task
  status changes; permission prompts and the calls rules decided, with how long they waited; reviews' verdicts;
  merges; board tool calls (the tool and how long it took, not what it was given or gave); automations' runs; links to
  other hosts going up and down; errors nothing handled; restarts and updates.
- **Samples every minute** (`metrics`): event-loop delay, memory, runs running, tasks needing attention and the rows
  waiting to be sent. (The old server's slowest routes aren't measured here.)
- **The server's log lines** (`logs`): warnings and errors by default, or all of them, or none. A line about a task is
  only sent if the task's profile sends.
- **The agents' own events** (`agent_events`), unless turned off: Claude Code and Codex both export OpenTelemetry, so
  each run of a profile that sends is pointed at its own server (with a secret only that run has), which keeps a fixed
  list of attributes: API requests (model, tokens, cost, latency), tool calls and decisions (the tool, whether it
  worked, how long it took), errors and a prompt's length. Who's logged in (email, account and organization ids), the
  commands and patches Codex ran and their output, and any prompt text are dropped before anything leaves the machine.
  A login that already sends its own telemetry somewhere (its `settings.json` or the machine's managed settings set
  `OTEL_*`, or Codex's `config.toml` has `[otel]`) is left alone.

Each row has ids, keys, names, models, tools, decisions, counts and times. Task titles are included unless the profile
turns **Include task titles** off. Prompts, messages, tool input or output, diffs and file contents are never sent.
Error messages are, cut to 1 KB.

**How it's sent:** rows wait in the host's database (table `telemetry_outbox`) and go every 10 seconds in batches, so
a restart, an update or a crash loses nothing, and a laptop away from the network sends what it kept when it's back.
A batch that failed is sent again exactly as it was, with the same deduplication token, so ClickHouse counts it once.
Failures back off up to 5 minutes; one that's the setup's (a wrong password, a missing grant or table) waits half an
hour and shows on the Telemetry section, as do the rows waiting. Past 200,000 rows or 100 MB waiting, the oldest are
dropped and counted, as are rows ClickHouse can't read. Turning telemetry off deletes the rows still waiting; what's
already in ClickHouse stays there. Test servers and PR previews never send anything, as they're never given a
ClickHouse; `scripts/copy-live-board.sh` takes the live board's out of the copy it gives a test server.
