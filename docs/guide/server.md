# Running a server

## Server options

| Flag / env                                 | Default                                                         |                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--host` / `IA_HOST`                       | `0.0.0.0`                                                       | Use `127.0.0.1` to disable network access                                                                                                                                                                                                                                                                 |
| `--port` / `IA_PORT`                       | `7878`                                                          | `0` picks a free port (printed in the `IA_READY {"port": …}` line on stdout)                                                                                                                                                                                                                              |
| `--data-dir` / `IA_DATA_DIR`               | `~/.local/share/huntaway` (`…/issue-agent` if only that exists) | DB, auth token, scratch folders, worktrees                                                                                                                                                                                                                                                                |
| `--ui-dir` / `IA_UI_DIR`                   | auto                                                            | Built UI (`apps/web/dist`)                                                                                                                                                                                                                                                                                |
| `IA_CLAUDE_BIN`                            | `claude`                                                        | Claude Code binary                                                                                                                                                                                                                                                                                        |
| `IA_CODEX_BIN`                             | `codex`                                                         | Codex binary                                                                                                                                                                                                                                                                                              |
| `--token` / `IA_TOKEN`                     | generated                                                       | Use this access token instead of the one in the data dir (a secret shared by deployments)                                                                                                                                                                                                                 |
| `--name` / `IA_NAME`                       | hostname                                                        | Name this host shows on boards                                                                                                                                                                                                                                                                            |
| `--hub` / `IA_HUB`                         |                                                                 | Hub(s) to dial out to (comma-separated or repeated)                                                                                                                                                                                                                                                       |
| `--hub-token` / `IA_HUB_TOKEN`             |                                                                 | Token for `--hub`, from that hub's Settings → Hosts                                                                                                                                                                                                                                                       |
| `--broker` / `IA_BROKER`                   |                                                                 | Broker to dial out to, to be reachable through it (see _Reaching a host from anywhere_)                                                                                                                                                                                                                   |
| `--broker-token` / `IA_BROKER_TOKEN`       |                                                                 | Token for `--broker` (the broker's `BROKER_TOKEN`)                                                                                                                                                                                                                                                        |
| `--broker-name` / `IA_BROKER_NAME`         | host name, as a slug                                            | Name to reach this host by on the broker                                                                                                                                                                                                                                                                  |
| `IA_CLOUDFLARED_BIN` (env only)            | `cloudflared`                                                   | Connector binary for a broker with managed tunnels                                                                                                                                                                                                                                                        |
| `--source-dir` / `IA_SOURCE_DIR`           | checkout the binary was built in                                | Repository to rebuild from on restart                                                                                                                                                                                                                                                                     |
| `--update-from` / `IA_UPDATE_FROM`         |                                                                 | A deployment of the board (e.g. `https://board.example`) to offer updates to (API 65)                                                                                                                                                                                                                     |
| `--release-updates` / `IA_RELEASE_UPDATES` |                                                                 | A GitHub repository (`OWNER/REPO`, e.g. `dire-kiwi/huntaway`) whose releases to check for a newer server, for release installs (API 88)                                                                                                                                                                   |
| `--demo` / `IA_DEMO`                       | off                                                             | On a fresh data dir, create a "Default" profile with a sample "Demo" project and tasks (used by PR previews)                                                                                                                                                                                              |
| `--open-token` / `IA_OPEN_TOKEN`           | off                                                             | Give the access token to any browser that opens the board, so it signs in without `?token=`. Anyone who can reach the server gets full control (used by LAN-only PR previews)                                                                                                                             |
| `IA_NEW_DB_FILE`                           | on                                                              | The board is kept in `huntaway-2.db`, copied from `huntaway.db` on the first start (see _The database file_); `0` keeps it in `huntaway.db`, where threads stay on their messages                                                                                                                         |
| `--recopy-db` / `IA_RECOPY_DB`             | off                                                             | With `IA_NEW_DB_FILE`: copy `huntaway.db` into `huntaway-2.db` again if an older build has changed it since the first copy, discarding what's been done in `huntaway-2.db` since (see _The database file_). Only for the start it's given to: a restart, Update or Roll back from the board leaves it out |
| `--profile NAME=DIR` / `IA_PROFILES`       |                                                                 | On start, make a profile `NAME` with the Claude config in `DIR`, unless there's a profile of that name already (repeatable, or comma-separated). Used by PR previews, to give them a `personal` profile on a Claude login mounted from their host                                                         |

## Agents survive restarts

Each agent run is started under `ia-shim`, which detaches it from the server and records its
output, pid and exit status in `<data-dir>/runs/<run_id>/`. The server only follows those files,
saving how far it has read. When it starts again it picks every unfinished run back up from
that point, so stopping, crashing or rebuilding the server doesn't interrupt agents.

A run's folder keeps everything the agent printed (every streamed delta, tool result and image),
which the thread no longer needs once the run is over, so the server removes it 14 days after
the run ends (`runs::KEEP_DAYS`), or as soon as its task is deleted. It checks every hour, and
also removes the recorded MCP calls of runs that ended over an hour ago.

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
alive across service restarts.

## The database file

The board's database is `<data dir>/huntaway-2.db`. Older builds used `huntaway.db` (or `issue-agent.db`, from before
the rename to Huntaway); the release that moves task threads onto items (HA-222, see `docs/threads.md`), whose
database an older build can't read correctly (a thread on items has no messages since it moved), keeps the board in a
file of its own so that going back to an older build is safe. `IA_NEW_DB_FILE=0` keeps a server on the older file
(`IA_NEW_DB_FILE=0 scripts/test-server.sh`, whose restarts keep it): since HA-225 its tasks move onto items there too,
so an older build rolled back to on that file shows each thread as it was when its task moved. With it on,
as by default:

- The first time the server starts on a data dir, it copies the older file into `huntaway-2.db` (with
  what's still in its write-ahead log, as `VACUUM INTO` to `huntaway-2.db.partial`, then a rename),
  migrates the copy, and uses that from then on. That's before it serves anything, so the first start
  takes longer on a big board (a few seconds for a gigabyte). It only reads the older file, which stays as
  it was: a start that stops part-way leaves it in use and copies it again next time. A fresh data dir
  gets only `huntaway-2.db`.
- **Going back** to an older build (Roll back, an older package or a checkout from before) opens the
  older file as it was at the switch, with every thread whole. What was done in between (tasks, threads, settings) is
  only in `huntaway-2.db`, and lost to the older build. Agents that
  were running at the switch carry on, as over any restart.
- **Coming forward again** after an older build has run for a while: `huntaway-2.db` hasn't got what
  the older build did. The server notices that the older file has changed since it was copied (its size
  or modification time, or its log's), logs a warning and shows it in Settings → Server (and a linked
  host's page). **Copy again** there (or starting it with `--recopy-db`) copies the older file again,
  discarding what's been done in `huntaway-2.db` since; that's kept in `huntaway-2.db.replaced` until
  the next copy. Nothing is copied again without asking. A copy that fails (the older file isn't a
  database, or the disk is full) is logged, and the server carries on with `huntaway-2.db` as it was.
- **Backups** around updates (see _Release builds_) are of `huntaway-2.db` once it's there. The first
  start needs none, since the older file isn't written: it is the backup.
- Each machine copies its own: linked hosts and a hub each have their own data dir.
- The copy takes as much disk space again as the older file, which isn't removed: delete `huntaway.db`
  (with its `-wal` and `-shm`) once you won't go back to an older build.
- `scripts/copy-live-board.sh` copies the file the live server has open (after a Roll back, both files
  are there and the older one is in use).

## Restarting after a merge

When the source checkout has commits the running server doesn't (for example, a task branch
merged to `master`), the sidebar shows **N new commits · Restart**. The same action is under
Settings → Server. At the top of the checkout it runs `pnpm install --frozen-lockfile` for the server and the UI
(pnpm on PATH, else the version `package.json` pins, through npx), `pnpm --filter huntaway-app run build`, and
`cargo build --release -p ia-shim` (skipped when there's no cargo and a prebuilt `apps/server/bin/ia-shim`, as
`scripts/install.sh` leaves without Rust), streaming the log, then re-execs `apps/server/bin/huntaway` with the same
arguments, so the PID stays the same and Electron or a supervisor keeps tracking it. Running agents keep going and
the new process picks them up. If a build fails, the old server keeps running.

With `--update-from <url>`, the server also follows that deployment of the board. Every five
minutes it asks the deployment which commit it runs (its unauthenticated `/api/health` reports
it, API 65) and fetches it from the checkout's `origin`. When that commit is ahead of the running
one, the sidebar shows **N new commits · Update**. Update fast-forwards the checkout to the commit
(it refuses if the checkout is dirty, or has diverged from the commit), then rebuilds and restarts
as above. Settings → Server shows the commit the deployment runs and when it was last checked.

With `--release-updates <OWNER/REPO>`, for a server installed from a release rather than a
checkout, the server checks that repository's GitHub releases 30 seconds after it starts, every six
hours, and on `POST /api/admin/release/check`. It picks the highest semver release (not drafts,
and prereleases only with `release_prereleases` on in `/api/settings`) that has a
`huntaway-server-<v>-<os>-<arch>.tar.gz` for this machine with a sha256 digest, and reports it,
with any error, as `release` in `/api/admin/server`. Requests send the last ETag, so a check when
nothing changed doesn't count against GitHub's limit of 60 unauthenticated requests an hour.
`IA_RELEASE_API` points it at another API than `https://api.github.com` (for tests).

A release newer than the running server is downloaded in the background into
`<data-dir>/app/<v>.partial/`, checked against the sha256 GitHub lists for it, unpacked with the
system `tar` (refusing entries outside its folder, and links), and smoke-tested with
`huntaway --version`. It's then renamed to `app/<v>/` and reported as `release.staged`; progress
and failures are in `release.download`, and a failed download is tried again on the next check.
A staged version that a later check no longer offers (a prerelease once they're turned off, or a
release that was taken down) is unstaged and deleted, even while a newer release downloads.
`POST /api/admin/release/update {"version": "<v>"}` restarts onto it in place (agents keep running,
as with a rebuild), downloading it first if it isn't staged yet, and
`POST /api/admin/release/rollback` marks the running version bad and restarts onto the one before
it (or the desktop app's own server, `IA_BUNDLED_SERVER`). `app/state.json` records `current`,
`previous`, `staged`, `trying` and `bad`, and is shared with the desktop app, which picks the version
to start from it. A server running from `app/<v>/huntaway` makes itself `current` on startup and
deletes the versions nothing needs (all but current, previous and staged).

On the board, a staged release shows in the sidebar as **v<version> · Update**, which opens its
release notes and restarts onto it (a download still running, or one that failed, shows only in
Settings). Settings → Server shows the version running and where from, the latest release and when
it was checked, the background download, **Check now**, **Include prereleases** and **Roll back**.
When the latest release needs a new desktop app too (`release.shell.outdated`), it says how to
install it: the `sudo pacman -U` command, the AppImage's link, or the dmg on the release page. The
AppImage and the pacman package can also do it themselves: **Update app** downloads the new AppImage
beside the running one, checks its sha256 against GitHub's digest and renames it over the old file;
**Install** downloads and checks the `.pacman` the same way and runs `pkexec pacman -U --noconfirm`
on it, which asks for your password in polkit's dialog. Either then relaunches the app. The app
takes the version from its server's release check and the package from GitHub's API
(`IA_RELEASE_API`), never from the page.

## Network access

Every API call needs the token in `<data-dir>/auth_token` (sent as a bearer token; the
UI picks it up from `?token=` once and remembers it). Settings → Network access shows a
ready-made link. The token lets anyone holding it run agents on your machine, and traffic is
plain HTTP, so expose the server only on a trusted network (Tailscale, VPN) or behind a TLS
reverse proxy.

A server started with `--host 127.0.0.1` can still be used from another computer that can SSH into
its machine, through a tunnel:

```sh
ssh -N -L 7878:127.0.0.1:7878 you@that-machine    # leave it running
```

Then open `http://localhost:7878/?token=<huntaway token>` there (`huntaway token`, or
`<data-dir>/auth_token`, on that machine), or point the desktop app at it with `"serverUrl":
"http://localhost:7878"` and the token (see _Desktop config_). To show that machine's board next to
the other computer's own, link it as a host over SSH instead (see _Hosts_).
