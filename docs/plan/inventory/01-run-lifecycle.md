# 01 — The agent run lifecycle

Source: `the huntaway repository` (master). Paths below are relative to `apps/server/src/` unless they start with
`rust/`, `scripts/` or `docs/`.

## 1. Purpose

A **run** is one agent process working on one thread (a task, review thread, assistant, routine, pen thread): either
`claude -p …` or `huntaway codex-run` (an adapter around `codex app-server`), started under the Rust supervisor
`ia-shim`, which detaches it from the server and records everything in `<data>/runs/<run_id>/`. The server only
*follows files*: it tails `out.jsonl` from a saved byte offset, turns each line into thread messages/items, answers the
agent's requests by appending lines to `input.jsonl`, and when the `exit` file appears decides which board column the
task goes to. Because the durable state is the `runs` table plus the run folder, the server can stop, crash or be
rebuilt while agents keep working, and re-attach on start. The same area owns the message queue/steering for a running
thread, the merge queue, the per-task temp folder, dev-server discovery, background-task tracking, the context meter
and the 5-hour-window restarter.

## 2. Capabilities

### Starting a run (`agent/runner.ts`, `runner/send.ts`, `runner/launch.ts`, `agent/runs.ts`)
- Send a user message on a thread: steer it into the live run, queue it, hold it for dependencies/usage, or start a run (`send`, `send_message`).
- `/new [message]`: forget the session (`session_id`, `rewind`, `context` cleared; assistant/pen threads re-pick their config); refused while running (`new_session`).
- `/compact [instructions]`: a `compact` run; never steered, queued behind a live run (`is_compact`, `compact`).
- `/plan [what]`: board-handled; gives the task the `plan` label and rewrites the prompt (`documents.plan_command`, launch.ts, queue.ts).
- Variants of send that mark provenance: `send_as(auto)`, `send_for_user` (board-written, no retitle), `send_fixes(round)` (review fixes, `review_round` on the message), `send_from_agent` (MCP `send_to_task`), `send_from_routine`, `send_from_automation`, `send_review` (kind `review`).
- Register a run atomically with the thread messages that explain it and the queue being emptied (`start_run`, one DB transaction).
- Launch asynchronously with a cancel handle while "preparing" (`start_run` + `launch`); `Cancelled` thrown at the next `check()`.
- Prepare: wait for a project relocation and for a restack to settle; adopt a default config for a config-less thread; verify the assistant workspace; choose cwd; set up the worktree; take a pre-run checkpoint; compute `--add-dir`s; make the task temp folder; build prompt and system prompt; build args/env or a Codex `Spec`; write the run folder; spawn the shim (`launch`, `runs.start`).
- Record per run: `config_dir`, `effort`, `board_tools`, `turn_message_id`, telemetry `run_start`.
- First prompt of a task = `# KEY-N: title`, description, external links, `---`, start instructions, then the user's text; a leading `/skill` goes first (`start_prompt`).
- Prompt decorations: lost-background note (once), `[Mentions, from the board: …]` note for keys named in the text (max 12), unread routine reports for the assistant.
- System prompt text per thread kind (task, scratch, group, documents-only, review/summary/workflow, assistant, routine, pens) plus notes on gh, docs, desktop, temp folder, profiles, pen brief, memory (`runner/prompt.ts`); `preview()` renders it for a hypothetical new task (project settings page).
- Decide what a run may use: board tools allowed list, gh read-only tools (+`pr_merge` while merging), docs tools, desktop read tools, project MCP servers/skills, reviewer allow/deny lists, approval-rule hook and disallowed tools (`runner/access.ts`, launch.ts).

### Following a run (`agent/runs.ts`, `runner/output.ts`, `codex/*`)
- Tail `out.jsonl` in whole lines from `out_offset`, tolerate repeats (skip below the saved offset), save the offset after each chunk (`follow_inner`, `on_output`).
- Claude stream-json → thread messages (slimmed), streamed text deltas, session id, cost, context tokens, rate limits, subagent lifecycle, background tasks, compaction boundaries (`handle_line`).
- Codex notifications → thread *items* directly (tool calls, messages, reasoning, plan-as-TodoWrite, subagents as Agent calls) (`codex/driver.ts`), requests → permission prompts / board tool calls (`codex/requests.ts`).
- Answer agent requests on its input: permission prompts (`can_use_tool`), in-process MCP messages (`mcp_message`), Codex approvals/questions/dynamic tool calls (`runner/requests.ts`, `codex/requests.ts`).
- Detect turn end (`result` / `turn/completed`), record it, decide to keep the input open or close it (`record_result`, `turn_ended`).
- Detect exit, compute the outcome, move the task to its column, start what follows (queued message, next merge, unblocked tasks, review, workflows, restack, PR lookup) (`on_exit`, `finish`).
- Detect a vanished shim (every 2 s) and a removed run folder, and end the run (`follow_inner`).

### Messages while a run is live (`runner/queue.ts`)
- Steer: append a stream-json user message to `input.jsonl` at once; keep it on `tasks.steering` until echoed; add the thread message at the echo (`steer_or_queue`, `write_steers`, `steered`).
- Queue (one concatenated message per task) when it can't be steered; send it when the run ends (`db.queue`, `send_queued`).
- Requeue never-taken-in steers ahead of anything queued later (`requeue_steers`, `requeue_ahead`).
- Unqueue (give the text back to the user) (`unqueue`).
- Close the input when a turn ends with nothing waiting; grace timers when something should start a turn but doesn't.

### Stopping (`runner.ts`, `runs.ts`, `runner/background.ts`)
- Stop = interrupt the turn (control request) keeping the session resumable; escalate to closing input + SIGTERM/SIGKILL of the process group (`stop`, `interrupt`, `stop_unless_interrupted`, `runs.kill`).
- Abort = clear queue and steering, kill at once (before deleting a thread) (`abort`).
- Cancel a launch still preparing; reap an agent the shim starts after the launch gave up (`reap`, `watch_to_reap`).
- Stop an orphan agent whose shim died (`stop_orphan`, `watch_orphan`).
- Stop individual background shells with `stop_task` control requests, falling back to stopping the run (`background.stop`).

### Background work and dev servers (`runs/background.ts`, `runner/background.ts`, `agent/servers.ts`)
- Track Claude Code's `background_tasks_changed` list per run on disk; show `Task.background_work`; idle vs working rule (`holds`).
- `background_wait` board tool: the agent declares it waits on a shell.
- Tell the agent, once, what background work its last run's end killed (`Task.lost_background` → note).
- Scan `/proc` every 4 s for listening TCP sockets of processes whose environ has `HUNTAWAY_TASK_ID=<task>`; show `Task.servers`; stop one by port.

### Merge queue (`runner/merge.ts`, `db/tasks/merges.ts`)
- One merge at a time per *lane*; start the next waiting task's merge run; ask for merge-approval summaries; whole-stack runs hold a lane; step-out/rejoin (`remerge`).
- Compose the merge request prompt (`request_merge`, `into_merge`, `stacked_merge`), and `as_told` (how the task's base is described).

### Gates before a run (`runner/send.ts`, `agent/usage.ts`)
- Dependencies: wait in "In progress" (`waiting=1`) with the message queued; `start_unblocked` starts them.
- Usage limits: wait for reset (`limit_reset_at`) or switch config; `config_changed`.
- Archived project: refuse.
- Merging task that isn't the lane's active merge: refuse messages (409).

### End-of-run column rules (`runner/output.ts`, `runner/plan.ts`, `runner/todos.ts`)
- The decision table in §9; plan-only runs → "Needs attention: Plan ready for review"; unfinished todo list holds the task in "In progress" and nudges the agent once.

### Housekeeping
- Idle-session auto-compaction (Claude only) (`send.ts: auto_compact`).
- Prune run folders (14 days), `mcp_calls` (1 h), thread event logs; count tokens before folders go (`runs.ts: prune`, `start_pruner`).
- Per-task temp folder: create, remove when done, sweep, stop leftover test servers first (`agent/task_tmp.ts`, `agent/leftovers.ts`).
- Context meter and per-turn/compaction statistics (`agent/context.ts`).
- Restart 5-hour usage windows with a throwaway prompt (`agent/window.ts`).
- Codex one-off queries: title, model list, skills, rate limits (`codex/queries.ts`).
- Capability checks: `can_run_agents`, `has_agent` (`runs.ts`).

## 3. Data

### Table `runs` (durable run state; `db/runs.ts`, migrations)
| column | meaning |
|---|---|
| `id` TEXT PK | uuid; also the run folder name |
| `task_id` | FK tasks, ON DELETE CASCADE |
| `kind` | `prompt` \| `compact` \| `review` |
| `status` | `preparing` → `running` → `exited` (index `runs_status`; `runs_task(task_id, created_at)`) |
| `out_offset` INT | bytes of `out.jsonl` already applied |
| `stop_requested` INT | 0 none; 1 stop asked, turn not yet ended; 2 the interrupted turn ended (reset to 0 if a message is then taken in) |
| `stop_id` TEXT | `stop-<uuid>`: id of the latest stop, also the interrupt's `request_id`; lets an older stop's timer ignore a newer stop |
| `attention` TEXT | question from `request_user_input` in this run → run ends in "Needs attention" with it; cleared when the user's steer is taken in |
| `finished` INT | agent called `finish_work`; cleared when a user steer is taken in |
| `result_error` TEXT | error of the *last* turn's result (null = ok) |
| `saw_result` INT | at least one turn ended |
| `between_turns` INT | last turn ended and nothing has started another |
| `cost_usd` REAL | what this run added (see `add_cost`) |
| `session_id`, `session_cost` | the agent session the run is in and the session's running total at its last result |
| `config_dir` TEXT | config folder the run was started with (`''` = agent default); the first run of a session pins the session's folder |
| `board_tools` INT | Codex: this run gave the new session the board's tools as dynamic tools |
| `effort` TEXT | effort as given to the agent (`''` = agent default) |
| `turn_message_id` INT | user message the current turn started with (checkpoints) |
| `agent_at` TEXT | Claude: uuid of the latest top-level message; Codex: current turn id (rewind target) |
| `turn_start_tokens`, `turn_tokens` | context size at first/latest model request of the current turn |
| `usage_at`, `usage_session`, `usage_snapshot`, `usage_tail` | token counting (owned by `agent/tokens.ts`) |
| `created_at`, `ended_at` | RFC 3339 ms |

Queries of note: `active_runs` (status != exited, by created_at), `has_active_run`, `later_run` (rowid order), `latest_run`,
`run_after`, `idle_sessions`, `session_board_tools`, `session_config_dir`, `add_cost`.

`add_cost(run, session, total, counted)`: Claude's `total_cost_usd` is the **session's** running total. The run is charged
`total - before`, where `before` is the latest `session_cost` of this run or an earlier run of the task in the same
session. A lower total in a result with `modelUsage` restarts from 0; a lower total without it (a failed turn's 0) charges
nothing.

### Task columns this area reads/writes
`running`, `steerable`, `run_started_at`, `status`, `attention_reason`, `waiting`, `limit_reset_at`, `session_id`,
`claude_config_id`, `cost_usd`, `merging`, `remerge`, `merge_approval`, `stack_run`, `position`, `rewind` (JSON `Rewind`),
`context` (JSON), `context_detail` (JSON text), `queued_message`, `queued_from_agent`, `queued_user_text`, `queued_routine`,
`queued_routine_runs` (JSON string[]), and JSON columns:
- `steering`: `Steer[]` = `{id (also the stream-json uuid), text, from_agent, run_id, written, routine_runs?, routine?}`.
- `background_work`: `{run_id, idle, tasks:[{id, kind: shell|subagent|other, description, command, since, waited}]}` or null.
- `lost_background`: `[{kind, label}]` (last 10), cleared once told.
- `servers`: `[{port, address, pid, pgid, command, since, detached}]`.

`Queued` (in memory): `{text, from_agent, user_text, routine, routine_runs}`. Queueing concatenates with `\n\n`; `from_agent`
is true only if every part was an agent's; `user_text` keeps the user's parts.

Other tables touched: `mcp_calls` (ids `stdio:<run id>:<request id>`, Codex `stdio:<run id>:codex:<id>`; `args` JSON holds
`Asked` = `{tool_name,input,tool_use_id,request_id,codex?}` or `Called` = `{request_id,rpc_id,arguments,codex?}`),
`permission_requests`, `context_stats` (kind `turn`/`compact`), `documents`, `thread_items`, `automation_runs`.

Settings keys read: `default_model`, `default_effort`, `default_permission_mode`.

### The run folder `<data_dir>/runs/<run_id>/` (stable on-disk format; old runs must stay readable)
| file | writer | content |
|---|---|---|
| `run.json` | server | `{"boot": <boot id or null>, "format": N, "version": <server version>}`; missing = format 1 |
| `prompt` | server | bytes fed to the agent first (see §5) |
| `input.jsonl` | server (appends) | present only for runs that take input; one JSON line per write |
| `input.closed` | server | empty marker: no more input |
| `out.jsonl` | shim (agent stdout, append) | stream-json / Codex JSON-RPC lines |
| `err.log` | shim (agent stderr, append) | last 4000 bytes quoted in failures |
| `shim.pid` | shim | pid of the detached shim |
| `pid` | shim | agent pid = its process group id |
| `exit` | shim (or server, for a vanished shim) | `{"code":N\|null,"signal":N\|null[,"error":"…"]}` |
| `spec.json` | server | `{args, config_dir, cwd}`; its existence means "the shim may start"; `reap` goes by it |
| `mcp.json` | server | `{mcpServers:{…}}`, keys sorted, pretty-printed |
| `mcp-run.json` | server | `{cwd, github_account, review, in_process, desktop}` for the HTTP MCP servers |
| `codex.json` | server | the Codex `Spec` (also marks the run as Codex's) |
| `system-prompt.md` | server | Claude's `--append-system-prompt-file` |
| `awaited` | server | uuid of the prompt message whose echo is awaited; removed once echoed |
| `background` | server | JSON `BackgroundTask[]` `{id,type,description,since,command,tool}` + `\n`; legacy: list of ids, or a bare count |
| `background-waited` | server | JSON string[] of shell ids the agent waits on |
| `background-killed` | server | JSON `BackgroundTask[]` the board stopped |
| `background-ended` | server | `{ended:(string\|null)[], taken:string[]}`; legacy empty file = `{ended:[null],taken:[]}` |
| `background-calls` | server | `{<tool_use_id>:{tool,command}}`, latest 20 |
| `reap`, `orphan` | server | empty markers: a kill in progress to resume after a restart |

Run formats (`RUN_FORMAT = 5`, each run written with the lowest it needs): 1 no `run.json`; 2 stream-json input; 3 Claude asks
permission on its output; 4 Claude calls board tools on its output; 5 Codex writes app-server requests to its output. A
server that finds `format > RUN_FORMAT` (a downgrade) reaps the run and fails it.

### Codex `Spec` (`codex.json`)
`cwd, thread_id, model, effort, approval_policy, approvals_reviewer, sandbox, plan, compact, developer_instructions, input,
writable_roots[], filesystem{path:"read"|"write"}, skills_dir, approved_mcp_servers[], disabled_mcp_tools{server:[tool]},
review_waits, requests_on_output, board_tools (namespace tool or null), revert_before_turn?, approval_rules?,
config_overrides?[]`. Read back leniently (`Spec_from_json`); unreadable `approval_rules` → not a spec (run doesn't start).

### Other folders
- Task temp folder: `<os tmpdir>/ha-<fnv1a32(data_dir) hex8>/<first 12 alnum chars of task id>`; mode 0700; a review thread
  uses its parent task's; tests use `<data_dir>/task-tmp`. Removal renames to `.removing-<name>-<uuid>` first.
- Profile scratch dir: `<data_dir>/profiles/<profile_id>/scratch` (cwd of a project-less thread).

## 4. In-memory state

| state | where | purpose | across a restart |
|---|---|---|---|
| `state.runs: Map<task_id, {run_id, cancel}>` | `state.ts` | *the* "is running" flag; one live run per task; `cancel` non-null only while preparing | rebuilt from `active_runs` in `load_active` |
| `WRITE_DOCUMENTS: Set<run_id>` | queue.ts | runs that can write the task's document folder (a `/plan` is only steered into those) | lost → `/plan` queues instead of steering |
| `AWAITED: Map<run_id, string\|null>` | runs/background.ts | cache of the `awaited` file | file |
| `cancelled: Set<call_id>` | requests.ts | calls the agent gave up on, while they settle | lost (harmless) |
| `state.calls_inflight`, `perm_waiters` | state.ts | executing MCP calls / waiting prompts | re-created by `resume_requests` from `mcp_calls` |
| `ended: Map<task_id, ms>` | servers.ts | keep scanning 5 min after a run ended | lost; tasks with `servers` listed are still scanned |
| `env_cache: Map<pid, task\|null>` | servers.ts | `/proc/<pid>/environ` read once | rebuilt |
| `watches` counter | runs.ts | lets tests end reap/orphan watch loops | n/a |
| `BOOT_ID` | runs.ts | cached boot id | re-read |
| window `watches: Map<config_id, Watch>` | window.ts | per-config window knowledge and retry backoff | lost by design ("until the server restarts") |
| `MODELS` (10 min), `SKILLS` (1 min) caches | codex/queries.ts | Codex model/skill lists | lost |
| timers (stop grace, steer grace, background grace…) | runner.ts, queue.ts | see §6 | re-armed in `load_active` from `stop_requested`, `stop_id`, `between_turns`, `steering` |
| usage "config is out until" | agent/usage.ts | gates runs | lost; a waiting task keeps `limit_reset_at` in the DB |

There is **no lock**: the server is single-threaded and every decision that must be atomic is a synchronous function
(`steer_or_queue`, `start_next_merge`, `start_unblocked`, `task_tmp.take`), which replaced Rust mutexes.

## 5. Outside the process

### `ia-shim` (Rust, `rust/shim/src/main.rs`, 135 lines, only dependency `libc`; kept as is)
Command line: `ia-shim <run-dir> -- <program> [args...]` (fewer than 3 args or `args[1] != "--"` → usage on stderr, exit 2).
1. `fork()`. Parent exits 0 at once (the launcher gets control back). Child `setsid()` (new session, no controlling
   terminal). Fork failure → writes `exit` with `"error":"fork failed"`, exit 1.
2. Writes `shim.pid` (its own pid). All small files are written atomically: `.<name>.tmp` then `rename`.
3. Opens `out.jsonl` and `err.log` with create+append; failure → `exit` `"cannot open output files"`.
4. **Relay mode iff `input.jsonl` exists at this moment**: child stdin is a pipe. Otherwise stdin is the `prompt` file
   itself (or `/dev/null` if it can't be opened).
5. Spawns `<program> args…` with stdout→`out.jsonl`, stderr→`err.log`, `process_group(0)` (own group, so `kill(-pid)`
   reaches the whole tree). Cwd and environment are inherited from whoever launched the shim. Spawn failure → `exit`
   `{"code":null,"signal":null,"error":"failed to start <program>: <os error>"}`, exit 1.
6. Writes `pid` (the child's pid).
7. Relay thread (relay mode): reads all of `prompt` and writes it to the pipe **as is (no newline added)**; then loops:
   note whether `input.closed` exists (*checked before reading*, so everything written before the marker gets through);
   read `input.jsonl` from its current position to EOF in 64 KiB chunks, writing each to the pipe; if the marker was
   seen, return (dropping the pipe = EOF for the agent); else sleep 50 ms. A failed write (agent stopped reading) ends
   the thread.
8. `wait()`s for the child, writes `exit`: exactly `{"code":<int|null>,"signal":<int|null>}`; on a wait error adds
   `"error":<json string>`. Then exits.
The shim handles no signals and is never signalled by the server; it never reads `out.jsonl`. Running shims are never
upgraded. Tests (`rust/shim/tests/relay.rs`): relays until closed (`cat` as the program; a line written just before the
marker still arrives; exit is `{"code":0,"signal":null}`), and without `input.jsonl` reads the prompt file.

Shim binary lookup (`shim_path`): `$IA_SHIM_BIN`; else the newer of `target/{release,debug}/ia-shim` at the checkout root
(not under tests); else `ia-shim` beside `bin/huntaway`.

### Server side of the protocol (`runs.start`, `write_input`, `close_input`, `kill`, `follow_inner`)
- Launch: refuse if `pid` or `exit` already exist; `mkdir`; write `run.json`, `prompt`, `input.jsonl` (empty, if input),
  `awaited`, `mcp-run.json`, `mcp.json`, (`codex.json`), `spec.json`; check cwd is a directory; `check()` for
  cancellation; spawn `ia-shim <dir> -- <program> <args>` with `cwd` = the run's cwd, `stdio: ignore`, env below; require
  exit code 0; then poll every 50 ms up to 100 times for `pid` (→ started) or `exit` (→ throw its `error` or "the run
  exited immediately"); else "the run did not start within 5s".
- Program: Claude → `$IA_CLAUDE_BIN` or `claude` with `[...args, "--mcp-config", <dir>/mcp.json]`; Codex →
  `<state.exe> codex-run <dir>/codex.json`.
- Env: the server's env minus `SERVE_ENV` (`IA_HOST, IA_PORT, IA_DATA_DIR, IA_UI_DIR, IA_SOURCE_DIR, IA_UPDATE_FROM,
  IA_RELEASE_UPDATES, IA_RELEASE_API, IA_NAME, IA_HUB, IA_HUB_TOKEN, IA_TOKEN, IA_DEMO, IA_OPEN_TOKEN, IA_PROFILES,
  IA_DESKTOP_VERSION, IA_DESKTOP_SHELL, IA_DESKTOP_INSTALL, IA_BUNDLED_SERVER, IA_TELEMETRY_URL`) and minus an inherited
  `HUNTAWAY_TASK_ID` (HA-185: an agent that starts its own `huntaway serve` must not inherit the board's settings); plus
  the launch's pairs; plus `CLAUDE_CONFIG_DIR` (or `CODEX_HOME`) = the config dir with `~` expanded, when set.
- `write_input(line)`: only if `input.jsonl` exists and neither `input.closed` nor `exit` do; **one** `appendFileSync` of
  `line.trimEnd() + "\n"` (so the shim never relays half a line). Returns false otherwise.
- `close_input`: create empty `input.closed` (idempotent).
- `kill`: no-op if `exit` exists or the boot id changed (pid may be reused); record `background-killed`; `SIGTERM` to
  `-pid`; after 10 s `SIGKILL` to `-pid` if still no `exit`.
- Follower: every 200 ms read up to 1 MiB from the offset (doubling while a single line is longer); apply only up to the
  last `\n` (all of it once `exit` exists); when `exit` exists and nothing is left → `on_exit(code, signal, error, last
  4000 bytes of err.log)`; folder gone → `on_exit(error "the run's folder was removed")`; every 10th poll: if `shim.pid`
  is dead or from another boot and there is no `exit`, `stop_orphan` and the server itself writes
  `{"code":null,"signal":null,"error":"the run's supervisor (ia-shim) disappeared"}`.
- Boot id: `/proc/sys/kernel/random/boot_id` (Linux), `sysctl -n kern.bootsessionuuid` (macOS). A differing boot id means
  recorded pids are untrusted (never compare clocks).

### `claude` launch (launch.ts) — full argument list, in order
```
-p --output-format stream-json --verbose --include-partial-messages
[--input-format stream-json --replay-user-messages]          # every run but /compact
--append-system-prompt-file <run dir>/system-prompt.md        # file, not arg: can exceed 128 KiB
--permission-mode <default|acceptEdits|auto|plan|dontAsk|bypassPermissions>
[--permission-prompt-tool stdio]                              # input && (mode != bypassPermissions || rules need a prompt)
[--settings '{"hooks":{"PreToolUse":[…]}}']                   # gh hook and/or approval-rules hook
--allowedTools <tool> <tool> …                                # separate args, see below
[--disallowedTools "<space-joined list>"]
[--resume <session id> [--resume-session-at <message uuid>]]  # rewind
[--model <m>] [--effort <e>]
--add-dir <dir> …
--mcp-config <run dir>/mcp.json                               # appended by runs.start
```
- `--allowedTools`: `mcp__huntaway` (in `auto` mode instead each `mcp__huntaway__<tool>` except `wait`, so Claude's
  classifier reviews waits); `mcp__docs` if the docs server is on; desktop read tools; `mcp__gh__<read-only tool>` (+
  `pr_merge` while the task is merging) unless the project has its own `gh`; the project's allowed tools; for a review:
  `Read Grep Glob Skill Agent Task` and `Bash(git diff:*)`, `git log`, `git show`, `git status`, `git merge-base`,
  `git rev-parse`, `gh pr view|diff|list|checks`.
- `--disallowedTools`: project's disallowed, approval rules' refused tools, reviewer's desktop write tools; for a review
  `Edit Write NotebookEdit` and the gh write tools.
- `--settings` hooks: `{matcher:"Bash", hooks:[{type:"command", command:"'<exe>' gh-hook", timeout:10}]}` (denies `gh` in
  Bash when our gh server is present) and the approval-rules entry `'<exe>' approval-hook '<rules json>'` (timeout 30;
  with strict rules the command is wrapped so a hook that can't run exits 2 = refuse).
- Model: first non-blank of task, project, profile default, host `default_model`. Effort: task's or host `default_effort`,
  mapped `ultra→max`, `minimal→low`.
- `--add-dir`: project repo (document/scratch threads), subproject worktree, group projects' repos, the task's own
  document folder, the skills dir, attachment folders named in the prompt, the temp folder.
- Env added: `MCP_TOOL_TIMEOUT=86400000`, `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, `CLAUDE_CODE_ENABLE_TASKS=0`, `TMPDIR=<task
  tmp>`, `HUNTAWAY_TASK_ID=<task id>`, proxy config's `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY=""`,
  and for telemetry `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=none`,
  `OTEL_TRACES_EXPORTER=none`, `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json`, `…_LOGS_ENDPOINT`, `…_LOGS_HEADERS`,
  `CLAUDE_CODE_OTEL_SHUTDOWN_TIMEOUT_MS=5000`.
- Stdin (`prompt` file) for an input run is two lines, each ending `\n`:
  1. `{"type":"control_request","request_id":"huntaway-init-<run id>","request":{"subtype":"initialize","sdkMcpServers":["huntaway"],"sdkMcpServerConfigs":{"huntaway":{"timeout":86400000,"disableAutoBackground":true}},"sdkMcpServerManifests":{"huntaway":{"initializeResult":…,"toolsListResult":{"tools":[…]}}}}}` (MCP protocol `2025-11-25`)
  2. `{"type":"user","uuid":"<prompt_id>","message":{"role":"user","content":"<prompt text>"}}`
  A `/compact` run's `prompt` is the plain text and there is no `input.jsonl`.
- `mcp.json`: HTTP entries `{type:"http", url:"<internal url>/api/mcp/<run id>/<server>", headers:{Authorization:"Bearer
  <HMAC-SHA256(host token, "mcp:<run id>") hex>"}, timeout}` for `huntaway` (86 400 000 ms; removed when in-process), `gh`
  (900 000), `docs` (removed if the project turned it off), `desktop` (300 000; only when computer use is on), plus the
  project's own servers (which may replace any but `huntaway`).

### Claude lines the server writes to `input.jsonl`
`user` messages (steers); `control_request` with `request.subtype` = `interrupt` (id `stop-<uuid>`), `stop_task`
(`bgstop-<uuid>`, `task_id`), `get_context_usage` (`context-<uuid>`, `detail:"summary"`); `control_response` with
`response` = `{subtype:"success", request_id, response:<permission decision>}`, `{subtype:"success", request_id,
response:{mcp_response:<JSON-RPC>}}` or `{subtype:"error", request_id, error}`.

### Claude lines the server reads from `out.jsonl`
`system`/`init` (session id; a turn starts), `system`/`compact_boundary`, `system`/`background_tasks_changed`,
`system`/`task_started|task_progress|task_updated|task_notification`, `rate_limit_event`, `stream_event` (top level only:
`message_start`, `content_block_start`, `content_block_delta` text deltas), `assistant`, `user` (tool results; `isReplay`
echoes), `control_request` (`can_use_tool`, `mcp_message`; others answered with an error), `control_cancel_request`,
`control_response` (to `huntaway-init-`, `bgstop-`, `context-` ids), `result`. Any line with a `method` field is Codex's.

### Codex (`huntaway codex-run <run dir>/codex.json`, `codex/adapter.ts`, `codex/rpc.ts`)
- The adapter reads `codex.json` and the sibling `mcp.json`, spawns `$IA_CODEX_BIN|codex [-c k=v …] app-server` (cwd =
  run cwd, stderr inherited → `err.log`), and speaks JSON lines **without a `jsonrpc` field**: requests `{id, method,
  params}`, responses `{id, result}` / `{id, error:{code:-32601,message}}`, notifications `{method}`.
- Sequence: `initialize` (`clientInfo {name:"huntaway", title:"Huntaway", version}`, `capabilities.experimentalApi:true`) →
  `initialized` → `skills/extraRoots/set` → `thread/start` (with `dynamicTools:[board namespace]` for a new thread; if
  Codex refuses dynamic tools, retried with the board's MCP server and a `huntaway/boardTools {dynamic:false}` line) or
  `thread/resume {threadId, excludeTurns:true}` → optional `thread/revert {beforeTurnId}` → `turn/start {threadId, input:
  [{type:"text",text,text_elements:[]}], summary:"detailed", effort?, sandboxPolicy? , collaborationMode?}`; compaction is
  `thread/compact/start`.
- `thread/start` params: `cwd, approvalPolicy, approvalsReviewer, sandbox, model?, developerInstructions, config:{
  mcp_servers, "tools.update_plan.enabled":true, sandbox_workspace_write:{network_access:true, writable_roots} }`; a
  reviewer instead gets `default_permissions:"huntaway-review"` with a permission profile extending `:read-only`.
- Permission mode → `(approval_policy, approvals_reviewer, sandbox)`: bypass `never,user,danger-full-access`; review
  `never,user,read-only`; dontAsk `never,user,workspace-write`; acceptEdits `on-request,user,workspace-write`; auto
  `on-request,auto_review,workspace-write`; plan `untrusted,user,read-only`; default `untrusted,user,workspace-write`.
- MCP servers are converted from `mcp.json` to Codex config (`command/args/env` or `url/http_headers`; timeouts: board
  `wait.MAX_SECS+300` s, gh 600 s, desktop 300 s; `default_tools_approval_mode:"approve"` for approved servers).
- Its stdin takes the **same stream-json input as Claude's**: `user` lines (first = prompt; during a turn → `turn/steer`
  with `expectedTurnId` and `clientUserMessageId`; between turns → a new `turn/start`), `control_request`/`interrupt` →
  `turn/interrupt`, and `{"type":"codex_response","id",…"result"|"error"}` → the answer to an app-server request.
- Its stdout (`out.jsonl`): a whitelist of app-server notifications passed through verbatim (`thread/started`,
  `thread/status/changed`, `thread/closed`, `turn/started`, `turn/completed`, `turn/plan/updated`, `item/started`,
  `item/completed`, `item/agentMessage/delta`, `thread/compacted`, `thread/tokenUsage/updated`,
  `account/rateLimits/updated`, `error`, `warning`, `model/rerouted`, `mcpServer/startupStatus/updated`); app-server
  *requests* verbatim with the referenced `item` attached; `serverRequest/resolved` for still-open requests; its own
  `huntaway/model`, `huntaway/boardTools`; and Claude-shaped echoes `{type:"user", isReplay:true, uuid, message}` once the
  model has moved past a steered message. It exits 0 when input ends with no turn going; on drop it emits
  `thread/closed` for child threads still open and SIGKILLs the app-server.
- Differences from Claude that matter: one process per run but possibly many turns; requests are answered with
  `codex_response` lines rather than `control_response`; board tools are *dynamic tools* fixed at thread creation
  (`runs.board_tools`; older sessions keep the HTTP MCP server); output becomes thread items directly; no cost figure
  (`total_cost_usd` absent); session id comes from `thread/started`; no hook for gh (only told); no auto-compaction;
  subagents are child threads; `agent_at` is a turn id; usage limit = `turn.error.codexErrorInfo == "usageLimitExceeded"`.

### Other processes and OS interfaces
`git rev-parse --git-common-dir`, `git ls-files --others --ignored …`, `git check-ignore -z --stdin` (reviewer sandbox);
`claude -p --model haiku --output-format stream-json --verbose --tools "" --strict-mcp-config --no-session-persistence
--disable-slash-commands --system-prompt "Reply with only the word OK."` with stdin `OK` (window restart, 60 s timeout);
short-lived `codex app-server` for titles (60 s) and queries (20 s); `ps -axww …`, `lsof` (macOS leftovers); `/proc/net/tcp`,
`/proc/net/tcp6`, `/proc/<pid>/{environ,fd,stat,cmdline,exe,cwd}`; signals to process groups.

Environment variables read: `IA_SHIM_BIN`, `IA_CLAUDE_BIN`, `IA_CODEX_BIN`, `PATH` (CLI presence), `VITEST` (`IN_TEST`),
`CARGO_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME` (Codex writable cache dirs: `~/.cache`, `~/.npm`, cargo `registry` and `git`,
`~/.local/share/pnpm`, created if missing).

## 6. Background work (timers, loops)

| what | interval / duration | file |
|---|---|---|
| Follower poll of `out.jsonl` | 200 ms; shim liveness every 10th poll | runs.ts |
| Shim relay poll of `input.jsonl` | 50 ms | rust/shim |
| Launch wait for `pid` | 100 × 50 ms = 5 s | runs.ts |
| `STOP_GRACE` (interrupt → kill) | 10 s (1 s in tests) | runner.ts |
| `kill` TERM → KILL | 10 s | runs.ts |
| `STEER_GRACE` (messages waiting at turn end must start a turn, else close input) | 30 s (1 s) | runner.ts, queue.ts |
| `BACKGROUND_GRACE` (background tasks ended between turns; wait for the follow-up turn) | 120 s (1 s); re-armed while output grows | queue.ts |
| `FOLLOW_UP_GRACE` (tasks ended during the turn, outcome not yet given) | 15 s (0.5 s) | queue.ts |
| Background-shell stop grace → stop the run | 10 s | runner/background.ts |
| `REAP_WAIT` (shim may still start the agent) / `REAP_GRACE` | 60 s / 10 s; poll 20 ms, 100 ms while stopping | runs.ts |
| Auto-compact tick | at start, then every 60 s; sessions idle ≥ 50 min and < 60 min | send.ts |
| Pruner | at start, then hourly; folders 14 days after end; `mcp_calls` 1 h (batches of 1000); unknown folders 1 h | runs.ts |
| Server scan | every 4 s; 5 min after a run; stop TERM → KILL 5 s; rescan after 0.5 s | servers.ts |
| Temp-folder sweep | at start, then every 10 min | task_tmp.ts |
| Leftover stop | TERM, poll 100 ms, KILL after 5 s if same process (start time) | leftovers.ts |
| Window restart | tick 30 s; prompt 60 s after reset; retry 5, 10, 20, 40 min then hourly | window.ts |
| Codex model cache / skills cache | 10 min / 1 min | codex/queries.ts |

## 7. Surface

HTTP (handlers in `api/thread.ts`, `api/tasks.ts`; all under `/api`):
- `POST /tasks/{id}/messages` `{text}` → Task. Send/steer/queue; also settles open questions.
- `DELETE /tasks/{id}/queue` → the Task *as it was* (so the UI can restore the text).
- `POST /tasks/{id}/stop` → `{stopped}`; stops the run and any review/summary/workflow runs of the task.
- `POST /tasks/{id}/background/stop` `{id?}` → `{stopping: string[]}`.
- `POST /tasks/{id}/servers/{port}/stop` → Task.
- `GET /tasks/{id}/context` → `{context, detail}`.
- `POST /tasks/{id}/wait-for-limit` (usage.ts, "Carry on then").
- Indirect: `PATCH /tasks/{id}` (status moves start runs, merges, unblock), `DELETE /tasks/{id}` (`abort`, `task_tmp.deleted`), project prompt preview (`runner.preview`), `/api/mcp/<run id>/<server>` (MCP HTTP, other area).

MCP tools whose effect lands here: `request_user_input` (sets `runs.attention`), `finish_work` (`runs.finished`),
`background_wait`, `send_to_task` (`send_from_agent`), `update_task` (step out with `remerge`), `wait`.

CLI subcommands: `huntaway codex-run <codex.json>` (adapter), `huntaway gh-hook`, `huntaway approval-hook '<rules>'`
(Claude PreToolUse hooks; they load only their own modules because agents start them often).

Slash commands handled by the board: `/new`, `/compact`, `/plan`.

## 8. Events

Emitted on the host event bus: `{type:"task", task}` on every task change; `{type:"message", task_id, message}`;
`{type:"delta", task_id, text}` and `{type:"delta_reset", task_id}` (streamed reply preview); `{type:"thread_event",
task_id, event}` for item threads. Thread "event" messages (`{level, text, detail}`) written here include: "Setting up
worktree…", "Run stopped", "Run failed", "Compacting stopped/failed", "<config> is out of usage", "Waiting for …'s usage
limit to reset", "Queued until X-1, X-2 are merged", "Back in the merge queue", "Run interrupted by server restart",
"The next message starts a new conversation with the agent", "Couldn't send the queued message: …".
Telemetry: `run_start` (`run_id, kind, runtime, model, effort, permission_mode, resume`), `merge`/`requested`; `run_end`
comes from `agent/tokens.ts`. Test race points: `reached("run:started")`, `"finish:released"`, `"finish:exited"`,
`"task_tmp:removable"`.

Consumed: agent output lines (above); task status changes (via `state.update_task` → `task_tmp.changed`).

## 9. Invariants and hard-won rules

### State machine of a run
```
(start_run tx) preparing ──launch ok──► running ──exit file──► exited
        │ cancel / launch error            │  turn loop: [turn] ─result─► between_turns=1 ─message echoed / init / assistant─► between_turns=0
        └──────────► reap + finish         └─ input closed when a turn ends with nothing waiting → process exits
```
- `start_run` (sync): 400 if the host can't run agents or lacks that CLI; 409 "an agent is already running on this
  thread" if `state.runs` has the task; refuse an archived project; then one transaction: move the thread onto items, take
  the queued message (`Take`: `No` | `Ahead` (queued text goes before this message) | `Only` (the run is *for* the queued
  message; 409 "nothing is queued to send" if another run took it)), insert the run, attach automation runs, insert the
  explaining thread messages. Either the message is still queued or run+messages+emptied queue are all recorded.
- Then: `state.runs.set`, task fields `running=1`, `steerable=!compact`, `run_started_at=now` only if it wasn't running (a
  queued message continues "the same stretch of work"), and unless compact: `attention_reason=null`, `waiting=0`,
  `limit_reset_at=null`, `status = merging ? ready_for_merge : in_progress` (tasks only). A compaction never moves the card.
- If the task update fails (deleted meanwhile) `abandon`: requeue what was taken, requeue steers, delete the run row,
  clear `running` only if no other active run.
- Launch end: started → nothing; cancelled → `reap` + `finish(Cancelled)`; error → `reap` + `finish(Failed)`. "An agent
  that reads its input as it works would wait for more forever, and one started after the launch gave up on it would
  work unseen" (runner.ts).
- `check()` is called just before the shim is spawned, *after* `spec.json` is written, "so a stop that came while the
  run's files were written doesn't leave an agent working unseen" (runs.ts).
- Outcome on exit (`on_exit`), in order: `stop_requested != 0` → Cancelled; `result_error` set → Failed(it); `code == 0
  && saw_result` → Ok; else Failed("the agent exited with code N" / "killed by signal N" / shim error, + stderr tail).
  The **last** turn's result decides.

### Turns, steering, closing the input
- Every run but `/compact` takes input, so the process does not exit by itself: **the server must close the input** or
  the run never ends. "A run with stream-json input only exits once its input is closed, so a server that doesn't know
  to close it must not follow it" (runs.ts). `record_result` calls `turn_ended` even if recording failed (disk full),
  because the line won't be read again.
- A steer is stored on the task first, then written; it enters the thread only when echoed (`isReplay` with its uuid).
  Claude Code echoes when it *takes a message in*, not when it receives it (checked with 2.1.306): one arriving during
  the final reply is echoed after that turn's `result` and starts the next turn of the same process.
- `write_steers` stops at the first failed write to keep order.
- `steered`: remove from `steering`; `between_turns=0`; `stop_requested 2→0`; if from the user also clear `attention` and
  `finished` (another agent's message does not answer the user's question); add the user message with `steered:true`.
- `turn_ended` with nothing waiting: if background tasks are going, leave the input open (HA-187) unless the run was
  stopped (then close + kill); if tasks ended during the turn and some outcomes weren't given to the agent and the run
  asks on its output, wait `FOLLOW_UP_GRACE` for the follow-up turn; else close the input. With steers waiting: wait
  `STEER_GRACE`, then close so they go to the next run.
- An agent that asks on its output needs its input open for any turn (Claude Code denies permission requests with
  "Stream closed" once it's closed), hence `close_unless_turn_starts`.
- A `result` is **not** this run's turn end when (HA-404/405): `origin.kind == "task-notification"` with `num_turns == 0`
  before the run's first result (Claude Code clearing a leftover notification on resume); or the prompt hasn't been
  echoed yet (`awaited` set) and the result has an `origin` or names other `user_message_uuids`. A result naming no turn
  at all still counts (Claude Code failing before taking the prompt).
- A session the model never answered (`is_error`, `duration_api_ms == 0`, zero cost, first run of that session, not
  stopped, task kind `task`) is dropped (`session_id=null`) so the next run starts again from the description.
- Queue vs steer: steer iff a run handle exists, text isn't `/compact`, a `/plan` targets a run that can write documents,
  run kind isn't `compact`, and the run is `preparing` or `accepts_input`. Otherwise `db.queue`.
- `finish` requeues un-taken steers *ahead of* anything queued since; a queued message is sent before the task's column is
  written (so the card stays put) unless the config is out of usage.

### Stop
- `stop`: set `stop_requested=1, stop_id`; if still preparing → cancel the launch; if between turns with background
  tasks and no steer waiting → kill; else write an `interrupt` and arm `STOP_GRACE`; if the agent takes no input → close
  input + kill; if nothing was ever started → `finish(Cancelled)`.
- The interrupted turn's result sets `stop_requested=2`, marks the result `interrupted`, and the run ends Cancelled →
  "Needs attention: Stopped by user", session kept for `--resume`.

### What `finish` writes to the task (first match)
| condition | status | attention_reason |
|---|---|---|
| Cancelled | needs_attention | "Stopped by user" |
| Failed while `limit_reset_at` is in the future | in_progress + `waiting` if profile `limit_wait` (not merging) else needs_attention | first line of the error |
| Failed | needs_attention | "Run failed: <first line>" |
| `runs.attention` set | needs_attention | the question |
| task already `done` | unchanged | |
| merge target closed/deleted (`merge_held`) | needs_attention, leaves the merge queue | "…: choose where it merges now" |
| merging, approval pending | needs_attention | "Approve or deny the merge" |
| merging, `finished`, workflow moves merges to Done | unchanged, `merging=0` | |
| merging otherwise | needs_attention | "The agent finished without marking the task merged" |
| `remerge` | ready_for_merge, `merging=1`, back of the column | |
| assistant / pen threads | todo | |
| routine | done | |
| otherwise | in_review | |
Then: a plan-only candidate leaves the status for `plan.settle` (async, after checkpoints); a workflow column that takes
the task on keeps it in place (or needs attention if it requires `finish_work`); an unfinished todo list keeps it in
"In progress" and nudges once, then "Todo list unfinished: …". Only `kind='task'` rows get a status; all get
`running=0`. The write is conditional on **no later run existing** (`end_run`/`later_run`): "the latest run's start and
end set the task's running state and column; an earlier run that ends after it must leave them".
- Compact runs: only `running=0`, then next merge / unblock; a task waiting on dependencies stays waiting.
- Review-kind runs hand their outcome to `review.finished` / `summary.finished` / `workflows.finished`.

### Restart (`load_active`, called once at startup after the DB is open)
1. `resume_reaping`: for every run folder with `orphan` or `reap`, continue the kill.
2. Settle plan columns left undecided.
3. For each non-exited run: set `state.runs`; **folder format newer than supported** → reap + Failed("This run was
   started by a newer huntaway; update this host to follow it"); **has `out.jsonl` or `exit`** → status `preparing→running`,
   `resume_requests` (re-ask open prompts and board calls from `mcp_calls` *before* re-reading output), `follow` from
   `out_offset`, fix `steerable`, re-arm the stop timer if `stop_requested == 1`, and if `between_turns`: write unwritten
   steers and arm the appropriate grace/close; **neither file** → reap + Failed("Interrupted by a server restart before
   the agent started").
4. Tasks with `running=1` but no run: send the queued message, else "Needs attention: Interrupted by server restart".
5. Expire permission requests of threads with no live run; sync subprojects; `start_queued_merges`; `start_unblocked`;
   resume restacks, GitHub stacks, stack titles.
- SQLite may lose the last commits on a power cut; output after the saved offset is simply applied again, so every
  handler must be idempotent on repeat (ids from the agent, "a request read again finds the same call").
- systemd: a service restart kills the whole cgroup unless `KillMode=process` (docs/guide/server.md).

### "Queue limits" — what actually limits concurrency
There is **no cap on concurrent runs per host, profile or project** (I searched for one; none exists). The limits are:
- **One live run per thread** (`state.runs` keyed by task id).
- **Merge lanes**: one merge at a time per lane. Lane of a task = the open task it merges into, else its subproject
  (`parent_id`), else `null` (the project's top-level lane); a stack level uses the lane of the merged level below. A
  lane's slot is held by a task with `merging=1 AND (running=1 OR status='needs_attention')` and `merge_approval !=
  'pending'`, or one handed to its workflow (ready_for_merge, `merging=0`, latest run `finished=1`). Waiting tasks:
  `merging=1, running=0, status='ready_for_merge'`, ordered by `position, created_at`, excluding held ones, stack levels
  waiting on the level below, and archived projects. A stack run (`stack_run`) owns its lane until its last level merges.
  A merge waiting on the user still holds the lane. Messaging a queued (non-active) merging task → 409.
- **Dependencies** (`waiting=1`) and **usage limits** (`waiting=1` + `limit_reset_at`), both shown in "In progress".
- Review fan-out has its own cap (`MAX_REVIEWERS = 6`, other area).

### Other rules
- `runs.prune` lists folders *before* reading rows: "a run is added before its folder is made, so each folder listed is
  either in what's read or its task is gone". Folders with `orphan` are never removed.
- `kill`/`reap` do nothing after a reboot: the process group is gone and its id may be someone else's.
- Dev-server Stop never signals the agent's, the shim's or the board's process group; it re-checks the pid still names the
  task and still listens on that port.
- Temp root must be a real directory owned by the user and not group/other-writable, or nothing is removed; removal is
  decided and renamed away in one synchronous step so a run starting meanwhile gets a fresh folder.
- Leftover cleanup never touches the board's own server, its ancestors, a server on the board's data dir, or a shim whose
  run is in the board's `runs` folder; processes are matched by pid + start time, never by `pkill` pattern.
- A thread keeps the config folder its session started in (`runs.config_dir` of the session's first run), unless that
  folder no longer exists; otherwise the agent says "No conversation found with session ID".
- The system prompt goes in a file because memory/documents can exceed the 128 KiB argument limit.
- Codex `/compact` may report its end twice (`turn/completed` and `thread/compacted`): the second is ignored.
- The legacy MCP server name `issue_agent` must still be recognised in old transcripts and Codex namespaces.

## 10. How it is tested

- `runner/testing.ts`: sets `IA_SHIM_BIN=/nonexistent/ia-shim` so no real agent starts; `runs.TEST_CAN_RUN` makes the host
  "able to run agents"; `running(input)` fabricates a run (row + folder with empty `out.jsonl`/`input.jsonl` + handle);
  `output(state, run, lines)` feeds lines through `on_output`; `input()` reads what was written to `input.jsonl`;
  `input_closed()`; `restart()` = clear `state.runs` + `load_active`; `replay`, `result`, `background(n)`, `refused_lines`.
- Timing knobs: `runs.timing` (`REAP_WAIT`, `REAP_GRACE`, `FOLLOW_POLL`), `background.timing`, `servers.timing`; grace
  constants shrink under `IN_TEST` (`VITEST` env); `runs.end_watches()` ends watch loops as a stopping server would.
- Race hooks `when(point, f)` / `reached(point)` in `util.ts`.
- `codex/launch.test.ts` uses a fake shim script that records the folder and starts nothing; `set_test_models`.
- `window.test_hooks` (`output`, `pings`) stand in for the ping prompt.
- `scripts/fake-claude` (Python, via `scripts/test-server.sh --fake-claude`, `IA_CLAUDE_BIN`): emits `system init`
  (`session_id` = `--resume` value or new uuid), optionally sleeps, echoes steered `user` lines with `isReplay:true`, asks
  `can_use_tool` for markers `fake-ask-permission|question|plan` when started with `--permission-prompt-tool stdio`,
  answers an `initialize` control request and then makes `mcp_message` `tools/call` requests for `fake-board-call <tool>
  <json>` lines, handles `interrupt` (`control_cancel_request`, success response, an error `result`, exit 0),
  `compact_boundary` for `/compact`, a subagent with stream deltas for `fake-subagent`, `rate_limit_event`s, the
  not-logged-in and usage-limit refusals, then one `assistant` and one `result` (`subtype`, `is_error`, `result`,
  `session_id`, `duration_ms`, `num_turns`, `total_cost_usd`, `modelUsage`), and exits. With `--output-format json|text` it
  is the title generator. Knobs: `IA_FAKE_CLAUDE_{SLEEP,TEXT,RESULT,EXIT,TITLE,LIMIT,USAGE,WINDOW,COST,LOGIN,SESSIONS,LOG,
  STREAM_SLEEP}`. A fake agent must therefore: read the two-line prompt, answer `initialize`, emit `init` with a session
  id, echo messages it takes in, and end each turn with a `result`; it exits only when stdin reaches EOF or by itself.
- Rust: `rust/shim/tests/relay.rs`.

## 11. Dependencies

Calls out to: `db` (tasks, runs, queue, merges, deps, profiles/configs), `threads/*` (message→item translation, `source.flip`
/`settled`, `native.append`, `live.send_events`), `mcp/tools` dispatch, `mcp/permissions`, `mcp/wait`, `mcp/http`,
`mcp/{gh,docs,desktop}_mcp`, `git/worktree` (setup, restack, github, keep_starts, find_pr), `git/checkpoints`
(`before_run`, `after_turn`, rewind), `git/relocate`, `review` / `review/summary` / `review/merge_gate`,
`integrations/workflows`, `integrations/automations` (routines' cost attribution), `agent/usage`, `agent/tokens`,
`agent/documents`, `agent/assistant/memory`, `agent/agent_tools`, `agent/approval_rules`, `agent/title`, `agent/pens`,
`attachments`, `telemetry`, `telemetry/otlp`.

Called by: `serve.ts` startup (`load_active`, `auto_compact`, `usage.resume_loop`, `window.start`, `runs.start_pruner`,
`servers.start`, `task_tmp.start_sweeper`), `api/thread.ts`, `api/tasks.ts`, `api/new_task.ts`, `api/incoming.ts`,
`api/projects.ts`, `api/stack_merge.ts`, `review*`, `integrations/workflows/engine*`, `mcp/tools/*`, `mcp/questions.ts`,
`mcp/permissions.ts`, `mcp/pr_watch/*`, `git/worktree/restack.ts`, `threads/live.ts`, `agent/usage.ts`, `agent/title.ts`,
`agent/assistant.ts`, `agent/documents.ts`.

## 12. Rewrite notes

Essential:
- The shim and its file protocol, including format numbers and the atomic-rename/poll contract; the boot-id check; the
  rule that the server closes the input.
- Offsets + idempotent line handling as the restart mechanism; `mcp_calls` as the at-most-once record of agent requests.
- The synchronous, transactional `start_run`; the "later run wins" rule for writing a task's column.
- The turn/steer/echo model and all four grace timers (each exists because of an observed Claude Code behaviour).
- The `finish` decision table and merge-lane semantics.

Accidental / legacy:
- Rust-port shape: snake_case, one file per former Rust file, `Outcome` as `"Ok" | "Cancelled" | {Failed}` (serde enum),
  `clone()` to copy non-enumerable row fields, `sort_keys` to mimic serde_json, cancel emulated with `pending`/`cancelled`
  flags instead of a dropped future, `watches` counter, comments citing `.rs` files.
- Old formats still read: run format 1 (no `run.json`), `background` as ids or a count, empty `background-ended`, runs
  "from before boot ids", sessions "from before runs kept their folder", Codex sessions with board tools on HTTP MCP,
  `issue_agent` server name, `issue-agent` binary name in leftovers. A new repository with no old runs can drop these but
  must keep the *mechanism* (additive files, format gate) for its own future.
- Subprojects ("legacy-subproject" branches in prompts and lanes) are kept only for existing data.
- Queued message is one concatenated text with four side columns (`queued_*`) rather than a list; `steering` is a JSON
  array on the task. Both are awkward: provenance is merged by AND-ing flags.
- `runs.status` plus six flag columns encode a state machine implicitly; `stop_requested` is a tri-state integer.
- The run's column decision lives in one 230-line function mixing merge, workflow, plan, todo and usage rules.
- Thread kinds are told apart by predicates on task rows (`is_assistant`, `is_routine`, `is_pen_threads`, `kind`,
  `subproject`, `task_type`), which the prompt builder and `finish` both re-derive.
- `agent/servers.ts` is Linux-only; `window.ts` knowledge is in memory only.
- Two transports for board tools (in-process control protocol vs HTTP MCP) exist only because compactions take no input
  and old Codex sessions can't gain dynamic tools.
