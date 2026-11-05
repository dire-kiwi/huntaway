# server-ts: the server (HA-174)

The `huntaway` server, in TypeScript: a port of the Rust server (`server/src/`, which is being removed: make server
changes here). Releases carry it (see *Release builds* in the top README): `scripts/package-server.sh` packages it with
the Node that runs it, `ia-shim` and the UI, for the server tarball and the desktop app. Checkouts run it too: test
servers (`scripts/test-server.sh`), the install script, the desktop app (`npm run electron`) and Rebuild & restart. It
runs on Node 24+ straight from the `.ts` files (Node strips the types; there's no build step), with `node:sqlite` for
the database and `ws` for websockets as its only dependency.

```sh
cd server-ts && npm ci
bin/huntaway serve --port 7979 --data-dir /tmp/board-ts   # the same flags and subcommands as the Rust binary
npm run typecheck && npm test                              # tsc, and the unit tests
```

It runs agents with the Rust `ia-shim` (`$IA_SHIM_BIN`, else the newer of `server/target/{release,debug}/ia-shim`, else
`ia-shim` beside `bin/huntaway`), so build that with `cargo build -p ia-shim` in `server/` first. `bin/issue-agent` is
the same command under the board's name from before the rename (see the top README), and release packages have it too.
`scripts/test-server.sh` runs `bin/huntaway`, and `IA_TEST_BIN` runs another build instead (as `scripts/ram-compare.mjs`
does for the Rust server):

```sh
scripts/test-server.sh --demo > $TMPDIR/ts-env
cd app && npm run test:ui                                   # the browser checks
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

Tests: every Rust test that applies is ported (737 TS tests: `src/**/*.test.ts` beside their modules, and
`tests/` for `server/tests/`). Not ported: `state.rs`'s two tests of the database lock, which the TS server doesn't have,
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
| Each agent's `huntaway mcp` helper | 9 MB | 87 MB |
| Each agent's `huntaway gh-mcp` helper | 7 MB | 90 MB |

On the `--demo` data, idle is 20 MB against 128 MB, and loading the board keeps them at about 26 MB and 133 MB.

- At rest, Node costs about 130 MB more: its runtime and heap, and the compiled server code.
- Under load the two are close. The Rust server's RSS keeps growing over the rounds because glibc's malloc keeps freed
  memory in its per-thread arenas: with `MALLOC_ARENA_MAX=2` the same run ends at 166 MB rather than 421 MB (the TS
  server's single thread isn't affected: 322 MB).
- Each agent run starts its own `mcp` and `gh-mcp` helpers, so the TS port also costs about 160 MB more per running
  agent: with ten agents at work, that's 1.6 GB more than the Rust helpers' 160 MB.
