# Huntaway

See `README.md` for layout, build and run instructions.

## Task workflow

- This project's own work is tracked on the Huntaway board (project `issue-agent`, task keys `IA-<n>`).
- If a task changed code, open a pull request for its branch before you finish (see below). Tasks
  with no code changes don't need one.
- When asked to merge (for example, after the task is moved to *Ready for merge*), commit and push
  any outstanding work, wait for the PR's checks to pass (`wait` with `pull_request: <N>` and
  `pull_request_events: ["checks_failed", "checks_passed"]`), then merge it with the gh tools'
  `pr_merge`. `master` has no required checks, so "all checks passed" means those that had started
  when GitHub was read: check `pr_checks` once more before merging, and wait again if a check is
  still pending. Don't merge while checks are pending or failing, and don't merge into `master`
  locally.
- Use the `gh` MCP server's tools for GitHub (`pr_create`, `pr_view`, `pr_checks`, `pr_merge`, `api`,
  and `gh` for any other gh command), not `gh` in Bash, which agents' runs block.
- Once a task's branch has been merged into its base (`master`, or a subproject's branch for a task
  in a subproject), set that task's status to `done` with the `huntaway` MCP `update_task` tool. Do this as part of the merge, not later. If a merge covers
  several tasks, mark each of them done.

## Pull requests

Every task that changes code gets a pull request:

1. Commit everything, then push the task branch: `git push -u origin <branch>`.
2. Open it with the gh tools' `pr_create` with base `master` (and a title and a body that says what to
   try). A task in a subproject targets the subproject's branch instead.
3. Put the PR link in your final summary, and in the task's `pr_url` via `update_task`, so the card
   links it.

CI (`.github/workflows/test.yml`) runs the tests on every PR. This repository has no deployment
workflows: deployments are kept elsewhere, and a merge to `master` may deploy it.

### PR previews

Each PR from this repository (not from forks) gets a preview deployment, also kept elsewhere: a few
minutes after each push it's rebuilt from the PR's head, and it's removed when the PR closes.

- A preview is a board of its own, LAN-only, started with `--demo` and `--open-token` (any browser
  that opens it is signed in), so it has the sample Default profile and Demo project. It sleeps when
  idle and wakes on the next request.
- It also has a `personal` profile (`--profile`, see `README.md`) on a Claude login shared by every
  preview, so agents can run there. Don't log it out or change that login's settings from a preview.
- Its address isn't kept in this public repository. The board project's *Pull request previews*
  setting has it, and the board fills in the task's `preview_url` from its PR, so the card links it.

## Testing in a worktree

The live host daemon serves the user's real board on port 7878 from `~/.local/share/issue-agent`
(the data dir from before the rename to Huntaway, which it keeps using).
Task worktrees live inside that data dir, and the agent working in them is run by that daemon.
Keep test servers fully separate from it:

- Your task has a temp folder of its own, `$TMPDIR`, which the board deletes once the task is done
  (see *Temp folders* in `README.md`). Put env files, logs, screenshots and scratch folders there
  rather than straight in `/tmp`, which is shared and fills up. `mktemp`, cargo's tests and the test
  scripts already use it.
- Start a test server with `scripts/test-server.sh --seed > $TMPDIR/ia<N>-env` (serve flags such as
  `--demo` can follow). It runs this worktree's build on a free port on 127.0.0.1, with a fresh
  `mktemp -d` data dir and no hub. Don't pick a fixed port: other agents' test servers are running
  too. It prints `export IA_TEST_URL=…` lines (`IA_TEST_TOKEN`, `IA_TEST_PID`, `IA_TEST_DATA_DIR`,
  `IA_TEST_ENV`), and writes them to `<data dir>/env` too. Shell variables don't survive between
  Bash calls, so start each later call with `. $TMPDIR/ia<N>-env` (or `. "$IA_TEST_ENV"`).
  The server log is `<data dir>/server.log`.
  - `--seed` creates a "test" profile on `~/.claude-personal` with default model haiku, and a
    project "Test" (key `TES`) on a fresh git repo in `<data dir>/repo`, and adds
    `IA_TEST_PROFILE`, `IA_TEST_PROJECT` and `IA_TEST_REPO`. A fresh server without it has no
    profiles; `--demo` adds a "Default" profile (on `~/.claude`) with a Demo project that isn't
    a git repo. Use a throwaway repo like this one for test projects, not this repository.
  - `--fake-claude` runs agents with `scripts/fake-claude`, a stub that logs each call (args,
    cwd, config dir, prompt) to `<data dir>/fake-claude.log`, then prints a reply and a
    `{"type":"result","subtype":"success",…}` line and exits. Use it for runner, queue, steering
    and merge logic. `IA_FAKE_CLAUDE_SLEEP`, `_TEXT`, `_RESULT`, `_EXIT` and `_TITLE` (the generated
    title) in the environment of `test-server.sh` change what it does (see the script). Codex runs fail with it.
  - `--no-agents` sets `IA_CLAUDE_BIN` and `IA_CODEX_BIN` to `/bin/false`, so no agent runs.
    (`IA_CLAUDE_BIN=/bin/false` alone doesn't stop Codex runs.)
  - `scripts/test-server.sh restart` restarts the server on the same port, data, binary path (so
    a fresh `cargo build` is picked up), flags and environment. Agent runs carry on, as they do
    over a real restart. A **Restart** from the test server's board binds a new port instead.
  - `scripts/test-server.sh stop` kills the server and its agent runs by PID and removes the data
    dir. Without a data dir, `restart` and `stop` use `$IA_TEST_DATA_DIR`, then the latest
    server started from this worktree (`.ia-test-env` links to its env file).
- Use `scripts/ia-api` for the API rather than curl and python. It finds the server from
  `$IA_TEST_ENV` (or `--env <file>`, or `.ia-test-env`), prints JSON, exits 1 with the error on
  an HTTP error or a wrong path, and refuses to touch the live board: it only calls test servers
  on 127.0.0.1 and servers started with `--open-token`, such as PR previews. A task can be given
  by key (`TES-1`, in the seeded project) as well as by id, in paths too.
  - `ia-api get|post|patch|delete <path> [json]`, with or without the `/api` prefix.
  - `ia-api new-task <title> ['{"description": …}']` (in the seeded project), `ia-api start
    <task>` (as dragging it to In progress does: moving a task to `in_progress` with a PATCH
    doesn't start its agent; the board then sends an empty message), `ia-api send <task> <text>`,
    `ia-api task <task>`.
  - `ia-api pending [<task>]` lists pending permission prompts, and `ia-api approve-all [<task>]
    [--deny-pattern REGEX]` allows them, denying those whose tool name or input matches.
  - `ia-api wait-idle <task> [--timeout 300] [--approve [--deny-pattern REGEX]]` polls until the
    agent stops running, then prints the task's status and last message. It exits 0 when idle, 2
    when the task needs attention (a pending prompt, unless `--approve` answers it, or a run that
    ended in `needs_attention`) and 124 on timeout. Run it with the Bash tool's timeout above
    `--timeout`, or with `run_in_background`.
- API facts that agents keep rediscovering (routes are in `router` in `server/src/api.rs`):
  - There's no `/api/projects` or `/api/tasks` list: use `/api/profiles/{id}/projects` and
    `/api/projects/{id}/tasks`.
  - `GET /api/tasks/{id}` returns `{task, last_message, pending_permissions}`, so read
    `.task.status`, not `.status`. `pending_permissions` is a count.
  - `GET /api/permissions[?task_id=…]` lists pending permission prompts, and
    `POST /api/permissions/{id}` with `{"decision": "allow"}` (or `deny`) answers one. They're in
    the `permission_requests` table of `<data dir>/huntaway.db`.
  - `<data dir>/runs/<run id>/spec.json` shows how a run was launched (model, permission mode,
    config dir), so you can check launch flags without waiting for the model.
- Build in the worktree, never in the main checkout (the board project's repository path), which is
  the live daemon's source dir (no building, `git pull` or restarting there). A debug
  `cargo build` is enough for a test server.
- Don't stop or restart the live daemon. That means no `pkill huntaway`/`pkill issue-agent`/`killall`, and no
  **Restart** or **Update** from the board. Stop processes by PID, and never `pkill -f` a pattern
  that also appears in your own command line (it kills your own shell). The same goes for
  `pgrep -f` in a wait loop: it finds its own shell, so the loop never ends.
- Don't wait in a foreground `sleep` loop. Start a long command with `run_in_background` and
  wait for its notification, or use Monitor with an until-loop. To wait for a task's agent, use
  `ia-api wait-idle`, which has a deadline and also stops on `needs_attention`.
- UI dev against the test server: `IA_SERVER=$IA_TEST_URL npm run dev`. Without `IA_SERVER`
  Vite proxies to the live daemon. Don't use `npm run electron`, which attaches to or starts the
  live server.
- Test agent runs with haiku (the seeded profile's default) and the default permission mode
  (never Bypass), and answer prompts on the test server with `ia-api approve-all` or
  `ia-api wait-idle --approve`.
- Against the live daemon, a deployed hub or the user's other linked hosts, only read. Make write
  tests on a test server.

## Checking UI changes

`tsc` and a build don't show layout or behaviour, so look at UI changes in a browser before you
finish, and click through what you changed: typechecked-only UI changes have shipped lost drafts,
stale forms and broken reordering that one interaction would have shown. Run the test server with a
fresh `npm run build` (it serves `app/dist`), then drive it with `scripts/ui-check.mjs`. It uses
`playwright-core` from `app/node_modules` (so `npm ci` in `app/` first) and `/usr/bin/chromium` (or `$CHROMIUM`);
there's no other browser tooling to look for.

```sh
scripts/test-server.sh --demo > $TMPDIR/ia<N>-env
node scripts/ui-check.mjs --env $TMPDIR/ia<N>-env "goto /p/<project id>" "click New task" "type A title" \
  "press Control+Enter" "gone Create task" "wait A title" "shot $TMPDIR/ia<N>-board.png"
```

- `--env` takes test-server.sh's saved output or its data dir (variables set with `. $TMPDIR/ia<N>-env`
  aren't exported, so pass the file). The token is set before the first page loads, so `goto` any
  path: `/p/<project id>`, `/t/<task id>`, `/settings`, `/inbox`, or `?task=<task id>` to open a
  task's panel.
- Steps: `goto`, `click`/`rclick`/`dblclick`/`hover <target>`, `type <text>` (into the focused
  field), `press <key>`, `wait`/`gone <target>`, `text <target>`, `eval <js>`, `assert <js>`, `sleep <ms>`,
  `size <w>x<h>`, `shot <file> [--crop <target>] [--full]`; `-f <file>` reads one per line.
  `node scripts/ui-check.mjs --help` has the details.
- A target starting with `#`, `.`, `[` or `css=`/`role=`/`text=` is a selector; anything else is
  text, matched case-insensitively (tab labels are lowercase in the DOM) and then against `title`,
  `aria-label` and `placeholder`, for icon buttons. With several matches it uses the first and says so.
  Text in a field counts too, so wait for the dialog to go before waiting for what you typed in it.
- The window is 1900×1000 (below about 1900px wide the Done column is off-screen) and each step
  times out after 5s. Page errors and console errors are printed and make it exit non-zero
  (`--allow-error <regex>` for expected ones). A failed step saves a screenshot of the page and
  prints its path; Read it to see what went wrong. Read the PNGs from `shot` the same way.
- Phones and tablets: `--size 390x844 --touch` (below 700px wide is the narrow layout, and
  `--touch` makes it a touch screen, which gives cards their move menu button). Start a new run for
  another size rather than a `size` step, which a touch screen's page doesn't lay out again for.
- The task panel covers the right half of the board, so a screenshot of the whole board needs it
  closed.
- For a visual fix, take the same screenshot with the change set aside and compare the two. Run
  `npm run build` again after setting it aside, and again after bringing it back: the server serves
  `app/dist`, so without a rebuild both screenshots show the new UI. The stash stack is shared with
  other worktrees, so stash with `git stash push -m <unique tag>` and `git stash apply` that entry
  rather than a bare `git stash pop`.
- For checks that need more than steps (`page.route` to fake a failed request, several pages, API
  calls in between), import `open` from `scripts/ui-check.mjs` and use `ui.page`, which is a
  Playwright page. Checks for bugs that are easy to bring back go in `app/tests/ui/` and run with
  `npm run test:ui` in `app/` (it builds the UI, and each file starts its own `--demo` test server
  with agents switched off, so `cargo build` in `server/` first). Files run 8 at a time (`IA_UI_TEST_JOBS`
  changes that), so a check mustn't count on a quiet machine: wait for what it reads rather than read it
  at once. Run one file with `node --experimental-strip-types --test tests/ui/<file>`. They aren't part of `npm test`,
  but CI runs them, split between three runners (`Tests / ui (1/3)` to `(3/3)`; `IA_UI_TEST_SHARD=2/3` runs the second third). Run them when you change the UI they cover, and add one when an interaction found a bug.
- For a change meant to make the UI faster, measure it: `node scripts/ui-profile.mjs --env $TMPDIR/ia<N>-env
  --task <id>` opens a task with a long thread and feeds the page streamed tokens, task events and
  messages, then prints the main-thread time each took. Run it on the build with the change set
  aside and with it, on the same machine. Demo data is too small to show much: start the test
  server with `--no-agents` and give it a scrubbed copy of the live board's database with
  `scripts/copy-live-board.sh $TMPDIR/ia<N>-env` (it only reads the live database).

## Running tests

- Run server tests with debug `cargo test` in `server/`, not `--release`: a release test build
  compiles a second copy of every dependency.
- Wrap long runs in `timeout` and write the output to a log file, then read the log:
  `timeout 900 cargo test > $TMPDIR/test.log 2>&1; tail -30 $TMPDIR/test.log`. Piping through `grep`
  buffers, so a hang shows nothing.
- Write async tests as `#[test] fn …() { testing::run(async || { … }) }` (`server/src/testing.rs`)
  rather than `#[tokio::test]`, so a hang fails after 30 seconds instead of running forever.
  `testing::state()` gives an `AppState` on an in-memory database.
- Give a test a folder with `testing::temp_dir()`, which is removed when the test ends (panics
  included), not `std::env::temp_dir()`: tests that left their folders there filled `/tmp`.
  `testing::state()`'s data dir goes with the state. `IA_KEEP_TEST_DIRS=1` keeps failing tests'
  folders. `cargo test` in `server/` runs each test binary in a `TMPDIR` of its own, which is removed
  when it exits, and fails it if it left anything there (`server/.cargo/test-runner`), so a test that
  leaks fails locally as it does in CI. `cargo test --manifest-path` from another folder skips that.
- `AppState::db()` isn't reentrant: drop a guard before calling `db()` again (that includes two
  calls in one statement). Tests and debug builds panic on a second lock on the same thread;
  release builds would hang.
- New worktrees have no `node_modules`. Run `npm ci` in `app/` first, then use the package
  scripts (`npm run typecheck`, `npm test`, `npm run build`). `npx tsc` without them runs an
  unrelated package.
- The code is formatted by hand, with lines of up to about 160 characters, and there's no
  Prettier, ESLint or rustfmt config. Don't run `prettier`, `eslint` or `cargo fmt`, because each
  rewrites whole files. Match the surrounding style, and check `git diff --stat` before committing.
- CI runs `cargo test`, `npm run typecheck` and `npm test` on every PR, and `npm run test:ui` and
  `scripts/ia-api-test.py` (`.github/workflows/test.yml`, the `Tests / server`, `Tests / app` and
  `Tests / ui (1/3)` to `(3/3)` checks, on GitHub-hosted runners). Still run them
  yourself before pushing and after merging master, since CI takes a while and a failure there costs
  another round trip. Check the PR's checks (`pr_checks`) before you merge or report a PR as ready.
- `scripts/ia-api` has its own tests (a faked server and clock): `python3 scripts/ia-api-test.py`.
- If both your branch and master bumped `API_VERSION` (`server/src/proto.rs`) or added a DB
  migration (`server/src/db.rs`), git may merge the two without a conflict. After merging master,
  check both numbers and move yours above master's.

## What to test

The happy path is rarely where review finds bugs. About a quarter of reviews asked for fixes, and
most of those were cases like these:

- State from before the change: rows written before a migration, unsaved input in a form, agents
  already running or queued, a linked host that is offline or on an older version.
- Concurrency: two requests or two tasks at once, and the order locks are taken in (debug builds
  only catch a second lock of the *same* mutex).
- Anything that deletes or cleans up data: run it from another working directory, through a
  symlink, with shared or custom folders, and with git state that `git status` hides.
- Access across profiles: a route or tool that returns another profile's tasks, or accepts
  their ids.
- Both agent runtimes (Claude and Codex) when the change touches runs, tools or MCP.

When you fix a bug or a review finding, add a regression test and check that it fails without the
fix. After a fix round, repeat the end-to-end check, not just the unit tests. In your summary, say
what you didn't verify.
