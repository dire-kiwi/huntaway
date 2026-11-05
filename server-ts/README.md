# server-ts: the server (HA-174)

The `huntaway` server, in TypeScript. It's a port of the Rust server (`server/src/`), which it replaced and which was
removed in HA-179 (`PORTING.md` says how to read that Rust in git history). Releases carry it (see *Release builds* in
the top README): `scripts/package-server.sh` packages it with the Node that runs it, `ia-shim` and the UI, for the
server tarball and the desktop app. Checkouts run it too: test servers (`scripts/test-server.sh`), the install script,
the desktop app (`npm run electron`) and Rebuild & restart. It runs on Node 24+ straight from the `.ts` files (Node
strips the types; there's no build step), with `node:sqlite` for the database and `ws` for websockets as its only
dependency.

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
load every task's thread through the API with three UI websockets open. On 2026-11-05, with a release build of the Rust
server and Node 26.8, on a scrubbed copy of the live board (`--live`: 1,568 tasks, 280,788 messages, 668 MB of thread
JSON):

| | Rust | TypeScript |
|---|---|---|
| Idle after start (RSS) | 38 MB | 172 MB |
| After loading every thread once | 279 MB | 310 MB (peak 347 MB) |
| After 5 rounds of that | 421 MB | 322 MB (peak 414 MB) |
| 10 s later, websockets closed | 421 MB | 321 MB |
| Each agent's `huntaway mcp` helper | 9 MB | 87 MB (none since HA-180) |
| Each agent's `huntaway gh-mcp` helper | 7 MB | 90 MB (none since HA-180) |

On the `--demo` data, idle is 20 MB against 128 MB, and loading the board keeps them at about 26 MB and 133 MB.

- At rest, Node costs about 130 MB more: its runtime and heap, and the compiled server code.
- Under load the two are close. The Rust server's RSS keeps growing over the rounds because glibc's malloc keeps freed
  memory in its per-thread arenas: with `MALLOC_ARENA_MAX=2` the same run ends at 166 MB rather than 421 MB (the TS
  server's single thread isn't affected: 322 MB).
- Each agent run starts its own `mcp` and `gh-mcp` helpers, so the TS port also costs about 160 MB more per running
  agent: with ten agents at work, that's 1.6 GB more than the Rust helpers' 160 MB.
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
