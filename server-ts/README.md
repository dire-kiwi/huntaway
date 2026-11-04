# server-ts: the server in TypeScript (HA-174)

A port of the `huntaway` server (`server/src/`, Rust) to TypeScript, made to compare their memory use. It isn't used by
the desktop app, the install script or deployments. It runs on Node 24+ straight from the `.ts` files (Node strips the
types; there's no build step), with `node:sqlite` for the database and `ws` for websockets as its only dependency.

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
and Web Push. These are thin: SSH hosts and the broker answer that they aren't supported, and so do restarting, updating
from a checkout and updating onto a release (Node can't replace its own process as the Rust server does); release
checks report as before. `PORTING.md` has the conventions the port follows (one TS file per Rust file, Rust's names).

Tests: 657 unit tests ported from the Rust server's 745 (the rest are the broker's, release downloads', SSH's and a few that
need a linked host), and all 220 browser checks in `app/tests/ui/` pass against it.

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
