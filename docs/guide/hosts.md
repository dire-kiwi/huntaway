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
  `huntaway install-service --host 127.0.0.1 --port 7878`, runs it as a user systemd service: see
  _Running a host as a service_ below), then add the line the dialog shows to that machine's
  `~/.ssh/authorized_keys`. The line holds the hub's own key (made on first use in
  `<hub data dir>/ssh/`), restricted to running `huntaway ssh-host` and forwarding to the host's
  port:

  ```text
  restrict,port-forwarding,permitopen="127.0.0.1:7878",command="/path/huntaway ssh-host --port 7878" ssh-ed25519 AAAA… huntaway-hub@<hub>
  ```

  `ssh-host` gives the hub the token from the host's data dir; add `--data-dir '<data dir>'` to the
  command if the host's isn't the default (`scripts/install-release-host.sh` prints the whole
  command). It doesn't start a host (before HA-278 it started `huntaway serve` through the login
  shell; `--no-start` and `--name` from those lines are still taken, and ignored): while nothing
  answers on the port, it waits 15 seconds for a host that's restarting (a Restart or an Update
  leaves the port closed for a moment), then fails, and the hub's connection retries. Adding a host
  fails at once when none is running. The host never listens beyond localhost or needs to reach
  the hub. The first connection trusts the machine's SSH host key, and a changed one is refused
  later. If the tunnel drops, agents keep running and the hub reconnects. The hub needs `ssh` and
  `ssh-keygen`.

- **Add host → By URL and token** (the hub connects to the host): enter the host's URL and its token
  (`huntaway token` on that machine). This works whenever the hub can reach the host,
  e.g. over Tailscale.
- **Connect from elsewhere** (the host dials out to the hub): run
  `huntaway serve --hub http://<hub>:7878 --hub-token <token>` on the host (`https://` for a
  hub behind TLS; the host doesn't follow redirects). No inbound port
  is needed, which suits cloud VMs or machines behind NAT. The hub's requests are tunnelled
  back over that connection.

**Nearby hosts.** Settings → Hosts also lists hosts it finds on this machine's networks and on Tailscale that aren't
on the board yet (`GET /api/hosts/discover`, API 128); **Link** opens _By URL and token_ with the host's URL filled in,
so only its token is left to paste. Each host that listens beyond localhost (not `--host 127.0.0.1`, so not an SSH
host) advertises itself over mDNS as the DNS-SD service `_huntaway._tcp.local`, with its id, name, port and version
and never its token (`avahi-browse -r _huntaway._tcp` shows them too); `--no-discovery` (`IA_DISCOVERY=0`) stops it.
mDNS passes ufw's and firewalld's default rules, and shares UDP port 5353 with avahi and browsers. Container and VM
bridges (`docker0`, `br-…`, `virbr…`) are left out. Tailscale carries no multicast, so the board asks each online peer
in `tailscale status --json` (`IA_TAILSCALE_BIN` for the CLI's path) directly, and tries its port 7878's
`/api/health`, which finds a host from before API 128 too (named by its Tailscale name; a host on another port is
found this way only if it answers the direct query).

Both ends of a link ping each other every 20 seconds, and drop a connection they've heard nothing
from for a minute (one that died without closing, say after a laptop slept or a NAT mapping
expired), so the host is shown offline and the link is made again. `GET /api/hosts` gives each
connected host's `last_message_at`, and an offline one's `last_seen` is when it was last heard from.
A host that dials in under the id of one that is already connected in is refused.

The UI reaches each host via `/api/h/<host_id>/…` on the hub, and events from every host
arrive on one websocket tagged with `host_id`. Agents' board tools act on their own host. A
project or task that isn't found there is looked up on linked hosts, and `list_projects` covers
every host, so an orchestrating agent can work across machines. On each host they reach their
own profile's board and those that let them in (see _Agents across profiles_).

A linked host's agents can use the hub's board too, once the hub lets them: switch on **Let this
host's agents use this board** for it under Settings → Hosts (off by default; hub and host need API
112). A board tool call the host can't resolve on its own board or the hosts it links itself then
goes up the link to the hub (on `/api/host/ws` for hosts linked over SSH or by URL, through the
tunnel for one that dials in). The hub takes it only from an agent in one of its profiles whose
**Assistant host** is that host (see _An assistant host_): the host names the caller's profile, and
whoever controls it could name any. It runs with that profile's access (its board, and those that
let that profile in), looking on its other linked hosts too, but never back on the calling host or
further up, and at most once per call id, and only if it came the way the hub links that host: a
host that dials in under the id of an assistant host the hub dials (by URL or over SSH) is refused,
so it gets none of that host's calls, the assistant's requests or the board's requests through
`/api/h/<host_id>`. (Another host the hub dials may dial in too, and stands in for itself while the
hub's link to it is down.) One that dialled in under a host's id before the host became an assistant
host is dropped when a profile picks it, and the hub dials the host again. A call that names the
calling host with `host` isn't sent back down to it either. A host that dials in is known only by
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

**Versions.** Each host reports `api_version` (bumped with every API change) and
`api_compat` (the oldest UI it still serves). A board's UI is built against one API version,
and Settings → Hosts marks each host as current, **outdated** (older, so newer features are
hidden for it), **too old**, or **board too old** (the host needs a newer UI; update the hub).
API changes should be additive (new endpoints, optional fields); raise `api_compat` only
for a breaking change, after keeping the old behaviour for a while. The run directory files
and the MCP call shape are stable formats too: shims and helpers started by an older build
keep running after an upgrade.

**Updating hosts.** For a linked host that runs different code, Settings → Hosts offers
**Update to <commit>**. The hub packs its checkout's current branch into a git bundle and sends
it over the link, so no git remote or inbound access is needed. The host fast-forwards its own
checkout (it refuses if the checkout is dirty, on another branch, or has diverged), then
rebuilds and restarts like Rebuild & restart; agents keep running. Hosts from before
versioning need one manual update (`git pull`, then Rebuild & restart).

A host installed from a release (with `--release-updates`, see _Release updates_; `/api/info`
reports `updates_from: "releases"` rather than `"checkout"`, API 89) goes by version instead: when
the hub runs a newer release, Settings → Hosts offers **Update to v<version>**, and the host restarts
onto that release as its own Update would, checking for releases first if it hasn't seen it yet. It
refuses a version older than its own, or one older than the latest release it knows of (update the
hub first). A hub without a checkout that runs a release sends its version and the commit the release was built
from (`IA_BUILD_COMMIT`; a release from before that, or a build without it or `IA_COMMIT`, sends only its
version, so it can update release hosts but not checkouts).

**Agent defaults** (Settings): each host has a default model, effort (`--effort`) and
permission mode for its agents. A model set on a thread, project or profile, or a permission
mode set on a thread or project, takes precedence.

## Running a host as a service

On Linux with systemd, a host can run as a user service, which starts it at boot and starts it
again if it stops. That's how to keep an SSH host running, since the hub doesn't start one.

- **From the board**: the host's page (Settings → Hosts → the host) has a _Service_ section (API
  123). **Install service** writes `~/.config/systemd/user/huntaway.service` (`huntaway-<port>.service`
  on a port other than 7878) to run the server with the flags and `IA_*` settings it has now (the
  release it was installed as, for a host that updated to a newer one: that one starts the newest
  again), enables it, turns lingering on (`loginctl enable-linger`, so it starts at boot rather than
  when the user logs in), and restarts the host under it. A host already run by a systemd service,
  or by the desktop app, isn't offered one. `POST /api/admin/service` does the same, as a restart
  job (`GET /api/admin/server`'s `service` says how it stands).
- **On the machine**: `huntaway install-service [serve flags…]` writes and enables the same unit for
  `huntaway serve [serve flags…]`, with the `IA_*` variables it's run with, and starts it (or
  restarts it, if it's running). It leaves a host that's running on the port some other way alone:
  stop that one, then `systemctl --user start huntaway.service`.

The unit runs the server through the user's login shell, so agents get the PATH they'd get in a
terminal, with `KillMode=process`, so stopping or restarting the service leaves agents and
terminals running (see _Agents survive restarts_ in `server.md`), and `Restart=on-failure`. Its log
is `journalctl --user -u huntaway.service`. Where lingering can't be turned on without root, the
board says so, and `sudo loginctl enable-linger <user>` does it. To stop running as a service:
`systemctl --user disable --now huntaway.service`, then remove the unit file.

## Reaching a host from anywhere

Away from home, without Tailscale or a VPN, a host can use a **broker** (`huntaway-broker`, in
`rust/broker`) to set up public access. There are two transports:

- **Managed tunnels**: the broker provisions a Cloudflare Tunnel and DNS hostname for each host.
  The host runs `cloudflared`, and the broker handles registration and endpoint discovery. Normal
  traffic follows `browser or hub ↔ Cloudflare Tunnel ↔ host`; it bypasses `huntaway-broker`.
  This is the same split as [T3 Connect](https://github.com/pingdotgg/t3code/blob/main/docs/internals/t3-connect.md).
- **Legacy relay** (a broker without tunnel configuration): the host keeps a websocket open to the
  broker, which carries every HTTP request, response and websocket message for its clients:
  `browser or hub ↔ broker ↔ host`. There is no handoff to a direct connection.

Connecting to a host's LAN or Tailscale/VPN URL bypasses either public transport. Enabling
`--broker` doesn't route the host's other network traffic through it: agents still call model
providers and git remotes themselves.

A **hub** combines linked hosts into one board and forwards requests to them; the **broker** makes
a host reachable from outside its network. A managed hub's board reaches a linked host via
`browser ↔ Cloudflare Tunnel ↔ hub ↔ linked host`. The hub uses the link configured in Settings →
Hosts for the last hop, which may be direct, another tunnel or a legacy relay.

[Configure the broker](../../rust/broker/README.md), then connect a host:

```sh
huntaway serve --broker https://broker.example.com --broker-token <broker token>   # or IA_BROKER, IA_BROKER_TOKEN
```

For managed tunnels, install `cloudflared` on each host first (`IA_CLOUDFLARED_BIN` overrides its
path). The broker needs Cloudflare account, DNS zone and API-token configuration; the host receives
only its tunnel connector token. It starts the connector automatically and restarts it if it exits.
The connector keeps running across broker disconnects, so existing sessions and direct use of the
tunnel URL keep working during a broker outage. New discovery needs the broker. Older hosts must
be updated to use managed tunnels; the broker refuses them rather than silently relaying traffic.

For the basic managed setup, use the DNS zone apex: `--tunnel-domain example.com` gives `desktop.example.com`.
In a full Cloudflare zone, [Universal SSL covers the apex and first-level subdomains](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/#hostname-coverage).
Using `hosts.example.com` instead gives `desktop.hosts.example.com`, requiring separate edge certificate coverage,
such as Advanced Certificate Manager with Total TLS or an appropriate custom certificate. Configure that coverage
before using nested domains; the broker doesn't provision certificates.

Open `https://broker.example.com/?token=<host token>` from anywhere. With managed tunnels, the broker
redirects the browser to the host's HTTPS hostname, preserving the path and query. With a legacy
relay it serves the board through the websocket. The host's token (`huntaway token`) still guards
its API, and `/api/open-token` (`--open-token`) is blocked on both public transports.

Each host has a broker name (`--broker-name`, by default its host name as lowercase letters, digits
and hyphens). Select it by:

- `/_broker/h/<name>/…`, for anything taking a base URL: **Add host** with
  `https://broker.example.com/_broker/h/<name>`, or dial into a hub with
  `--hub https://broker.example.com/_broker/h/<hub's name>`. Current hosts discover the tunnel endpoint
  before sending credentials or opening websockets, and discover it again on reconnect. A legacy
  broker keeps working with the same URLs.
- Otherwise, an `X-Huntaway-Host` header, the cookie set by opening `/_broker/use/<name>`, the broker's
  default host (`--default-host`), or the only host connected, in that order.

Managed hosts each have their own site and browser token. For a legacy relay, a browser keeps one
token per site: put the hub (whose board links the others) on the broker and use its board to reach
the rest. After moving to tunnels, sign in at the new hostname; browser credentials stored on the
broker site don't transfer to it. Use the tunnel's URL for webhook deliveries and API clients that
don't perform discovery: many webhook senders don't follow redirects.

Keep the broker token as secret as a host token and give it only to your own hosts: it authorizes
a host to take any free name, and clients selecting that name trust where the broker sends them.
Each host keeps a secret `broker_key` in its data dir. A name stays with that host while connected
and for an hour after it goes; a second host with the same name is refused and keeps trying. Give
it its own `--broker-name`. `--state` preserves these reservations across broker restarts and is
required with managed tunnels. Without it, a legacy broker keeps reservations only in memory.
Tunnel allocations and DNS records are retained across restarts; see the broker README for cleanup.
