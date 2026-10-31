# huntaway-broker

Public access for Huntaway hosts behind NAT, without Tailscale or a VPN. In **managed tunnel mode** it handles
connection setup and endpoint discovery; application traffic travels through Cloudflare Tunnel. Without tunnel
configuration it keeps the **legacy relay** transport, carrying application traffic on hosts' outbound websockets.
A hub combines linked hosts into one board; either transport can expose that hub.

How hosts connect and how clients select one is in the main README,
[Reaching a host from anywhere](../../README.md#reaching-a-host-from-anywhere). Registration and relay messages are
in `src/proto.rs`. Agents' own model-provider and git traffic is independent of the public transport.

## Managed tunnels: broker handles setup only

This follows [T3 Connect's split](https://github.com/pingdotgg/t3code/blob/main/docs/internals/t3-connect.md): the
broker manages endpoints, while normal HTTP and websocket traffic uses a separate tunnel service. Cloudflare
still carries that traffic for the session; this isn't peer-to-peer NAT traversal.

Build the broker (`cd server && cargo build --release -p huntaway-broker`), serve it behind HTTPS, and configure:

```sh
export BROKER_TOKEN='<secret shared only with your hosts, at least 16 characters>'
export BROKER_CLOUDFLARE_ACCOUNT='<32-character Cloudflare account id>'
export BROKER_CLOUDFLARE_ZONE='<32-character DNS zone id>'
export BROKER_CLOUDFLARE_TOKEN='<Cloudflare API token>'
target/release/huntaway-broker --port 8080 --state /var/lib/huntaway-broker/state.json \
  --tunnel-domain hosts.example.com --default-host desktop
```

The domain must be in the configured Cloudflare DNS zone. The API token needs **Account → Cloudflare Tunnel → Edit**
on that account and **Zone → DNS → Edit** on that zone. It stays on the broker; it isn't sent to hosts or browsers.
The state file preserves name ownership, so it is required. The broker never replaces an existing DNS record that
isn't already the host's proxied tunnel CNAME: choose an unused hostname or remove the conflicting record yourself.

On each host, [install cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
and run the usual `huntaway serve --broker https://broker.example.com --broker-token <broker token>`.
`IA_CLOUDFLARED_BIN` can name another connector binary. Huntaway starts it with a per-tunnel token in its environment,
not its arguments, and restarts it after an exit. Its origin is a separate loopback listener that blocks
`/api/open-token`, even if the LAN listener uses `--open-token`.

A host called `desktop` gets `https://desktop.hosts.example.com`. Opening the broker's URL selects a host and sends
an uncached 307 redirect, preserving the path and query (including `?token=`). The board loads, authenticates and
opens websockets at the host's hostname, so board traffic doesn't pass through this process. Current hubs use
`GET /_broker/resolve/<name>` (or `/_broker/resolve` for the default host) before authenticating or opening a
websocket. It returns `{"host_id":"…","url":"https://desktop.hosts.example.com"}` with `Cache-Control: no-store`;
it never returns the connector token. Saved links resolve again on reconnect, and reject a changed host id.

Upgrade hosts and hubs before switching the broker to managed tunnels. Old host registrations are refused with
an upgrade message; old clients don't know to discover endpoints before opening websockets. Browser tokens saved
on the broker site don't transfer to the new hostname: sign in there with the host token. Send webhooks straight
to that hostname, since many senders won't follow a redirect. The public endpoint still enforces the host's token.

The connector runs independently of the broker connection. Existing board sessions and the tunnel URL keep
working while the broker is down; registration, discovery and provisioning need the broker. Restarting a host
reconciles its loopback origin port, reuses its tunnel and DNS record, and starts a new connector. Cloudflare
availability and bandwidth limits apply to session traffic. Hosts reconnect to the broker within 30 seconds;
provisioning failures retry too, with a diagnostic in the host log. Check the installed connector and outbound
Cloudflare connectivity if the tunnel URL stays unavailable. Initial DNS and connector startup can take a short
time after registration; retry the public URL once the connector has registered.

Tunnels and DNS records are deliberately retained when hosts or the broker disconnect, to keep names stable and
avoid interrupting working sessions. There is no automatic cloud resource cleanup. To retire a host, stop it and
remove its tunnel and CNAME in Cloudflare as well as its reservation from the broker state file while the broker
is stopped. Tunnel names start with `huntaway-` and a digest of the hostname and owner; find the tunnel id in the
hostname's CNAME (`<id>.cfargotunnel.com`). A different owner taking an expired broker name won't silently replace
that DNS record. A partially completed provisioning attempt is reconciled on retry, without allocating a tunnel
per reconnect. Keep the host's data dir (`host_id` and `broker_key`) to retain its allocation.

## Legacy relay

```sh
cd server && cargo build --release -p huntaway-broker
BROKER_TOKEN=$(openssl rand -hex 32) target/release/huntaway-broker --port 8080 --state /var/lib/huntaway-broker/state.json [--default-host desktop]
```

## Shared settings and name reservations

| Flag / env | Default | |
|---|---|---|
| `--host` / `BROKER_HOST` | `0.0.0.0` | Address to listen on |
| `--port` / `BROKER_PORT` | `8080` | |
| `--token` / `BROKER_TOKEN` | (required) | What hosts connect with (`huntaway serve --broker-token`), at least 16 characters |
| `--default-host` / `BROKER_DEFAULT_HOST` | | The host for requests that don't pick one |
| `--state` / `BROKER_STATE` | | Name reservations across restarts; required with managed tunnels |
| `--tunnel-domain` / `BROKER_TUNNEL_DOMAIN` | | Enable managed tunnels below this DNS domain |
| `--cloudflare-account` / `BROKER_CLOUDFLARE_ACCOUNT` | | Cloudflare account id for managed tunnels |
| `--cloudflare-zone` / `BROKER_CLOUDFLARE_ZONE` | | Cloudflare DNS zone id |
| `--cloudflare-token` / `BROKER_CLOUDFLARE_TOKEN` | | API token for tunnel and DNS provisioning (prefer env) |

The broker speaks plain HTTP, so serve it behind a TLS proxy (Caddy, nginx, a Cloudflare tunnel) on a public address, and
give hosts the `https://` URL. It keeps no data but its `--state` file, if it has one (on a volume, in a container).
Things to know about the proxy in front of it:

- It has to pass websockets through, and leave them open: hosts hold one all the time. The broker sends a message on
  it every 20 seconds, so idle timeouts of a minute or more are fine after registration. For managed tunnel
  provisioning, allow two minutes for the initial welcome. Don't stop it when it's idle (a scale-to-zero platform
  would cut registration off; in managed mode existing tunnel traffic would continue).
- Don't put a password (basic auth) in front of it: hosts and the board's API calls can't send one. Each host's own
  token guards its API, and the broker's token guards who can connect as a host. Anyone with the broker's token can
  connect under a name that's free and be sent its clients' requests (with their host tokens), so give it only to
  your own hosts.
- In legacy relay mode, a proxy's request size limit applies to uploads through it (Cloudflare's is 100 MB, which only matters for
  **Copy login** of a large Claude config).

In legacy relay mode, each request or websocket through the broker has at most 256 KiB in flight each way, so a slow client or host holds
up only its own request and the broker's memory stays bounded. A host has at most 128 requests in flight through it.
When it has that many, a new one takes the place of the one whose client has left data waiting longest. A request
or websocket that makes no progress for 60 seconds (its client takes nothing of what's waiting for it, or the host
nothing of what the client sent) is closed.

A name stays with the host that took it first (by its host id and the secret key it keeps in its data dir): another
host asking for it is refused while that one is connected, and for an hour after it goes. With `--state <file>`, the
broker writes the names taken to that file (each name's host id and a SHA-256 of its key, so the file doesn't give
away what to connect with) whenever a host connects or goes, and reads it when it starts. A host that was connected
when the broker stopped has its name kept for an hour from when the broker starts again, and one that had gone keeps
what was left of its hour. A file that can't be read or written stops the broker from starting; none yet is fine. If it can't be written later
(a full disk, say), a host taking or coming back to a name is refused until it can, rather than given a name the file
doesn't keep for it; hosts already connected stay connected.
Without `--state`, names are kept in memory only: after a restart, the first host to connect under a name has it.
To let a name go before its hour is up, stop the broker, take the name out of the file and start it again.

`GET /_broker/health` answers `{"ok": true}` without reaching a host, for health checks. To change the token or the
default host, restart it with the new value: hosts reconnect by themselves within 30 seconds.
