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
| `fake-claude`          | The program for whole-server tests and test servers: the old `scripts/fake-claude` ported to TypeScript with its prompt markers (`fake-ask-permission`, `fake-board-call …`, `fake-subagent`; and `fake-until-interrupted`, new: a turn that goes on until a stop interrupts it; `fake-skill-fork`, HE-8: a forked skill, `/code-review`, as a `local_agent` subagent whose Bash call asks first) and knobs. What it must do is inventory 01, section 10. As a reviewer (4.6, new): a review run calls `submit_review` with `pass`, or `needs_fixes` every round when the task's description (which the review prompt quotes) says `fake-review-fixes`, or on a first round only with `fake-review-fixes-once` (a round that re-checks issues passes); a run whose prompt says `fake-commit` (a task's first, which quotes its description) or that is sent a review's issues ("Fix them, then commit") makes an empty commit, so the next round has new work. A task described `fake-commit fake-review-fixes-once` goes To do → In progress → In review → a round of fixes → In review, passed, summarised |
| `fakeGh`, `fakeGithub` | `gh` answers and a GraphQL pull request that tests change over time. As built (4.4): `fakeGitHub(state)` and `fakePull` over `bin/fake-gh` (its state, a JSON file a test sets and reads back, is documented there); `test-server.sh --fake-gh` |
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
| The import (9.1)                                            | `import-legacy --check`: wall time, peak RSS | Recorded                               |

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

### As measured before the switch (HE-8, 9.2)

On 12 November 2026, at `b05a54f` (9.1's last commit) with 9.2's scripts, on the same i9-13900K (32 threads, 62 GiB,
Linux 7.2, Node 26.13) shared with the live board and other agents' work: the load average ran from 1 to 48 over the
day, so each pair was taken alternately, new then old, and the table's rows at a load of 1 to 6 unless said. 60 GB of
swap was in use: RSS is read with `VmSwap` beside it, which was 0 for every figure here (the old test server had 43 MB
swapped out after an idle hour, so it was restarted before it was measured).

The data: the old test server (`f2298f0c`, its own `test-server.sh --seed --fake-claude`) seeded through its REST API
with 3 projects and 2,848 tasks over the columns and 60 fake-claude runs (480 thread items; a 4.4 MB database), and the
new server on a scrubbed copy of it (`copy-live-board.sh`: `import-legacy --check`, 0 failures, 0 problems), so the
same tasks on both. For the runs, a second old test server seeded by the same script (the first one's agent is the
plain fake), and the new copy with its three projects pointed (`projects.update`) at clones of the old server's
repositories, which the scrub moves under `/nonexistent`. The agent for both is `scripts/fake-claude-flood.mjs`, which
runs each server's own fake claude and, when armed, turns its reply into N assistant text lines, each its own message
and each with the same `usage` (as Claude Code's lines carry; the old fake's carry none, the new one's a token each).
`scripts/measure-vs-old.mjs` takes the figures, on either server: RSS of the server's node; start to ready (the
launcher's start in `/proc` to the time on the log line before the ready line); `/api/health` every 5 ms; the old
client's loads as `store.ts` makes them; one flood (first line written to the last line's item seen in the database,
read-only, and the server's CPU meanwhile); ten runs at once. Medians, with the number of runs.

| What                                                                  | New                     | Old                 | New/old       | Limit    | Within  |
| --------------------------------------------------------------------- | ----------------------- | ------------------- | ------------- | -------- | ------- |
| RSS at idle, 20 s after ready: empty board (5) / 2,848 tasks (5)      | 167 / 190 MB            | 116 / 138 MB        | 1.44× / 1.38× | ≤ 1.5×   | yes     |
| RSS, ten runs live / 10 s after they ended (6 × ten runs)             | 275 / 281 MB            | 142 / 134 MB        | 1.93× / 2.10× | ≤ 1.5×   | **no**  |
| … 60 s after they ended (3)                                           | 214 MB                  | 131 MB              | 1.63×         | ≤ 1.5×   | **no**  |
| Start to `HUNTAWAY_READY` / `IA_READY`: fresh (5) / 2,848 tasks (5)   | 855 / 1,303 ms          | 353 / 368 ms        | 2.4× / 3.5×   | < 2 s    | yes     |
| `/api/health` p99 while 10,000 lines arrive at once (3)               | 6.7 ms                  | 1,112 ms            | 0.006×        | ≤ old    | yes     |
| `/api/health` p99 at ~483 lines/s (5,000 lines, 3)                    | 3.5 ms                  | 11.1 ms             | 0.32×         | ≤ old    | yes     |
| Follower: 10,000 lines, first written to last stored (5)              | 3,165 ms                | 982 ms              | **3.2×**      | ≤ 1.5×   | **no**  |
| … CPU per line / SQL statements per line                              | 0.39 ms / 8.1           | 0.106 ms            | 3.7×          |          |         |
| … the same lines without `usage` (4)                                  | 1,333 ms, 0.18 ms / 6.1 | 720 ms, 0.08 ms     | **1.85×**     | ≤ 1.5×   | **no**  |
| Follower after the context meter's fix, alternating with the old (7)  | 1,417 ms, 0.17 ms       | 920 ms, 0.12 ms     | **1.54×**     | ≤ 1.5×   | at it   |
| Board's first message (snapshot; old: its 16 loads) (6)               | 164 ms, 4.9 MB          | 84 ms, 5.0 MB       | 1.95×         | recorded |         |
| `approval-hook`, cold / warm compile cache (2 × 9)                    | 60 / 30 ms              | 52 / 25 ms          | 1.15× / 1.2×  | < 60 ms  | warm only |
| `pnpm check` / `pnpm test` (3)                                        | 14.1 s / 28.9 s         |                     |               | recorded |         |
| `import-legacy --check`, the 2,848-task board (5)                     | 1.27 s, 228 MB peak     |                     |               | recorded |         |
| … a board of 2,848 tasks and 144,930 items (161 MB) (3)               | 3.8 s, 275 MB peak      |                     |               | recorded |         |

Ten runs: each run 300 lines at 20 a second, on boards that had had the floods (idle before them, 211 against 143 MB).
Ten runs of one line each lift the new server the same way (211 to 283 MB), so it is what a run's start allocates, not
its lines; the new server gives most of it back within a minute (a collection); the old one's barely moves. The flood's
`/api/health` p99 is over a flood that the new server takes 3 s for and the old one 1 s, in which the old answered 18
times. `pnpm check` covers 1,373 files and `pnpm test` 242 files of 2,016 tests (M2: 4.2 s and 7.0 s). Start with 2,848
tasks is 450 ms more than fresh on the new server and 15 ms on the old: not looked into. The board's snapshot holds the
new server's thread for 57 to 77 ms (the probe's slowest answer meanwhile). The hook's cold start is at its limit (60
and 61 ms medians; M2 56 ms); the warm one, which an agent's calls find, is well under it.

**Three were over their limits.** Memory with runs live and after (1.9× to 2.1×, still 1.6× a minute later; at idle
1.38× to 1.48×), the follower (3.2×, and 1.85× even without `usage`), and the hook's cold start (60 ms, not under).
The follower's first cause is fixed (below): 1.54× the old server, seven floods each, new and old alternating at a load
of 2 (one set of four gave 1.46×), so at its limit rather than within it. Memory with runs and the hook's cold start are
as measured, and open.

The follower: the plan's first step (precompiled line decoders, no per-line span) has been in since M2 (HE-4) and still
is (`RunOutput`'s and the Claude output's handlers are `Effect.fnUntraced`, the follower runs with the tracer off), so
there was nothing of it left to try. What the measurement found instead:

- **The context meter, per line.** `ContextMeter.onAssistant` runs for every assistant line with `usage`, after the
  line's commit and so outside the 64-line transaction: an `UPDATE runs SET turn_start_tokens…` and a whole task read
  (`TaskRepo.get`, the task row with its queue as `json_group_array`, 78 µs of SQLite and its decoding) only to find the
  tokens unchanged. Those are 2 of the 8.1 statements a line and about half its time: with the call skipped (an
  experiment, not kept) the flood took 1,580 to 2,000 ms. HE-4's 6.1 statements say its lines had no `usage`. Fixed
  (HE-8): the meter remembers the tokens each task's run last noted and skips a line that repeats them (one reply
  comes as several lines with the same usage), forgetting them at a turn's end, a compaction and any other change to
  the task's context; `ContextMeter.test.ts` holds that a turn starting at the last turn's size still has its start.
- **Without `usage`**, the statements are M2's 6.1 a line, but the CPU a line has gone from 0.098 to 0.18 ms (the old
  server's from 0.072 to 0.08 on this day's machine), and the time from 770 to 1,333 ms. The profile: SQLite a quarter,
  then the Effect runtime and `Context` lookups, schema decoding and GC; the work added to each line's `follow` since M2
  is where to look. Not done here: 9.2 measures.

`copy-live-board.sh` had never run to the end since 9.1: it put the snapshot inside the test server's data folder, and
`import-legacy` refuses an old folder inside the new one. The snapshot is now beside it (`<data dir>-legacy-source`),
which `test-server.sh stop` removes with the data folder.

### As measured at HE-1 (`main` at `26b22c4`)

On 12 November 2026, the same i9-13900K shared with the live board and other agents' work (load 0.4 to 5 for the
figures below; each pair taken alternately, new then old, the floods and runs only once the load was under 4 or 5), the
old server at `f2298f0c` from a clone, both through their own `test-server.sh`. RSS had no swap beside it.

The data: the old test server seeded by `scripts/seed-old-board.mjs` (3 projects, 2,848 tasks, no runs) and the new one
on its import (`copy-live-board.sh`, 0 failures, 0 problems); empty boards for the empty figures; and for the floods and
the runs a fresh `--seed` board of each with 11 tasks and `fake-claude-flood.mjs` as the agent (each with its own
repository, so no projects to repoint). All floods were on one task, whose thread grew by 10,000 items each time. The
"release" rows run `scripts/package-server.sh`'s package of each (`HUNTAWAY_TEST_BIN`, `IA_TEST_BIN`): precompiled `.js`,
so neither loads Node's TypeScript stripper, as a checkout's does. Medians, with the number of runs.

| What                                                                 | New              | Old              | New/old       | Limit    |
| -------------------------------------------------------------------- | ---------------- | ---------------- | ------------- | -------- |
| RSS at idle, 20 s after ready: empty board / 2,848 tasks (5)         | 169 / 191 MB     | 116 / 145 MB     | 1.46× / 1.32× | ≤ 1.5×   |
| … release packages, empty board (5)                                  | 149 MB           | 91 MB            | **1.64×**     | ≤ 1.5×   |
| RSS, ten runs live / stored / 60 s after they ended (3 × ten runs)   | 200 / 213 / 194 MB | 131 / 131 / 129 MB | 1.52× / 1.62× / 1.51× | ≤ 1.5× |
| Start to ready: empty board / 2,848 tasks (5)                        | 800 / 1,425 ms   | 302 / 353 ms     | 2.6× / 4.0×   | < 2 s    |
| … release packages, empty board (5)                                  | 579 ms           | 156 ms           | 3.7×          | < 2 s    |
| Follower: 10,000 lines with `usage`, first written to last stored (5) | 1,720 ms         | 896 ms           | **1.92×**     | ≤ 1.5×   |
| … CPU per line                                                       | 0.198 ms         | 0.098 ms         | 2.0×          |          |
| `/api/health` p99 meanwhile (5)                                      | 4.7 ms           | 983 ms           | 0.005×        | ≤ old    |
| Board's first message (snapshot; old: its 16 loads) (6)              | 164 ms, 5.4 MB   | 88 ms, 5.5 MB    | 1.87×         | recorded |
| `pnpm check` (vp's own times) / `pnpm test` wall time                | 14.1 s / 31 s    | 1.5 s / 28 s     |               | recorded |
| … what they find / run                                               | no warning; 2,045 tests in 250 files | 292 lint warnings; 2,046 tests in 211 files | | |

Since HE-8: idle memory and start time are as they were (HE-8: 167 / 190 MB, 855 / 1,303 ms); memory with ten runs is
1.5× to 1.6× here against HE-8's 1.9× to 2.1×, on a small board rather than a 2,848-task one with floods behind it; the
follower is 1.92× against HE-8's 1.54× after its fix (and 1.85× before it), at a higher load (3.5 to 3.9 against 2). A
release package lowers both servers' memory, the old one's more (25 MB against 20 MB), so the release ratio, 1.64×,
is over the limit where the checkout's is not.

What the profiles showed (`node --cpu-prof` on the new test server through one flood):

- **Start-up** is 0.85 s on the thread before the first request, most of it loading modules: resolving them (190 ms) and
  stripping their types (165 ms) in a checkout; a release package skips the stripping (579 ms).
- **A run's start reads its task's whole thread.** The Claude translator keeps its state per run (`kept` in
  `runs/claude/output.ts` is the run's, and `released` drops it when the follower lets the run go), so the first line of
  every run calls `rebuild`, which reads every item of the thread (`Threads.stored`: `ThreadStore.entries`, no limit),
  decodes them and folds them (`stateFromItems`) in the line's transaction. The probe's slowest answer during a flood
  grew with the thread, 23, 79, 134, 187 and 237 ms over the five floods (the thread at 1,000 to 41,000 items when
  each run started), then 284 ms at 51,000: about 5 ms per 1,000 items. The
  old server keeps one translator per thread across runs and checks it against the thread's writes count
  (`threads/write.ts` at `f2298f0c`), so its runs start with no such read. Not isolated by an experiment beyond that
  growth; the flood's own time does not include it (the read is at the run's first line, before the flood's first).
- No single synchronous stretch in the flood passed 25 ms (the longest were SQLite statements); the follower's cost is
  spread over the Effect runtime, SQLite and schema decoding, as HE-8 found.
