# 8. Hosts and the hub

One board across several machines. The model is the old one; the wiring is one protocol where there were three.
Behaviour and rules: [inventory 05](inventory/05-hosts-update.md).

## The model, unchanged

- Every `huntaway serve` is a **host**: its own database, its own agents, its own files.
- Any host can be the **hub** for a client: it serves the UI and knows how to reach other hosts. A hub stores
  nothing about a linked host but the link (`links` row: id, name, mode, how to reach it, its token).
- The UI shows every host's projects together. Profiles and agent configs are matched across hosts **by name**.
  Ids are unique per host only.
- Three ways to link, with different trust:

  | Mode       | Who dials   | What proves the other end                                                           |
  | ---------- | ----------- | ----------------------------------------------------------------------------------- |
  | `outbound` | the hub     | The host's own board token, which the user gave the hub                              |
  | `ssh`      | the hub     | The hub's SSH key, accepted by a forced command on the host that prints its token; then as `outbound` through a local port forward |
  | `inbound`  | the host    | The hub's shared hub token. The host is known only by the id it claims               |

- The rules that follow from that last line are kept exactly (inventory 05, section 9): a dial-in is refused under
  an id that is already connected; a dial-in may stand in for a dialled host while its link is down, except for a
  profile's assistant host; calls up a link are taken only with the link's `uplink` switch on, from the right kind
  of connection, for a profile whose assistant host is that host.

## What changes

The old hub proxied HTTP requests (`/api/h/<host>/…`), merged every host's events onto the UI's socket, and spoke two
more formats to hosts: an event websocket with tool-call frames mixed in for links it dialled, and a tunnel with its
own request, stream and ping frames for hosts that dialled in.

Now a client holds **an RPC session per host**, and the hub's job is to hand it a socket to that host. The hub
never decodes what passes through. Events are not merged by the hub: each host's `board.watch` stream arrives on
that host's session.

```
 browser ── /api/rpc ──────────────────────────────► hub (its own board)
 browser ── /api/relay/<ticket> ──► hub ══ pipe ══► host B   (dialled:   hub opens  wss://B/api/rpc)
 browser ── /api/relay/<ticket> ──► hub ══ pipe ══► host C   (dial-in:   C opens    wss://hub/api/link/stream/<id>)
```

### Services

| Service           | Owns                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Links`           | The `links` table; adding by URL and token, over SSH, forgetting; `uplink`                                                               |
| `LinkConnections` | One live connection per linked host, in a `FiberMap` keyed by host id: dial, hello, keep alive, back off, replace. `open(host, path)` gives a `Socket` to that host |
| `Relay`           | Tickets, and piping a client's socket to a host's                                                                                        |
| `Uplink`          | Board tool calls from a host's agents up to a hub                                                                                        |
| `Discovery`       | Finding hosts: mDNS for `_huntaway._tcp.local`, Tailscale peers, hosts that linked hosts know                                            |
| `Ssh`             | The hub's key, the forced command, the port forward                                                                                      |
| `SettingsSync`    | Settings shared between hosts, with version vectors                                                                                      |

### A link is a control connection

Whichever side dials, each connected link has one long-lived RPC connection on which the two ends say hello and the
hub learns the host's state.

```ts
export class LinkRpcs extends RpcGroup.make(
  // Both directions: who are you, what do you speak.
  Rpc.make("link.hello", { payload: Hello, success: Hello, error: LinkRefused }),
  // A host that dialled in keeps this stream open; the hub asks for sockets through it.
  Rpc.make("link.attach", { success: OpenStream /* { id, path } */, stream: true }),
  // A hub that dialled a host keeps this stream open; the host sends its agents' tool calls up through it.
  Rpc.make("link.upcalls", { success: Upcall, stream: true }),
  Rpc.make("link.upcallResult", { payload: UpcallResult })
).middleware(Auth) {}

const Hello = Schema.Struct({ host_id: HostId, name: Schema.String, protocol: Schema.Int, version: Schema.String, capabilities: Schema.Array(Schema.String) })
```

- **Dialled (`outbound`, `ssh`)**: the hub opens `wss://<host>/api/rpc` with the host's token and calls
  `link.hello`. It then uses the host's ordinary `HostRpcs` for everything it does itself: `host.info`, `tools.call`
  for a board tool that names this host, `admin.update` to push an update, `settingsSync.merge`. For another socket
  to this host it simply dials again.
- **Dial-in (`inbound`)**: the host opens `wss://<hub>/api/link` with the hub token, calls `link.hello`, and then
  holds `link.attach` open. When the hub needs a socket to that host, it emits `OpenStream { id, path }`; the host
  dials `wss://<hub>/api/link/stream/<id>` and pipes that socket to its own `path` (`/api/rpc`, or a terminal). The
  hub pairs the arriving socket with whoever asked. So the hub talks to a dial-in host with the same RPC client it
  uses for a dialled one, over a socket the host opened for it. There is no multiplexing code.
- **Keep-alive** is the RPC client's ping (interval 20 s, dead after 60 s without a frame from the peer), which
  already counts only frames the peer sent, not a proxy's pongs. **Back-off** is `Schedule.exponential("1 second")`
  capped at 30 s, reset after a connection that lasted; a dial-out resets only after a minute up, so a hub that
  refuses at once is not redialled every second.
- A link's state (`connecting`, `connected`, `offline`, `needs update`, `refused: reason`) is a `SubscriptionRef`
  per link, which `hub.hosts.watch` streams.

### Relay<a id="relay"></a>

1. The client calls `hub.hosts.openRelay({ host_id })` on its hub session and gets a ticket.
2. It opens `wss://<hub>/api/relay/<ticket>`. The hub checks the ticket, asks `LinkConnections.open(host, "/api/rpc")`
   for a socket, and pipes the two until either closes.
3. When the hub opens (or asks the host to open) that socket, the upgrade request carries
   `x-huntaway-link: <hub's host id>` and `x-huntaway-session: <payload>.<mac>`, where the payload is the client's
   session (kind, scopes, an expiry) and the mac is `HMAC-SHA256(link token, payload)`.
4. The host's `Auth` middleware sees those headers on every RPC request of that socket, verifies the mac with that
   link's token, and gives the handlers a `Session` with the asserted scopes, never more than a board user's and
   never `link`. A relayed client cannot forge the header: it never holds the link's token, and a header it sends
   inside an RPC request fails the mac.
5. The client's own `Auth` middleware still puts its hub token on each request. The host ignores it: a relayed
   socket's session comes from the signed header only.

As built (7.2, `packages/client/src/session/relay.ts`): the socket's URL is an effect that asks for a ticket, so every
connection, the RPC client's reconnects included, takes a new one. It asks only once the hub's directory
(`hub.hosts.watch`) says the host is connected: a host that is away or forgotten costs the hub no requests, and one that
comes back is dialled as soon as the hub says so. A ticket refused is a socket open error, which the RPC client retries
as it does a host that is down.

A terminal is relayed the same way: `terminal.open` on the host's session returns a ticket for the host, and the
client reaches `/api/terminal/<ticket>` through a relay ticket whose path is that terminal.

What this removes: the JSON-only HTTP proxy with its body limits and status rewriting, the tunnel's request and
stream frames, the event socket's mixed-in call frames, `host_id` stamping of events, and the rule that uploads must
be base64 JSON because they cross the tunnel (they still are base64, inside an RPC payload, with the same 10 MB
cap).

### Board tools across hosts

- **Down** (an agent on the hub names a task on another host, or something is not found locally): `ToolCalls` asks
  each connected link in turn with `tools.call({ profile, tool, args })` on the link's RPC client, as now.
- **Up** (an agent on a host uses its hub's board, for an assistant that lives on its own machine): a host that
  dialled in calls the hub's `tools.call` on its control connection. A host the hub dialled offers its calls on
  `link.upcalls` and takes answers by `link.upcallResult`. Either way the hub runs them under the old conditions
  and at most once per call id.

As built (7.4):

- **The contract** (`packages/contracts/src/rpc/tools.ts`, in `HostRpcs`): `tools.call({ profile, tool, args, call_id,
  up })` (scope `link`) answers a `ToolOutcome`: `Ok { value }`, `Err { message, not_found }` (the message final, as the
  agent is told it) or `Off { why }` (an up-call not taken). `link.upcalls` takes the hub's `LinkHello` as its payload
  (registering is one call, as `link.attach`) and streams `UpCall { id, profile, tool, args, call_id }`;
  `link.upcallResult({ id, outcome })`. The old `task_fields` is gone with the hosts that lacked it (14).
- **The seam**: `ToolCalls` is in `mcp`, above `hosts`, so it asks `mcp/OtherHosts` (`links`, `hubs`: each `{ id, name,
  call }`) and `hosts/Uplink.ts`'s `Uplink.otherHosts` implements it over `LinkConnections.connected` (links speaking this
  host's protocol, `tools.call` with `up: false`), `Hubs.connected` (`tools.call` with `up: true`) and the hubs holding
  `link.upcalls` open (`Uplink.offer`/`answer`), each hub once, by name, leaving out one this host links itself. So that
  `ToolCalls` can be built over it, `Main.ts` builds the links' connections (`HostLinksLive`: `LinkConnections`, `Hubs`,
  `Uplink`) before the MCP area and the rest of the hosts area after it. Calls to another host time out after 300 s; a
  call up that lost its link or its answer "may or may not have taken effect"; a link that can't be reached is that
  host's reason, not "not found" (as the old `call_tool`'s errors were).
- **The dispatch** is `mcp/acrossHosts.ts` (the old `dispatch`), run by `ToolCalls` for every board tool but the thread's
  own (`THREAD_TOOLS`), and by the tracked work tools for a task on another host. What is not found anywhere is
  `not found: …` again, as the old tools said it (3.2 had dropped the prefix).
- **Who calls** (`hosts/HostTools.ts`, the `tools.call` handler and the hub's side of `link.upcalls`): a call down
  (`up: false`) must come on a hub's own connection (a sealed session, `via_link` set): a host that dialled in holds only
  the hub token every such host shares. A call up must come on the connection a dial-in host attached on:
  `LinkConnections.attach` records the RPC connection (`Rpc.ServerClient`) it came on, and `dialInOver(client)` gives
  the host registered on it while it is the registered one, so another holder of the hub token can't speak for a host it
  isn't. Then the old `run_up_call` checks, in order (the link's `uplink`; the way the call came against the link's mode;
  a profile of the caller's name whose `assistant_host` is that host), then `ToolCalls.upCall` (`mcp_calls` id
  `up:<host>:<call id>`, run `up:<host>`): the gates for another host's agent (thread tools refused; the arguments; this
  host's profile of that name, or none that lets it in: not found), then the dispatch with `from` that host, never back
  down to it and never up. `HostTools.served` holds `link.upcalls` open on each dialled connection (anew when it
  reconnects), takes each call as `dialled` and answers it.
- **A caller from another host** has no run or thread here: `McpCaller.run` and `.task` are null, `profile.id` null
  when this host has no profile of its name. Thread tools are registered with `threadTool` (given a `LocalCaller`) and
  refuse it; `Approvals` takes a null asker and refuses what needs asking with the old text ("… needs the user's
  approval, which only an agent on the task's own host can ask for; …"); the actor of its changes is an `Agent` with no
  task.
- Left out: the assistant on its own host (needs `Assistant`, 6.7); the old checks of hosts on older builds (14).
  Tested: `hosts/HostTools.test.ts` (two boards, the old uplink tests), `mcp/acrossHosts.test.ts` (scripted hosts),
  `hosts/Uplink.test.ts`, and `tests/e2e/hosts-tools.test.ts` (whole servers, both ways of linking).

### Events for things that watch every host

Push notifications and settings sync on a hub need other hosts' events. `LinkConnections` keeps one `board.watch`
subscription per connected link for the server's own use and offers the merged stream to those two services. The
UI does not use it.

As built (7.5): `LinkConnections` does not offer that stream yet, so `SettingsSyncExchange` opens its own
`board.watch` on each connected link's client that takes part (a `FiberMap` keyed by link, opened again a second after
it ends, replaced when the link's connection is), and keeps only `settings_changed`, `profiles_changed` and
`approval_rules`. Each such subscription starts with the host's whole snapshot; when push needs the events too, the
one shared stream should replace it.

### Discovery, SSH, settings sync

Ported as they are, on Effect's primitives:

- `Discovery`: the mDNS responder and browser on `DatagramSocket` (`effect/socket`), Tailscale peers from
  `tailscale status --json`, mesh through linked hosts' `hub.hosts.list`.
- `Ssh`: the argument list is the specification (inventory 05, section 5). The target must not start with `-`,
  checked on input and again when building arguments. The tunnel process is scoped to the link's fiber and dies
  with the server.
- `SettingsSync`: the merge is a pure function (idempotent, commutative, associative) taken with its property
  tests; the exchange loop is a debounced fiber on the hub. Subtle and already right: port it, do not redesign it.

As built (7.5):

- **Discovery** (`hosts/Discovery.ts`, `hosts/discovery/`): the DNS encoding and parsing are plain functions
  (`dns.ts`); the responder and the browser (`mdns.ts`) are on a small `Udp` service over Node's `dgram`, not on
  `DatagramSocket`. Effect's `DatagramSocket` joins a group, but sets the interface multicast goes out of once, when the
  socket opens, and the responder answers out of every LAN interface in turn from its one socket on 5353; nor has Effect
  a service for the machine's interfaces. `Udp.layerNode` takes Node's `createSocket` and `networkInterfaces` from
  `Main.ts`, as Node's HTTP server is, so no other file imports Node. Each socket's datagrams are handled by one fiber,
  so two answers never interleave their interfaces (the old `serial_sender`). The TXT record carries `proto` (the RPC
  protocol) where it had `api`; `FoundHost` gained `protocol`. Tailscale peers are asked by `tailscale status --json`
  (a `Tailscale` layer, 3 s) and tried on the HTTP port this hub listens on (7879 when it took a free one), since a
  fleet runs one port. The mesh reads each connected link's `hub.hosts.list`, so `PeerRpcs` includes `HubHostRpcs`; a
  host found that way must answer `/api/health` with its own id (the loopback fallback for hosts too old to give one is
  gone with the probes for old hosts). The responder starts once the server listens (`serverLayer`), and not with
  `--no-discovery`, on a loopback-only host, or on a test board; `--no-discovery` also keeps `hub.hosts.discover` to
  the mesh.
- **Settings sync** (`hosts/SettingsSync.ts`, `SettingsSyncRepo.ts`, `SettingsSyncExchange.ts`, `hosts/settingsSync/`):
  `observe` runs right after a change, on the `settings_changed`, `profiles_changed` and `approval_rules` events
  (`SettingsSync.observer`), and at the start of every read, merge and resolve, in a transaction of its own, rather
  than inside the transactions that make the changes: `HostSettings`, `Profiles` and `ApprovalRules` need not know about
  sync, and a write that announces nothing is still caught at the next look, as before. Writes go through the
  repositories with the old checks (`settingsSync/fields.ts`), and the events a pass announces carry what the board
  needs (`settings_changed` with the settings, `profiles_changed` through `AgentConfigs.emitChanged`, `approval_rules`
  with the view). Sync off is `Unavailable` (was 409). The exchange is `coalesced`: a dropping queue of one, so triggers
  during the 200 ms wait or a run make one more run after it. Only links on this protocol with `settings_sync` in their
  hello take part (`takesPart`). Property tests found one gap in the old merge: it is associative for changes made
  apart, but when an entry another covers also lost to a third, hosts that merged in different orders agree on the
  value and vector and can keep different `lost` lists, which equal vectors then never reconcile. Ported as it is.
- **Copying a config** (`hosts/CopyConfig.ts`): through each host's RPCs (this host's services directly); the config
  is matched by name and made on the target if missing. The login travels as the config's archive, which comes with
  6.11: until then the copy fails `Unavailable` after finding the source, before anything is made on the target.
  `profile` (copying a profile's login, hosts before API 20) is refused.

Paired devices (codes, device tokens, revocation) wait for the phone app. The session and scope design already has
their place: a device's session carries `read` and `operate`, checked by the host that serves each call, which
closes the old gap where a linked host could not tell a phone from the board.

### As built (7.2, 7.3, HE-6)

- **Services** (`apps/server/src/hosts/`): `LinkRepo` (the `links` table), `Links` (the directory: this host and every
  link with its live state; link by URL and token, which asks the host's `host.info` first; over SSH; rename, `uplink`,
  forget (profiles whose assistant ran there have it here again); `join`), `LinkConnections` (one connection per link,
  whichever way it came), `Relay` (tickets), `Ssh`, `Hubs` (this host as a host of other hubs: `--hub`), `SessionSeal`,
  `pipe.ts`. Routes: `/api/relay/<ticket>`, `/api/link/stream/<id>`.
- **Dial-in goes to `/api/rpc`, not `/api/link`.** The hub token there gives a session of `link` and nothing else, which
  is what a separate path would have guarded. `link.attach` takes the host's hello as its payload, so registering is one
  call; the hub refuses it under an id already connected (either way), under a profile's assistant host that it dials
  (even while that link is down), and under its own id. A dialled connection that comes up replaces a dial-in standing
  in for it; a host that becomes an assistant host has its stand-in dropped (`profiles_changed`).
- **The hub's client for a dial-in host** runs over a socket that asks the host for a new stream on each (re)connect
  (`OpenStream { id, path, session }` on the attach stream, answered on `/api/link/stream/<id>` with the hub token), so
  the hub talks to every host with the same RPC client. The host pipes each such stream to its own `/api/rpc` over
  loopback, sealing the session itself (above), once its server listens (`Hubs.dialIn`, built after the listener).
- **Sessions' lives**: a hub's own session on a host lasts 7 days (a connection that outlives it is dialled again), a
  relayed client's 12 hours (the hub closes the pipe then; the client dials again with a new ticket), a ticket 1 minute.
- **SSH**: the forced command is `huntaway ssh-host [--port N] [--data-dir D]` (default port 7879), which prints
  `{ info, port, started: false, token }`; `--name`/`--no-start` are gone (14). `HUNTAWAY_SSH_BIN` (read in
  `ServerConfig`) names the ssh program; whole-server tests give `packages/testing/bin/fake-ssh`, which runs `ssh-host`
  for the command and forwards the port for `-L`, so no `authorized_keys` or sshd is touched.
- `profiles.assistant_host` and the `scratch_host` setting are checked against the `links` table (until M7 they took no
  linked host).
- `hub.hosts.watch` streams the whole list on every change (a link's state, its heard time on each ping, the links
  themselves). `Host` gained `status` and `status_reason`, optional.

## Versions across a fleet

A hub updates its hosts one at a time through the link, so for a while they differ. `link.hello` carries
`protocol`, `version` and `capabilities`:

- A different `protocol` leaves the link in the state `needs update`: the hub can still call the stable core
  (`host.info`, `admin.status`, `admin.update`) and nothing else, and offers the update.
- The same protocol with a different version works; missing methods surface as `Unavailable("needs an update")` on
  the features that use them ([05-protocol.md](05-protocol.md#versions)).
- There is no link to hosts running the old code. The cut-over moves every host
  ([11-migration.md](11-migration.md#several-hosts)).

## To check early

Two things in this design were read in Effect's source but not run, and M7 started by running them (7.0, HE-6):

1. That headers on a websocket's upgrade request reach RPC middleware for every request on that socket
   (`RpcServer.ts` prepends them), and that the signed-session scheme holds when a request carries a header of the
   same name. **Holds** (`hosts/SessionSeal.test.ts`, a real server and websocket): the RPC server puts the upgrade's
   headers before each request's own and `Headers.fromInput` joins two of one name as `a, b`, so a relayed client's
   own `x-huntaway-session` spoils the seal (the request is refused) and never replaces it.
2. That piping two `Socket`s gives back-pressure in both directions, with a terminal's output as the load. **Not with
   Effect's `Socket` alone** (`hosts/pipe.test.ts` keeps it as the control): its websocket `Reader` pauses a peer while
   frames wait unread, but its `Writer` hands each frame to `ws.send` and returns, so `reader.pull` into
   `writer.writeAll` reads a fast peer as fast as it sends and holds whatever the slow side has not taken (all 16 MiB
   of the control's load). `hosts/pipe.ts` therefore waits, after each write, for the TCP connection under the slow side
   to drain (`writableNeedDrain`, `drain`): the connection of an accepted socket is the request's (`NodeHttpServerRequest
   .toIncomingMessage(request).socket`), a dialled one's comes with `ws`'s `upgrade` event. With that, 96 MiB to a
   reader that does not read leaves the sender holding more than half, the hub pauses the sender's connection, no write
   leaves more than 1 MiB in the hub's buffer, and everything arrives in order once the reader reads, both ways.

As built (7.0): the seal is MAC'd with the board token of the host that serves the socket, always. A hub that dials a
host holds that token (the link's); a host that dialled in is told the client's session on its control stream and
seals it itself before it pipes the hub's socket to its own `/api/rpc`. So a host never takes a session sealed with a
hub token, which every host dialled into that hub also holds and could otherwise use on another such host reached
directly. A sealed session of kind `link` (a hub's own connection to a host) may carry `link`; a relayed board client's
never, and a device's only `read` and `operate`.
