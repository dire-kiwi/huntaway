# huntaway-broker

A public relay for Huntaway hosts that can't be reached directly (at home, behind NAT, without Tailscale or a VPN).
Hosts dial out to it and keep a websocket open; browsers and hubs reach them through it. How hosts connect and how
a request picks a host is in the main README, *Reaching a host from anywhere*; the wire protocol is in
`src/proto.rs`.

## Running it

```sh
cd server && cargo build --release -p huntaway-broker
BROKER_TOKEN=$(openssl rand -hex 32) target/release/huntaway-broker --port 8080 --state /var/lib/huntaway-broker/state.json [--default-host desktop]
```

| Flag / env | Default | |
|---|---|---|
| `--host` / `BROKER_HOST` | `0.0.0.0` | Address to listen on |
| `--port` / `BROKER_PORT` | `8080` | |
| `--token` / `BROKER_TOKEN` | (required) | What hosts connect with (`huntaway serve --broker-token`), at least 16 characters |
| `--default-host` / `BROKER_DEFAULT_HOST` | | The host for requests that don't pick one |
| `--state` / `BROKER_STATE` | | A file to keep the names hosts took in, across restarts (below) |

It speaks plain HTTP, so serve it behind a TLS proxy (Caddy, nginx, a Cloudflare tunnel) on a public address, and
give hosts the `https://` URL. It keeps no data but its `--state` file, if it has one (on a volume, in a container).
Things to know about the proxy in front of it:

- It has to pass websockets through, and leave them open: hosts hold one all the time. The broker sends a message on
  it every 20 seconds, so idle timeouts of a minute or more are fine. Don't stop it when it's idle (a scale-to-zero
  platform would cut hosts off).
- Don't put a password (basic auth) in front of it: hosts and the board's API calls can't send one. Each host's own
  token guards its API, and the broker's token guards who can connect as a host. Anyone with the broker's token can
  connect under a name that's free and be sent its clients' requests (with their host tokens), so give it only to
  your own hosts.
- A proxy's request size limit applies to uploads through it (Cloudflare's is 100 MB, which only matters for
  **Copy login** of a large Claude config).

Each request or websocket through the broker has at most 256 KiB in flight each way, so a slow client or host holds
up only its own request and the broker's memory stays bounded. A host has at most 128 requests in flight through it.
When it has that many, a new one takes the place of the one whose client has left data waiting longest. A request
or websocket that makes no progress for 60 seconds (its client takes nothing of what's waiting for it, or the host
nothing of what the client sent) is closed.

A name stays with the host that took it first (by its host id and the secret key it keeps in its data dir): another
host asking for it is refused while that one is connected, and for an hour after it goes. With `--state <file>`, the
broker writes the names taken to that file (each name's host id and a SHA-256 of its key, so the file doesn't give
away what to connect with) whenever a host connects or goes, and reads it when it starts. A host that was connected
when the broker stopped has its name kept for an hour from when the broker starts again, and one that had gone keeps
what was left of its hour. A file that can't be read or written stops the broker from starting; none yet is fine.
Without `--state`, names are kept in memory only: after a restart, the first host to connect under a name has it.
To let a name go before its hour is up, stop the broker, take the name out of the file and start it again.

`GET /_broker/health` answers `{"ok": true}` without reaching a host, for health checks. To change the token or the
default host, restart it with the new value: hosts reconnect by themselves within 30 seconds.
