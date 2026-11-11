# 1. Architecture

What runs, what talks to what, and the handful of patterns every area of the server follows. The pages after this one
fill in each part.

## What runs

```
 browser / desktop app                               another machine
┌────────────────────────────┐                     ┌──────────────────────┐
│ React components (kept)    │                     │ huntaway serve       │
│ atoms  (packages/client)   │                     │ (a host; same code)  │
│ RPC session per host       │                     └──────────▲───────────┘
└────────────┬───────────────┘                                │ link: outbound, SSH or dial-in
             │ one websocket per host, Effect RPC             │ (control RPC + relayed sockets)
┌────────────▼────────────────────────────────────────────────┴───────────┐
│ huntaway serve   (Node 24+, one process per data dir, one Effect runtime)│
│                                                                          │
│  transports   RPC /rpc (ws + http) · HTTP routes · MCP /mcp · static UI  │
│  services     Tasks · Runs · Threads · Merges · Reviews · Workflows · …  │
│  platform     Db (SQLite) · Events · KeyedLock · Proc · DataDir · Clock  │
└───────┬──────────────────────────┬───────────────────────────┬───────────┘
        │ files in runs/<run id>/  │ child processes           │ node:sqlite
┌───────▼────────┐          ┌──────▼───────────────┐    ┌──────▼──────┐
│ ia-shim (Rust) │          │ git · gh · tmux ·    │    │ board.db    │
│  └ claude -p   │          │ ssh · bash scripts   │    └─────────────┘
│  └ codex-run   │          └──────────────────────┘
└────────────────┘
```

- **One server process per machine**, as now. Each is a _host_ (its own database, its own agents) and can be a _hub_
  (serves the UI and shows other hosts). The whole server is one Effect program: a tree of layers launched by
  `Layer.launch` under `NodeRuntime.runMain`.
- **Agents still run under `ia-shim`**, carried over unchanged, and still outlive the server. The server follows a
  run's files and writes its input file; it never holds a pipe to an agent. This is the property the rewrite is
  built around: stopping the server interrupts fibers, never agents.
- **The `bin/huntaway` launcher is carried over** (a shell script). It keeps the PID stable across restarts and
  updates, restarts a crashed server with backoff, and execs what the server asks for (exit code 75 and a restart
  file). Node cannot exec, and the desktop app, service managers and scripts all track that PID.
- **Clients hold one RPC session per host.** A session is one websocket carrying Effect RPC. The page's own board is
  reached directly; other hosts are reached through the hub, which relays the socket without reading it
  ([08-hosts.md](08-hosts.md)).
- **Everything a client can do is in one contract package** (`packages/contracts`): schemas for the domain, the RPC
  groups, the few plain HTTP endpoints and the event unions. The server implements it; the web and desktop apps get
  typed calls, queries and mutations from it. Nothing else is shared between server and clients.

## Layers of the server

Imports go down only. A structural test holds the order.

| Layer         | Folder (`apps/server/src/`) | What is in it                                                                                           |
| ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------- |
| Entry         | `bin.ts`, `Main.ts`, `cli/` | The CLI, the composition root that wires every layer, `serve`'s startup order                            |
| Transports    | `rpc/`, `http/`, `mcp/transport/` | RPC handlers, HTTP routes, the MCP endpoints. Decode, call one service method, map errors          |
| Orchestration | `lifecycle/`                | What happens when a task moves, a run ends, a review finishes: the rules that span areas                 |
| Areas         | one folder each             | `tasks`, `threads`, `runs`, `agents`, `git`, `merge`, `review`, `workflows`, `automations`, `github`, `mcp` (board tools), `permissions`, `hosts`, `terminal`, `docs`, `assistant`, `push`, `update`, `desktop`, … |
| Platform      | `platform/`                 | `Db`, `Migrations`, `Events`, `KeyedLock`, `Proc`, `DataDir`, `ServerConfig`, `Secrets`, `Telemetry`     |

An area may use the platform and the areas below it in [06-server.md](06-server.md#dependency-order). Two areas that
need each other meet in `lifecycle/`, which is the only place allowed to know, for example, that a run ending in a
workflow column hands the task to the engine before the merge queue looks at it. In the old server those rules were
in `update_task_inner`, `runner/output.ts` and the engine, each calling back into the others.

## The five patterns

### 1. Decide, commit, publish, reconcile

Every change to the board's state has the same four steps, and each area's main service is built from them.

```
command ──► take the entity's lock ──► load ──► decide (pure) ──► commit (one transaction) ──► publish events
                                                                                             └─► reconcile
```

- **Decide** is a plain function from the current rows and the request to the new rows and a list of events. It does
  no I/O and is where the rules live: what a move to _Ready for merge_ sets, which column a finished run goes to,
  whether a review round goes back to the agent. It is tested as a table of cases with no layer.
- **Commit** writes the rows in one transaction. Nothing waits inside it.
- **Publish** sends the events after the commit, in commit order ([Events](06-server.md#events)).
- **Reconcile** is what follows from the change: start the next merge in a lane, start tasks whose dependencies are
  done, start a review, advance a workflow, tear down a terminal. Each is an idempotent method named `reconcile…`
  that reads the state and does whatever is due. The command calls the reconcilers its change could affect, in a
  fixed order. **Startup calls all of them**, which is how the server recovers from stopping between a commit and what
  should have followed it. The old server has the same weakness and the same cure (`load_active`); here it is the
  design rather than a list of repairs.

### 2. One lock per entity, taken for work that spans a wait

A transaction makes a multi-row change atomic. It cannot cover a git command or a process start. Work on one task
that reads, waits and writes holds that task's lock (`KeyedLock`), so two of them cannot interleave: starting a run,
removing a worktree, restacking, the end of a run. Reads never take it. Order is project, then task, then run, and a
lock is never held while waiting for a person.

This replaces the old server's reliance on "nothing runs between two awaits", which Effect's scheduler does not give
(HA-408 measured the difference). It also replaces the old global mutexes (`STARTING`, `PICKING`,
`project_changes`), which serialised unrelated tasks.

### 3. State that must survive a restart is in the database or the run folder

In-memory state is caches, live connections and fibers. For each one, [06-server.md](06-server.md) says how it is
rebuilt at startup. The follower of a run reads from the byte offset saved with the last line it applied, so output
is applied at least once, and every line handler is safe to repeat. A board tool call is recorded before it runs and
answered before it is marked done, so it runs at most once.

### 4. Fibers belong to scopes, and scopes follow the things they serve

- The server's scope: loops that last as long as the process (pruners, pollers, the scheduler).
- An entity's entry in a `FiberMap`: the follower of a run, the connection of a link, an attached terminal, a wait.
  Starting it again replaces it; deleting the entity interrupts it.
- A request's scope: an RPC stream ends when its client goes away.

Shutdown closes the server's scope: fibers are interrupted, finalizers run, the database closes. Agents carry on.

### 5. Time, randomness, processes and the network are services

`Clock` (through `DateTime.now`, `Effect.sleep`, `Schedule`), `Random`, `ChildProcessSpawner`, `HttpClient`,
`FileSystem` and `Path` come from the environment. Tests give the real database (in memory), the real file system
(in a temp folder) and real git, and replace the clock, the agent CLIs, `gh`, GitHub and other hosts with layers
from `packages/testing`.

## What a request passes through

A browser clicks _Ready for merge_ on a task of a linked host:

1. The component calls `useAtomSet(taskMutations.update)` with `{ id, status: "ready_for_merge" }`.
2. `packages/client` sends `tasks.update` on that host's RPC session. The socket goes to the hub, which relays it to
   the host over its link.
3. On the host, RPC middleware resolves the session (the hub's link, acting for a board user) and checks the method's
   scope. The payload is decoded against the contract.
4. The handler calls `Tasks.update(id, patch)`.
5. `Tasks.update` takes the task's lock, loads it, calls `decideUpdate` (which sets `merging`, the queue position
   and the rest, or fails with `AgentRunning`, `PrNotApproved`…), commits, publishes `task`, then calls
   `Lifecycle.afterTaskChange`, which runs the reconcilers that apply: the merge lane, dependencies, workflows.
6. `Merges.reconcileLane` finds the lane free and starts the merge run through `Runs.start`.
7. The `task` events reach every subscriber of that host's board stream. The client folds them into its atoms and the
   card moves. The mutation's own result is not what redraws it.

## What is deliberately different from the old server

| Old                                                                 | New                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| REST, 183 paths, hand-written client with 224 calls                 | One RPC contract; typed client, queries and mutations derived from it                              |
| `/api/ws` with no replay: a reconnecting client refetches everything | Subscriptions that start with a snapshot or resume from a sequence number                          |
| `s: AppState` passed to 1,157 functions                             | Services with the state they own                                                                   |
| Atomic because nothing awaits                                       | Transactions and per-entity locks                                                                  |
| Follow-ups written out after each write, repaired at startup        | Reconcilers called after a commit and at startup                                                   |
| Thread writes phrased as legacy messages, then translated           | Items written directly; one translator per agent CLI                                               |
| Three wire formats between hosts (HTTP proxy, event socket, tunnel) | One: RPC over a socket, however the socket was made                                                |
| Numeric API version gates                                           | A protocol number checked at hello, named capabilities, additive schemas                           |
| Route allowlist for paired devices                                  | A scope on every RPC, checked by middleware on the host that serves it                             |
| Environment variables as test seams, 142 sleeps in tests            | Layers, and the test clock                                                                         |

What is deliberately the same: the shim and its files, one process and one SQLite file per host, restart in place
under running agents, hosts that keep their own data, the task and thread shapes the components draw, and every
behaviour in [the inventory](inventory/README.md) that this plan does not list as dropped.
