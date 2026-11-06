# The desktop app and releases

## Desktop config

`~/.config/huntaway/desktop.json` (all optional):

```json
{ "port": 7878, "dataDir": "~/.local/share/huntaway", "host": "127.0.0.1",
  "serverBin": "/path/to/huntaway",
  "serverUrl": "http://other-machine:7878", "token": "…",
  "skipDbBackup": false }
```

`skipDbBackup` starts the server without the database backup it makes when its version changes, when
that backup can't be made (see [Release builds](#release-builds)).

Setting `serverUrl` makes the desktop app a client of a remote server instead of starting one.
An `http:` one counts as a secure page in the app, so it can show notifications.

## Installing the desktop app

`scripts/install.sh` installs the desktop app from source on Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/dire-kiwi/huntaway/master/scripts/install.sh | bash
```

It checks for git, Node.js 24+ and npm (and warns if `claude`/`codex` or `tmux` are missing), then clones the
repository to `~/.local/share/huntaway-app` (`--dir`), builds the UI and installs the server's dependencies there. Its
agents run under `ia-shim`, which it builds when there's Rust 1.89+ and a C compiler; without them, on Linux x64 and
Apple silicon, it downloads the latest release's server tarball (checked against its sha256) and puts its prebuilt
`ia-shim` in `apps/server/bin/` (`HUNTAWAY_RELEASES` names another repository's releases). Last, it adds **Huntaway** to the app launcher: on Linux a
`huntaway-app.desktop` entry that runs `~/.local/bin/huntaway-desktop`, and on macOS
`~/Applications/Huntaway.app` (a renamed copy of the checkout's Electron whose app runs the
checkout's). Run it again to update an install by hand or to change its options (`--help`).

The app runs from that checkout like `npm run electron`, so it updates like a host: **Rebuild &
restart** builds whatever the checkout has. With `--update-from https://board.example` (or
`HUNTAWAY_UPDATE_FROM`) it also follows the board deployed there: the launcher starts its server
with `IA_UPDATE_FROM`, and once the deployment runs a newer commit the sidebar shows **N new
commits · Update** (and Settings → Server shows **Update to <commit>**). Updating fetches that commit
from the checkout's `origin`, fast-forwards to it, rebuilds and restarts. When the update changed
the app itself (`apps/web/electron/`, or the Electron version), the app relaunches once the board has
reloaded. Agents keep running throughout.

The launcher also puts the folders of `node`, `npm`, `cargo`, `git` and the agent CLIs on `PATH`,
as found at install time, since a desktop session may not have them. Run the script again after
moving any of them, for example to another nvm Node version. Like `npm run electron`, the app uses
a server already listening on its port (7878 by default) and starts its own otherwise. In that
case the app updates through that server, which follows a deployment only if it was started with
`--update-from`.

## Release builds

Publishing a GitHub release runs `.github/workflows/release.yml`, which builds the release's tag
and attaches these files to it. The tag is the version, as `v1.2.3` or `1.2.3`. Nothing else starts
it: pull requests don't build the release (their tests are `test.yml`'s), and Actions → Release → Run
workflow builds an existing release's tag again and replaces its files.

| File | What |
|---|---|
| `huntaway-<version>-linux-x86_64.AppImage` | The desktop app for Linux |
| `huntaway-<version>-linux-x64.pacman` | The desktop app as an Arch package (`sudo pacman -U <file>`) |
| `huntaway-<version>-mac-arm64.dmg`, `.zip` | The desktop app for Apple silicon Macs |
| `huntaway-<version>.apk` | The mobile app for Android, once its signing key is set (see [The mobile app](mobile.md#the-mobile-app)) |
| `huntaway-server-<version>-<os>-<arch>.tar.gz` | The server alone, for hosts: `huntaway` (which runs the TypeScript server in `apps/server/` with the Node in `node/`, and `issue-agent`, which runs it under its old name) and `ia-shim`, with the UI in `ui/` |
| `huntaway-<version>-release.json` | The release's manifest: its `version`, and the desktop app's `shell` stamp and `electron` version, which change when an update needs a new package (Electron or the app's `boot.cjs`) rather than only changing the server, the UI and the rest of the app's code |

The server's version is the release's too (`huntaway --version`).

Releases carry the TypeScript server (`apps/server/`, see its [README](../apps/server/README.md)) since 0.4.0, rather than the Rust
server that 0.3.x and earlier carried (removed from the repository in HA-179):
`scripts/package-server.sh` puts it together with the Node that runs it (the release job's own, so
hosts don't need Node installed), `ia-shim` and the UI, and both the tarball and the desktop app
carry that. A host on an earlier, Rust, release updates onto it like onto any release, and Roll back
can return to a Rust release, which the backup below makes safe. Checkouts run the TypeScript server too.

Whichever server starts on a data dir that another version last ran on (`<data dir>/server_version`;
the Rust server doesn't write it) first copies the database to
`<data dir>/backups/huntaway-<from>-to-<to>-<time>.db`, before opening and migrating it, unless both
are TypeScript releases (0.4.0 on) and the database's schema is already the new one's, so that opening
it changes nothing the version before can't read. Before a Roll back to a Rust release (or to a server
of unknown version), the server makes the copy itself, as that one won't, and records that version in
`server_version`, so the TypeScript server that starts after it backs up again, even if it's the same
version as before; an Update or Roll back onto a TypeScript release only checks there's room for the
copy that one makes. Once the server is up, it gzips the copy (`.db.gz`, about a quarter of the size),
and keeps the newest two, and the newest from before a major change (another major version, or minor
before 1.0, or from the Rust server). Settings → Disk shows what they take up.

Without a backup nothing goes ahead: an Update or Roll back that can't make one (or for which the disk
hasn't room) fails and leaves the running server as it is, and a server that can't make one at startup
doesn't start, so the update onto it is never settled and the version before it starts again (it's
marked bad). The error says why (a full disk, or no permission to write to `backups/`).
`IA_SKIP_DB_BACKUP=1` goes ahead without a backup; in the desktop app, the error page's **Start without
a backup** does that once, and `"skipDbBackup": true` in `desktop.json` always. To go back to a
backup: stop the server, move `huntaway.db` (with any `huntaway.db-wal` and `huntaway.db-shm`) aside,
and `gunzip -c` the backup to `huntaway.db` (or copy it there, if it isn't gzipped yet). A server that
keeps the board in `huntaway-2.db` (see [The database file](server.md#the-database-file)) backs that up instead, so its backups go
back to `huntaway-2.db`.

The desktop app carries the server, `ia-shim` and the UI, and starts the server as above. It takes
`PATH` from your login shell, so it finds `claude`, `codex`, `git` and `gh` when it's started
from the Dock or an app launcher. A release build isn't a checkout, so it has no **Rebuild &
restart**: it updates from GitHub's releases instead (see below). The Mac build is ad-hoc signed,
not signed with a Developer ID, so macOS blocks a downloaded copy until you run
`xattr -dr com.apple.quarantine /Applications/Huntaway.app`. To build the same files locally,
run `npm run dist` in `app/`, which puts them in `apps/web/release/`. To build an existing release
again, use Actions → Release → Run workflow with its tag, which replaces its files.

## Updating the desktop app

A release build (the AppImage, the pacman package or the Mac app) updates itself from this
repository's GitHub releases; nothing needs root. The server it starts checks for a newer release 30
seconds after it starts and every six hours (or with **Check now** in Settings → Server), downloads
the new server in the background, checks it against the sha256 GitHub lists for it, and unpacks it
into `<data dir>/app/<version>/` (`~/.local/share/huntaway/app/` on Linux,
`~/Library/Application Support/huntaway/app/` on a Mac). That's per user, so the pacman package's
files in `/opt/Huntaway` stay as pacman installed them. Nothing changes until you click
**v<version> · Update** in the sidebar, which shows the release notes and restarts the server onto
the new version in place: running agents keep going, as with a rebuild. Downloading the next
version is all a check does; quitting and starting the app again still runs the one you had.

- **Which version runs.** The app starts the version you last updated to, if it's at least as new
  as the app's own server, and otherwise its own. So installing a newer package (a `pacman -Syu`,
  or a new AppImage) takes over from older downloads by itself. `IA_SERVER_BIN` or `serverBin` in
  the desktop config still win over both.
- **A version that won't start.** If an Update's version doesn't come up, or a downloaded version
  exits before it's ready, the app marks it bad and starts the one before it, then its own server.
  A bad version isn't offered again; the next release is.
- **Roll back.** Settings → Server → **Roll back** marks the running version bad and restarts onto
  the one before it, or onto the app's own server when there's none (or the one before it is older
  than the app's own server, which a newer package's takes over from). A newer server may have
  updated the database; the older one runs on it as it is (the changes so far only add to it).
- **Prereleases** are offered only with **Include prereleases** on in Settings → Server. Turning it
  off again withdraws a prerelease that was downloaded but not yet updated to.
- **What's kept.** `app/state.json` records the `current` version, the `previous` one (for a
  rollback), one `staged` for Update, and the `bad` ones. Only those versions are kept, about 40 MB
  each. Deleting `app/` goes back to the app's own server.
- **The app's own code.** The window, notifications, badge and the server launcher (`apps/web/electron/`) update
  with the server, like the UI. The app's entry point, `boot.cjs`, loads `electron/main.cjs` from the `electron/`
  folder of the version the server runs (each release's server tarball has one, with a `shell.json` naming the
  Electron it was written for), and falls back to the copy in the package. After an Update has restarted the
  server and the board has reloaded, the app relaunches once onto the new code. A shell that throws as it loads, or
  that stops without the app quitting in its first 20 seconds, is marked bad (`app/shell-state.json`) and the
  package's runs instead; the server version stays. A shell written for another Electron major version isn't loaded.
  `IA_RELEASE_UPDATES` blank or a remote `serverUrl` turn this off with the rest.
- **What needs a new package.** Only Electron itself and `boot.cjs` (the "frame"), which
  `huntaway-<v>-release.json` records as `shell`. When a release newer than the app changes either,
  Settings → Server says so and how to install it. An app installed before `boot.cjs` existed needs one new package
  to start getting its code this way. An app installed from a prerelease isn't offered
  an older release's package while prereleases are off. The AppImage's **Update app** downloads the new AppImage beside the
  running one, checks it, renames it over the old file and relaunches. The pacman package's
  **Install** downloads and checks the `.pacman`, then runs `pkexec pacman -U --noconfirm` on it,
  which asks for your password in polkit's dialog (without a polkit agent, use the `sudo pacman -U`
  command it shows). On a Mac, download the new dmg from the release page.
- **When it doesn't apply.** An app that finds a server already running on its port (your own
  `huntaway serve`, say) or that uses a remote `serverUrl` leaves updates to that server, and never
  offers releases. A blank `IA_RELEASE_UPDATES` in the app's environment turns release updates off.
  An install from source (`scripts/install.sh`) updates from its checkout instead, as above.

A host installed from the server tarball can update the same way with
`huntaway serve --release-updates dire-kiwi/huntaway` (or `IA_RELEASE_UPDATES=dire-kiwi/huntaway`):
the board it serves shows the same Update, Check now and Roll back, and versions go into
`<data dir>/app/` as above. So does its page in a hub's Settings → Hosts, through the hub. There's
no desktop app to choose the version when a supervisor starts the tarball's `huntaway` again (after
a reboot, say), so the server chooses as the app would: it execs the version you last updated to
(`current` in `app/state.json`, else `previous`), when that's newer than itself and isn't bad, and
otherwise carries on itself. So a newer tarball takes over from older downloads, as a newer package
does. A version it starts this way that exits before it's listening is marked bad on the next start,
which starts the one before it, or the tarball's own server: a broken version is tried once, not on
every restart (a server killed while it's starting counts as one that didn't start). Roll back can go
back to the tarball's own server, from the first Update on: the tarball's server passes itself as
`IA_BUNDLED_SERVER` to the release it starts, by Update or as above, unless you set that yourself.
Deleting `<data dir>/app/` goes back to the tarball's server until the next Update.

A hub deployed as a container (a board on a server, with the binary and UI in its image or bundle) can
update itself from GitHub this way too, rather than being redeployed for every change: start it with
`--release-updates dire-kiwi/huntaway` and keep `<data dir>` on a volume, so the versions in
`<data dir>/app/` and `app/state.json` survive the container being recreated. Update restarts the server
in place (the container's process stays), and when the container starts again the deployed server execs
the version it last updated to, as above. A release serves its own `ui/` even when the deployment passes
`--ui-dir`, and reports the commit it was built from (`IA_BUILD_COMMIT`, which `release.yml` sets) rather
than the deployment's `IA_COMMIT` (in `/api/health`, and `running_commit` in `/api/admin/server`), so hosts
that follow the hub with `--update-from` and the checkouts it updates go by the release's commit. The Linux
releases are built on GitHub's `ubuntu-latest`, so their server needs glibc 2.39 or later (Debian 13,
Ubuntu 24.04) in the image.

`scripts/install-release-host.sh` installs a host this way: it downloads the latest release's tarball
(or `--version`'s), checks its sha256, unpacks it into `~/.local/share/huntaway-server/<v>/`, points
`~/.local/share/huntaway-server/current` at it, and prints the command to start it with
`IA_RELEASE_UPDATES` set, and the forced command for a host a hub starts over SSH
(`command="IA_RELEASE_UPDATES=dire-kiwi/huntaway '…/current/huntaway' ssh-host --port 7878 --data-dir '<data dir>'"`).
Both name the data dir (`--data-dir`, or the default it found), so the host keeps its board.
`scripts/install-release-host-test.sh` checks the script against a fake release.

`scripts/release-update-e2e.sh` checks all of this on real packages: it builds three releases of the
checkout, serves them from a fake GitHub on 127.0.0.1, and runs the packaged app headless through
background downloads, Update with an agent running, a broken version, Roll back, prereleases and
the AppImage replacing itself (`--pacman` adds the Arch package, in a docker container). It needs
`npm ci` in `app/` and about 2 GB in `~/.cache/huntaway-release-e2e`.
