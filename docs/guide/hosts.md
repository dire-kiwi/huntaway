# Hosts

Every `huntaway serve` is a **host**: it keeps its own SQLite database with its profiles,
projects, tasks, agent threads and runs, and runs agents on its own machine. It is also a
**hub**: it serves the UI and can show other hosts on the same board. Nothing about another
host is stored on a hub beyond how to reach it, so any number of boards (your desktop, a
laptop somewhere else) can connect to the same host and see the same data.

Settings → Hosts offers three ways to link a host:

- **Add host → Over SSH** (the hub tunnels to a host running on that machine): enter `user@host`,
  the SSH port, the absolute path of `huntaway` on that machine (with `ia-shim` beside it) and the
  host's port. Start the host there (on Linux, the command the dialog shows,
  `huntaway install-service --host 127.0.0.1 --port 7879`, runs it as a user systemd service: see
  _Running a host as a service_ below), then add the line the dialog shows to that machine's
  `~/.ssh/authorized_keys`. The line holds the hub's own key (made on first use in
  `<hub data dir>/ssh/`), restricted to running `huntaway ssh-host` and forwarding to the host's
  port:

  ```text
  restrict,port-forwarding,permitopen="127.0.0.1:7879",command="/path/huntaway ssh-host --port 7879" ssh-ed25519 AAAA… huntaway-hub@<hub>
  ```

  `ssh-host` gives the hub the token from the host's data dir; add `--data-dir '<data dir>'` to the
  command if the host's isn't the default (`scripts/install-release-host.sh` prints the whole
  command). It doesn't start a host: while nothing answers on the port, it waits 15 seconds for a host that's
  restarting (a Restart or an Update leaves the port closed for a moment), then fails, and the hub's connection
  retries. Adding a host fails at once when none is running. The host never listens beyond localhost or needs to
  reach the hub. The first connection trusts the machine's SSH host key, and a changed one is refused
  later. If the tunnel drops, agents keep running and the hub reconnects. The hub needs `ssh` and
  `ssh-keygen`. (The old server's `ssh-host --name` and `--no-start` are not taken any more: take them out of
  `authorized_keys` lines written for it.)

- **Add host → By URL and token** (the hub connects to the host): enter the host's URL and its token
  (`huntaway token` on that machine). This works whenever the hub can reach the host,
  e.g. over Tailscale.
- **Connect from elsewhere** (the host dials out to the hub): run
  `huntaway serve --hub http://<hub>:7879 --hub-token <token>` on the host (`https://` for a
  hub behind TLS; the host doesn't follow redirects). No inbound port
  is needed, which suits cloud VMs or machines behind NAT. The hub asks the host for a connection over the one the
  host opened, so it reaches the host as it would one it dialled.

**Nearby hosts.** Settings → Hosts also lists hosts it finds on this machine's networks and on Tailscale that aren't
on the board yet; **Link** opens _By URL and token_ with the host's URL filled in,
so only its token is left to paste. Each host that listens beyond localhost (not `--host 127.0.0.1`, so not an SSH
host) advertises itself over mDNS as the DNS-SD service `_huntaway._tcp.local`, with its id, name, port, version and
protocol, and never its token (`avahi-browse -r _huntaway._tcp` shows them too); `--no-discovery`
(`HUNTAWAY_NO_DISCOVERY`) stops it, and keeps the list to the hosts linked hosts know (below).
mDNS passes ufw's and firewalld's default rules, and shares UDP port 5353 with avahi and browsers. Container and VM
bridges (`docker0`, `br-…`, `virbr…`) are left out. Tailscale carries no multicast, so the board asks each online peer
in `tailscale status --json` directly, and tries `/api/health` on the port the board itself listens on (7879 when it
took a free one), since a fleet usually runs on one port; a host on another port is found this way only if it answers
the direct query.

It also lists the hosts that the hosts linked here link by URL, shown as _Linked from …_: link one host (over
Tailscale, say, where mDNS doesn't reach) and the others it links show up, as in a mesh. The board asks each connected
host for its list of hosts, and lists one only if it answers here at the same URL as the
same host (its `/api/health` gives its `host_id`): one on a network this machine isn't on, or another host at the same
address here, is left out. It goes one hop, and the other host's token for it isn't passed on, so linking one still
takes its own token.

Both ends of a link ping each other every 20 seconds, and drop a connection they've heard nothing
from for a minute (one that died without closing, say after a laptop slept or a NAT mapping
expired), so the host is shown offline and the link is made again. Settings → Hosts shows when each
connected host was last heard from, and an offline one's reason.
A host that dials in under the id of one that is already connected (in, or by the hub's own link
to it) is refused, so no host with the hub token can take the place of another.

The UI holds a connection to each host: to its own board directly, and to every other host through the hub, which
passes the connection on to that host without reading it. So each host's events reach the UI from that host, and
each host checks what the UI may do. Agents' board tools act on their own host. A
project or task that isn't found there is looked up on linked hosts, and `list_projects` covers
every host, so an orchestrating agent can work across machines. On each host they reach their
own profile's board and those that let them in (see _Agents across profiles_).

A linked host's agents can use the hub's board too, once the hub lets them: switch on **Let this
host's agents use this board** for it under Settings → Hosts (off by default). A board tool call the host can't
resolve on its own board or the hosts it links itself then goes up the link to the hub (on the link's own
connection, whichever way it was made). The hub takes it only from an agent in one of its profiles whose
**Assistant host** is that host (see _An assistant host_): the host names the caller's profile, and
whoever controls it could name any. It runs with that profile's access (its board, and those that
let that profile in), looking on its other linked hosts too, but never back on the calling host or
further up, and at most once per call id, and only if it came the way the hub links that host: a
host that dials in under the id of an assistant host the hub dials (by URL or over SSH) is refused,
so it gets none of that host's calls, the assistant's requests or the board's connections to it.
(Another host the hub dials may dial in too, and stands in for itself while the
hub's link to it is down; the link takes its place again when it's back.) One that dialled in under a host's id
before the host became an assistant host is dropped when a profile picks it, and the hub dials the host again. A call
that names the calling host with `host` isn't sent back down to it either. A host that dials in is known only by
the id it gives with the hub token, which every such host shares, so any host given that token could
claim to be it: link an assistant host over SSH or by URL. If the link drops after a call went up,
the agent is told it may have taken effect. Changes that need the user's approval (`update_project`,
`delete_task`, automations) are refused there, since the agent's thread isn't on the hub, and `wait`
only watches tasks on the agent's own host. Calls with `host` set to the hub's name (or one of its
hosts') go there.

A hub that can't run agents itself (no `claude` or `ia-shim`, e.g. a board-only deployment)
sends new scratch tasks to a linked host. Pick which one under Settings → Hosts →
**Scratch task host**; by default it's the first host that can run agents.

**Agent configs** and **profiles** (work, personal…) are configured on each host, and the
board merges them by name. Settings → Agent configs and Settings → Profiles show which hosts
have each. **Copy login** copies a Claude config's credentials, `.claude.json`, settings,
`CLAUDE.md`, skills, agents, commands, plugins and hooks (for a Codex config: `auth.json`,
`config.toml`, `AGENTS.md`, skills, rules and prompts) to another host, creating the config
there if needed. Session history and caches are not copied. (On macOS, Claude may keep
credentials in the keychain rather than `.credentials.json`; in that case log in on the target
host instead.)

**Versions.** Each host reports its version, the protocol it speaks (one number, which changes only when the way
hosts and boards talk changes) and its capabilities (the features it has, by name). A host on another protocol than
the hub's shows as **Needs an update**: the hub can still see its version and update it, and nothing else. A host on
the same protocol but an older version works, and a feature it doesn't have yet is hidden or says the host needs an
update. The run directory files and the MCP call shape are stable formats too: shims and helpers started by an older
build keep running after an upgrade.

There's no link between this server and the old Huntaway server, either way: an old host linked from a new hub, or a
new host linked from an old one, shows offline until it has moved too. `switching.md` has how to move several hosts
together.

**Updating hosts.** For a linked host that runs different code, Settings → Hosts offers
**Update to <commit>**. The hub packs its checkout's current branch into a git bundle and sends
it over the link, so no git remote or inbound access is needed. The host fast-forwards its own
checkout (it refuses if the checkout is dirty, on another branch, or has diverged), then
rebuilds and restarts like Rebuild & restart; agents keep running.

A host installed from a release (with `--release-updates`, see _Release updates_) goes by version instead: when
the hub runs a newer release, Settings → Hosts offers **Update to v<version>**, and the host restarts
onto that release as its own Update would, checking for releases first if it hasn't seen it yet. It
refuses a version older than its own, or one older than the latest release it knows of (update the
hub first). A hub without a checkout that runs a release sends its version and the commit the release was built
from (its `build.json`; a build without one or `HUNTAWAY_COMMIT` sends only its version, so it can update release
hosts but not checkouts).

**Agent defaults** (Settings): each host has a default model, effort (`--effort`) and
permission mode for its agents. A model set on a thread, project or profile, or a permission
mode set on a thread or project, takes precedence.

**Settings sync** (Settings → Hosts → a host; capability `settings_sync`): a host with **Sync this host's settings** on
keeps these the same as the board's other hosts that have it on. It's off by default, and the hub needs it on too,
since the hub is what passes settings between its hosts (they don't talk to each other).

- What syncs: the agent defaults (model, effort, permission mode), terminal tools, whether release checks include
  prereleases, and for each profile its default model, GitHub account, the two usage-limit switches, merge approval,
  required pull request approval, which profiles' agents may use its board, and its assistant's approval rules.
  Profiles are matched by name: a setting for a profile a host doesn't have is kept, and applied when a profile of
  that name is added there. Sync never creates or deletes a profile.
- What doesn't: anything that belongs to one machine or is a secret. Folders, Claude configs, logins, tokens,
  the public address, the scratch task host, telemetry and the assistant's host stay each host's own. So do reviewers
  and summarizers (they name a Claude config, which is a host's own), projects' settings, workflows, automations and pens.
- A change goes to the other hosts when it's made. A host that was disconnected catches up when it reconnects, in both
  directions, and that is not a conflict: each setting carries a counter per host, so the hosts can tell a value one of
  them simply hasn't heard of from two changes made apart.
- When two hosts did change the same setting while apart, the later change wins on every host (by the clock of the
  host that made it, so keep the hosts' clocks right), and the value that lost is listed under **Overwritten
  values** on each host's page: **Use this** makes it the value everywhere, **Keep** drops it. Changing the setting
  again drops it too.
- A host that turns sync on with settings of its own takes the board's values where they differ, and its own are
  listed the same way to use instead. A value from before a host synced has no time, so any change made on a syncing
  host wins over it, and where no host has changed a setting since, the value of the host that has been syncing longest
  stays. So turn it on first on the host whose settings the board should have (usually the hub).
- A host that turns sync off keeps its settings as they are. What it changes while it's off counts as from before it
  synced when it's turned on again: the board's values win, and the host's are listed. So does everything it has, if no
  other host was syncing with it before.

`apps/server/src/hosts/SettingsSync.ts` and `apps/server/src/hosts/settingsSync/` have how it works.

## Running a host as a service

On Linux with systemd, a host can run as a user service, which starts it at boot and starts it
again if it stops. That's how to keep an SSH host running, since the hub doesn't start one.

- **From the board**: the host's page (Settings → Hosts → the host) has a _Service_ section.
  **Install service** writes `~/.config/systemd/user/huntaway-<port>.service` to run the server with the flags and
  `HUNTAWAY_*` settings it has now (the release it was installed as, for a host that updated to a newer one: that one
  starts the newest again), enables it, turns lingering on (`loginctl enable-linger`, so it starts at boot rather than
  when the user logs in), and restarts the host under it. A host already run by a systemd service,
  or by the desktop app, isn't offered one.
- **On the machine**: `huntaway install-service [serve flags…]` writes and enables the same unit for
  `huntaway serve [serve flags…]`, with the `HUNTAWAY_*` variables it's run with, and starts it (or
  restarts it, if it's running). It needs `--port`. It leaves a host that's running on the port some other way alone:
  stop that one, then `systemctl --user start huntaway-<port>.service`.

The unit is named after the port on every port (the old server named its default port's `huntaway.service`; this
one never writes that name, so installing it doesn't replace an old server's unit). It runs the server through the
user's login shell, so agents get the PATH they'd get in a
terminal, with `KillMode=process`, so stopping or restarting the service leaves agents and
terminals running (see _Agents survive restarts_ in `server.md`), and `Restart=on-failure`. Its log
is `journalctl --user -u huntaway-<port>.service`. Where lingering can't be turned on without root, the
board says so, and `sudo loginctl enable-linger <user>` does it. To stop running as a service:
`systemctl --user disable --now huntaway-<port>.service`, then remove the unit file.

## Reaching a host from anywhere

Away from home, reach a host over Tailscale or another VPN (the board finds hosts on a tailnet, see
above), or put a TLS proxy or tunnel you run yourself in front of it, such as a Cloudflare Tunnel
(`cloudflared`) or Caddy on a public machine, pointed at the host's `http://127.0.0.1:7879`. Open
it at `https://<its address>/?token=<host token>`: the host's token (`huntaway token`) still guards
its API. Don't use `--open-token` on a host that's reachable like this, since it gives the token to
whoever asks. A hub reached this way links its hosts as usual, and hosts can dial into it at its
public address (`--hub https://<its address>`).

Huntaway used to have a connection broker of its own (`huntaway-broker`) for this; it was removed in
HA-339, and this server doesn't take its `--broker` flags.
