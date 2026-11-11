# Huntaway on Effect

Huntaway, a kanban board for orchestrating Claude Code and Codex agents, written again as one Effect v4 program. The old
code (`dire-kiwi/huntaway`) is the specification of behaviour, not of structure. **[docs/plan/](docs/plan/README.md)
is the plan** and the specification of this port: its pages say where everything goes, its
[inventory](docs/plan/inventory/README.md) is the checklist of behaviour, and
[13-milestones.md](docs/plan/13-milestones.md) is the list of tasks. Where the plan is silent or turns out wrong,
decide the way the old behaviour points and update the plan page in the same pull request.

## How code is written

**Read [docs/effect.md](docs/effect.md) before writing any code.** This is Effect **v4** (`effect` 4.1.4): most of what
the web and a model remember is v3, and the names differ (`Context.Service`, `Effect.catch`, `Schema.Literals([...])`,
`effect/rpc` inside `effect`…). `node_modules/effect/AGENTS.md`, `node_modules/effect/ai-docs/src/` and
`node_modules/effect/src/` describe v4; [docs/plan/spike/](docs/plan/spike/README.md) has shapes that ran.

- The workspace: pnpm (`apps/server`, `apps/web`, `packages/{contracts,client,shared,testing}`) with Vite+ (`vp`), and
  a Cargo workspace for `rust/shim` (`ia-shim`). [docs/plan/02-repository.md](docs/plan/02-repository.md) has what goes
  in which package.
- `pnpm check` is the whole static check (format, lint, type check, Effect's rules). **Every rule is an error, and a
  warning fails the check.** Do not suppress or loosen a rule to get green: a suppression is for one line, with its
  reason, and is listed in [docs/effect.md](docs/effect.md#suppressions); a rule that is wrong for this code base is
  turned off in `vite.config.ts` in a change that says why.
- `pnpm test` runs the server's and the packages' tests; `pnpm test:e2e` the whole-server tests; `pnpm test:ui` the
  browser checks; `cargo test` the shim's.
- Tests wait on what the code produces (a `Deferred`, an event, a row) and move time with `TestClock`: no sleeps.

## Task workflow

- This project's work is tracked on the Huntaway board (project `huntaway-effect`, keys `HE-<n>`).
- A task that changes code gets one pull request into `main`: commit, push the task branch, open it with the gh tools'
  `pr_create`, and put its link in your summary. Use the `gh` MCP server's tools, not `gh` in Bash.
- A pull request says, per plan task, what it did, what it left out and why, and what it did not verify.
- When asked to merge: its checks passed on its head commit (`pr_checks`), GitHub reports no conflicts, then
  `pr_merge` as it stands. Don't merge `main` into the branch first unless it conflicts.

## Never touch the live board

A Huntaway server in daily use runs on this machine (port 7878, data folder `~/.local/share/issue-agent`). It is what
runs the agents working here. The new server's default data folder is `~/.local/share/huntaway-effect` and its default
port 7879: those are for a real board too.

- Never stop, restart or signal the live server. Never write to its data folder or open its database. No
  `pkill huntaway`, `killall node` or the like: stop processes by PID, and never `pkill -f`/`pgrep -f` a pattern that
  also appears in your own command line.
- Never use a fixed port, and never 7878 or 7879. Start servers only from your worktree, on a free port, with a fresh
  data folder under `$TMPDIR`, with `scripts/test-server.sh`.
- Run agents off (`--no-agents`) or with the fake agent in tests.

## Testing in a worktree

Your task has a temp folder, `$TMPDIR`, deleted once the task is done. Put env files, logs and screenshots there.

- `pnpm install` at the top of the worktree first.
- `scripts/test-server.sh --seed > $TMPDIR/server-env` starts this worktree's server (`apps/server/bin/huntaway`) on a
  free port on 127.0.0.1 with a fresh data folder and no hub. It prints `export HUNTAWAY_TEST_URL=…` lines
  (`HUNTAWAY_TEST_TOKEN`, `_PID`, `_DATA_DIR`, `_ENV`; with `--seed` also `_PROFILE`, `_PROJECT`, `_REPO`) and writes
  them to `<data dir>/env`. Shell variables don't survive between Bash calls: start each later call with
  `. $TMPDIR/server-env`. The server's log is `<data dir>/server.log`.
  - `--seed` makes a "test" profile and a project "Test" (key `TES`) on a fresh git repository in `<data dir>/repo`.
  - `--demo` adds the demo board (a "Default" profile with a Demo project); other `serve` flags follow too.
  - `--no-agents` runs no agent.
  - `scripts/test-server.sh restart` restarts it on the same port and data; `scripts/test-server.sh stop` stops it by
    PID and removes its data folder. Stop the servers you start.
- `huntaway rpc <method> [json]` (`apps/server/bin/huntaway rpc …`) calls a test server's RPC over HTTP and prints the
  result as JSON. It finds the server from `$HUNTAWAY_TEST_ENV` (or `--env <file>`, or `.huntaway-test-env`), exits 1
  with the tagged error on a failure, and refuses anything but a test server on 127.0.0.1.
- UI against a test server: `HUNTAWAY_SERVER=$HUNTAWAY_TEST_URL pnpm dev`.

## Checking UI changes

A type check and a build don't show layout or behaviour, so look at UI changes in a browser before you finish and click
through what you changed. Run the test server with a fresh `pnpm build` (it serves `apps/web/dist`), then drive it with
`scripts/ui-check.mjs` (Playwright from `apps/web/node_modules`, and `/usr/bin/chromium` or `$CHROMIUM`):

```sh
scripts/test-server.sh --demo > $TMPDIR/server-env
node scripts/ui-check.mjs --env $TMPDIR/server-env "goto /" "click New task" "type A title" \
  "press Control+Enter" "wait A title" "shot $TMPDIR/board.png"
```

`node scripts/ui-check.mjs --help` lists the steps (`goto`, `click`, `type`, `press`, `wait`, `gone`, `shot`…).
