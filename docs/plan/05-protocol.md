# 5. Protocol

How clients, scripts, agents and other hosts talk to a server. One RPC contract carries almost everything; a short
list of plain HTTP paths covers what RPC is wrong for.

## The shape

| Who                          | Speaks                                              | To                                         |
| ---------------------------- | --------------------------------------------------- | ------------------------------------------ |
| The web and desktop apps     | Effect RPC over a websocket, one per host            | `GET /api/rpc` (their own board), `GET /api/relay/<ticket>` (another host, through the hub) |
| Scripts, the CLI, `curl`     | The same RPC group over HTTP POST, one NDJSON line   | `POST /api/rpc`                             |
| A hub and its hosts          | The same RPC, plus the `link.*` group                | [08-hosts.md](08-hosts.md)                  |
| Agents                       | MCP (JSON-RPC): on the run's files, or over HTTP     | `/api/mcp/<run id>/<server>` ([07-agents.md](07-agents.md#board-tools)) |
| GitHub and other senders     | Webhooks                                             | `POST /api/hooks/<id>/<token>`              |
| Browsers                     | The built UI                                         | everything not under `/api`                 |

Everything keeps the `/api` prefix. Webhook URLs registered with GitHub and others carry it, and reverse proxies in
front of existing boards route on it.

The spike ([spike/](spike/README.md)) ran one RPC group on both `/ws` and `/rpc` of a Node HTTP server, with a
streaming method, typed errors and middleware that provides the session: `RpcServer.layerHttp({ group, path, protocol:
"websocket" | "http" })` with `RpcSerialization.layerNdjson`.

## The contract package

```
packages/contracts/src/
  ids.ts  time.ts  errors.ts
  task.ts  project.ts  profile.ts  agentConfig.ts  pen.ts  automation.ts  workflow.ts  doc.ts  host.ts  usage.ts …
  thread/        Item.ts  Request.ts  Event.ts  Command.ts  Snapshot.ts  reducer.ts  window.ts
  events.ts      BoardEvent, HubEvent
  session.ts     Session, Scope, the Auth middleware's declaration (not its implementation)
  rpc/           one file per group: board.ts tasks.ts threads.ts … ; HostRpcs.ts, HubRpcs.ts, LinkRpcs.ts, PublicRpcs.ts
  capabilities.ts
  index.ts
```

`HostRpcs` is every group a host serves about itself. `HubRpcs` is what a server adds as the board a client opened:
the directory of hosts, linking, push subscriptions, discovery. `LinkRpcs` is for hosts talking to each
other. `PublicRpcs` needs no session. A client of its own board gets `HostRpcs + HubRpcs + PublicRpcs`; a client of
another host, through the relay, gets `HostRpcs`.

## Sessions and scopes

```ts
export const Scope = Schema.Literals(["read", "operate", "git", "terminal", "settings", "admin", "link"])

export class Session extends Context.Service<Session, {
  readonly kind: "board" | "device" | "link"
  readonly scopes: ReadonlySet<Scope>
  readonly device_id: DeviceId | null
  readonly via_link: LinkId | null // set when a hub relays for someone
}>()("huntaway/Session") {}

export class Auth extends RpcMiddleware.Service<Auth, { provides: Session }>()("huntaway/Auth", {
  error: Schema.Union([Unauthorized, Forbidden]),
  requiredForClient: true
}) {}
```

- **Every RPC states the scope it needs**, as an annotation on its definition. The `Auth` middleware resolves the
  session and fails with `Forbidden` when the scope is missing. A structural test fails on an RPC without one.
- **Who gets what.** The board token: every scope but `link`. A link: `link`, and, when it relays for a client, that
  client's scopes and no more. A paired device (`read` and `operate` only) is the third kind of session; it is in
  the contract so that scopes are designed for it, and is implemented with the phone app, later.
- **What each scope covers.** `read`: lists, gets, subscriptions, thread pages. `operate`: create and change tasks,
  send messages, answer prompts and questions, stop runs, start reviews, attachments. `git`: the Changes tab's writes,
  worktree setup and teardown, rewind. `terminal`: terminals and the desktop viewer. `settings`: profiles, projects,
  agent configs, automations, workflows, agent tools, approval rules, docs. `admin`: linking hosts, restart
  and update, config archives, telemetry, the service, the folder browser.
- **How a session is proved.** The client's `Auth` middleware puts `authorization: Bearer <token>` on every RPC
  request (in the request, not the URL). A relayed socket instead carries, in the headers of its upgrade request,
  the link's id and a session the hub asserts, signed with the link's token ([08-hosts.md](08-hosts.md#relay)). The
  RPC server gives upgrade headers to the middleware with each request (seen in `RpcServer.ts`); a relayed client
  cannot forge the signature because it never holds the link's token.
- **Tokens** are compared in constant time. The per-run MCP secret stays
  `HMAC-SHA256(board token, "mcp:" + run id)`.
- **`--open-token`** (previews and test servers) keeps its meaning: `PublicRpcs` then has `openToken`, guarded on a
  loopback-only server by a loopback `Host` header.

This replaces the route allowlist for devices and the second `board_only` check in sensitive handlers. The old
problem that a linked host could not see that a request came from a phone is gone, because the host that serves the
call checks the scope.

## RPC groups

Method names are `group.verb`. Payloads and results are the old request bodies and answers
([inventory](inventory/07-server-root-api.md), section 7.6, numbered there), as schemas. The numbers in the last
column are that table's.

| Group          | Methods                                                                                                                                                         | Scope                | Old routes |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------- |
| `public`       | `health`, `openToken`                                                                                                                                            | none                 | 1          |
| `board`        | `watch` (stream), `previewStatus`                                                                                                                                | read                 | 23, 14     |
| `host`         | `info`, `settings`, `updateSettings`, `usage`, `defaultPrompts`, `listDirs`                                                                                      | read; settings; admin | 24–27, 33 |
| `profiles`     | `list`, `create`, `update`, `delete`, `githubAccounts`, `githubRepos`, `asanaTasks`                                                                              | read; settings       | 57–60, 91  |
| `configs`      | `list`, `create`, `update`, `delete`, `models`, `exportArchive`, `importArchive`                                                                                 | read; settings; admin | 61–64     |
| `projects`     | `list`, `get`, `create`, `clone`, `createOnGithub`, `update`, `delete`, `branches`, `systemPrompt`, `setupThread`, `removeMergedWorktrees`                        | read; settings; git  | 66–68, 110–115 |
| `tasks`        | `list`, `get`, `create`, `update`, `delete`, `updateStack`, `send`, `dropQueued`, `stop`, `stopBackground`, `stopServer`, `waitForLimit`, `review`, `extendReview`, `summarize`, `fixChecks`, `mergeTarget`, `mergeStack`, `fanout`, `pickFanout`, `removeTracked`, `context`, `document`, `skills`, `unmerged` | read; operate | 69, 86, 111, 140–141, 148–165, 179–180, 139 |
| `threads`      | `watch` (stream), `page`, `command`, `answerQuestion`                                                                                                            | read; operate        | 143–147    |
| `permissions`  | `pending`, `answer`, `approvals`                                                                                                                                 | read; operate        | 35–37      |
| `git`          | `status`, `diff`, `show`, `taskDiff`, `stage`, `unstage`, `discard`, `apply`, `commit`, `stash`, `reset`, `setupWorktree`, `teardownWorktree`                     | read; git            | 157–159, 166–175 |
| `checkpoints`  | `turns`, `turnDiff`, `rewind`, `cancelRewind`                                                                                                                    | read; git            | 176–178    |
| `terminal`     | `status`, `open` (gives a ticket), `kill`, `keepalive`                                                                                                           | terminal             | 181–183    |
| `docs`         | `list`, `get`, `update`, `delete`, `renameFolder`, `labels`, `image`, `version`, `publish`, `comments`, `addComment`, `updateComment`, `deleteComment`, `sendComments`, `hostedStatus`, `hostedDisconnect`, `hostedDeviceStart`, `hostedDeviceCancel`, `hostedToken` | read; settings | 97–109 |
| `pens`         | `list`, `create`, `update`, `delete`, `rootThread`, `thread`                                                                                                     | read; operate        | 93–96      |
| `automations`  | `list`, `get`, `create`, `update`, `delete`, `run`, `runs`                                                                                                       | read; settings       | 92, 116–119 |
| `workflows`    | `list`, `get`, `create`, `update`, `delete`, `run`, `runsOfTask`, `stopRun`                                                                                      | read; settings; operate | 120–124 |
| `agentTools`   | `get`, `setSwitch`, `addSource`, `removeSource`, `updateSource`, `addSkill`, `updateSkill`, `removeSkill`, `addServer`, `updateServer`, `removeServer`, and the same under a project | read; settings | 125–138 |
| `assistant`    | `get`, `send`, `memory`, `memoryFile`, `writeMemoryFile`, `memoryHistory`, `memoryDiff`, `restoreMemory`, `importMemory`, `google`, `setupGoogle`, `addBrief`, `briefFeedback` | read; operate; settings | 71–80 |
| `approvalRules`| `get`, `set`, `log`                                                                                                                                              | read; settings       | 81–82      |
| `analytics`    | `report`, `contextStats`, `tokenStats`, `diskUsage`                                                                                                              | read                 | 87–90      |
| `attachments`  | `upload`, `get`                                                                                                                                                  | operate; read        | 38–39      |
| `desktop`      | `status`, `setEnabled`, `install`, `uninstall`, `stop`, `check`, `frame`, `ops`                                                                                  | terminal; admin      | 51–56      |
| `admin`        | `status`, `restart`, `update`, `checkRelease`, `updateRelease`, `rollback`, `installService`, `telemetry`, `updateTelemetry`, `testTelemetry`                    | admin                | 31–32, 40–47 |
| `settingsSync` | `get`, `merge`, `resolve`                                                                                                                                        | settings; link       | 28–30      |
| `tools`        | `call`                                                                                                                                                           | link                 | 34         |
| `hub.hosts`    | `watch` (stream), `list`, `add`, `addSsh`, `sshKey`, `join`, `discover`, `update`, `remove`, `copyConfig`, `pushUpdate`, `openRelay` (gives a ticket)           | read; admin          | 6–13, 22   |
| `hub.push`     | `info`, `subscribe`, `update`, `unsubscribe`, `test`                                                                                                             | read; operate        | 15–18      |
| `link`         | `hello`, `attach` (stream), `reply`, `upcalls` (stream), `upcallResult`, `events` (stream)                                                                       | link                 | 2, 50      |

Waiting for the phone app: device pairing (5, 19–21) and answering a prompt from a notification (4).

Not carried: the legacy `messages` routes (142's GET), `profiles/{id}/scratch` (70), `profiles/{id}/claude-config`
(65), `admin/threads*` (48–49), `admin/database/recopy` (46), and Telegram (83–85).

A definition, for the shape:

```ts
export class TaskRpcs extends RpcGroup.make(
  Rpc.make("tasks.update", {
    payload: { id: TaskId, patch: TaskPatch },
    success: Task,
    error: Schema.Union([NotFound, Invalid, Conflict])
  }).annotate(RequiredScope, "operate"),
  Rpc.make("tasks.send", {
    payload: { id: TaskId, text: Schema.String },
    success: Task,
    error: Schema.Union([NotFound, Conflict, Unavailable])
  }).annotate(RequiredScope, "operate")
  // …
).middleware(Auth) {}
```

## Subscriptions

Three streams replace the one unsequenced websocket. Each puts the ordering problem on the server, where it is one
transaction, instead of in every client.

### The board

```ts
Rpc.make("board.watch", {
  payload: { since: Schema.optional(Schema.Struct({ boot: Schema.String, seq: Schema.Int })) },
  success: Schema.Union([BoardSnapshot, BoardEvent]),
  stream: true
})
```

- The stream starts with `hello { host_id, boot, seq }`.
- **With no `since`, or one the server cannot replay**, the next message is `snapshot { seq, profiles, configs,
  projects, archived_projects, tasks, pens, settings, usage, approvals }`: everything the board store holds for this
  host, read in one transaction, so it is exactly the state at `seq`. Then every event after `seq`.
- **With a `since` from this boot that the server's buffer still covers**, the events after it and nothing else.
  The `Events` service keeps the last few thousand events in memory for this.
- A subscriber that falls too far behind gets `resync` and the stream ends; the client subscribes
  again without `since`.

So a client never loads lists beside the stream, and the old rules for it (connect before loading, number the loads,
events beat stale loads, a deleted task stays deleted) have nothing left to guard. The old client made one request
per project and kind on every reconnect.

The snapshot holds every task of the host, as the store does today. Its size is measured at M2
([10-testing.md](10-testing.md#measurements)); if it proves too large, the payload gains a filter (`profile_id`,
"not archived").

### A thread

```ts
Rpc.make("threads.watch", {
  payload: { task_id: TaskId, limit: Schema.Int, since: Schema.optional(Schema.Int) },
  success: Schema.Union([ThreadSnapshot, ThreadEvent, ThreadPreview, UnknownEvent]),
  error: NotFound,
  stream: true
})
```

- First a `snapshot` (a window of the last `limit` items with its context items, open requests and `seq`), or, with
  a `since` the 24-hour log still reaches, the events after it. Then saved events and deltas as they happen.
- The handler subscribes to the thread before it reads the window and drops what the window already has, so there is
  no gap to detect. The client's hold, gap, catch-up and resync logic is gone; its reducer stays.
- The snapshot carries the text streamed so far for the reply being written (`preview`), which the server keeps per
  running thread. Opening a thread mid-reply shows the whole reply so far, not only what comes after.
- Older items: `threads.page({ task_id, before, limit })`.
- A task with no thread yet is an empty snapshot, not a 404.

### The hub's hosts

`hub.hosts.watch` streams the directory: this host and its links with their live state, again on every change.

## Plain HTTP

| Path                                       | For                                                                                      | Auth                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------- |
| `GET /api/health`                          | `{ ok, host_id, version, protocol, capabilities, commit }`. The desktop shell, discovery, `--update-from` and deploy checks read it | none |
| `GET /api/rpc` (websocket), `POST /api/rpc` | RPC                                                                                      | per request                  |
| `GET /api/relay/<ticket>` (websocket)      | A client's socket to another host, relayed                                                | the ticket                   |
| `GET /api/terminal/<ticket>` (websocket)   | A terminal: binary output and input, JSON control frames, as now                          | the ticket                   |
| `GET /api/link` (websocket)                | A host dialling in: its control connection                                                | the hub token                |
| `GET /api/link/stream/<id>` (websocket)    | A host answering the hub's request for one more socket                                    | the hub token and the id     |
| `POST /api/hooks/<id>/<token>`             | An automation's webhook. Same path as now, so registered URLs keep working                | the token in the path        |
| `POST /api/mcp/<run id>/<server>`, `GET` with `Last-Event-ID` | MCP for a run                                                          | the run's secret             |
| `POST /api/otlp/<run id>/v1/logs` (and `metrics`, `traces`) | Telemetry from an agent CLI                                              | the run's secret             |
| `GET /*`                                   | The built UI, with the single-page fallback and the cache headers it has now              | none                         |

Rules at this edge, each from a past bug ([inventory](inventory/07-server-root-api.md), section 9): requests that
arrive while the server starts wait for it; a route's auth is checked before its body is read; a body over its limit
is answered 413 only after it has been drained; open routes take small bodies only; static files never leave the UI
folder; CORS stays open on `/api`.

Tickets are single-use, expire in a minute, and are bound to the session that asked. They exist because a browser
cannot put a header on a websocket, and a long-lived token must not sit in a URL that proxies log.

## Versions

Hosts are updated one at a time through the hub, and the desktop shell ships on its own schedule, so two ends of a
connection can differ. The old server managed that with a frozen API number, a
compatibility number and about forty numeric gates in the clients. The new rules:

- **`PROTOCOL`** is one integer, checked in `public.health` and `link.hello`. It changes only when RPC framing or
  the meaning of an existing method changes, and a mismatch shows the host as "needs an update" with the update
  button and nothing else.
- **Schemas change by adding.** A new field is optional or nullable until every supported peer sends it. A method is
  never repurposed; a new one is added. Decoding ignores unknown fields, and the event unions end in an
  `Unknown…` member so an unknown `type` is skipped, not fatal.
- **A capability is a name**, in `packages/contracts/src/capabilities.ts`, reported by `host.info`. A client asks
  `hostHas(host, "computer_use")` before showing a feature that only some hosts can do. A host one version behind
  that lacks a method answers the RPC server's "unknown request" defect; the client's session turns that into
  `Unavailable("needs an update")`.
- **A stable core** that never changes shape: `public.health`, `host.info`, `link.hello`, `admin.status`,
  `admin.update`. It is what lets a hub update a host that is otherwise too old to talk to.

## The CLI as a client

`huntaway rpc <method> [json]` calls a server over `POST /api/rpc` with the typed client and prints the result as
JSON, exiting non-zero with the tagged error on a failure. It finds a test server from its env file and refuses the
live board's port unless told, as `scripts/ia-api` does. The helpers agents use every day sit on top of it:
`huntaway dev new-task`, `start`, `send`, `task`, `thread`, `pending`, `approve-all`, `wait-idle`
([10-testing.md](10-testing.md#tools-for-agents)).
