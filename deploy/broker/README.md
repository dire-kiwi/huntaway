# Broker deployment

`huntaway-broker` (`server/broker`) is a public relay for hosts that can't be reached directly: they dial out to it, and
browsers and hubs reach them through it (README, *Reaching a host from anywhere*). It speaks plain HTTP, keeps no data
and needs no volume, so it runs behind any TLS proxy; with site-deploy, Caddy (and on 201 the Cloudflare tunnel) does
TLS.

## Deploying with site-deploy

```sh
export BROKER_TOKEN=$(openssl rand -hex 32)          # keep it: hosts connect with it
deploy/broker/bundle.sh /tmp/broker.zip <domain> [<default host>]
site-deploy --host <server> deploy <app name> /tmp/broker.zip
```

`bundle.sh` builds the binary in a `rust:1-bookworm` container (Docker volumes `huntaway-broker-target` and
`huntaway-broker-cargo` keep its build cache) and bundles it with a compose file for the stock `debian:bookworm-slim`
image, so there is no image to push. `BROKER_BIN=<path>` bundles a binary built elsewhere instead. The token and the
default host go in the bundle's `broker.env`; the bundle is the only copy on this machine, so keep the token somewhere
safe (e.g. `~/.config/dkcode/broker_token`). The app never idles (`idle_timeout: 0`): hosts keep a websocket open to it.

It has to be reachable from wherever you are, so deploy it to a public server, e.g. 201 as `<name>.dire.nz` (one
subdomain level there, through the Cloudflare tunnel; Cloudflare caps request bodies at 100 MB, which only matters for
**Copy login** of a large Claude config through the broker). Don't put site-deploy's `basic_auth` on it: hosts and
the board's API calls would need its password too. The hosts' own tokens guard their APIs.

To change the token or default host, build a new bundle and redeploy (`site-deploy delete`, then `deploy`). Hosts
reconnect by themselves within 30 seconds.

## Connecting hosts

On the host whose board you want to reach (usually the hub that links the others):

```sh
huntaway serve --broker https://<domain> --broker-token $BROKER_TOKEN [--broker-name desktop]
```

or set `IA_BROKER`, `IA_BROKER_TOKEN` and `IA_BROKER_NAME` in its environment. Restarts from the board keep the flags.
Its log says `reachable through the broker https://<domain> as <name>` once it's connected. Then open
`https://<domain>/?token=<host token>` (`huntaway token` on the host), or `https://<domain>/_broker/use/<name>?token=…`
when more than one host is connected and the broker's default host isn't the one you want.

A host somewhere else (a laptop away from home) can join a hub that is behind the broker with
`huntaway serve --hub https://<domain>/_broker/h/<hub's name> --hub-token <the hub's hub token>`.

## Running it elsewhere

```sh
cd server && cargo build --release -p huntaway-broker
BROKER_TOKEN=… target/release/huntaway-broker --port 8080 [--default-host desktop]   # BROKER_HOST, BROKER_PORT, BROKER_DEFAULT_HOST
```

`GET /_broker/health` answers `{"ok": true}` without reaching a host.
