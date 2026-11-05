# server-ts: the server in TypeScript (HA-174)

A port of the `huntaway` server (`server/src/`, Rust) to TypeScript, made to compare their memory use. Releases carry
it in place of the Rust server (see *Release builds* in the top README): `scripts/package-server.sh` packages it with
the Node that runs it, `ia-shim` and the UI, for the server tarball and the desktop app. Checkouts, the install script and
test servers still run the Rust server unless told otherwise (`IA_TEST_BIN`). A checkout runs on Node 24+ straight from
the `.ts` files (Node strips the types; there's no build step), with `node:sqlite` for the database and `ws` for websockets
as its only dependency. A release's package carries it compiled to `.js` (`tsconfig.build.json`), which saves every
process Node's TypeScript compiler (see *Memory*).

```sh
cd server-ts && npm ci
bin/huntaway serve --port 7979 --data-dir /tmp/board-ts   # the same flags and subcommands as the Rust binary
npm run typecheck && npm test                              # tsc, and the unit tests ported from the Rust ones
```

It runs agents with the Rust `ia-shim` (`$IA_SHIM_BIN`, else `server/target/{release,debug}/ia-shim`), so build that with
`cargo build` in `server/` first. Any script that runs the Rust server takes it through `IA_TEST_BIN`:

```sh
IA_TEST_BIN=$PWD/server-ts/bin/huntaway scripts/test-server.sh --demo > $TMPDIR/ts-env
cd app && IA_TEST_BIN=$PWD/../server-ts/bin/huntaway npm run test:ui     # the browser checks, against the TS server
```

## Scope

Everything a single machine's board does is ported: the API, the database and its migrations, live events, agent runs
(Claude and Codex) and their thread output, the board's MCP tools and the gh MCP server, permission prompts, worktrees,
checkpoints and the git views, reviews, automations, status scripts, terminals, hub links (`--hub`, hosts added by URL)
and Web Push, restarting, rebuilding from a checkout (the UI, `npm ci` when `server-ts`'s lockfile changed, and the Rust
`ia-shim`) and release updates (downloaded into `<data dir>/app/`, Update and Roll back onto a release, which is the Rust
server), SSH hosts (`ssh-host`, and hosts added over SSH) and the broker (`--broker`: the legacy relay, and managed
tunnels with cloudflared). An SSH target runs `bin/huntaway ssh-host` from its `authorized_keys`: `bin/huntaway` finds `node` on
the PATH, in the usual install folders, or at `$IA_NODE`. `PORTING.md` has the conventions the port follows
(one TS file per Rust file, Rust's names).

Restarts: the Rust server execs (itself, a rebuild or a release), which keeps its process id, arguments and environment.
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

Tests: every Rust test that applies is ported (737 TS tests: `src/**/*.test.ts` beside their modules, and
`tests/` for `server/tests/`). Not ported: `state.rs`'s two tests of the database lock, which the TS server doesn't have,
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
| Idle after start (RSS) | 38 MB | 108 MB | 172 MB |
| After loading every thread once | 264 MB | 176 MB (peak 242 MB) | 310 MB (peak 347 MB) |
| After 5 rounds of that | 481 MB | 172 MB (peak 242 MB) | 322 MB (peak 414 MB) |
| 10 s later, websockets closed | 444 MB | 172 MB | 321 MB |
| A minute later | 444 MB | 104 MB | |
| Each agent's `huntaway mcp` helper | 9 MB | 55 MB | 87 MB |
| Each agent's `huntaway gh-mcp` helper | 7 MB | 56 MB | 90 MB |

On the `--demo` data, idle is 20 MB against 85 MB (128 MB before), and loading the board keeps them at about 26 MB and
87 MB. A checkout's `.ts` (test servers, `bin/huntaway` in `server-ts/`) idles at 132 MB on the live copy, and its
helpers at 78 and 80 MB: Node's TypeScript compiler, below.

- At rest, Node costs about 70 MB more: its runtime and heap, and the server's code. About 45 MB of that is any Node
  process's (most of it the pages of the `node` binary, which a package's processes share), which is also most of each
  helper's.
- Under load the TS server stays lower. The Rust server's RSS keeps growing over the rounds because glibc's malloc keeps
  freed memory in its per-thread arenas: with `MALLOC_ARENA_MAX=2` the same run ends at 166 MB rather than 421 MB.
- Each agent run starts its own `mcp` and `gh-mcp` helpers, so the TS port also costs about 95 MB more per running
  agent than the Rust helpers' 16 MB (less in PSS, as they share Node's pages).

### What HA-181 changed

Where the 172 MB of an idle server went (`process.memoryUsage()`, a heap snapshot and `/proc/<pid>/smaps`): about 60 MB
was the `node` binary's pages, 74 MB V8's heap, of which a full GC left 32 MB live, and 40 MB malloc'd outside it. Of
what was live, about 23 MB was the server's code (126 modules, 1.5 MB of JavaScript) and Node's own, and 9 MB Node's
TypeScript compiler.

- **Precompiled `.js` in packages** (`scripts/package-server.sh`, `tsconfig.build.json`): run as `.ts`, every process
  loads Node's type stripper (amaro: swc as WebAssembly), about 20 MB of RSS each, the helpers included. A checkout still
  runs the `.ts`, as tests and test servers do.
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
- `demo.ts` loads only for `--demo`.

Tried and left out:

- Lazy imports for the rarely used parts: all the server's modules cost about 8 MB of heap over a bare Node, and the
  rarely used ones (broker, SSH, push, release updates, Codex, `gh-mcp`) are 18% of the code, so 1 to 2 MB at most;
  most have several static importers (`gh_mcp.ts` 19, `update/admin.ts` 8).
- SQLite's `cache_size`: the server keeps one connection, and its default page cache is 2 MB.
- `--optimize-for-size`: Node doesn't take it in `NODE_OPTIONS`, and the flags above already do what it's for here.
