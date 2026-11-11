# 10. Testing and tools

How the port is known to behave like the old board, and the tools agents use while they build it.

## What "the same behaviour" is checked against

There is no old API to compare answers with, because the transport changes. Parity is held by three things that do
not depend on the transport:

1. **The old tests' cases.** The old server has about 53,000 lines of tests beside its modules. Most assert
   behaviour through functions that no longer exist, so the code is not carried, but each test's _case_ is: the
   situation, the action, what must be true after. A task that ports an area lists the old test files it covers
   (they are named after the parts: `agent/runner/queue.test.ts`, `mcp/wait/tests.test.ts`,
   `git/worktree/tests.test.ts`…) and ports their cases onto the new services. A case that is dropped is named in
   the pull request with the reason.
2. **Recorded agent sessions.** The 42 scenarios under `threads/fixtures/` (raw Claude and Codex output with the
   events it must produce) run against the new translators unchanged. They move to `packages/testing/fixtures/`.
3. **The whole-app checks.** The 93 files of `apps/web/tests/ui` drive the built UI in Chromium against a real
   server with a fake agent, finding things by visible text and role. The components are kept, so these run against
   the new server with a new harness under them. They cover drag and drop, the thread, approvals, the Changes tab,
   settings, hosts, notifications and reloads. **The port is ready to switch to when this suite passes.**

## Tiers

| Tier            | Where                                         | Runs                                             | Against                                                                 |
| --------------- | --------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| Pure            | beside the module, `*.test.ts`                | `it(…)`                                          | Decision functions, reducers, translators, parsers, graph rules: tables of cases |
| Service         | beside the service                            | `it.effect` on `TestClock`, `layer(TestBoard)`   | Real SQLite in memory, a real temp folder, real `git`; fake agent CLIs, `gh`, GitHub, other hosts |
| Whole server    | `apps/server/tests/e2e/`                      | `it.live`, one server process per file           | The real launcher and shim, a fake `claude` on `PATH`, the typed RPC client |
| Structure       | `apps/server/tests/structure/`                | reads the sources                                | The rules in [12-conventions.md](12-conventions.md#structural-tests)     |
| Component       | `apps/web/tests/browser/`                     | Vitest browser mode                              | Components on a fake host ([09-frontend.md](09-frontend.md#tests))       |
| Whole app       | `apps/web/tests/ui/`                          | Playwright, a test server per file               | The built UI and a real server with agents off or faked                 |
| Shim            | `rust/shim/tests/`                            | `cargo test`                                     | As now                                                                  |

Rules:

- **No sleeps, no polling loops, no wall-clock assertions** in the pure and service tiers. Wait for what the code
  produces: `Reactor.idle`, an event from `Events`, a `Deferred`, the end of a fiber. Move time with
  `TestClock.adjust`. The old suite sleeps 142 times and shortens constants under a test flag; neither survives.
- **A dependency is replaced with a layer.** No `IN_TEST` flag, no `*_BIN` variable read by the code under test, no
  `when(point)`/`reached(point)` race hooks. A race is tested by controlling the fibers: fork both sides, let one
  reach a `Latch`, then the other.
- **The whole-server tier is for what only a process can show**: a restart under a running agent, the launcher's
  exec-on-75, a crash and its backoff, two hosts linked over real sockets, a webhook over HTTP.
- **Each fixed bug gets a test that fails without the fix**, as now.
- Behaviour checks go in the lowest tier that can show them.

## `packages/testing`

| Module                 | Gives                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `TestBoard`            | A layer of the whole server's services on an in-memory database and a scoped temp data folder, with the clock, agent CLIs, `gh` and other hosts replaced. `TestBoard.with(overrides)` swaps any service |
| `board`                | Builders: `profile()`, `project({ git: true })`, `task()`, `taskWithWork()`, `review()`, `stack()`                  |
| `git`                  | A repository in a temp folder with commits, branches and a bare remote; `squashMerge`                              |
| `fakeAgent`            | A scripted agent for service tests: feed lines to a run's `out.jsonl`, read what was written to its input, end it. Replaces `runner/testing.ts` |
| `fake-claude`          | The program for whole-server tests and test servers: the old `scripts/fake-claude` ported to TypeScript with its prompt markers (`fake-ask-permission`, `fake-board-call …`, `fake-subagent`; and `fake-until-interrupted`, new: a turn that goes on until a stop interrupts it) and knobs. What it must do is inventory 01, section 10 |
| `fakeGh`, `fakeGithub` | `gh` answers and a GraphQL pull request that tests change over time                                                |
| `twoHosts`             | Two `TestBoard`s linked in memory, and the same over real sockets for the whole-server tier                        |
| `fixtures/threads/`    | The recorded sessions                                                                                              |
| `fakeHost` (browser)   | The component checks' fake                                                                                         |

## Tools for agents<a id="tools-for-agents"></a>

The old repository's `CLAUDE.md` tells every agent how to try a change without touching the live board. The same
tools exist from M0, because every later task is built with them.

| Old                              | New                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `scripts/test-server.sh`         | Same name and behaviour: a server from this worktree on a free port with a fresh data folder, `--seed`, `--demo`, `--fake-claude`, `--no-agents`, `restart`, `stop`. It prints and saves `export HUNTAWAY_TEST_URL=…` lines (`_TOKEN`, `_PID`, `_DATA_DIR`, `_ENV`, and with `--seed` `_PROFILE`, `_PROJECT`, `_REPO`) |
| `scripts/ia-api`                 | `huntaway rpc <method> [json]` and `huntaway dev new-task \| start \| send \| task \| thread \| pending \| approve-all \| wait-idle`, with the same exit codes (0, 2 needs attention, 124 timeout) and the same refusal to touch anything but a test server |
| `scripts/ui-check.mjs`           | Carried over: the step language (`goto`, `click`, `type`, `press`, `wait`, `gone`, `shot`…) and the module API are unchanged |
| `scripts/ui-profile.mjs`, `event-loop-probe.mjs` | Carried over, pointed at the new server                                                                         |
| `scripts/copy-live-board.sh`     | Same purpose, one more step: snapshot an old board's database, scrub it as now (paths under `/nonexistent`, no configs, links, automations, PR watches, sign-ins or telemetry), then `import-legacy` it into a `--no-agents` test server. It still refuses any folder `test-server.sh` did not make. Looking at a real board's import without scrubbing is a [rehearsal](11-migration.md#rehearsal), which is read-only |
| `IA_SERVER=… pnpm dev`           | `HUNTAWAY_SERVER=… pnpm dev`                                                                                              |

The rules around them are unchanged and go into the new `CLAUDE.md`: never a fixed port, never the live daemon,
build in the worktree, test agent runs with a cheap model and the default permission mode, look at UI changes in a
browser before finishing.

## Measurements

Taken at the end of M2 and again before the switch, on a scrubbed copy of a live board's data
(`copy-live-board.sh`), and compared with the old server on the same data:

| What                                                        | How                                         | Limit                                   |
| ----------------------------------------------------------- | ------------------------------------------- | --------------------------------------- |
| Memory at idle and with ten runs followed                   | RSS after start; after ten fake runs        | No worse than 1.5× the old server       |
| Time to ready                                               | Start to `HUNTAWAY_READY`                   | Under 2 s on the reference machine      |
| Event-loop delay under a busy agent                         | `event-loop-probe.mjs`                      | p99 no worse than the old server        |
| One line of agent output, read to stored                    | A run of 10,000 lines through the follower  | Within 1.5× the old server              |
| The board snapshot                                          | Bytes and time for `board.watch`'s first message | Recorded; a filter is added if it is slow to open |
| A hook's start                                              | `approval-hook` wall time                   | Under 60 ms                             |
| `pnpm check`, `pnpm test`                                   | Wall time                                   | Recorded per milestone                  |

Schema decoding is the cost Effect adds on the hot path. If the follower misses its limit, its line schemas are
decoded with precompiled decoders and the per-line span is dropped (`Effect.fnUntraced`), before anything else is
tried.

As measured at M2 (HE-4), the follower: 10,000 Claude `assistant` text lines (`flood-claude`) through the real
ia-shim and the server's follower, from the first line written to the last item stored, on a test server seeded with
2,848 tasks and left 20 s to settle; the old server measured the same way on the same day. The first M2 run had new
9,216 ms against old 875 ms (10.5×) on a busier machine; the table is one day's machine, medians of 3 to 7 runs.
"CPU / line" is the server's user and system time from the task's creation to the last item, over 10,000.

| Server                                                                                      | 10,000 lines | CPU / line | SQL / line |
| ------------------------------------------------------------------------------------------- | ------------ | ---------- | ---------- |
| Before (HE-4 at 2b43633)                                                                    | 5,880 ms     | 0.64 ms    | 23.0       |
| Precompiled row decoders, no per-line span                                                  | 5,450 ms     |            | 23.0       |
| No task read per write, background synced on real turn starts only, no `startTurn` per line | ~2,000 ms¹   |            | 13.0       |
| `agent_at` with the offset, one statement for a thread's numbers, tracer off                | 1,670 ms     | 0.20 ms    | 10.0       |
| Up to 64 lines to a transaction, synchronous row decoding (now)                             | 770 ms       | 0.098 ms   | 6.1        |
| Old server                                                                                  | 653 ms       | 0.072 ms   | 20         |

¹ With the SQL statements counted, which slows it a little. The old server's statements are the first M2 run's count.

1.18× the old server's time (limit 1.5×). Less the wait for the follower's first poll (up to `FOLLOW_POLL`, 200 ms,
whichever server), 736 ms against 622 ms. The profile of what is left: the Effect runtime about a third, node:sqlite
a fifth, schema decoding and encoding a tenth, GC 7%; the follower's design is in
[07-agents.md](07-agents.md#the-follower-after-the-m2-measurement-he-4).

The other M2 measurements (HE-4), on an i9-13900K (32 threads, 62 GiB, Linux, Node 26.13) shared with a live board, both
servers on the same synthetic data made through their own APIs (3 projects, 2,848 tasks; no scrubbed live copy until the
importer, M9), the old one at `f2298f0c` through its own `test-server.sh`, the same fake agent for both, medians:

| What                                                   | New                 | Old                 | New/old | Limit   |
| ------------------------------------------------------ | ------------------- | ------------------- | ------- | ------- |
| RSS at idle: empty board / 2,908 tasks                 | 150 / 150 MB        | 113 / 132 MB        | 1.33× / 1.13× | ≤ 1.5× |
| RSS with ten runs live / 10 s after they ended         | 162 / 163 MB        | 131 / 133 MB        | 1.23×   | ≤ 1.5×  |
| Start to `HUNTAWAY_READY`: fresh / 2,908 tasks         | 526 / 556 ms        | 315 / 341 ms        | 1.7×    | < 2 s   |
| `/api/health` p99 while 10,000 lines arrive at once    | 1.3 ms              | 935 ms              |         | ≤ old   |
| `/api/health` p99, ~485 assistant lines/s              | 1.3 ms              | 10.1 ms             | 0.13×   | ≤ old   |
| Board's first message (snapshot; old: its 15 loads)    | 154 ms, 5.5 MB      | 65 ms, 5.7 MB       | 2.4×    | recorded |
| `approval-hook`, cold / warm compile cache             | 56 / 30 ms          | 50 / 25 ms          |         | < 60 ms |
| `pnpm check` / `pnpm test`                             | 4.2 s / 7.0 s       |                     |         | recorded |

The probe is `scripts/event-loop-probe.mjs`. The memory and event-loop figures were taken before the follower's changes
above, which lower the CPU per line; they were not taken again.
