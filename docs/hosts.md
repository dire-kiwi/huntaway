# Hosts

Every `huntaway serve` is a **host**: it keeps its own SQLite database with its profiles,
projects, tasks, agent threads and runs, and runs agents on its own machine. It is also a
**hub**: it serves the UI and can show other hosts on the same board. Nothing about another
host is stored on a hub beyond how to reach it, so any number of boards (your desktop, a
laptop somewhere else) can connect to the same host and see the same data.

Settings → Hosts offers three ways to link a host:

- **Add host → Over SSH** (the hub starts the host and tunnels to it): enter `user@host`, the SSH
  port, the absolute path of `huntaway` on that machine (with `ia-shim` beside it) and the host's
  port, then add the line the dialog shows to that machine's `~/.ssh/authorized_keys`. The line
  holds the hub's own key (made on first use in `<hub data dir>/ssh/`), restricted to running
  `huntaway ssh-host` and forwarding to the host's port:

  ```text
  restrict,port-forwarding,permitopen="127.0.0.1:7878",command="/path/huntaway ssh-host --port 7878" ssh-ed25519 AAAA… huntaway-hub@<hub>
  ```

  `ssh-host` starts `huntaway serve --host 127.0.0.1` through the login shell if nothing answers on
  that port, and gives the hub the token from its data dir; add `--data-dir '<data dir>'` to the
  command if the host's isn't the default (`scripts/install-release-host.sh` prints the whole
  command). The host never listens beyond localhost or needs to reach the hub. The first connection
  trusts the machine's SSH host key, and a changed one is refused later. If the tunnel drops, agents
  keep running and the hub reconnects. The hub needs `ssh` and `ssh-keygen`.
- **Add host → By URL and token** (the hub connects to the host): enter the host's URL and its token
  (`huntaway token` on that machine). This works whenever the hub can reach the host,
  e.g. over Tailscale.
- **Connect from elsewhere** (the host dials out to the hub): run
  `huntaway serve --hub http://<hub>:7878 --hub-token <token>` on the host (`https://` for a
  hub behind TLS; the host doesn't follow redirects). No inbound port
  is needed, which suits cloud VMs or machines behind NAT. The hub's requests are tunnelled
  back over that connection.

Both ends of a link ping each other every 20 seconds, and drop a connection they've heard nothing
from for a minute (one that died without closing, say after a laptop slept or a NAT mapping
expired), so the host is shown offline and the link is made again. `GET /api/hosts` gives each
connected host's `last_message_at`, and an offline one's `last_seen` is when it was last heard from.
A host that dials in under the id of one that is already connected in is refused.

The UI reaches each host via `/api/h/<host_id>/…` on the hub, and events from every host
arrive on one websocket tagged with `host_id`. Agents' board tools act on their own host. A
project or task that isn't found there is looked up on linked hosts, and `list_projects` covers
every host, so an orchestrating agent can work across machines. On each host they reach their
own profile's board and those that let them in (see [Agents across profiles](concepts.md)).

A linked host's agents can use the hub's board too, once the hub lets them: switch on **Let this
host's agents use this board** for it under Settings → Hosts (off by default; hub and host need API
112). A board tool call the host can't resolve on its own board or the hosts it links itself then
goes up the link to the hub (on `/api/host/ws` for hosts linked over SSH or by URL, through the
tunnel for one that dials in). The hub takes it only from an agent in one of its profiles whose
**Assistant host** is that host (see [An assistant host](#an-assistant-host)): the host names the caller's profile, and
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

A host installed from a release (with `--release-updates`, see [Restarting after a merge](server.md#restarting-after-a-merge); `/api/info`
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

## An assistant host

Each profile's **assistant** (the sidebar's *Assistant*) can run on another machine, such as a
home server or a small VPS, rather than on the hub. Its credentials then never sit where project
agents run, and its agents can't read the hub's files or database. Set it up like this:

1. **Install a host there** from a release, as the user the assistant should run as:

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/dire-kiwi/huntaway/master/scripts/install-release-host.sh
   sh install-release-host.sh
   ```

   It prints the command that starts the host with release updates, and the forced command for SSH.
   The host's data dir is made private at start (`0700`, and its databases `0600`; every host does
   this), so other users of that machine can't read the assistant's threads.
2. **Link it over SSH** from the board: Settings → Hosts → **Add host** → **Over SSH**, with
   `user@machine` and the path the script printed. Add the line the dialog shows to that user's
   `~/.ssh/authorized_keys` on the machine, with the forced command the script printed:

   ```text
   restrict,port-forwarding,permitopen="127.0.0.1:7878",command="IA_RELEASE_UPDATES=dire-kiwi/huntaway '/home/me/.local/share/huntaway-server/current/huntaway' ssh-host --port 7878 --data-dir '/home/me/.local/share/huntaway'" ssh-ed25519 AAAA… huntaway-hub@<hub>
   ```

   The hub starts the host through that command and tunnels to it, so it listens on its own
   localhost only and never needs to reach the hub. When the hub's machine sleeps or changes network,
   the link drops and comes back by itself; the assistant keeps running there meanwhile.
3. **Give it a Claude login.** Settings → Agent configs → **Copy login** copies the config's login
   and settings to the new host (or log in there with `claude` as that user). Then add a profile of
   the same name there: Settings → Profiles shows **Not set up on: <host>** under the profile.
4. **Move the assistant there**: Settings → Profiles → **Edit** the profile on the board's own host
   and pick the host under **Assistant host** (API 112 on both). The sidebar's *Assistant* then opens
   the assistant on that host, and says so while the host is offline. `GET /api/profiles/<id>/assistant`
   on the hub goes there too (to `/api/profiles/<id there>/assistant?local=1`), and returns the task with
   that host's `host_id`, which clients reach through `/api/h/<host_id>/…`. Removing the host puts the
   assistant back on the board's own host. Its routines are that host's: make them in its Routines
   tab there. Routines made on the board's own host before the move stay there and don't run (each
   run fails, saying where the assistant is, and new ones can't be made there); the Routines tab on
   the assistant host lists them, to delete.
5. **Let it use your board**, if it should hand work to your projects or read what needs your
   attention: Settings → Hosts → **Let this host's agents use this board** for that host. Agents
   there in the profiles whose assistant runs on it then act on your boards with that profile's access
   (see [Hosts](#hosts) above); other profiles on that host stay out. The assistant's Details panel
   shows the host it runs on and whether it can use this board.
6. **Google and Telegram** are set up on the assistant host only (see [Google for the assistant](assistant.md#google-for-the-assistant)
   above, and [Telegram](#telegram) below).

## Telegram

You can talk to a profile's assistant from Telegram (API 117), and it can reach you there. Its bot
runs on the host the assistant runs on, which long-polls Telegram for messages, so it needs no open
port and keeps working while that host's link to the hub is down.

1. **Make a bot**: message [@BotFather](https://t.me/BotFather) with `/newbot`, and copy the token it
   gives you (`123456789:AAH…`).
2. **Give it to the assistant**: open the assistant, and in its Details panel under **Telegram**,
   paste the token and **Save token**. The host checks it with Telegram and keeps it in its settings;
   the board never shows it again. One bot serves one profile's assistant, and one host reads it at
   a time.
3. **Link your chat**: **Link a chat…** shows a one-time code that lasts ten minutes. Send
   `/start <code>` to the bot from a private chat with it (or tap **Open in Telegram**). That chat is
   then the only one the bot listens to and writes to. A code sent from a group stops working (everyone
   there has seen it): make a new one. Messages and button presses from anyone else are dropped,
   logged and counted in the panel.

What you send the bot (text, and photos, voice notes and files up to 10 MB, saved as attachments) goes
to the assistant as your message, and its reply comes back, formatted for Telegram and split if it's
long; replies to what you send there aren't pushed. Besides those, its prompts (with **Allow** and
**Deny** buttons) and questions (answered by replying), word that it needs attention, its routines'
reports and its replies to what you send from the board go by push (to the devices that chose them in
Settings → Notifications) and, as you choose for each, Telegram too. A prompt answered from Telegram
is answered as the board's buttons answer it (the approval rules and a routine's expiry hold the same,
and the action log says *on Telegram*), and its message is edited to say how it ended, however it
did. What can't be sent while Telegram is unreachable is kept and tried again, across restarts.
Moving the assistant to another host removes its bot from the host it left (if that host is online):
set it up again on the new one. Deleting the profile removes its bot.

Tests and test servers talk to a fake Bot API instead: `IA_TELEGRAM_API=http://127.0.0.1:<port>` in the
server's environment (`scripts/test-server.sh` keeps it over a `restart`, and `copy-live-board.sh`
drops the live board's bots from its copy).

## Reaching a host from anywhere

Away from home, without Tailscale or a VPN, a host can use a **broker** (`huntaway-broker`, in
`crates/broker`) to set up public access. There are two transports:

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

[Configure the broker](../crates/broker/README.md), then connect a host:

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
Tunnel allocations and DNS records are retained across restarts; see the [broker README](../crates/broker/README.md) for cleanup.
