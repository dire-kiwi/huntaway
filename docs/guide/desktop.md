# The desktop app and releases

## Desktop config

`~/.config/huntaway-effect/desktop.json` on Linux, `~/Library/Application Support/huntaway-effect/desktop.json` on a
Mac (`HUNTAWAY_DESKTOP_DIR` names another folder), all optional:

```json
{
  "port": 7879,
  "dataDir": "~/.local/share/huntaway-effect",
  "serverBin": "/path/to/huntaway",
  "serverUrl": "http://other-machine:7879",
  "token": "…",
  "skipDbBackup": false
}
```

`skipDbBackup` starts the server without the database backup it makes before migrating the database, when
that backup can't be made (see _Release builds_).

Setting `serverUrl` makes the desktop app a client of a remote server instead of starting one.
An `http:` one counts as a secure page in the app, so it can show notifications.

The app's folder, port and data folder are not the old Huntaway app's (`~/.config/huntaway`, 7878,
`~/.local/share/huntaway`), so the two can be installed side by side and this one never finds the old board. After a
board has been moved over on the old port, give this app that port: see `switching.md`.

## Windows

The app can have several windows on the board, for example one for each profile. **File → New Window**
(Ctrl+Shift+N, ⌘⇧N on a Mac; on Linux and Windows the menu bar shows on Alt) opens one on the home page, and
right-clicking a profile or a project in the sidebar has **Open in new window**. A link to a page of the board that opens
in a new tab (Ctrl-, Shift- or middle-clicked) opens in a new window too. Starting the app again while it's running
opens another window rather than a second app. Each window's title names the profile its sidebar lists, where there's
more than one.

The windows share the server and the board's storage (the sidebar's state, the sign-in, notification settings), and
only one of them shows each notification. The app keeps running until the last window is closed (on a Mac, until it's
quit). When it relaunches itself after an update, it opens the windows it had again, on the pages they were on.

## Installing the desktop app

`scripts/install.sh` installs the desktop app from source on Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/dire-kiwi/huntaway/main/scripts/install.sh | bash
```

It checks for git, Node.js 24+ and npm (which runs pnpm when it isn't installed; it warns if `claude`/`codex` or
`tmux` are missing), then clones the repository to `~/.local/share/huntaway-effect-app` (`--dir`), installs the
dependencies with pnpm and builds the UI and the desktop shell there. Its agents run under `ia-shim`, which it builds
when there's Rust 1.89+ and a C compiler; without them, on Linux x64 and Apple silicon, it downloads the latest
release's server tarball (checked against its sha256) and puts its prebuilt `ia-shim` in `apps/server/bin/`
(`HUNTAWAY_RELEASES` names another repository's releases). Last, it adds **Huntaway Effect** to the app launcher: on
Linux a `huntaway-effect.desktop` entry that runs `~/.local/bin/huntaway-effect-desktop`, and on macOS
`~/Applications/Huntaway Effect.app` (a renamed copy of the checkout's Electron whose app runs the checkout's). The
names differ from the old app's so that both can be installed while the old board is still in use. Run it again to
update an install by hand or to change its options (`--help`).

The app runs from that checkout like `pnpm desktop`, so it updates like a host: **Rebuild &
restart** builds whatever the checkout has. With `--update-from https://board.example` (or
`HUNTAWAY_UPDATE_FROM`) it also follows the board deployed there: the launcher starts its server
with `HUNTAWAY_UPDATE_FROM`, and once the deployment runs a newer commit the sidebar shows **N new
commits · Update** (and Settings → Server shows **Update to <commit>**). Updating fetches that commit
from the checkout's `origin`, fast-forwards to it, rebuilds and restarts. When the update changed
the app itself (`apps/desktop/`, or the Electron version), the app relaunches once the board has
reloaded. Agents keep running throughout.

The launcher also puts the folders of `node`, `npm`, `cargo`, `git` and the agent CLIs on `PATH`,
as found at install time, since a desktop session may not have them. Run the script again after
moving any of them, for example to another nvm Node version. Like `pnpm desktop`, the app uses
a server already listening on its port (7879 by default) and starts its own otherwise. In that
case the app updates through that server, which follows a deployment only if it was started with
`--update-from`.

## Release builds

Publishing a GitHub release runs `.github/workflows/release.yml`, which builds the release's tag
and attaches these files to it. The tag is the version, as `v1.2.3` or `1.2.3`. Nothing else starts
it: pull requests don't build the release (their tests are `test.yml`'s), and Actions → Release → Run
workflow builds an existing release's tag again and replaces its files.

| File                                           | What                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `huntaway-<version>-linux-x86_64.AppImage`     | The desktop app for Linux                                                                                                                                                                                                                                         |
| `huntaway-<version>-linux-x64.pacman`          | The desktop app as an Arch package, `huntaway-effect` (`sudo pacman -U <file>`; see [The Arch package](#the-arch-package))                                                                                                                                        |
| `huntaway-<version>-mac-arm64.dmg`, `.zip`     | The desktop app for Apple silicon Macs                                                                                                                                                                                                                            |
| `huntaway-server-<version>-<os>-<arch>.tar.gz` | The server alone, for hosts: `huntaway` (which runs the server in `server/` with the Node in `node/`), `build.json` (the version and commit), `ia-shim`, the UI in `ui/`, and the desktop app's code in `electron/`; with its `.sha256` beside it                 |
| `huntaway-<version>-release.json`              | The release's manifest: its `version`, and the desktop app's `shell` stamp and `electron` version, which change when an update needs a new package (Electron or the app's `boot.cjs`) rather than only changing the server, the UI and the rest of the app's code |

The server's version is the release's too (`huntaway --version`). There's no phone app in a release (see
`mobile.md`).

`scripts/package-server.sh` puts the server together, compiled to JavaScript, with the Node that runs it (the
release job's own, so hosts don't need Node installed), `ia-shim` and the UI, and both the tarball and the desktop app
carry that. `scripts/release-check.sh` starts the package before it ships. Checkouts run the same server from its
TypeScript sources.

Before a server migrates its database (a version that changes the schema), it copies the database to
`<data dir>/backups/board-<from>-to-<to>-<time>.db`, and keeps the newest two copies. Settings → Disk shows what they
take up. Without a backup nothing goes ahead: an Update or Roll back for which the disk hasn't room for one fails and
leaves the running server as it is, and a server that can't make one at startup doesn't start, so the update onto it
is never settled and the version before it starts again (it's marked bad). The error says why (a full disk, or no
permission to write to `backups/`). `--skip-db-backup` (`HUNTAWAY_SKIP_DB_BACKUP=1`) goes ahead without a backup; in
the desktop app, the error page's **Start without a backup** does that once, and `"skipDbBackup": true` in
`desktop.json` always. To go back to a backup: stop the server, move `board.db` (with any `board.db-wal` and
`board.db-shm`) aside, and copy the backup to `board.db`.

The desktop app carries the server, `ia-shim` and the UI, and starts the server as above. It takes
`PATH` from your login shell, so it finds `claude`, `codex`, `git` and `gh` when it's started
from the Dock or an app launcher. A release build isn't a checkout, so it has no **Rebuild &
restart**: it updates from GitHub's releases instead (see below). The Mac build is ad-hoc signed,
not signed with a Developer ID, so macOS blocks a downloaded copy until you run
`xattr -dr com.apple.quarantine "/Applications/Huntaway Effect.app"`. To build the same files locally,
run `pnpm --filter huntaway-desktop run dist`, which puts them in `apps/desktop/release/`. To build an existing
release again, use Actions → Release → Run workflow with its tag, which replaces its files.

### The Arch package

The `.pacman` file is the package `huntaway-effect`, and every name it installs differs from the old app's (the
package `huntaway` from `dire-kiwi/huntaway-legacy`, in `/opt/Huntaway`), so the two install side by side and neither
replaces the other:

|                                            | This app                                      | The old app                        |
| ------------------------------------------ | --------------------------------------------- | ---------------------------------- |
| Package                                    | `huntaway-effect`                             | `huntaway`                         |
| Files                                      | `/opt/Huntaway Effect/`                       | `/opt/Huntaway/`                   |
| Command                                    | `/usr/bin/huntaway-effect-desktop`            | `/usr/bin/huntaway-desktop`        |
| Launcher entry, icon, window class         | `huntaway-effect-desktop` ("Huntaway Effect") | `huntaway-desktop` ("Huntaway")    |
| Its own settings (`desktop.json`, windows) | `~/.config/huntaway-effect/`                  | the old app's                      |
| Board (data folder, port)                  | `~/.local/share/huntaway-effect`, 7879        | `~/.local/share/issue-agent`, 7878 |

To install the latest release's package, download its `.pacman` (from the release page, or with `gh`) and install
that file:

```sh
gh release download --repo dire-kiwi/huntaway --pattern 'huntaway-*-linux-x64.pacman'
sudo pacman -U huntaway-*-linux-x64.pacman
```

Start it as **Huntaway Effect** from the app launcher, or with
`huntaway-effect-desktop`. Later releases come through the app's own updates (below), or the same `pacman -U` with
the newer file; `sudo pacman -R huntaway-effect` removes it, and leaves its board in `~/.local/share/huntaway-effect`.

Releases up to 0.0.2 named the package `huntaway`, like the old app: installing one of those replaces the old app.

## Updating the desktop app

A release build (the AppImage, the pacman package or the Mac app) updates itself from GitHub's releases
(`HUNTAWAY_RELEASE_UPDATES` names the repository); nothing needs root. The server it starts checks for a newer
release 30 seconds after it starts and every six hours (or with **Check now** in Settings → Server), downloads
the new server in the background, checks it against the sha256 GitHub lists for it, and unpacks it
into `<data dir>/app/<version>/` (`~/.local/share/huntaway-effect/app/`). That's per user, so the pacman package's
files in `/opt/Huntaway Effect` stay as pacman installed them. Nothing changes until you click
**v<version> · Update** in the sidebar, which shows the release notes and restarts the server onto
the new version in place: running agents keep going, as with a rebuild. Downloading the next
version is all a check does; quitting and starting the app again still runs the one you had.

- **Which version runs.** The app starts the version you last updated to, if it's at least as new
  as the app's own server, and otherwise its own. So installing a newer package (a `pacman -Syu`,
  or a new AppImage) takes over from older downloads by itself. `HUNTAWAY_SERVER_BIN` or `serverBin` in
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
  rollback), one `staged` for Update, and the `bad` ones. Only those versions are kept. Deleting `app/` goes back to
  the app's own server.
- **The app's own code.** The window, notifications, badge and the server launcher (`apps/desktop/src/main/`) update
  with the server, like the UI. The app's entry point, `boot.cjs`, loads `main.cjs` from the `electron/`
  folder of the version the server runs (each release's server tarball has one, with a `shell.json` naming the
  Electron it was written for), and falls back to the copy in the package. After an Update has restarted the
  server and the board has reloaded, the app relaunches once onto the new code. A shell that throws as it loads, or
  that stops without the app quitting in its first 20 seconds, is marked bad (`app/shell-state.json`) and the
  package's runs instead; the server version stays. A shell written for another Electron major version isn't loaded.
  A blank `HUNTAWAY_RELEASE_UPDATES` or a remote `serverUrl` turn this off with the rest.
- **What needs a new package.** Only Electron itself and `boot.cjs` (the "frame"), which
  `huntaway-<v>-release.json` records as `shell`. When a release newer than the app changes either,
  Settings → Server says so and how to install it. An app installed from a prerelease isn't offered
  an older release's package while prereleases are off. The AppImage's **Update app** downloads the new AppImage
  beside the running one, checks it, renames it over the old file and relaunches. The pacman package's
  **Install** downloads and checks the `.pacman`, then runs `pkexec pacman -U --noconfirm` on it,
  which asks for your password in polkit's dialog (without a polkit agent, use the `sudo pacman -U`
  command it shows). On a Mac, download the new dmg from the release page.
- **When it doesn't apply.** An app that finds a server already running on its port (your own
  `huntaway serve`, say) or that uses a remote `serverUrl` leaves updates to that server, and never
  offers releases. A blank `HUNTAWAY_RELEASE_UPDATES` in the app's environment turns release updates off.
  An install from source (`scripts/install.sh`) updates from its checkout instead, as above.

A host installed from the server tarball can update the same way with
`huntaway serve --release-updates dire-kiwi/huntaway` (or `HUNTAWAY_RELEASE_UPDATES=dire-kiwi/huntaway`):
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
`HUNTAWAY_BUNDLED_SERVER` to the release it starts, by Update or as above, unless you set that yourself.
Deleting `<data dir>/app/` goes back to the tarball's server until the next Update.

A hub deployed as a container (a board on a server, with the binary and UI in its image or bundle) can
update itself from GitHub this way too, rather than being redeployed for every change: start it with
`--release-updates dire-kiwi/huntaway` and keep `<data dir>` on a volume, so the versions in
`<data dir>/app/` and `app/state.json` survive the container being recreated. Update restarts the server
in place (the container's process stays), and when the container starts again the deployed server execs
the version it last updated to, as above. A release serves its own `ui/` (unless it's given `--ui-dir`), and reports
the commit it was built from (its `build.json`) rather than the deployment's `HUNTAWAY_COMMIT` (in `/api/health` and
Settings → Server), so hosts that follow the hub with `--update-from` and the checkouts it updates go by the
release's commit. The Linux releases are built on GitHub's `ubuntu-latest`, so their server needs glibc 2.39 or later
(Debian 13, Ubuntu 24.04) in the image.

`scripts/install-release-host.sh` installs a host this way: it downloads the latest release's tarball
(or `--version`'s), checks its sha256, unpacks it into `~/.local/share/huntaway-effect-server/<v>/`, points
`~/.local/share/huntaway-effect-server/current` at it, and prints the commands to run it with
`HUNTAWAY_RELEASE_UPDATES` set (as a user systemd service,
`… install-service --host 127.0.0.1 --port 7879 --data-dir '<data dir>'`, or by hand), and the forced command for a
hub that links it over SSH
(`command="HUNTAWAY_RELEASE_UPDATES=dire-kiwi/huntaway '…/current/huntaway' ssh-host --port 7879 --data-dir '<data dir>'"`).
All name the data dir (`--data-dir`, or the default `~/.local/share/huntaway-effect`), so the host keeps its board.
`scripts/install-release-host-test.sh` checks the script against a fake release.
