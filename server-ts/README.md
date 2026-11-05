# server-ts: the server (HA-174)

The `huntaway` server, in TypeScript. It's a port of the Rust server (`server/src/`), which it replaced and which was
removed in HA-179 (`PORTING.md` says how to read that Rust in git history). Releases carry it (see *Release builds* in
the top README): `scripts/package-server.sh` packages it with the Node that runs it, `ia-shim` and the UI, for the
server tarball and the desktop app. Checkouts run it too: test servers (`scripts/test-server.sh`), the install script,
the desktop app (`npm run electron`) and Rebuild & restart. It runs on Node 24+ straight from the `.ts` files (Node
strips the types; there's no build step), with `node:sqlite` for the database and `ws` for websockets as its only
dependency. A release's package carries it compiled to `.js` (`tsconfig.build.json`), which saves the server Node's
TypeScript compiler (see *Memory*).

```sh
cd server-ts && npm ci
bin/huntaway serve --port 7979 --data-dir /tmp/board-ts   # the same flags and subcommands as the Rust binary had
npm run typecheck && npm test                              # tsc, and the unit tests
```

It runs agents with the Rust `ia-shim` (`$IA_SHIM_BIN`, else the newer of `server/target/{release,debug}/ia-shim`, else
`ia-shim` beside `bin/huntaway`), so build that with `cargo build -p ia-shim` in `server/` first. `bin/issue-agent` is
the same command under the board's name from before the rename (see the top README), and release packages have it too.
`scripts/test-server.sh` runs `bin/huntaway`, and `IA_TEST_BIN` runs another build instead (as `scripts/ram-compare.mjs`
does for a Rust release's server):

```sh
scripts/test-server.sh --demo > $TMPDIR/ts-env
cd app && npm run test:ui                                   # the browser checks
```

## Scope

Everything a single machine's board does is ported: the API, the database and its migrations, live events, agent runs
(Claude and Codex) and their thread output, the board's MCP tools and the gh MCP server, permission prompts, worktrees,
checkpoints and the git views, reviews, automations, status scripts, terminals, hub links (`--hub`, hosts added by URL)
and Web Push, restarting, rebuilding from a checkout (the UI, `npm ci` when `server-ts`'s lockfile changed, and the Rust
`ia-shim`) and release updates (downloaded into `<data dir>/app/`, Update and Roll back onto a release, which may be one
that runs the Rust server: 0.3.x and earlier, which `backup.ts`'s backup on a version change makes safe to go back to),
SSH hosts (`ssh-host`, and hosts added over SSH) and the broker (`--broker`: the legacy relay, and managed tunnels with
cloudflared). An SSH target runs `bin/huntaway ssh-host` from its `authorized_keys`: `bin/huntaway` finds `node` on the
PATH, in the usual install folders, or at `$IA_NODE`. `PORTING.md` has the conventions the port follows (one TS file per
Rust file, Rust's names).

Restarts: the Rust server exec'd (itself, a rebuild or a release), which keeps its process id, arguments and environment.
Node can't, so `bin/huntaway` (a shell) runs `node` as its child for `serve`: to restart, the server writes what to exec
to the file the wrapper named in `IA_RESTART_FILE` and exits with 75, and the wrapper execs it as the same process (see
`update/admin.ts`'s `exec`). TERM, INT and HUP to the wrapper stop node; node stops by itself if the wrapper is killed.

Crashes (HA-182): a panic in a Rust task ended that task, and the server carried on. Here, a promise that rejects with
nothing to handle it, or a throw in a timer or an event's listener, is logged to the server log with its stack and the
server carries on (`src/crash.ts` says why uncaught exceptions are carried on from too). Every promise the server makes is
awaited, `.catch`ed or run with `util.ts`'s `background`, which logs what it throws; `tests/floating_promises.test.ts`
checks that with the TypeScript compiler (there's no ESLint). If node exits with an error anyway once it's up (or
aborts, as it does when it runs out of memory), `bin/huntaway` starts it again as the same process, after 1, 2, 4, 8 and
16 seconds, then gives up (see its comments). `IA_DEBUG_FAULTS=1` adds `POST /api/debug/fault {"kind": "reject" |
"throw" | "loop" | "exit"}`, which makes the server fail on purpose, to try that.

Tests: every Rust test that applied was ported (737 TS tests: `src/**/*.test.ts` beside their modules, and
`tests/` for the Rust server's `server/tests/`). Not ported: `state.rs`'s two tests of the database lock, which the TS server doesn't have,
and `testing.rs`'s tests of the cargo test harness. All 220 browser checks in `app/tests/ui/` pass against it. The broker
tests run the Rust broker's `test_broker` example (`cargo build -p huntaway-broker --example test_broker`).

## Memory

`node scripts/ram-compare.mjs [--live]` starts a test server of each on the same data, then reads their memory as they
load every task's thread through the API with three UI websockets open. `TS_BIN=<dir>/huntaway` measures a release's
package (what `scripts/package-server.sh <dir>` puts together) rather than this checkout's `.ts`. On 2026-11-05, with a
release build of the Rust server and a package of the TS server on Node 26.8, on a scrubbed copy of the live board
(`--live`: 1,631 tasks, 286,590 messages, 680 MB of thread JSON):

| | Rust | TypeScript | TypeScript before HA-181 |
|---|---|---|---|
| Idle after start (RSS) | 38 MB | 111 MB | 172 MB |
| After loading every thread once | 331 MB | 198 MB (peak 236 MB) | 310 MB (peak 347 MB) |
| After 5 rounds of that | 436 MB | 182 MB (peak 246 MB) | 322 MB (peak 414 MB) |
| 10 s later, websockets closed | 437 MB | 173 MB | 321 MB |
| A minute later | 437 MB | 98 MB | |
| Each agent's `huntaway mcp` helper | 9 MB | none since HA-180 | 87 MB |
| Each agent's `huntaway gh-mcp` helper | 7 MB | none since HA-180 | 90 MB |

On the `--demo` data, idle is 20 MB against 85 MB (128 MB before), and loading the board keeps them at about 26 MB and
87 MB. A checkout's `.ts` (test servers, `bin/huntaway` in `server-ts/`) idles at 132 MB on the live copy: Node's
TypeScript compiler, below.

The Rust server's figures vary by 10 to 20% from run to run, the TS server's by a few MB.

- At rest, Node costs about 70 MB more: its runtime and heap, and the server's code. About 45 MB of that is any Node
  process's, most of it the pages of the `node` binary.
- Under load the TS server stays lower. The Rust server's RSS keeps growing over the rounds because glibc's malloc keeps
  freed memory in its per-thread arenas: with `MALLOC_ARENA_MAX=2` the same run ends at 166 MB rather than 421 MB.
- Before HA-180 each agent run started its own `mcp` and `gh-mcp` helpers, so the TS port cost about 160 MB more per
  running agent: with ten agents at work, 1.6 GB more than the Rust helpers' 160 MB.
- Since HA-180 runs have no helpers: the server serves both MCP servers itself, over HTTP (see `src/mcp/http.ts` and
  *How runs reach the board's MCP servers* in the top README). Measured before choosing (Node 26.8, one helper after
  `initialize` and `tools/list`, RSS / private memory):

  | | RSS | Private |
  |---|---|---|
  | `mcp.ts` as it ran (type stripping) | 89 MB | 37 MB |
  | the same, precompiled to `.js` | 59 MB | 16 MB |
  | `.js` with `--jitless --max-semi-space-size=1 --max-old-space-size=32` | 52 MB | 12 MB |
  | `--lite-mode` | 51 MB | – |
  | Node's floor (`node -e` reading stdin, `--jitless`) | 45 MB | 9 MB |

  So lighter Node helpers would still have cost 90–100 MB of RSS per agent. With five agents at once on a test server,
  each agent's processes came to 424 MB RSS (242 MB PSS, of which its helpers were 187 MB RSS and 87 MB PSS) before and
  239 MB RSS (159 MB PSS) after; the server's own RSS stayed about the same (145 MB before, 123 MB after, with their
  five calls open).

### What HA-181 changed

Where the 172 MB of an idle server went (`process.memoryUsage()`, a heap snapshot and `/proc/<pid>/smaps`): about 60 MB
was the `node` binary's pages, 74 MB V8's heap, of which a full GC left 32 MB live, and 40 MB malloc'd outside it. Of
what was live, about 23 MB was the server's code (126 modules, 1.5 MB of JavaScript) and Node's own, and 9 MB Node's
TypeScript compiler.

- **Precompiled `.js` in packages** (`scripts/package-server.sh`, `tsconfig.build.json`): run as `.ts`, every process
  loads Node's type stripper (amaro: swc as WebAssembly), about 20 MB of RSS each (as the helpers did before HA-180). A
  checkout still runs the `.ts`, as tests and test servers do.
- **A small young generation** (`--max-semi-space-size=2`, set by `bin/huntaway`): V8 lets the young generation grow to
  two 16 MB semi-spaces as the server starts, and an idle server then allocates too little to collect them, so it kept
  20 to 30 MB of garbage. With 2 MB ones its heap is collected, and V8's memory reducer gives back what a burst of
  load left about 30 s after it ends.
- **A 1 GB old-space limit** (`--max-old-space-size=1024`; V8's default here is about 4 GB): under a lower limit V8 grows
  the heap less eagerly, so loading every thread peaks at about 240 MB rather than 340 to 380 MB. The largest thread on
  the live board is 12 MB of JSON, and a server that does run out aborts, which `bin/huntaway` starts again (HA-182).
  Together with the young generation, loading every thread 5 times takes about 10% longer (15.5 s rather than 14.2 s).
- **A fixed malloc mmap threshold** (`MALLOC_MMAP_THRESHOLD_=131072`, which `bin/huntaway` gives node alone and
  `main.ts` takes out of what agents and git inherit): glibc serves blocks above its threshold with mappings of their
  own, which go back to the system when freed, but raises the threshold (up to 32 MB) as they're freed, so the large
  response bodies and query results that follow come from its heap, which kept 50 to 100 MB after a burst of load.
- **A full GC after a burst** (`src/memory.ts`, with `--expose-gc`): the garbage a burst of requests leaves holds on
  to malloc'd memory too, which only a full GC frees. V8's memory reducer has one once the heap is quiet, but not
  reliably: a minute after the same load, a server was back at 105 MB in some runs and still at 180 MB in others. Now a
  server whose RSS grew by 32 MB since its last full GC has one within 30 s, and is back at about 100 MB every time.
- `demo.ts` loads only for `--demo`.

### Over hours

A 2-hour soak of a package on the live copy (HA-181, before merging HA-180 and HA-183), with fake agents (a `claude` stand-in that streams text deltas,
tool calls and six turns a run) and a driver that kept up to 3 runs going, opened a UI websocket every few seconds and
held each for 2 to 60 s, loaded a random task's thread every 2 s and every thread every 15 minutes, and deleted each task
past 200 messages for a new one: 699 runs, 1.2 million streamed deltas, 1,151 websockets, 52 tasks made and deleted.

- RSS stayed level: its median was 119, 125, 123 and 127 MB in each half hour (peaks of 144 to 172 MB during the
  rounds of every thread; 276 MB at most), and it was back to 105 MB a minute after the load stopped (110 MB at the
  start).
- The heap after a full GC went from 20 MB at the start to 22.3 MB after 30 minutes, then 22.5, 23.0 and 22.2 MB: what
  it gained is compiled code, not data. Open files (25 to 34) and threads (11) stayed level.
- Nothing in the code read for it (listeners on `s.events` and `hub_events`, Maps keyed by task, run or call, timers)
  outlives what it's for: the websocket handlers unsubscribe on close, and per-task and per-run entries go when the run
  ends or the task is deleted.
- After merging HA-180 and HA-183 (MCP over HTTP, worker threads, a statement cache) and with the full GC after a burst,
  a second soak of 1 h 50 min (654 runs, 1.1 million deltas, 1,057 websockets, 54 tasks made and 48 deleted) had RSS
  medians of 118, 124, 125 and 129 MB per half hour, and was back to 107 MB a minute after it (112 MB at the start). The
  heap after a full GC went 20.5, 22.8, 23.0, 23.5 and 22.7 MB, of which 2.6 MB more was compiled code. Open files and
  threads stayed level.
- For reference, the live 0.4.0 server (before these changes) was at 171 to 274 MB over 2.5 hours of the user's own
  work (2 to 4.5 hours after it started), with no upward trend.

Tried and left out:

- Lazy imports for the rarely used parts: all the server's modules cost about 8 MB of heap over a bare Node, and the
  rarely used ones (broker, SSH, push, release updates, Codex, `gh-mcp`) are 18% of the code, so 1 to 2 MB at most;
  most have several static importers (`gh_mcp.ts` 19, `update/admin.ts` 8).
- SQLite's `cache_size`: the server keeps one connection, and its default page cache is 2 MB.
- `--optimize-for-size`: Node doesn't take it in `NODE_OPTIONS`, and the flags above already do what it's for here.

## The event loop (HA-183)

The Rust server answered requests on several threads. This one does everything on one: `node:sqlite` is synchronous,
and so are JSON parsing and file walks with `*Sync` calls, so while one request runs, every other request, websocket and
agent's output waits. `src/lag.ts` measures how long:

- `GET /api/debug/event-loop` gives `monitorEventLoopDelay`'s histogram (`delay_ms`), each API route's time on the thread
  (its handler's synchronous part and its JSON; the most and the slowest request's path), and the latest stalls.
  `?reset=1` starts them again.
- A stall over `IA_LAG_LOG_MS` (default 250; 0 for none) is logged to the server log, with the request that ran:
  `the event loop was blocked for 740 ms (GET /profiles/{id}/disk-usage /profiles/…)`.

`node scripts/event-loop-probe.mjs --env <test-server env>` runs the board's heavy reads one at a time (every profile's
and big project's task lists, analytics, context and token stats over a week and a year, disk usage, the longest threads
whole and as the UI's first page, their context and checkpoints) while it fetches `/api/health` and pings a UI websocket
every 5 ms, and prints how long each took, its time on the server's thread, and how late the health check and the ping
were answered meanwhile. It works on an older build too, without the thread times. Other requests can be given instead
(`GET` paths).

Measured on 2026-11-05 with Node 26.8 on a fast desktop, on a scrubbed copy of the live board (`copy-live-board.sh`:
1,642 tasks, 887 MB of database), master's build against this one. "Held" is the longest the health check and the
websocket ping waited.

| | Held before | Held after |
|---|---|---|
| Disk usage, the live board's own folders (17 projects, read only) | 3.7–5.9 s | 3 ms (the walk takes as long, in a worker) |
| Disk usage, a test project with an 88,000-file worktree | 166 ms | 2 ms (the request: 170 ms before, 300 ms after) |
| Backup before an Update or Roll back (`VACUUM INTO`, 880 MB) | 0.7 s | 3 ms (as long, in a worker) |
| Token stats, a year (3,600 runs, 1,550 reviews) | 116 ms | 51 ms |
| Token stats, a week | 70 ms | 33 ms |
| The longest thread's first page (4,586 messages, 13.6 MB) | 67 ms | 53 ms |
| The same thread whole (legacy clients) | 61 ms | 65 ms |
| Analytics, a year | 38 ms | 32 ms |
| A profile's task list (4.4 MB) | 19 ms | 22 ms |
| The git views (status, diffs, unmerged, turns) on a 258-file change | under 10 ms | the same |

What changed:

- **Disk usage** walks the folders in a worker thread (`src/worker.ts`: a module's function run on a thread made for it,
  which ends when it's done; none is kept, as each costs a V8 heap). Starting one adds about 130 ms to the request.
- **The backup before switching releases** is made in a worker, on a connection of its own to the database file, which
  sees what the server has committed (the WAL included). The backup when a new version starts is made before the
  server listens, so nothing waits for it but the start.
- **Prepared statements are cached** per connection (the latest 500, by their SQL) by `db.ts`'s `one`, `all`, `value`
  and `run`, which prepared each query anew: the token report ran 10,000 small queries and spent half its time
  preparing them. It also looks each task's parent up once rather than once per run.
- **A thread's first page** matches the messages against its subagents' calls with one pattern rather than one search
  per call (the longest live thread has 136).

What was measured and left alone, as it stays well under 100 ms: thread loads (the UI loads pages since API 56, and a
page holds about a megabyte at most; a whole 13 MB thread's JSON is 30 ms to read and 25 ms to write), the task lists,
analytics and context stats, and the git views and checkpoints (git runs as a child process, asynchronously). Counting a
finished run's tokens parses its `out.jsonl` (47–77 ms for the three biggest live ones, 21–25 MB), once per run as it
ends; after a restart, the runs that ended meanwhile are counted together. Moving a project's folder copies its
threads' transcripts synchronously. The live board's indexes covered every query that was looked at.
