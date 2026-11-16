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
| `Mesh`            | The hosts the neighbours reach, by route (HE-46, [The mesh](#the-mesh))                                                                  |
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
5. A relayed session's requests carry **no token**. RPC request headers travel inside each frame, and the hub pipes
   frames to the host as they are, so a token there would hand the hub's own board token to every host it links (a
   dial-in host that only ever held the hub token included). The host takes a relayed socket's session from the signed
   header only. (Corrected on review of HE-6: the plan first had the client's `Auth` put its hub token on each request,
   for the host to ignore; the old hub too kept its token to itself.)

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
- Left out: the old checks of hosts on older builds (14).
- **As built (HE-8): the assistant on its own host.** `hosts/AssistantHost.ts` sends `assistant.get` and
  `assistant.send` for a profile whose `assistant_host` is a linked host over that link, to the profile of the same
  name there, asking for that host's own (`here`), so a host whose profile names the hub doesn't send it back; the
  answer carries the host's id (`AssistantTask.host_id`). No new host protocol: the hub's link client already has the
  board's scopes. A stand-in that dialled in under the assistant host's id is refused when it attaches, so the user's
  messages only go the way the host is linked. Details in [06-server.md](06-server.md) (Assistant, As built HE-8).
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
  Settings → Experiments' switches (HE-22) sync too, one global field each (`global/experiment_<id>`, `"true"` or
  null), added to `GLOBAL` from the shared list.
- **Copying a config** (`hosts/CopyConfig.ts`): through each host's RPCs (this host's services directly); the config
  is matched by name and made on the target if missing. The login travels as the config's archive (6.11's
  `configs.exportArchive`, then `importArchive`), exported before anything is made on the target; the answer's `files`
  are the archive's entries, as the old one's were (6.12, HE-7: it was a count). A login already there without
  `overwrite` is `Invalid` (`overwrite`). `profile` (copying a profile's login, hosts before API 20) is refused.

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

## The mesh (HE-46)<a id="the-mesh"></a>

A link used to go one way: the host that held it reached the other, never the other way back, and a host's directory
listed only its own links (code.dire.nz showed omarchy, omarchy didn't show code.dire.nz). Now any hosts joined by links
show as one board on every one of them.

- **Both ways.** A link this host dials (`outbound`, `ssh`) with its **Mesh switch** on (`links.mesh`, on by default,
  old links too) also holds `link.attach` open on its dialled connection, saying who it is. The host it dials takes that
  as it takes a dial-in (`OpenStream` for each socket it wants, answered on its `/api/link/stream/<id>`, which now takes
  its own board token as well as the hub token), and registers the link as `reverse`: the sealed session it attached
  with shows that the other end holds its token, which is more than a dial-in shows. A host that dials in with the hub
  token under the id of a `reverse` link is refused, and a reverse attach is taken even for a profile's assistant host
  (that rule is for a host this one dials itself). The attach back is held, and made again with back-off, for as long
  as the dialled connection lasts, and it takes the place of a `reverse` or dial-in registration of its id the host
  still holds (a half-open socket, a link the host forgot), so the link comes back by itself. The session a ticket
  gives is the hub's to say: a board user's scopes at most, a device's for a device, never `link` (the host's agents
  call board tools up its control connection, under `uplink`). `as` on `hub.hosts.openRelay` only ever narrows the
  asker's own session. A host that dialled in (`--hub`) asks its hub for a ticket on the
  connection it attached on (`link.ticket { path, session }`), which the hub gives while its `inbound` link to that host
  has the switch on. That link starts with the switch **off** when a host dials in under an id the hub hasn't seen
  (`LinkRepo.upsert`): the hub token, which every host given it holds, is all that names it, so the user lets each one
  reach the hub back once, in Settings → Hosts (decided with the user on review of HE-46; a link this host makes starts
  on). With it on, the hub token is what that host's board user then holds on the hub's board, and a host claiming
  that id while it is away does too; the host opens the hub's `/api/relay/<ticket>`, piped to the hub's own `path` with the session
  sealed by the hub, and registers the hub as a `hub` link (a `links` row with its URL and no token) while its connection
  lasts. Only `outbound` and `ssh` links are dialled (`dials`); a `reverse` or `hub` link waits for the other end and
  shows `offline` until it is heard from. Each of these is a `Live` like the others, so the relay, settings sync and discovery use them alike. The switch
  turned off redials the link (or drops the host that dialled in, which dials again and gets no tickets).
- **What it lets in.** With the switch on, the users of the other host can use this board as this host's users can use
  theirs, and the hosts this one reaches. A host's agents still call board tools across hosts only as before: calls go
  down only over `dialled` and `dial-in` connections, and up to a hub under its `uplink` switch (`Uplink.otherHosts`
  leaves `reverse` and `hub` out).
- **The directory** (`hosts/Mesh.ts`) is a path vector. Each connected neighbour with the `mesh` capability has its
  `hub.hosts.watch` watched; every host it lists connected that this one doesn't link, isn't itself and isn't the
  neighbour is taken as `mode: "mesh"`, with `through` (the neighbour) and `route` (the neighbour first, then that
  entry's own route). An entry whose route already passes through this host is left out, so no route loops back and a
  host that goes away leaves every directory as its neighbours' do. Of two routes the shorter is taken; none longer than
  8. A host this one links itself is always its own entry, even while that link is down. A neighbour's list like the one
  held changes nothing, and `hub.hosts.watch` sends only a list that differs from the one before (`sameHosts`): each
  host's list is made from its neighbours', so two that took every list as news would send theirs back and forth for
  ever (found on review).
- **The relay** to a mesh host asks the neighbour for a ticket (`hub.hosts.openRelay` with `as`: the client's kind,
  scopes and device), and opens the neighbour's `/api/relay/<ticket>` over this host's way to it. A session of kind
  `link` may now ask the relay, but only for a client of its own (`as`), never with more than its own scopes, never
  `link`. A host answering `OpenStream` or a ticket may be asked for `/api/relay/<64 hex>` as well as `/api/rpc` and a
  terminal (`STREAM_PATH`).
- **Roles.** A host's `role` setting (`host_role`, not synced) is `projects` (the default) or `access`: a way in to the
  board, like a public hub, which isn't offered for new projects (`holdsProjects` in the client: Add project's host
  picker and the default host for new work). It is in `host.info`, `link.hello` and each `Host`; the web app reads each
  host's own from its board (`hostSettings`), since a hello is only as new as the connection. Settings → Hosts sets it
  on any host, through that host's session.
- **Config sync across the mesh.** Settings sync's exchange runs over every connected `Live`, `reverse` and `hub` ones
  included, and its merge is idempotent, commutative and associative, so a change crosses the mesh hop by hop. The
  host's **global skills and MCP servers** sync as fields (`hosts/settingsSync/agentTools.ts`): `skill/<name>`
  (`{ content, enabled }`) and `mcp_server/<name>` (`{ config, enabled, auto_allow }`), null when removed. The fields are
  the host's own and those other hosts' entries name (`fields(known)`), so one added elsewhere is made here when it is
  applied; one this host lacks and only an entry names makes no entry of its own (it isn't one it removed). A skill
  whose text names another skill, one a skill source here has the name of, or a server whose config doesn't check is
  kept and not applied. Skills from a skill source, projects' own skills and servers, and the profiles' switches stay
  on their host. `AgentTools` emits `agent_tools_changed` after a change to a global skill, server or source, which the
  observer and the exchange (here and on the hosts watching) take as a trigger, and the client's `agentTools.get`
  reads again on.
- **The board's settings as an eventually consistent store.** Whichever host a client is on, it sees the same settings.
  Sync is on unless a host switches it off (`settings_sync` "false"; unset is on, so every host takes part from the
  start). The merge was already convergent (version vectors; changes made apart go to the later, then by host id, and
  the value that lost is kept to use instead); what changed is how much of the board it holds
  (`hosts/settingsSync/boardFields.ts`):
  - **Profiles themselves**: `profile/<name>/exists` (true, null once removed, or `{ renamed_to }`). A profile one host
    has is made on the others (a row with no configs, then its other fields; `Profiles.scratchDirs` makes its scratch
    folder). A rename is kept as the profile's former name (`profile_former_names`, `ProfileRepo.renamed`), so the old
    name reads `{ renamed_to }` and the other hosts rename theirs (a change of case too), with its work, in place of an empty one of the new name
    that sync may have made first. A name a profile takes is no former name any more (`ProfileRepo.insert`, `update`),
    so a new profile of an old name, removed, reads as removed. One removed is removed elsewhere only where it has no projects and no tasks
    (`ProfileRepo.holds`): sync never deletes work, and the value it couldn't take waits (it isn't sent back as a change)
    until the profile holds nothing there.
  - **More of a profile**: `asana_enabled`, `telemetry`, `telemetry_titles`, `tint`; its configs (`configs`), its
    assistant's and threads' config, and its reviewers' and summarizers' configs, all by config name; its switches for
    global skills and servers (`tool_switches`, `skill:<name>` and `mcp:<name>`). Its configs are one field each,
    `profile/<name>/config/<config>` (true, or null once taken off), so each host keeps the configs of its own the others
    have none of; one taken off resets the assistant's and threads' config if it was theirs, as `Profiles.update` does.
    Agent configs and their names are each host's own, so a config renamed or deleted on one host isn't taken off the
    profile elsewhere: a field is looked at only while this host has a config of its name.
  - **Agent configs' options by config name**: `config/<name>/show_usage`, `restart_window`, `api_url`.
  - **Skill sources**: `skill_source/<url>|<ref>|<folder>`. A host takes one with no commit, and `AgentTools.catchUp`
    (at the start and on every `agent_tools_changed`) clones it there and deletes the clones of sources removed.
  - A value naming a config, skill or server this host lacks is taken in part or not at all, and taken again once it has
    it: settings sync's "couldn't take" path, which never sends this host's value back as a change. Paths (`clone_dir`,
    `config_dir`), logins and keys (`asana_token`, configs' keys, telemetry's password), `assistant_host`,
    `scratch_host`, `public_url`, the host's role, its links and every browser's own preferences stay where they are.
- Tested: `hosts/Mesh.test.ts` (the path vector), `hosts/SettingsSync.test.ts` (skills and servers), and
  `tests/e2e/hosts-mesh.test.ts` (three servers in a chain by URL, a host dialled in to a hub, each switch turned off,
  and skills and servers synced through a host that links neither end).

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
