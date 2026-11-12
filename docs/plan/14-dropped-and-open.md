# 14. What is dropped, what is open, what was not verified

## Dropped

Not carried into the new code base. Each is something the old board no longer creates, a compatibility layer for old
versions or old data, or a leftover of the Rust port. If one of these should stay, say so before its milestone.

| Dropped                                                                                         | Was for                                                         | Its data at the switch                                    |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| **Subprojects**: a task with a board of its own, its merge lane, `subproject_pull_requests`, the subproject prompts, `SubprojectBoard` | Replaced by `merges_into`; new ones have been refused since HA-295 | Their tasks become ordinary tasks ([11-migration.md](11-migration.md#tasks)) |
| **Telegram**: the bot, its polling, linking, the `telegram` event and settings                   | Not in use                                                      | Settings not imported                                     |
| The `messages` table, the legacy thread routes, the `message`, `message_updated`, `delta`, `delta_reset` events | Threads before they were items                  | Checked by the importer: it refuses a board with a thread still on messages, and carries a stray row ([11-migration.md](11-migration.md#threads-not-yet-items)) |
| Moving threads onto items: `thread_source`, flip, batch rebuild, `threads-rebuild`, `threads-import`, the converter version | A migration that is finished on the board measured, and must be finished on each host before its import | Columns dropped once the importer has seen every task on items |
| `API_VERSION`, `API_COMPAT`, the forty numeric gates in the clients, `too_old` and `task_fields` in board tools, the probes for old hosts | Linking to hosts on older builds          | —                                                         |
| The HTTP proxy `/api/h/<host>/…`, the tunnel frames, the event socket's call frames              | Three host protocols                                            | —                                                         |
| The two-file database scheme, `db_origin`, recopy, the backup rules for Rust releases            | Rolling back to older builds on one data folder                 | The old file is left as the way back                      |
| Numbered migrations 1 to 130 and the defensive `has_column` style                                | History                                                         | —                                                         |
| Mirror and dead columns: `claude_config_dir`, single `summarizer`, `pens.hidden`, `now_at`, `summary` as one object | Old clients and rollbacks                    | Converted                                                 |
| Legacy shapes: `kind: "scratch"`, document names as `task_type`, workflow nodes `set_status` and `trigger` on a status | Old rows                                  | Converted                                                 |
| Run folder formats 1 to 4; reading sessions "from before runs kept their folder"                 | Runs from older builds                                          | No run is live at the switch                              |
| The `issue-agent` command, the `issue_agent` MCP server name, the `IA_*` server variables        | The former name                                                 | Old threads still show their old tool names               |
| `--broker*` flags, `ssh-host --name/--no-start`, `/profiles/{id}/scratch`, `/profiles/{id}/claude-config` (and with it `profile` in `hub.hosts.copyConfig`) | Removed features kept as no-ops                        | —                                                         |
| The serde emulation: `_from_json` readers that reproduce Rust's error texts, sorted-key JSON, `hidden()` fields, 422 texts | The Rust port                         | —                                                         |
| The test seams: `IN_TEST`, `when`/`reached`, `*_BIN` variables read by the code, shortened constants | Tests without layers or a test clock                       | —                                                         |
| `IA_PUSH_SUBJECT` (6.8): the VAPID `sub` a board names to push services                          | Naming someone other than the project's page                    | — (the subject is the project's GitHub page; a `ServerConfig` flag if wanted) |
| The hand-written cron and time-zone arithmetic                                                   | `Cron` and `DateTime` do it                                     | —                                                         |
| Moving an assistant workspace's own `.git` beside it (HA-160), on its first open (6.7)          | Workspaces from before HA-160                                   | The old server moved each one it opened; one never opened since keeps its `.git` in the workspace, which the board leaves alone (its history starts again beside it) |
| The one-time startup move of the Review tab's reviews into a workflow for projects that used workflows before HA-277 (`move_all_review_settings`, setting `workflows_reviews_moved`) (6.6) | Boards from before HA-277 | Ran on the old board before its import |
| `Lag`'s time on the thread per HTTP route (`lag.record`, `busy_with`), a stall's "busy" label and telemetry's `route_ms` metric (6.9) | Finding the route that held the one thread | Requests are fibers that interleave here, so a route's share of the thread can't be measured; the stall log and the delay histogram stay |
| `huntaway telemetry` asking for a password on a terminal (6.9)                                   | Typing an admin's password                                      | `HUNTAWAY_TELEMETRY_PASSWORD` or the URL give it; a script never waits on a prompt |

What is **not** dropped, although it carries an old name: `ia-shim`, branches `ia/…`, `refs/huntaway/…`, the script
variables `IA_TASK_KEY` and friends, the `ia.*` browser storage keys, tmux names `ia-…`, and the item id prefix
`legacy:`. Each is in something that outlives a server or lives outside this repository.

## Deferred

**The phone app**, and what exists only for it: device pairing and device tokens, Expo push, answering a prompt from
the lock screen (`/api/push-answer`), the Jest set-up. The old app keeps working against machines that have not
switched and cannot reach one that has. Sessions and scopes are designed with a device's place in them, and
`packages/client` is kept free of browser APIs, so the app can be built on this later
([09-frontend.md](09-frontend.md#the-phone-app)).

With it, Settings → Network access's paired phones (the old `settings/Devices.tsx`): the panel keeps the board's URL
and token (6.12).

As built in 6.8: the `expo` subscriptions a board has are listed in Settings and kept, not pushed to (a test push says
so); `push_answer_tokens` stays in the schema, unused; a push carries no `answer`, and the service worker has no Allow
or Deny. The `IA_EXPO_*` variables and the receipt loop wait with Expo push.

## Decisions taken in this plan

Each could have gone another way. They are listed so that a different answer is one message away.

| Decision                                                                                   | Instead of                                               | Because                                                                                                   |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| RPC over one websocket per host, the same group over HTTP for scripts                      | Keeping REST with Effect's `HttpApi`                     | One contract gives typed calls, streams, queries and mutations to both apps; HA-408 left it out only because old and new had to coexist |
| A client session per host; the hub relays sockets                                          | The hub proxying requests and merging events             | One protocol between everything; the host that serves a call checks its scope                              |
| The schema is the old one cleaned up; the task keeps its wire shape                         | A redesigned, normalised model                           | The components draw that shape, and the old database must be imported into it                              |
| No event sourcing                                                                          | T3 Code's orchestrator, event store and projections      | The board's state is rows with rules, not a log; the thread is already an event-numbered list. "Decide, commit, publish, reconcile" takes the part of that design that pays here |
| Transactions and per-entity locks                                                          | `PreventSchedulerYield`, as HA-408 proposed for a port in place | That setting was a way to keep unconverted code safe beside converted code. A rewrite can state atomicity instead of inheriting it |
| Our own MCP dispatcher over `effect/ai` tool definitions                                   | Effect's `McpServer` transports                          | The control-request transport, at-most-once across restarts and resumable answers are ours to keep         |
| Our own named-migration runner                                                             | Effect's `Migrator`                                      | It skips a migration merged later with a lower id                                                          |
| A data folder of its own (`~/.local/share/huntaway-effect`, port 7879); the importer copies in and makes stored paths absolute | Running on the old folder with a new database file | Decided on review. The new server can be built and tried beside the live board with no way to touch it; the old folder is never written. The cost: the old folder stays on disk for its worktrees and work folders |
| Components move in two steps, the first mechanical                                         | Rewriting each component once                            | The whole UI runs on the new server early, and the hand work can go on after the switch                    |
| Wire field names stay, `claude_config_id` included                                         | Renaming while porting                                   | Every rename is a diff in a kept component. One mechanical rename can follow the port                      |
| Server variables become `HUNTAWAY_*`                                                       | Keeping `IA_*`                                           | A new repository with new scripts is the cheap moment. Deploy scripts outside this repository change once  |
| Lint: every enabled rule an error, warnings fail                                           | Recommended presets at their default levels              | Asked for; and the old repository's warning backlog shows where the other road goes                        |

## Settled on review

- **Subprojects' rows** are kept as ordinary tasks.
- **The phone app** is left out for now ([Deferred](#deferred)).
- **A new data folder**, not the old one ([11-migration.md](11-migration.md#a-data-folder-of-its-own)).

## Open questions

1. **Telegram.** Dropped because it is not in use. If it is to come back it is a self-contained area after M6.
2. **Renaming `claude_config` to `agent_config` on the wire.** Proposed as one mechanical task after M9. Say if it
   should be done during the port instead, while the components are being edited anyway.
3. **Tokens between hosts.** A link still stores the other host's full board token, and dial-in hosts share one hub
   token. The plan ports that. Per-link credentials would be a design of their own.
4. **Who writes prompts.** The plan copies every prompt word for word. Prompt changes wait until after the switch.
5. **Moving worktrees out of the old folder.** After the switch they stay where they are. A command to move a
   project's worktrees into the new folder is possible and is not planned.
6. **Reconnecting when the network comes back.** The old page's events socket reconnected at once on the browser's
   `online` event (HA-38) rather than waiting out its back-off (up to 32 s). The client's sessions retry on their own
   schedule and do not listen for it; its check (the old hostUpdate's third case) is not ported (6.12, HE-7). It
   belongs to `packages/client`'s sessions if it is wanted.

## Risks

| Risk                                                                                     | What limits it                                                                                                   |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A rule that lived in a comment is lost in the rewrite                                    | The inventory's sections 9 are those rules; a task's checklist is its inventory section; the old tests' cases are ported |
| Agents write Effect 3                                                                    | `outdated-api` as a lint error, `docs/effect.md`, the spike, the package's own `AGENTS.md`                        |
| `effect/rpc`, `effect/sql`, `effect/http`, `effect/reactivity` are tagged unstable       | Exact versions; an upgrade is a task; the allow-list in `tsconfig` names every unstable module used               |
| The old board keeps changing while the port is written (about 190 merges a week)         | The inventory is at one commit. A feature merged to the old board after it is ported too, as a task; freeze the old board's features at M4 |
| Two code bases for months                                                                | M4 is the point this repository's own work can run on the new server; the old one then takes fixes only           |
| Slower than the old server on the hot path (schema decoding per output line)             | Measured at M2 with limits; precompiled decoders and untraced functions held in reserve                           |
| Strict lint slows agents down or pushes them to suppress                                 | Suppressions are counted by a structural test and need a written reason; a rule that is wrong here is turned off in the config, in the open |
| The import loses or bends data                                                           | Every row passes the schema it will be read with; `--check`; no table is dropped on the strength of one board's row count; nightly runs on a scrubbed copy; the old file untouched |
| A server on imported data acts on the live board (same host id, links, repositories)     | Two kinds of import only. The switch needs the old server stopped, and `ImportGuard` refuses to start beside it afterwards. A rehearsal has its own identity, no credentials, and a server that is read-only at four separate places, with a test ([11-migration.md](11-migration.md#rehearsal)) |
| The relay's signed session, and socket piping under load                                 | Tested first in M7 (7.0): both hold, the pipe with a drain-waiting write                                         |
| Atomicity bugs that the old single-threaded style could not have                          | Every state change is one transaction; work across a wait holds the entity's lock; decisions are pure and tested as tables |

## Not verified

Checked for this plan, on 11 November 2026: the versions, the RPC, SQL, atom and MCP shapes in
[the spike](spike/README.md), and the lint configuration in [spike/lint](spike/lint/README.md). Everything below was
read or reasoned, not run.

- The per-host family of atom runtimes: the spike type-checked one host with `AtomRpc.Service`.
- ~~Upgrade headers reaching RPC middleware on every request of a socket; the signed session; piping two sockets.~~
  Checked in 7.0 (HE-6, [08-hosts.md](08-hosts.md#to-check-early)): the headers and the seal hold; piping needs a write
  that waits for the connection to drain, which Effect's websocket `Writer` does not do.
- `Rpc.annotate` as the carrier of an RPC's scope, read by the middleware (the method exists; the pattern was not
  run).
- Effect's `Tool.getJsonSchema` output against what Claude Code and Codex accept for each of the 70 tools. Partly checked in
  M3 (HE-4): the board server's 22 tools served so far are accepted by a real Claude Code once every input schema is an
  object with `"type": "object"` (a struct of no fields came out as `{ not: { type: "null" } }`, and Claude Code then
  dropped the whole list; `mcp/tool.ts` now fixes the shape). Codex in M5 (HE-5): a real codex-cli 0.167.1 took the board
  server's tools as dynamic tools (their input schemas as `tools/list` gives them) and called `list_projects`, once the
  namespace's description was cut to 1024 characters (it refused the board's whole instructions); the other tools'
  schemas were taken, not each called. The `gh`, `docs` and `desktop` servers are not checked.
- The gh server and `gh-run` against the real gh and GitHub (4.4, HE-5): every test runs the fake gh. Not run: the real
  gh's `--help` read by `parseHelp` (the old test's texts are gh 2.102's), the token's host-only reach with the real gh
  (the old `gh_sends_the_token_to_the_accounts_host_only`), a push or fetch over HTTPS to GitHub with the account's
  token, a stacked merge with GitHub's merge-async, and a real Claude Code (or Codex) taking the gh server's tool list and
  JSON Schemas over HTTP. `ssh -G` was run with a test config only.
- Pull requests against the real GitHub (4.5, HE-5): `PrWatch`'s GraphQL query, the merged watcher's aliased one, `gh
  run view --job N --log-failed` and `gh pr view` were run against the fake GitHub only, which answers them from its own
  model of a pull request (the shapes are the old code's, which ran against GitHub). Not run: a real Claude Code agent
  waiting on a pull request, a wake with a real agent, a preview on another host than the board's.
- Adding a project from GitHub, and Asana, against the real services (6.11, HE-7): `gh repo clone`, `gh repo create`
  (with its push), the repositories' listing and search, and `gh auth status --json=hosts` were run against the fake gh
  only (the arguments and answers are the old code's, which ran against GitHub); Asana's `users/me`, typeahead and task
  reads against the fake Asana only. A config archive moved between two real hosts waits for 7.5's copy.
- M6's outside services (HE-7) against fakes only: web push (a fake push service that decrypts, not FCM, Mozilla or
  Apple; headless Chromium's push manager is a stand-in), ClickHouse and the agents' OTLP export, a hosted docs site,
  Google's sign-in, a webhook sender, the Cua Driver (the fake driver; no real screen, lock or download). No real Claude
  Code or Codex run was given the `docs` or `desktop` servers' tools, a project's own skills and MCP servers, an
  assistant's workspace or a workflow's agent step: the launch specs and prompts are tested, not a real agent using them.
- HA-274's check that a touch held on the board doesn't let a plan open a link (`tests/ui/documentCsp.test.mjs`) is
  skipped (6.2, HE-7): on headless Chromium 155 the board's activation after a touch sent over the DevTools protocol
  outlasts its 5 s while the plan's frame keeps the focus, so the frame's request opens after `ACTIVATION_MS`. The
  logic is the old `htmlFrame.ts`'s, unchanged; whether a real touch on a real Chromium behaves the same is not known.
- A test server started without its fakes reads the real home folder, as the old one did: gh without `--fake-gh` is the
  real gh (6.11's check read a real account's repository list once), the composer's `/` menu lists `~/.claude/skills`
  for a task with no config (6.4), and the assistant's Google card looks at `~/.google_workspace_mcp` (6.7). Only reads.
- The size and time of the board snapshot on a real board; the cost of decoding 2,848 task rows. Measured at M2 (HE-4) on
  synthetic data of that size, not a real board: 5.5 MB in 154 ms (the old client's 15 loads: 5.7 MB, 65 ms);
  [10-testing.md](10-testing.md#measurements).
- Memory, start-up time and event-loop delay of a whole server on Effect. HA-408 measured a bare import: 104 ms and
  100 MB for all of `effect`. Measured at M2 (HE-4) against the old server on the same synthetic data: within the limits
  of [10-testing.md](10-testing.md#measurements) (memory 1.13–1.33×, ready in ~0.55 s, event-loop p99 better), after
  the follower was brought within 1.5×; at M9 (HE-8) on an import of a board made through the old server's API, beside the old server on the same board ([10-testing.md](10-testing.md#measurements)); not on a scrubbed copy of a real board, which is the user's to make.
- ~~`tsrs` compiling the whole server for a release; the size of a release package~~: checked in M8 (HE-6), with
  TypeScript 7's own `tsc` instead of `tsrs` (it emits, and the workspace has it): the whole server and the two
  workspace packages it runs compile in under a second with the type check, and the package starts, migrates a new
  board, answers `/api/health` and runs its hooks in 23–36 ms. 173 MB unpacked (Node 144 MB, `server/` 25 MB), a 53 MB
  tarball, built in 8 s: [02-repository.md](02-repository.md#releases). As of that check the packaged server served
  its `ui/` only when given `--ui-dir` (it looked for `web/dist` beside `server/`), and reported the constant version
  and no commit (it did not read `build.json` yet): `scripts/release-check.sh` fails until both are fixed (with
  `HUNTAWAY_UI_DIR` and the commit check set aside, the rest passed). The macOS
  build, the desktop packages and the release workflow itself have not run (nothing is published from a branch).
- ~~Three names in the lint configuration~~: checked in M0 (HE-3): `import/no-cycle` (with the `import` plugin listed),
  `no-restricted-imports` with `{ patterns: [{ group, message }] }`, and `react/rules-of-hooks`/`react/exhaustive-deps`.
  The old line said: `import/no-cycle`, the `react/*` rules and the options of
  `eslint/no-restricted-imports` under Vite+ 1.5.0.
- The `STRICT` tables against every value the importer will write: checked in M9 (HE-8) for what the importer's tests,
  boards made through the old server's own API (its demo board; 3 projects, 2,848 tasks and 60 fake runs) and the
  throwaway switch hold; a row SQLite refuses is a failure in the report with SQLite's message. Not against a real
  board's data: no real board was imported (its rehearsal is the user's to run).
- The read-only server: the git commands it allows (the plan's nine and a few more reading forms, 06-server.md "As
  built in 9.1") under `GIT_OPTIONAL_LOCKS=0` left a repository and an old folder byte for byte untouched in the
  rehearsal's service test (HE-8); finding "a process has this database open" on macOS (`lsof`) was not run, only the
  Linux `/proc` way. Nothing gates the file system on a read-only server: a read may write inside its own folder (the
  assistant's workspace, made on `assistant.get`), and the service test's byte-for-byte check is what holds the rest.
- Whether any host has threads still on messages. The importer checks each board; on boards made through the old API
  it found that every task made since the old server's last start is left on `messages` with no rows, and imports those
  (11-migration.md, As built in 9.1). A real board's state is the user's rehearsal to see.
- ~~That every thread resumes its agent session after an import~~: checked in M9 (HE-8) by the throwaway switch, one
  real Claude Code session (haiku) on the old repository's test server, stopped and imported: the next message resumed
  the same session in its worktree in the old folder. Codex sessions, assistants' workspaces and scratch tasks were not
  resumed for real (their folders are kept: 11-migration.md, As built in 9.1).
- Terminals after the switch: the new server's tmux server is not the old one (9.3), so a task's terminal starts a new
  shell; the old sessions stay on the old tmux server until the user ends them.
- Run folders: nothing prunes them (the old run pruner's 14 days are only reported by `Disk`), and deleting a task
  leaves its run folders (found in 9.3).
- Discovery on a real network (7.5, HE-6): the responder and browser were run on loopback with sockets of their own
  and on a fake socket, never on UDP 5353 or the multicast group of a machine with a live board; multicast out of each
  LAN interface, renewal against `igmp_max_memberships`, and `tailscale status --json` against a real Tailscale were
  not run.
- The task count and sizes: an estimate from line counts.
- The inventory itself: eleven notes written by agents reading the old source, without running it. One note's
  section on the docs server is second-hand (it says so). Where a note and the old source disagree, the source is
  right.
