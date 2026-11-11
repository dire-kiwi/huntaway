# 7. Agents: runs, threads, board tools, permissions

The part of the server that starts agents, follows them, records what they say, and answers what they ask. It is
the part with the most rules that exist because of a bug, so this page fixes the structure and points at the
inventory for the rules: [01-run-lifecycle.md](inventory/01-run-lifecycle.md), [03-mcp.md](inventory/03-mcp.md),
[08-threads.md](inventory/08-threads.md), [02-agent-support.md](inventory/02-agent-support.md).

## What does not change

- **`ia-shim`** and its command line: `ia-shim <run dir> -- <program> [args…]`. It forks, detaches, runs the program
  with stdout to `out.jsonl` and stderr to `err.log`, relays `prompt` and then `input.jsonl` to its stdin until
  `input.closed` appears, and writes `exit`. It is 135 lines of Rust with one dependency and is copied as it is, with
  its tests.
- **The run folder is the interface.** The server never holds a pipe to an agent. It reads a run's files and
  appends to its input file.
- **How each CLI is driven**: `claude -p` with stream-json in both directions, and `codex app-server` through the
  `codex-run` adapter. Every argument, environment variable, input line and output line the old server uses is in
  inventory 01, section 5, and is the specification for the two drivers.
- **Agents outlive the server.** A restart re-attaches. Nothing in a scope's finalizer signals an agent.

## The run folder<a id="the-run-folder"></a>

`<data dir>/runs/<run id>/`, unchanged ([inventory 01](inventory/01-run-lifecycle.md), section 3). `RunDir` is the
one module that reads and writes it, with a schema for each file:

| File                                   | Writer  | `RunDir` method                                        |
| -------------------------------------- | ------- | ------------------------------------------------------ |
| `run.json` `{ boot, format, version }` | server  | `writeHeader`, `header`                                |
| `prompt`, `input.jsonl`, `input.closed` | server | `writePrompt`, `appendInput(line)`, `closeInput`       |
| `out.jsonl`, `err.log`                 | shim    | `readOutput(offset, max)`, `errorTail`                 |
| `shim.pid`, `pid`, `exit`              | shim    | `pids`, `exit`                                         |
| `spec.json`, `mcp.json`, `mcp-run.json`, `codex.json`, `system-prompt.md` | server | `writeSpec` …            |
| `awaited`, `background*`, `reap`, `orphan` | server | one pair each                                       |

- `appendInput` is one append of one whole line, so the shim never relays half a line. It refuses when the input is
  closed or the run has exited.
- New runs are written as **format 6**, the first format of this code base. The server reads format 5 and 6 and
  fails a run with a higher number ("started by a newer huntaway"). Formats 1 to 4 are not read: the cut-over
  requires that no run is going ([11-migration.md](11-migration.md)).
- The boot id (`/proc/sys/kernel/random/boot_id`, `sysctl kern.bootsessionuuid`) guards every signal: after a
  reboot, recorded pids are never signalled.

## The run<a id="the-run"></a>

```ts
export const RunPhase = Schema.Literals(["preparing", "running", "exited"])
export const StopState = Schema.Literals(["none", "requested", "interrupted"])

export class Run extends Schema.Class<Run>("Run")({
  seq: Schema.Int, // order of starting; "a later run" is a higher seq
  id: RunId,
  task_id: TaskId,
  kind: Schema.Literals(["prompt", "compact", "review"]),
  phase: RunPhase,
  out_offset: Schema.Int, // bytes of out.jsonl applied
  stop: StopState,
  stop_id: Schema.NullOr(Schema.String),
  between_turns: Schema.Boolean,
  saw_result: Schema.Boolean,
  result_error: Schema.NullOr(Schema.String),
  attention: Schema.NullOr(Schema.String), // the agent asked the user something
  finished: Schema.Boolean, // the agent called finish_work
  session_id: Schema.NullOr(Schema.String),
  config_dir: Schema.NullOr(Schema.String), // the first run of a session pins its folder
  // … cost, tokens, effort, board_tools, agent_at, turn_write_no, created_at, ended_at
}) {}

export type Outcome = { _tag: "Ok" } | { _tag: "Cancelled" } | { _tag: "Failed"; reason: string }
```

`Run` is server-side only, so it is a class with methods (`isLive`, `acceptsInput`).

### Services

| Service         | Does                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunRepo`       | The `runs` table: `active`, `latest(task)`, `laterThan(run)`, `sessionConfigDir`, `addCost` (cost as the increase of a session's running total)     |
| `RunDir`        | The folder, above                                                                                                                                 |
| `Shim`          | Finding the binary, spawning it detached with the agent's environment, waiting up to 5 s for `pid` or `exit`                                       |
| `AgentDriver`   | One per CLI, below                                                                                                                                |
| `RunFollower`   | One fiber per live run, in a `FiberMap` keyed by run id                                                                                           |
| `Runs`          | The commands: `send`, `start`, `stop`, `abort`, `steer`, `dropQueued`, `newSession`, `compact`                                                     |
| `BackgroundWork`, `DevServers`, `Compaction` | Claude's background tasks; listening sockets of a task's processes; compaction of idle sessions                      |

```ts
export class Runs extends Context.Service<Runs, {
  /** A message for a thread: steered into the live run, queued, held for dependencies or usage, or it starts a run. */
  send(task: TaskId, message: Outgoing): Effect.Effect<SendResult, TaskNotFound | ProjectArchived | MergeNotActive | AgentsUnavailable>
  stop(task: TaskId): Effect.Effect<{ stopped: boolean }, TaskNotFound>
  abort(task: TaskId): Effect.Effect<void> // before deleting: clear the queue, kill at once
  dropQueued(task: TaskId): Effect.Effect<Task, TaskNotFound>
  isRunning(task: TaskId): Effect.Effect<boolean>
  /** For Recovery: adopt every run that had not exited. */
  readonly reattach: Effect.Effect<void>
}>()("huntaway/runs/Runs") {}

export type Outgoing = { text: string; source: "user" | "agent" | "routine" | "automation" | "board"; auto?: boolean; review_round?: number; automation_run_id?: string }
```

### Starting

`Runs.send` takes the task's lock and decides with a pure function (`decideSend`: steer, queue, wait, or start).
Starting has two parts, as now:

1. **Register** (one transaction): insert the run as `preparing`, take what is queued (ahead of this message, or as
   the message), write the thread items that explain it, set the task `running`. Either the message is still queued
   or the run, its items and the emptied queue are all recorded.
2. **Launch** (a fiber in the follower map, after the transaction): wait for a relocation or restack to settle, set
   up the worktree, take a checkpoint, build the prompt and system prompt, ask the driver for the launch spec, write
   the folder, check for cancellation one last time, spawn the shim, then follow. A stop during this part interrupts
   the fiber; its finalizer reaps anything the shim may still start and ends the run as cancelled.

Interruption replaces the old `Cancelled` exception and `check()` calls. The one place it must be checked by hand
stays: after `spec.json` is written and before the shim is spawned.

### Following

```ts
const follow = (run: Run) =>
  Effect.gen(function* () {
    const driver = yield* drivers.for(run)
    let offset = run.out_offset
    while (true) {
      const chunk = yield* dir.readOutput(run.id, offset) // whole lines only, unless the run has exited
      for (const line of chunk.lines) yield* driver.handleLine(run.id, line) // safe to repeat
      if (chunk.lines.length > 0) offset = yield* repo.saveOffset(run.id, chunk.end)
      if (chunk.exit !== null && chunk.drained) return yield* changes.put({ _tag: "RunExited", run: run.id, exit: chunk.exit })
      if (chunk.lines.length === 0) yield* Effect.sleep("200 millis")
      // every 10th idle pass: is the shim alive, on this boot?
    }
  })
```

- Each line's effects and the new offset are **not** one transaction (a line can start a process). So a line may be
  applied twice after a crash, and every handler is written for that: ids come from the agent, an agent request
  "read again finds the same call", a thread item added twice replaces itself. (As built in 2.5, what a line writes to
  the database, its thread items included, *is* committed with the offset after it; what it does outside comes after.)
- The follower is the only writer of a run's progress columns (`between_turns`, `saw_result`, `session_id`…), so
  they need no lock.
- The timers that decide when to close a run's input (steer grace, background grace, follow-up grace, stop grace)
  are `Effect.sleep`s raced inside the follower and re-armed from the run's columns when it is re-attached. Each
  exists because of something Claude Code was seen to do; inventory 01, section 9 has them one by one. **The server
  closes the input, or the run never ends.**

### The two drivers

```ts
export interface AgentDriver {
  readonly agent: "claude" | "codex"
  /** What to run and what to put in the folder for this run. */
  launch(input: LaunchInput): Effect.Effect<LaunchSpec, LaunchRefused>
  /** One line of the run's output. */
  handleLine(run: RunId, line: string): Effect.Effect<void>
  /** Lines for the run's input. */
  userMessage(id: string, text: string): string
  interrupt(stopId: string): string
  answer(request: AgentRequest, answer: AgentAnswer): string
}
```

`ClaudeDriver` and `CodexDriver` each have three parts, in `agents/claude/` and `agents/codex/`:

- **`launch.ts`**: the argument list, environment, `mcp.json`, hooks and prompt lines. Pure given its input, and
  tested by comparing with launch specs recorded from the old server for the same input.
- **`lines.ts`**: a schema for each line the CLI writes (a union on `type`/`subtype`, or on `method` for Codex), so a
  malformed or unknown line is logged and skipped, never thrown through the follower.
- **`translate.ts`**: lines to thread events. For Claude this is the old `Translator` with its state (open calls by
  id and session, subagents, results that arrive before their call, prompts waiting for their call) and without the
  legacy message step in the middle. For Codex it is the old `driver.map`. Both are pure functions of
  `(state, line) → (state, events, effects)` and are tested against the recorded sessions.

The translator's state for a thread is kept by `Threads` while the thread is being written and rebuilt from the
stored items when it is not. Two kinds of held state are lost on a restart today (results before their call, prompts
before their call); they are now part of what a run's follower rebuilds by re-reading from the saved offset.

As built (HE-4, 2.4's line schemas and translator), in `agents/claude/`:

- **`lines.ts`**: `decodeLine(text) → Result<ClaudeLine, LineProblem>`, one precompiled decoder per `type`
  (`system/<subtype>` for system lines). A problem is `NotJson`, `Codex` (a `method`), `Ignored` (system `status`,
  `hook_*`, `api_retry`, `thinking_tokens`), `Unknown` (a newer type) or `Malformed` (a field the server reads of the
  wrong type): the follower logs and skips it. Decoding drops what the server does not read, which is most of `slim`.
- **`translate(state, line, { writeNo, at, turn? }) → { state, events, metas, effects, warnings }`**. The state is
  immutable (persistent `HashMap`s), so a caller whose append failed keeps the state from before the line. `writeNo`
  is the board's write number the line's own ids take (`legacy:<writeNo>…`). For a `result`, `turn` carries what the
  run knows: the cost the turn added (`turnCost(line)` → `RunRepo.addCost`, computed before translating), whether a
  stop cut it short, whether the run is a compaction's. `isForeignResult` is the HA-404/405 check the follower makes
  before. Effects: `SessionStarted`, `TurnStarted` (`init` — unless a steer started it —, `message_start`,
  `assistant`), `TurnEnded` (`error` = the run's `result_error`, `interrupted`, `usageLimit`), `PreviewReset`,
  `PreviewText`, `Echoed` (an `isReplay` echo: its uuid and `<task-notification>` task id), `AgentAt`, `RateLimit`,
  `Compacted`. Control lines and `background_tasks_changed` make nothing: the follower reads them.
- **Board writes are not translated**: `observe(state, events)` takes in what `Threads` wrote itself (a user message
  starts what a turn says afresh; any item ends a compaction's claim to the next summary; requests and their
  resolutions are what link prompts and make a denied call's error `denied`). `requestForPrompt(state, prompt)`
  (`requests.ts`) builds a prompt's request (plan, questions, permission) and links it to its call with the old rules
  (`linkPrompt`); `translate` opens it again, linked, when a call it waited for comes. `stateFromItems(items, requests,
  meta)` is the old `Translator.from`.
- **`ItemMeta`** (the schema of inventory 08, 3.3) is declared in `state.ts` until the thread store's is merged.
- **Decided**: a Claude `compact_boundary` with a `parent_tool_use_id` goes in that subagent (the old `slim` dropped the
  field, so its summary was never placed); a `task_*` line's `session_id` is not used to tell calls apart (the old
  board deleted it); the import-only `finish` (cancel what is open at the end of a history) is not ported.

`codex-run`, the adapter process between a run's files and `codex app-server`, is ported as its own entry point
([inventory 01](inventory/01-run-lifecycle.md), section 5, _Codex_).

### As built in 2.3 (HE-4)

- **Driver types live in `agents/AgentDriver.ts`, as types only**: `ProcessSpec` (program, args, env pairs, cwd),
  `LaunchSpec` (that plus the config folder, prompt, whether it takes input, the awaited prompt id, the system prompt,
  `mcp.json`'s servers, `mcp-run.json`'s `McpRunSettings`). `agents/` is above `runs/`, so a driver never sees `Run`,
  `RunDir` or `RunRepo`: `RunDir.prepare(run, spec)` writes the folder (spec.json last) and `Shim.spawn(run, spec)`
  starts it. The config folder's variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `~` expanded) is one of the spec's env
  pairs, the driver's to add.
- **The follower's line handler is `runs/RunOutput`** (`handle(run: Run, line): Effect<void>`), not
  `AgentDriver.handleLine`: handling a line writes the run's progress columns (`RunRepo`), which `agents/` cannot
  reach. The Claude and Codex pieces supply its layer, built from their pure `translate.ts`; until then
  `RunOutput.layerLog` logs and drops. A defect in it is logged and the follower goes on with the next line.
- **`RunExited { run, task, exit, errorTail }`** is what the follower offers on `Changes` once the exit file exists and
  everything before it is applied (or the folder was removed, or the shim vanished, with the old error texts). The
  reactor works the outcome out from it and the row (the `Outcome` type is in `runs/Run.ts`); until then it ignores it.
- **`Run`** is a `Schema.Class` read straight from the row (`status AS phase`); `isLive` is "not exited", `acceptsInput`
  "live and not a compaction" (whether the agent still reads input is `RunDir.acceptsInput`, from the files). The
  `usage_*` columns are left to `Tokens`. `RunRepo.addCost` reads and writes in one transaction.
- **`RunDir`** has every file of the table above but `codex.json` (the Codex piece's) and the `background*` files
  (2.8). It reads the boot id once (`/proc/sys/kernel/random/boot_id`, else `sysctl -n kern.bootsessionuuid`) and
  writes it in `run.json`; `rebooted(run)` guards every signal.
- **`Shim`**: `binary` (`--shim-bin`/`HUNTAWAY_SHIM_BIN`, else the newer of the checkout's `target/{release,debug}`,
  else beside `HUNTAWAY_EXE`), `spawn` (refuses a started run, a missing shim or cwd; the shim's first process is
  spawned *not* detached, so that closing its scope never signals a process group the forked shim may not have left
  yet; up to 5 s on a `Schedule` for `pid` or `exit`), `kill` (SIGTERM, SIGKILL 10 s later if no `exit`), `vanished`,
  `stopOrphan`/`watchOrphan` (the old `stop_orphan`/`watch_orphan`, marker `orphan`). The old `reap` (a launch given
  up on) belongs with `Runs`' launch and is not here yet.
- **`ServerConfig`** gained `shimBin`, `claudeBin` (`--claude-bin`/`HUNTAWAY_CLAUDE_BIN`, default `claude`), `noAgents`
  (`--no-agents`/`HUNTAWAY_NO_AGENTS`: `Runs` will refuse to start agents), `exe` (`HUNTAWAY_EXE`) and `agentEnv`, the
  overlay that removes `SERVE_ENV` (the old list under `HUNTAWAY_*` names, plus `SKIP_DB_BACKUP`, `NO_AGENTS` and
  `TASK_ID`) from a child's environment. It is there rather than `Proc.agentEnv()` because `ServerConfig` is the one
  place the environment is read; `Proc`'s scripts take it from there too when they come.
- **`fake-claude`** (`packages/testing/bin/fake-claude`) with stream-json input now waits for more after its result,
  as Claude Code does: each further user message is echoed and answered by a turn, and it exits when its input ends.
  The old one exited after its first result, which let a server that never closes the input pass. A prompt with
  `fake-until-interrupted` (new) keeps its turn going until an `interrupt`, then ends it as Claude Code does
  ("[Request interrupted by user]" and an `error_during_execution` result), for checks of a stop.
- **`host.info`** says `agents: !noAgents` and `agent_clis: ["claude"]` (none with `--no-agents`), the old
  `can_run_agents` without its look for the shim and `claude` on the PATH; it had said `agents: false`, so the web app
  never started a fresh task moved into In progress.

### As built in 2.4 and 2.5 (HE-4): the Claude launch, `Runs`, the line handler

- **The launch is `agents/claude/launch.ts`** (`claudeLaunch(input) → LaunchSpec`), pure given `ClaudeLaunchInput`:
  the run and its folder, its kind, the task (`id`, `kind`, `merging`, `session_id`), cwd, `claude`, the launcher (for
  the gh and approval-rules hooks; none without it), the config folder and proxy env, model, effort, permission mode,
  the thread's rules (`forMode` applied inside), the project's tools (`RunTools`, `noRunTools` until `AgentTools`), which
  of the board's HTTP servers this server serves (`ServedServers`), the GitHub account, the extra folders, the prompt
  text and its id, the system prompt, and `mcp: { url, secret, manifest }`. It returns the argument list in the old
  order (with `--mcp-config` last), the env pairs (`CLAUDE_CONFIG_DIR` among them), the two prompt lines (`initialize`,
  then the user message) or a compaction's plain prompt, `mcp.json`'s servers and `mcp-run.json`. `userInput`,
  `interruptLine`, `controlResponse` and `initializeLine` are the lines the server writes. It is checked against 13
  launches recorded from the old server (`agents/claude/fixtures/launchSpecs.ts`: the old launch run under Node with a
  stand-in ia-shim, ids and folders replaced by placeholders). `agents/claude/access.ts` is the old `access.ts`'s pure
  rules (board, gh, desktop, docs and reviewers' tools, `approvesOwnWaits`, `githubAccount`, `codexEffort`,
  `reviewFilesystem`, `cacheDirsIn`); its git and Codex-model parts are M5's. **Decided**: gh's read-only tools stay in
  `--allowedTools` whether or not the board serves gh (as before), and `mcp.json` names only the HTTP servers the board
  serves (`AgentRequests.served`: none yet), so no run is pointed at a server that is not there. The internal URL is
  `http://127.0.0.1:<--port>`; with `--port 0` it is not known when the launch runs (only a compaction's `mcp.json`
  uses the board's HTTP server).
- **`runs/LaunchFacts`** gathers the input (the old `launch`'s preparing half): the task's config (adopting the first
  available for a thread with none and no conversation), the config folder its conversation is kept in
  (`task_config_dir`), its proxy, cwd (the parent's ready worktree for a review thread, else the task's worktree, else its
  project's repository, else `<data dir>/profiles/<id>/scratch`), a labelled task's documents folder, a group task's
  repositories, mode, model and effort as before, the prompt (`Prompts.start`, or the text for a compaction) and system
  prompt (`Prompts.system`), the run's secret (`Identity.runSecret`) and manifest. It records the run's `config_dir` and
  `effort`. Left with their areas: worktrees, checkpoints and rewinds (M4), the temp folder and lost background work
  (2.8), the project's tools (`AgentTools`), attachments' folders, telemetry's env, the assistant's workspace and
  memory (6.7), Codex (M5).
- **`Runs`** (`runs/Runs.ts`): `send(task, Outgoing) → Task` (fails `TaskNotFound | SendRefused`), `sendQueued(task)`
  (for 2.6: what is queued, `take: "Only"`), `stop(task) → { stopped }`, `abort(task)`, `dropQueued(task) → Task` (as
  it was), `isRunning(task)`, `newSession(task)` (`/new`), `compact(task, why)` (the board's own compaction, with a
  notice), `launched(task)` (waits for a launch: tests), `reattach`, `startWaiting(task)` and `startUnblocked(project)` (2.6, below). `Outgoing` is `{ text,
  source: user | agent | routine | automation | board, auto?, review_round?, automation_run_id?, review? }`.
  `SendRefused.reason` is `archived`, `merge_queued`, `no_agents`, `already_running`, `no_conversation`,
  `nothing_queued` or `agent_running`; `rpc/tasks.ts` maps them to `Conflict`, `Unavailable` and `Invalid`.
  `tasks.delete` aborts the task's run first. The decision is `decideSend` (`runs/queue.ts`, pure, the old
  `send_message`'s order); merges' "active merge of the lane" is none until M4, and usage holds are left to `Usage`.
  `/plan` gives a task the plan label in the transaction that steers, queues, waits or registers the message. A `/plan`
  is steered only into a run that may write the documents folder (it started with labels), as before; that set is kept
  in memory and lost on a restart.
- **Registering** is one transaction: the run `preparing`, the queue taken (`No`, `Ahead`, `Only`), the user message
  (or a task's start message: `auto`, `start`) with its metas, the run's `write_no`, and the task's columns (`running`,
  `steerable`, `run_started_at` unless it was running, and unless a compaction `attention_reason`, `waiting`,
  `limit_reset_at` and the working status), written through `TaskRepo` and `deriveColumns` (the task's lock is held, so
  not `Tasks.change`), then `TaskChanged` offered. The **launch** is a fiber in a `FiberMap` keyed by task: the facts,
  `RunDir.prepare`, the check that the row is not stopped (after `spec.json`), `Shim.spawn` uninterruptibly, the phase
  `running`, the steers written, `RunFollower.follow`. A stop while it prepares removes the fiber from the map.
- **What `Runs` offers when a launch ends without starting its agent** (failed, or interrupted by a stop, or stopped
  before anything started): `Shim.reap(run)` (input closed, and an agent the shim starts within 60 s stopped, marked
  `reap`), then `RunExited { run, task, exit: { code: null, signal: null, error: <why> }, errorTail: "" }`. The run's row
  is left as it is (`preparing`, `stop: requested` after a stop), so 2.6's outcome rule (stopped → cancelled; else failed
  with the error) works it out as for any exit, and 2.6 ends the row and writes the column.
- **The queue and steers are rows** (`TaskRepo.queued`, `enqueue`, `takeQueued`, `queueAhead`, `steers`, `addSteer`,
  `steerWritten`, `takeSteer`, `takeSteers`); `combine` (`runs/queue.ts`) is the old `Queued::then` over them. A
  message is another agent's (`from_agent`) when its source is `agent`, `routine`, or `automation` with text.
- **`runs/RunInput`** writes to a run's input and closes it: `writeSteers(task)` (in order, stopping at the first that
  can't be written; the text through `Prompts.steer`, which rewrites `/plan` and adds the mentions note),
  `steered(run, id)` (database only: the steer row goes, the user message is written `steered`, `between_turns` off,
  `stop` interrupted → none, a user's steer clears `attention` and `finished`, the next turn's `write_no`),
  `turnStarted`, `turnEnded(run)` (closes the input with nothing waiting, else `STEER_GRACE` 30 s),
  `interrupt(run, stopId)` (the `interrupt` line and `STOP_GRACE` 10 s), `closeAndKill`, and `rearm(run)` for 2.6.
  **The timers** are fibers in `RunInput`'s two `FiberMap`s keyed by run id (stop, steer), each reading the run's row
  when it fires, so they are re-armed from the row (`rearm`); `settled(run, timer)` waits for one (tests).
  `BACKGROUND_GRACE` and `FOLLOW_UP_GRACE` are 2.8's, at the hooks marked in `turnEnded`.
- **The line handler is `runs/claude/output.ts` (`ClaudeOutput`, the `RunOutput` layer)**. `RunOutput.handle(run,
  line, end)` now takes the offset after the line and saves it in the line's transaction; the follower stays generic
  (it saves the offset after a line whose handling failed, and after each chunk). Per line: `decodeLine` (a problem is
  logged and skipped); the translator's state, kept per thread with the thread's `seq` it has seen (rebuilt with
  `stateFromItems` from `Threads.stored` when a run is followed afresh, and brought up to date with what others wrote,
  from the thread's log, before each line); then one transaction: the HA-404/405 foreign result skipped, the cost
  (`RunRepo.addCost`), `translate` inside `Threads.writeFromAgent` for the lines that make items (the others take no
  write number), the effects (session id on the task and run, turn started, the turn's end recorded with the task's
  cost and session and the never-answered session dropped, steers taken in, `agent_at`), Claude Code's refusal of the
  board's tools as a notice, and the offset. After the commit: the `awaited` file, the preview (`Threads.preview` /
  `endPreview`), the agent's requests to `AgentRequests`, and `RunInput.turnEnded` — also when the transaction failed,
  for a result. Rate limits, compactions' statistics, background tasks and task notifications are hooks for 2.8 and
  `Usage`.
- **`runs/AgentRequests`** is the registry the areas below `runs/` answer agents through: `register(kind:
  "can_use_tool" | "mcp_message", { handle(run, request), cancel(run, requestId) })` (an area's layer registers when it is
  built; registering again replaces), `provideServers({ manifest(review), served })`, and for the line handler and the
  launch `handle(run, request)` (in the background; a kind nobody registered, or one the board doesn't handle, is
  answered at once with `{ subtype: "error", request_id, error: "the board doesn't handle \"<kind>\" requests" }`),
  `cancel(run, requestId)` (every handler hears it), `respond(run, response)` (a `control_response` on the input),
  `manifest(review)` and `served`. Until something registers: no tools, no HTTP servers. 3.1's `McpControlRegistered`
  registers `mcp_message` and the manifest; `Permissions` (3.3) registers `can_use_tool`.
- **Shared edits**: `ServerConfig.layerTest` gives no ia-shim by default (`/nonexistent/ia-shim`), so no test starts an
  agent unless it gives a shim and a fake `claude`; `Prompts.steer`; `RunDir.readOutput` gives each line's end
  (`ends`); `RunRepo.startTurn`, `sessionStartedBy`; `Shim.reap`, `watchReap`.

### The follower after the M2 measurement (HE-4)

The follower missed its limit by 10× ([10-testing.md](10-testing.md#measurements), As measured at M2). What changed,
in the order it was tried:

- **No per-line decoder or span** (2.5): row readers decode with a decoder made once per row schema
  (`platform/columns.ts` `rowsOf`, synchronous: `Schema.decodeUnknownResult`), not `SqlSchema.findAll` built on each
  call; `toJson` encodes synchronously; the per-line functions are `Effect.fnUntraced`; the follower's fiber runs with
  the tracer off (`Effect.withTracerEnabled(false)`: nothing collects spans, and each statement and transaction made
  several).
- **No redundant work** (2.5, 2.8):
  - `Threads.writeFromRun(task, make)` is `writeFromAgent` for the line handler: in the line's transaction, with no
    check that the task is there (the line read the run's row, and a run goes with its task) and no savepoint. The
    board's writes check with `TaskRepo.exists`, not by reading the whole task.
  - Every top-level assistant message says `TurnStarted`; only one that finds the run between turns writes
    `between_turns` (`RunRepo.startTurn` and `RunInput.turnStarted` return whether it was), and **`BackgroundWork.sync`
    runs when a turn really starts, a turn ends or a message is echoed**, as the old `turn_started` did (`if
    (r.changes) background.sync`), not on every message (it read the run twice, the steers and two files and wrote in
    a second transaction).
  - `agent_at` is written with the offset (`RunRepo.saveOffset(run, offset, columns)`); a thread write takes its
    events' numbers in the statement that makes the thread (`… ON CONFLICT DO UPDATE SET seq = seq + n RETURNING`).
- **Several lines to a transaction** (2.5): `RunOutput.handleChunk(run, lines)` (optional; the follower uses it for a
  read of more than one line) applies up to `CHUNK_LINES` (64) lines in one transaction. A transaction ends after a
  line that isn't `deferrable`: anything but a message or a part of one that starts and ends no turn, takes nothing in
  and writes to the thread only its own items. So the lines it holds before its last left the run's row and the
  thread's `seq` as they found them, and neither is read again; and what a line sets off (a turn's end closing the
  input, a request answered, a steer taken in) follows the commit with nothing applied after it, as with a
  transaction per line. What follows each line's commit follows the transaction's, line by line in order; the reply
  being written is published from the transaction's `afterCommit`, in order with the items that end it. A transaction
  that fails is rolled back whole and its first line handled on its own, as before. A line's items and the offset after
  it are still committed together, so a power cut loses both or neither (`tests/e2e/restart.test.ts`).

### When a run ends<a id="when-a-run-ends"></a>

`RunExited` goes to the reactor, which holds the task's lock and:

1. Works out the outcome: stopped → cancelled; the last turn's result was an error → failed; exit 0 after at least
   one result → ok; otherwise failed with the exit code, signal or shim error and the tail of `err.log`.
2. Requeues steers the agent never took in, ahead of anything queued since.
3. If a later run exists for the task, records this run as exited and stops: **the latest run's start and end set the
   task's column; an earlier run that ends after it leaves it alone.**
4. Gathers the facts and calls `decideFinish`, a pure function that returns the task's next column and reason. Its
   table is the old `finish` ([inventory 01](inventory/01-run-lifecycle.md), section 9), first match wins:

   | Condition                                                   | Column                                   |
   | ----------------------------------------------------------- | ---------------------------------------- |
   | Cancelled                                                   | Needs attention: "Stopped by user"       |
   | Failed on a usage limit that will reset                     | In progress and waiting, or Needs attention, by the profile's setting |
   | Failed                                                      | Needs attention: "Run failed: …"         |
   | The agent asked a question                                  | Needs attention: the question            |
   | The task is already done                                    | unchanged                                |
   | Its merge target was closed or deleted                      | Needs attention, out of the merge queue  |
   | Merging, and the approval is pending                        | Needs attention: "Approve or deny the merge" |
   | Merging, `finish_work` called, the workflow takes merges    | unchanged, out of the merge              |
   | Merging otherwise                                           | Needs attention: finished without merging |
   | Stepped out to fix something (`remerge`)                    | Ready for merge, back of the queue       |
   | Assistant or pen thread                                     | To do                                    |
   | Routine                                                     | Done                                     |
   | A workflow column takes the task on                         | stays, held for the workflow             |
   | A plan-only run                                             | Needs attention: "Plan ready for review" |
   | Its todo list is unfinished                                 | In progress, nudged once                 |
   | Otherwise                                                   | In review                                |

5. Sends a queued message before writing the column (so the card stays where it is), unless the config is out of
   usage.
6. Commits, publishes, and carries on as for any `TaskChanged`.

Review, summary and workflow-step threads' runs hand their outcome to `Reviews`, `Summaries` and `WorkflowEngine`
instead of step 4.

As built in 2.6 (HE-4):

- **`decideFinish(facts) → { notices, columns, sendQueued, nudge }`** (`runs/finish.ts`, pure) is the old `finish`
  table, first match wins, with `outcomeOf(run, exit, errorTail)` (the old `on_exit`) and the todo-list hold
  (`unfinished`, `todoReason`, `nudged`). The facts later areas give are there and false until they come: `mergeHeld`
  and the merge rows (M4), `mergesToDone` (6.6), `planOnly` (a plan-only run needs the turns' checkpoints, M4: until
  then a plan task goes to In review), the workflow column that takes a task on (6.6, not in the facts yet). A compaction
  only stops running (with "Compacting stopped" / "Compacting failed"); a review thread's run only stops running (its
  outcome is `Reviews`' later).
- **`runs/RunEnds.ended(RunExited)`**, which the reactor calls: (1) under the task's lock, in one transaction: the
  outcome, `RunRepo.end` (a run already ended is left alone, so an exit read twice does nothing), the run's steers queued
  again ahead of what was queued since (`takeSteers` + `queueAhead`), whether a later run exists, the decision and its
  notices; (2) `Tokens.runEnded`, `DevServers.notifyRunEnded`, `AgentRequests.ended(run, idle)` (the handlers let the
  run's prompts go: 3.3), the preview ended; (3) with no later run, `Runs.sendQueued` unless out of usage (a run started,
  or the task waiting for dependencies, ends it there; a refusal is said: "Couldn't send the queued message: …"); (4)
  under the lock again, the column, written only if no later run has started meanwhile, then `TaskChanged`; (5) the
  nudge, a board message (`auto`) that starts a run, or Needs attention if it can't be sent. The column is written with
  `TaskRepo.write` and `deriveColumns` under the lock rather than `Tasks.change` (which takes the lock itself), with the
  `TaskChanged` offered here.
- **`Runs.reattach`** (Recovery, before `startUnblocked(null)`): each folder marked `orphan` or `reap` carries on
  (`Shim.resumeMarked`); each run that had not exited is adopted: a newer format, or one never started (no `out.jsonl`
  nor `exit`), is reaped and offered as `RunExited` with the old error texts; otherwise it goes `running`, its open
  requests are taken up again (`AgentRequests.resume`, before its output is read again), it is followed from its offset,
  `steerable` is set right, and `RunInput.rearm` re-arms its stop grace and, between turns, writes unwritten steers and
  closes the input or arms `STEER_GRACE`. Tasks marked running with no live run send what is queued, else need
  attention ("Interrupted by server restart"). Plan columns left unsettled by a restart (the old `settle_plans`) wait
  for checkpoints (M4).
- **`Runs.startUnblocked(project)`** (the reactor on a status, dependency or deletion change, and Recovery) starts the
  tasks `Dependencies.ready` finds with `Runs.startWaiting` (the old `start_waiting`: what is queued, else the task's
  start, else a note to carry on; an archived project's task goes back to waiting; a failure needs attention).
  `Dependencies.reconcile` stays as it was for tests of `ready`. `Dependencies.layer` moved into `TasksLive`.
- **Whole-server tests** (`tests/e2e/restart.test.ts`): the server stopped under a running fake agent, and the next on
  the same data folder adopts the run and ends it in In review; a power cut, the database put back to a copy taken while
  the agent worked, and the run's output applied again from the offset the copy has, with nothing doubled. Because a
  line's thread items and the offset after it are one transaction, a power cut loses both or neither. The e2e harness
  kills the agents a data folder's runs started when the test ends (`e2eDataDir`).

## Threads<a id="threads"></a>

```ts
export class Threads extends Context.Service<Threads, {
  /** Board-side writes. Each takes the next write number and commits its items and events together. */
  userMessage(task: TaskId, text: string, meta: UserMessageMeta): Effect.Effect<WriteNo>
  notice(task: TaskId, level: "info" | "warning" | "error", text: string, detail?: string): Effect.Effect<WriteNo>
  openRequest(task: TaskId, request: NewRequest): Effect.Effect<WriteNo>
  resolveRequest(task: TaskId, id: RequestId, resolution: Resolution): Effect.Effect<void, RequestNotOpen>
  /** An agent's output: events from a driver's translator. */
  appendFromAgent(task: TaskId, events: ReadonlyArray<NewEvent>, meta: ItemMetas): Effect.Effect<void>
  /** Streamed text for the reply being written. Never stored. */
  preview(task: TaskId, text: string): Effect.Effect<void>
  /** A window and then everything after it, for threads.watch. */
  watch(task: TaskId, options: { limit: number; since?: number }): Stream.Stream<ThreadMessage, TaskNotFound>
  page(task: TaskId, before: number, limit: number): Effect.Effect<ItemPage, TaskNotFound>
}>()("huntaway/threads/Threads") {}
```

- **Items are written directly.** The old path (phrase the write as a legacy message, translate it, keep enough in a
  request's metadata to rebuild the message for an update) is gone. A permission prompt is opened with
  `openRequest` and settled with `resolveRequest`; `resolveRequest` is the compare-and-set that makes the first of
  two answers win.
- **One writer at a time per thread.** `ThreadStore.append` runs in a transaction: number the events after
  `threads.seq`, apply each to `thread_items` and `thread_requests`, save the events, bump `seq`, prune events older
  than a day. Published after commit, in order. Saved events are gapless per thread.
- **Live fan-out** is a `PubSub` per watched thread, made when the first watcher subscribes and dropped with the
  last. `watch` subscribes before it reads the window.
- **`ThreadReaders`** has the readers other areas use, with their exact old meanings (inventory 08, section 3.8):
  `lastAssistantText`, `saidSinceAsked`, `lastTurnEnd`, `userReplies`, `movedOn`, `toolCallsSince`, `openQuestions`…
  Review prompts, waits and push notifications depend on them.
- **A request has one source of truth.** `permission_requests` holds a prompt's status; the thread's request is
  written from it in the same transaction. The old code kept the mutable card state in the thread request's
  metadata and read it back.
- **Todos on a card** still come only from a completed, top-level todo call.

As built (HE-4, 2.2), in `apps/server/src/threads/`: `model.ts` (`WriteNo`, `ItemMeta`, `Entry`, `legacyId`,
`writeNoOf`), `ThreadStore.ts`, `Threads.ts`, `ThreadReaders.ts`; `rpc/threads.ts` serves `threads.watch` and
`threads.page`.

- **The interface as built** differs from the sketch above: `notice`'s level is the protocol's (`warning`, not
  `warn`); `openRequest` takes a `NewRequest` (a `ThreadRequest` without `resolution`, its `id` optional: left out, it
  is `legacy:<n>`); `appendFromAgent(task, events, metas?)` returns the saved events; `writeFromAgent(task, make)` is
  added for agent output that needs a write number (`make(n)` returns the events, in the write's transaction);
  `endPreview(task)` ends the reply being previewed; `stored(task)` reads every item with its meta and write number,
  and the requests, in one transaction: **the hook a translator rebuilds its state from** (the translator and the
  per-thread cache of its state are 2.4's); `watchers(task)` says how many watch a thread; `prune` is the hourly sweep
  (`Threads.pruner`, run from `ThreadsLive`). Writes fail with `TaskNotFound` for a task that is not there.
- **A thread's own state** (`Thread`) is read from its task on every snapshot: `status` from `tasks.running` and the
  open requests (no `Runs.isRunning` yet), `harness` from the task's config, else its project's or profile's first
  (the old `task_is_codex`).
- **Publishing** uses `SqlClient.afterCommit`, as `Events.emit` does, so a write inside a caller's `Db.tx` is
  published when that commits, and not at all on a rollback. The watcher drops a saved event whose seq it has already
  sent (the window's, or a replay's). A `PubSub` per watched thread is unbounded.
- **The card's todo list** is written in the same transaction as the events that change it (`TaskRepo.write` and a
  `task` event), not through `Tasks.change`, so a caller holding the task's lock can write a thread.
- **The readers** are pure functions of entries newest first (`said`, `userRepliesOf`…) fed by
  `ThreadStore.newest`, which reads 64 entries and four times as many each time a reader wants more. `approval` (3.3,
  over `permission_requests`) and `turn_end` of a Claude result's data (2.4) are not readers here; `openQuestions`
  returns the open question requests with `legacy:<n>` ids and their write numbers (the card state moves to
  `Questions`, 3.2).

The recorded sessions (22 Claude, 20 Codex scenarios: raw CLI output and the expected events) move to
`packages/testing/fixtures/threads/` and are the conformance suite for the two translators and the reducer. They
come from the `agent-threads` project, whose protocol this is.

## Board tools<a id="board-tools"></a>

The board is the MCP server for every run it starts. Four servers: `huntaway` (33 tools), `gh` (17), `docs` (9),
`desktop` (11). Inventory 03 has every tool with its arguments and who may call it.

### Definitions

A tool is defined once, with `Tool.make` from `effect/ai`, in `mcp/tools/<area>.ts`:

```ts
export const CreateTask = Tool.make("create_task", {
  description: "Create a task on the board. Its agent starts straight away unless start is false.",
  parameters: Schema.Struct({ title: Schema.String, description: Schema.optional(Schema.String), project_id: Schema.optional(Schema.String) /* … */ }),
  success: TaskSummary
})
```

From that one definition come the JSON Schema the agent is shown (`Tool.getJsonSchema`), the check of what it sends
(unknown or missing arguments are an error that names the tool's arguments, as now, because Claude Code does not
validate deferred tools), and the handler's types. A `Toolkit` per server groups them. Tool names, argument names and
descriptions are copied exactly: prompts, approval rules and agents' habits depend on them.

### Dispatch

Effect ships an MCP server (`McpServer`), and the spike ran it over HTTP with per-caller tool visibility. The board
does not use its transports, for three reasons the old server's behaviour gives: Claude runs reach the `huntaway`
server over control requests on the run's files, not HTTP; every call must run at most once and survive a restart;
and an HTTP call's answer must be resumable by `Last-Event-ID`. So there is one dispatcher of our own, small, over
the shared definitions:

```ts
export class ToolCalls extends Context.Service<ToolCalls, {
  /** Run a board tool call at most once per call id, whoever delivers it and however often. */
  call(input: { call_id: CallId; run: RunId; server: ServerName; tool: string; args: unknown }): Effect.Effect<ToolResult>
  /** For Recovery: re-run or settle calls found executing. */
  readonly resume: Effect.Effect<void>
}>()("huntaway/mcp/ToolCalls") {}
```

- **Three ways in, one way through.** `mcp/transport/control.ts` (Claude: `mcp_message` control requests read by the
  follower, answered on the input), `codex.ts` (Codex dynamic tools: `item/tool/call`, answered with
  `codex_response`), `http.ts` (`/api/mcp/<run>/<server>`: JSON-RPC, SSE with keep-alive and progress, resume by
  `Last-Event-ID`). All three call `ToolCalls.call`.
- **At most once.** The call is recorded `executing` before it runs and `done` with its result after; for the control
  path the answer is written to the run's input before the row is marked done. A call found `executing` at startup is
  run again only if the tool is marked `rerunnable` in its definition (read-only tools, tools that resume by call
  id, calls whose approval was never given); otherwise the agent is told it was interrupted and may or may not have
  taken effect.
- **Gates, in order**: arguments · the run exists and has not exited · reviewer threads may call only tools marked
  for reviewers · a thread in plan mode only tools marked for planning (checked per call: a run's tool list is fixed
  at launch while its mode changes) · any call but `wait` ends the run's current wait · approval rules (assistant
  threads) · the tool.
- **Who the caller is**: run → task → profile. Access to other profiles' boards, `<profile>:<key>` references and
  falling through to linked hosts when something is not found here are `mcp/resolve.ts`, kept rule for rule
  (inventory 03, section 2.3).
- **A handler is a service call.** `create_task` calls `Tasks.create` with the agent as the actor; it does not reach
  into another area's internals. The old tools reused the HTTP handlers' inner functions.
- The per-run secret for the HTTP transport stays `HMAC-SHA256(board token, "mcp:" + run id)`.

### As built in 3.1 (HE-4)

- **The frame is `mcp/tool.ts`.** A tool is a `Tool.make` value annotated with `Rerunnable`, `ForReviewers`,
  `ReviewersOnly` (offered to reviewers only: `submit_review`), `ForPlanning` and `ApprovalKind` (the approval a tool
  asks for before it changes anything, which makes a call cut short while it was pending safe to run again). An area
  pairs each tool with its handler, `toolHandler(Tool, (params, caller: McpCaller) => Effect<Success, ToolError>)`, and
  registers the list with `McpServers.register(server, list | Effect<list>)`, a layer that joins the first line of
  `mcpLayer` in `Main.ts`; the list's order is `tools/list`'s. `McpServers` also answers `initialize`, `ping` and
  `tools/list` (the reviewers' tools for a review run). `checkArgs` reads the tool's JSON Schema (`Tool.getJsonSchema`)
  for the old messages; the handler's parameters are then decoded with the tool's schema (a wrong type is an error that
  says so, which the old server did not check).
- **`ToolCalls.call` runs every server's calls**, gh's, docs' and desktop's too (M4, M6), not only the board's: the old
  server kept those answers in memory for 10 minutes and told a client that reconnected after a restart that the
  output was lost; recorded in `mcp_calls`, a reconnect gets the answer, or "interrupted" as the board's calls do. The
  reviewer, plan-mode, wait and rule gates are the board's server's only, as before. Calls run in fibers of
  `ToolCalls`' own, so a client that goes away does not stop its call; stopping the server leaves it `executing`, and its
  other deliveries are let go unanswered.
- **The gates' order** is the old `execute_mcp`'s: the arguments (of a tool the server has), the run, its task and
  profile, then an unknown tool, the reviewer gate, plan mode (the thread's mode at the call: its own, its project's,
  the host's default), the wait, the rules. A never rule is logged `blocked` and refused here; an ask rule goes to
  `McpHooks.askRule`.
- **`McpHooks`** is what a call needs of the areas built after it: `callMade` (ends the run's wait, `Wait` 3.5),
  `askRule` (the user's answer, `Permissions` 3.3) and `cancelled` (a call the agent gave up on: its prompt expires, its
  wait ends). `McpHooks.layerNone` ends nothing and refuses an ask; `Main.ts`'s `BoardHooks` is the live one.
- **The control transport's interface is `runs/McpControl.ts`**, implemented by `mcp/transport/control.ts`
  (`McpControlLive`): `handle(run, { request_id, server_name, message })` for an `mcp_message`, `cancel(run, requestId)`
  for a `control_cancel_request`, `manifest(review)` (the board server's handshake results), `initializeLine(run,
  review)` (built with the launch's `initializeLine`, `agents/claude/launch.ts`) and `isInitializeResponse(requestId)`.
  The runs area does not depend on it (a board tool needs `Runs`, which would be a cycle of layers): `McpControlRegistered`
  (a layer in `mcpLayer`) registers it with `runs/AgentRequests` for `mcp_message` requests and their cancellations, and
  as the provider of the manifest the launch puts in the `initialize` line (2.5, below). A board call on the output is `stdio:<run>:<request id>` with
  `{ request_id, rpc_id, arguments }` recorded, so `ToolCalls.resume` (Recovery) takes it up again and answers it on
  the input; the answer is written before the row is marked done.
- **The run's secret is `Identity.runSecret(run)`** (and `isRunSecret`, constant time), on `effect/crypto`'s `Mac`: the
  launch writing `mcp.json` is in `agents/`/`runs/`, above `mcp/`. The HTTP route is `mcp/transport/http.ts`
  (`McpHttpRoute`), mounted in `RoutesLive`.
- `mcp_calls` older than an hour whose run is gone or ended an hour ago are pruned when `ToolCalls` starts and hourly,
  1000 at a time. The `board_tool` telemetry event is left for analytics.

### As built in 4.4 (HE-5): the `gh` server

The `gh` server's 17 tools are `mcp/tools/gh.ts` (`GhTools`, `McpServers.register("gh", …)`,
through `ToolCalls` like every call, over `Gh.run`; null arguments dropped as the board's). Their result is MCP content
(gh's output, `isError` when gh failed), which `callResult(result, server)` passes through for every server but the
board's; `GhRefused` is the tool's `Error: …`. The servers other than the board's offer a reviewer every tool (the
reviewer and plan gates were the board's only already) and list `readOnlyHint` (`Tool.Readonly`; those tools are also
`Rerunnable`). `initialize` on gh says the run's account (`initializeResult(server, protocol, account)`, from
`mcp-run.json`). `McpControlRegistered` now tells the launch gh is served, so Claude runs get gh in `mcp.json` and the
gh hook. 3.1's test of an ended run gives gh's call arguments it takes, since an unknown argument is refused first.

### As built in 6.3 (HE-7): the `docs` server

The `docs` server's 9 tools are `mcp/tools/docs.ts` (`DocsTools`, `McpServers.register("docs", …)`): the hosted
server's definitions from the renderer (`toolDefinitions()` but `share_document`), as `Tool.dynamic` over their JSON
Schema, with `labels`, `images`, `label`, `set_document_labels` and `list_labels` added as the old server added them
(0.2.0 lacks them); `readOnlyHint` from the definitions (those also `Rerunnable`). Each handler reads its arguments as
the hosted server's serde structs do, so an agent gets the hosted server's messages (``invalid arguments: missing field
`slug` ``); the dispatcher's argument check refuses only arguments a tool doesn't have (its `required` is left to the
tools: a folder may be ""), and `set_document_labels` takes `slug` too. A result is its JSON as text and as
`structuredContent`; a failure is its message as a tool error without "Error: ". `initialize` gives
`DOCS_INSTRUCTIONS` (word for word, `McpServers.ts`); `resources/list` and `prompts/list` answer empty. The renderer
loads when the tools are registered (at startup), not on the first call. `McpControlRegistered` says docs is served, so
Claude runs get it in `mcp.json` and `--allowedTools`, Codex runs in `approved_mcp_servers`, and `Prompts` gives the
docs note (`docsTools`).

### As built in 3.2 (HE-4)

- **`mcp/tools/<area>.ts`** declare and handle the board's tools: `questions.ts` (`request_user_input`, `finish_work`),
  `projects.ts` (`list_projects`, `get_project`), `tasks.ts` (`list_tasks`, `get_task`, `get_task_field`,
  `create_task`, `update_task`, `send_to_task`), `pens.ts` (`list_pens`). `taskJson.ts` is the task as the
  tools give it (`summary`, `summarize`, `details`, `overview`, `field`), `reminders.ts` the old `reminder_time`,
  `common.ts` the shared arguments and `boardTool` (the registration, which drops arguments given as null, as the old
  tools read null as "not given"; `get_task_field` keeps them and refuses a null offset). **`board.ts`** registers
  every area's tools with one `McpServers.register("huntaway", …)` (`BoardTools`, on the first line of `mcpLayer`),
  sorted by `BOARD_TOOLS`, the old `tools/list` order of all 33: 3.4's and 3.5's tools add their area's list there.
- Parameters are `Schema.Struct`s of `Schema.optionalKey` fields, annotated with the old descriptions, so the JSON Schema
  an agent is shown has the old names, descriptions, enums and bounds (an `Int`'s `maximum` is the largest safe
  integer). A wrong type is refused by the schema with a message that says so, where the old tools had their own texts
  ("starred must be…", "model must be a string", "effort must be one of…"). `request_user_input`'s options may still be
  plain strings (taken as labels). Results are JSON (`Schema.Unknown`), built as the old tools built them.
- **`mcp/resolve.ts`** (`makeReach`) is the old resolve, rule for rule, over `ProfileRepo`, `ProjectRepo` and `TaskRefs`;
  what is not found fails with `ToolError.notFound`, the seam for linked hosts (M7). Annotations: `Rerunnable` on the
  readers, `request_user_input` and `finish_work` (and `get_task_field`, which the old list left out though it only
  reads); `ForReviewers` and `ForPlanning` as the old lists; `list_pens` for planning only.
- **Subprojects are gone**: `subproject` is kept in the schemas (names are copied), `"none"` and `"all"` list every
  task, and any task named is "not a subproject". Left out of a task's JSON: `subproject`, `is_subproject`,
  `workflows` (M6); of `get_project`'s: `summarizer`, `profile_summarizer`, `subproject_pull_requests` (legacy).
- **Starting agents** goes through `Runs.send(task, { text: "", source: "agent" })` (a never-run task's start message):
  `create_task` with `start` (said, or by default for todo and in_progress), and `update_task` moving a todo or backlog
  task that has never run (no session, not queued for dependencies, not running, not the caller's own) to in_progress.
  `send_to_task` is `Runs.send(task, { text, source: "agent" })`. Refused, `create_task` still returns the task it made,
  with a note: the old one for `no_agents`, "The task was made, but not started: <why>" for another refusal (new: the
  old server threw, after making the task, which an agent could retry into a duplicate); `update_task` on a host that
  can't run agents leaves the task in In progress, as before.

### `wait`

`Wait` owns the blocking tool: a wait is a fiber in a `FiberMap` keyed by run, racing a deadline, changes to watched
tasks, a subagent finishing, a command's exit, pull request news, a message for the run, a stop, and an explicit
move of the task. It subscribes to `Events` **before** it reads state. The stored wait (`tasks.agent_wait`) is what
a resumed call picks up after a restart: same deadline and watched set, the command started again, the pull request
read again. The nine end conditions and the "told" bookkeeping for PR news are inventory 03, sections 2.8 and 2.9.

As built in 3.5 (HE-4):

- **`mcp/Wait.ts`**: `wait(caller, { reason, seconds, tasks, command }) → { ended, wait, output }` (fails with
  `ToolError`: a period too long for what it watches, a command that couldn't start), `workDir(task)` (the worktree,
  the project's repository, else the profile's scratch folder: where the command runs), `callMade(caller)` and
  `cancelled(run, call)` (`McpHooks`' parts, `Wait.hooks`). A wait's fiber subscribes to `Events`, then reads the
  stored wait (a call retried with the same id carries on with it) or stores a new one, and loops: `check` (the run
  stopped, ended or gone → `stopped`; the stored wait gone → `resumed`; `moved_to` → `task_moved`; a queued message or a
  steer of this run → `message`; `subagent_finished` → the subagent; `pull_request.news` → its news; the watched tasks
  → `tasks_changed`), then races a `task`/`task_deleted` event of its own task or a watched one, a 5 s tick (a stop
  writes no event), the deadline and the command's exit. It clears the stored wait when it ends **unless it was
  interrupted** (the server stopping): the retried call picks it up. A second wait of the same run replaces the first
  in the `FiberMap`; the first returns `resumed`. The pure rules (periods, `ended`'s names, the notes word for word,
  the watched tasks' check) are `mcp/wait/ended.ts`.
- **The command** (`mcp/wait/command.ts`) runs through `ChildProcessSpawner`: `bash -c LAUNCH issue-agent-wait
  <command>`, detached (its own group), `killSignal: SIGKILL`, stdin a pipe the server holds (the watchdog), in
  `workDir` with the agent's environment and the task's `TMPDIR`. **Decided**: its output comes through one pipe (LAUNCH
  begins `exec … 2>&1`, so stdout and stderr keep their order) rather than an unlinked temp file, kept to its last 4000
  bytes as it is read; at its exit the group is killed and the pipe read to its end. gh as the task's account in its
  environment is 4.4's.
- **A message for the run needs no new signal**: `Runs.send` publishes the task after it queues or steers a message,
  and the wait reads `TaskRepo.queued`/`steers(task, run)`. **What the run's output says** is `runs/RunWaits.ts`
  (`line(run, line)`, called in the Claude line handler's transaction: the agent's own thread calling another tool, or
  a turn's `result`, clears the run's wait; a subagent's terminal `task_notification`/`task_updated` of an Agent or
  Task call is recorded as `subagent_finished`, the first only), and `over(task, run)`, which the end of a run (2.6)
  calls. Each writes `agent_wait` and publishes the task, which wakes the wait.
- **The command's approval** is `mcp/wait/CommandApproval.ts`, asked when the agent's reviewer didn't review the call
  (`approvesOwnWaits` of the run's `spec.json`) or an approval rule asks about or refuses Bash; `Permissions` supplies
  the live layer (a `Bash` prompt of the call, Don't ask refusing); `layerNone` refuses until then. Codex's
  `review_waits` is M5's.
- **The tools** (`mcp/tools/wait.ts`) are in `BoardTools`' list: `wait` (`seconds`' bounds are shown in its JSON
  Schema, not enforced: the period clamps, as before) and `background_wait`, which checks the id against the task's
  `background_work` of this run and writes the run's `background-waited` (`RunDir.backgroundWaited`,
  `setBackgroundWaited`); 2.8's `BackgroundWork` reads that file when it shows the task's background work again.
- **Pull requests (as built in 4.5, HE-5)**: the tool asks `PrWatch.request` (the target in the task's repository,
  `pull_request_events` added to the three every wait has, the account's host) and passes it in `WaitRequest.pullRequest`;
  `pull_request` takes a number too (`7`, `7.0`), as agents send one. A new wait reads the pull request before it is
  stored (`PrWatch.poll` for its call: one that can't be read fails the call, "The wait didn't start: …", with the SSH
  alias hint off github.com), and keeps the news found in the stored wait's `pull_request`. `waitOut` forks
  `PrWatch.watch` in the wait's scope, which reads every `PrPoll` (straight away for a wait carried on after a
  restart) and records news on the stored wait in one transaction, publishing the task, which `check` already ends on.
  After the call, news that reaches the agent (not `Stopped` or `Resumed`) is `delivered`: told. The note is
  `prompts/pullRequests.ts`' (`prNote`, through `github/prWatch/pr.ts` `note`, which decodes the stored news); the
  result's `pull_request` is the news, or else `PrWatch.last` (the last read with `read_at`).

## Permissions, questions, approvals

```ts
export class Permissions extends Context.Service<Permissions, {
  /** An agent wants to use a tool. Resolves when rules, the mode or the user decide. */
  ask(run: RunId, request: ToolUse): Effect.Effect<Decision>
  answer(id: RequestId, answer: UserAnswer, by: Actor): Effect.Effect<AnswerResult, NotFound | NotPending | MovedOn | Invalid>
  pending(filter: { task?: TaskId; profile?: ProfileId }): Effect.Effect<ReadonlyArray<PendingPermission>>
  /** Bypass allows, Don't ask denies, what is pending when a thread's mode changes. */
  applyMode(task: TaskId): Effect.Effect<void>
  expireFor(scope: ExpireScope): Effect.Effect<void>
}>()("huntaway/permissions/Permissions") {}
```

- **The order of decision** is kept exactly (inventory 03, section 2.7): an approval rule for the tool in the
  current mode; then the thread's always-allow list and writes to its own documents; then the mode (Bypass allows,
  Don't ask denies); then the user. Questions and plans skip rules and Bypass.
- **Waiting for the user** is a `Deferred` per request id, registered before the row is read, so an answer cannot
  slip between. The request row is the durable part; a resumed call re-registers.
- **Answers**: first wins (one conditional update). Allow-always adds to the task's list. A plan's approval changes
  the thread's mode. An expired question or plan can still be answered late, as a message, unless the conversation
  moved on.
- **Board changes that always ask** (create a project, risky project fields, delete a task, automations,
  workflows) are `Approvals`: it works out what would change, asks, and applies exactly the fields shown.
- `Questions` is `request_user_input`: a card that is not waited on, answered later as the user's message.

As built in 3.2 (HE-4), `permissions/Questions.ts`: a card is a question request in the thread (`legacy:<n>`, one
question `q`, metadata the card and the `call_id` that asked), opened with `Threads.openRequest` once per call
(`ThreadReaders.asked`); the tool sets the run's `attention`. The request is the card's one record: open is pending, an
`answer` resolution is answered (`answers.q` the picks and the text), a `cancel` is replied, replaced or expired
(`SETTLED` has each one's message; `settle(task, how)` does it). `card` (the checks of what the agent asks) and
`replyText` (the user's message an answer sends) and `checkAnswer` are plain functions. `answer(task, requestId,
{ choices, text })` (the `threads.answerQuestion` RPC, the old `POST /tasks/{id}/questions/{message_id}`) checks the card
is open and the conversation hasn't moved on (`ThreadReaders.movedOn` past the card's write), resolves it (the
compare-and-set), sends `replyText` with `Runs.send(task, { source: "user" })` (on a failure the card is opened again),
then settles the thread's other open questions as replied. It fails with `QuestionNotFound`, `QuestionClosed`
(`answered`, `moved_on`), `AnswerInvalid`, `SendRefused` or `TaskNotFound`; the handler maps them to `NotFound`,
`Conflict` (`not_pending`, `moved_on`), `Invalid` and `rpc/tasks.ts`'s `sendRefused`. `tasks.send` settles the open
questions as replied after a user's message that isn't blank. The merge gate's card (`merge_approval`, M4) is not
special-cased yet: M4 routes its answer to the gate.

As built in 3.3 (HE-4), `permissions/Permissions.ts` (+ `PermissionRepo.ts`, the plain `prompts.ts`):

- **The interface**: `ask(asker, { tool_name, input, tool_use_id }) → Decision` (Claude Code's `can_use_tool` answer:
  `{ behavior: "allow", updatedInput, updatedPermissions? }` or `{ behavior: "deny", message }`), in the old order;
  `askRule(asker, name, input, rule)` (a board tool an ask rule matched: Don't ask denies, else the user);
  `approve(asker, kind, tool, input) → Result<input approved, why not>` and `asked(call)` for 3.4's approvals;
  `answer(id, PermissionAnswer, by) → "allowed" | "denied"` (fails `PromptNotFound | PromptNotPending | PromptMovedOn |
  Invalid | SendRefused | TaskNotFound`); `pending(filter)`, `approvals`, `applyMode(task)`, `expireFor(scope)` (`Task`,
  `Run`, `Call`, `Project`, `DeletionsOf`, `Automation`, `Workflow`), `sweep(at)`; `expireOrphans` (Recovery, before runs
  are re-attached), `resume(run)` and `ended(run, idle)` (registered as `AgentRequests`' `resume` and `ended`, which 2.6's
  re-attach and run end call); `onControl`/`onCancel` (the `can_use_tool` handler); `asking(call)` and `settled(call)`
  for tests. An `asker` is `{ run, call_id, control_id? }`.
- **The row is the one source of truth.** `permission_requests` gained `run_id`, `control_id` (a `can_use_tool` prompt's
  control request) and `answered` (its answer is on the run's input). Raising a prompt is one transaction: the row, the
  thread's request (opened with `Threads.writeFromAgent`, not `openRequest`, so its metadata carries the write number
  as `message_id`, which the web orders it by), the action log's entry for a rule, the `approval` event, and the task's
  attention. Settling it is one conditional update of the row (the first answer wins) with the request **written again
  from the row** (one `request.opened` carrying the resolution and the card's state: `status`, `note`, `answers` as
  shown, `feedback`, `mode`, `late`), not `Threads.resolveRequest`, since a late answer settles a request that is already
  resolved. A prompt is raised only from a run that is still its task's latest live run.
- **Waiting** is a `Deferred` per waiter, registered before the row is read and woken after a commit; a waiter reads
  the row again. A call delivered again finds its row by (call id, tool) and waits on it, or gets its answer at once.
- **Claude**: `Permissions.registered` registers `can_use_tool` with `AgentRequests` (with `resume` and `ended`). A
  request is `stdio:<run>:<request id>`, asked once however often it is read (in memory while asked; `answered` after),
  linked to its call with `requestForPrompt` over the thread's stored items (`stateFromItems`), answered with
  `AgentRequests.respond` (`{ subtype: "success", request_id, response: decision }`). A `control_cancel_request` expires
  its prompt and leaves it unanswered. Not recorded in `mcp_calls` (that is `mcp/`, below `permissions/`): a decision
  without a row (a rule, the list, the mode) may be written twice if its line is read twice, which Claude Code ignores.
- **Board tools**: `McpHooks.layerPermissions` (and `askRuleWith`, `cancelledWith`); `Main.ts`'s `BoardHooks` joins
  them with `Wait.hooks` (Wait's `callMade`, Permissions' `askRule`, both `cancelled`). A wait's command is asked as a
  `Bash` prompt of the call through `CommandApproval.layerPermissions`.
- **Decided**: the sweeper is `Permissions.sweeper` (at once, then every 15 s, on `Schedule`); the reactor applies the
  mode to what is pending when a task's `permission_mode` changes, and expires a deleted task's prompts and requests to
  delete it. Writes to the thread's own documents folder are allowed for a task with labels or a scratch, document,
  assistant, pen or pens thread (the folder `DataDir.documents(task)`, symlinks resolved); the assistant's workspace is
  6.7's. Left out: Codex's questions and `agent: "codex"` (M5), the action log's `push` and Telegram answerers (only
  `user`, and `push` for a paired device's session), `expireFor` callers for projects, automations and workflows (their
  areas). `permissions.answer` takes the old body (`decision`, `message`, `answers`, `mode`, `feedback`, `automation`);
  the thread's `respond` command (`threads.command`) is not served.

As built in 3.4 (HE-4), `permissions/Approvals.ts`:

- **The interface**: `createProject(asker, request)`, `updateProject(asker, request)`, `deleteTask(asker, request)`, each
  given its request as an Effect (`CreationRequest { board, name, repo_path, reason }`, `ChangeRequest { project, patch,
  reason }`, `DeletionRequest { task, deleteBranch, reason }`) that is only run when the call hasn't asked before: a call
  that asked (`Permissions.asked(call)`) carries on with the input it saved, whatever changed since, as the old tools
  did (the old code checked `asked()` before resolving anything). Each fails with `NotApproved { message }` (the old
  "The user didn't approve <what>, so nothing was <done>: <why>"), `Invalid` (the checks), and the services' errors; the
  tools map them with `told`. Asked through `Permissions.approve` (kinds `project` and `delete_task`; the card is the
  approval's input); approved, it applies the input **as stored** (`apply` and `project.id`, `delete.id`, `apply` of a
  creation, read back with a schema), through `Projects.create`/`update` and `Runs.abort` + `Tasks.delete` (the agent as
  the actor).
- **What would change** is `Projects.preview(id, patch)` (new): `update`'s checks and write, rolled back with its event
  (the old `db.preview_project_update`); the changed fields are those given whose stored value differs (`sameJson`), in
  the old API's field order, and only they are in `apply`. A risky one (`APPROVAL_FIELDS`) asks; otherwise `apply` is
  made at once. A new `repo_path` is refused by `Projects` before anything is asked (relocating is M4's), and
  `move_repo` without one is "move_repo needs a new repo_path to move the folder to".
- **`create_project`**'s checks are the old `project_creation`'s (absolute or `~/`, symlinks resolved as far as the
  path exists, `..` refused in the missing part, not a file), with the key derived, `git` (`git rev-parse --git-dir`)
  and the host's default mode shown. **`delete_task`** refuses the caller's own task and the assistant, shows the task
  (with its branch and whether it runs), and if the task went meanwhile (its deletion approval expires with it) answers
  `{ deleted: false, key, note }`. Subprojects are gone: `tasks_with_it` and `tasks_deleted_with_it` are left out.
- **A deleted project's approvals expire** (the old `expire_for_project`): `Approvals.projectsDeleted` watches `Events`
  for `project_deleted` (`Projects` offers no `Change` for a project) and calls `Permissions.expireFor({ Project })`.
  Both layers are in `PermissionsLive`.
- **Fixed in `Permissions`**: a waiter registers inside what unregisters it, so a call interrupted as it registers (the
  server stopping) leaves no waiter for its retried delivery to find (`asking` found the stale one; the restart cases
  in mcp/tools/approvals.test.ts fail without it).
- **The tools**: `update_project` and `create_project` (`mcp/tools/projects.ts`, `ApprovalKind` `project`),
  `delete_task` (`tasks.ts`, `delete_task`), `create_pen`, `update_pen`, `delete_pen` (`pens.ts`, over `Pens`; a pen's
  own thread can't delete its pen), and the tracked work tools `track_work`, `untrack_work` (rerunnable),
  `list_tracked_work` (rerunnable, for planning) in `mcp/tools/tracking.ts`, with the list's rules where the old ones
  were (`agent/assistant/tracked.ts` → `assistant/tracked.ts`: `owner`, `track`, `untrack`, `effectiveStatus`; each
  change one `Tasks.change` of the assistant's `tracked`). The board's `Tracked` service (the user's removal) is 6.7's.
  `update_project` keeps an explicit null `reviewers`/`summarizer`/`summarizers` (back to the profile's; `summarizer`
  is a list of one), and checks `status_scripts`' keys ("unknown status … in status_scripts"). Still missing of the old
  33: the automation tools (6.5), the workflow tools (6.6), `submit_review` (4.6). Calls from another host, which have
  no thread to ask in, are M7's.
- **Web** (step 1): `apps/web/src/components/task/thread/approvalDetails.tsx` has the old `ProjectChangeDetail`,
  `ProjectCreationDetail` and `TaskDeletionDetail`; the approval card shows them while it waits (or once opened) and a
  line otherwise. The browser check is `apps/web/tests/ui/boardApprovals.test.mjs` (the old suite had none).

## Codex<a id="codex"></a>

### As built in 5.1–5.3 (HE-5)

- **The pure parts are `agents/codex/`**: `spec.ts` (`CodexSpec`, `codex.json`, read back leniently with `specFromJson`
  as serde did, unreadable `approval_rules` making it no spec; `policy(mode, review)`, `threadParams`, `REVIEW_PROFILE`,
  `isClaudeModel`), `servers.ts` (`mcpServerConfig`; the approval rules as per-server config, `codexServer`, and
  `codexPolicy`, which returns why a never rule on Codex's own tools refuses the run rather than throwing), `items.ts`
  (an item as a tool call: `toolUse`, `toolOutput`, `displayCommand`, `fileChanges`, `subagentId`, `ownThread`),
  `requests.ts` (`classify(request)`: a `Prompt` for `Permissions`, a `Tool` call of the board's, or an `Answer` given at
  once; `promptAnswer`, `toolAnswer`, `codexResponse`, `requestId` (`codex:<id>`), `boardTools(manifest)`), `lines.ts`
  (a schema per line, by `method`: `decodeLine → Result<CodexLine, LineProblem>`, `CodexLine` a `Notification` of the
  adapter's kept list, a `Request`, `Resolved`, `Model`, `BoardTools` or `Echo`), `translate.ts` (below), `launch.ts`
  (`codexLaunch(input) → { spec, codex, boardTools }`, failing `LaunchRefused`), `queries.ts` (`parseModels`,
  `parseSkills`, `titleModel`, `rateLimits`, `planType`), and `rpc.ts`, the app-server client (`appServer(options)`, a
  scoped process: `request`, `notify`, `initialize`, `next`, `respond`, `respondError`, `exitStatus`, `exited`; killed
  with SIGKILL when its scope closes).
- **`codex-run` (5.1)** is `apps/server/src/codex-run.ts`, an entry point of its own (the launcher execs it as it does the
  hooks, without `bin.ts`), over `agents/codex/adapter/` (`runAdapter`, the old adapter line for line: the handshake,
  `skills/extraRoots/set`, `thread/start` with the board's tools as dynamic tools or `thread/resume`, `thread/revert`, the
  turn loop with steers, interrupts and echoes, a compaction's `thread/compact/start`, the requests on the output and
  their answers from the input, declined without a board, child threads closed as it ends). It reads stdin as a stream
  and writes each output line with one `writeSync`, so nothing is lost on exit. It finds `codex` in
  `HUNTAWAY_CODEX_BIN`, which the launch sets from `ServerConfig.codexBin` (`--codex-bin`/`HUNTAWAY_CODEX_BIN`, default
  `codex`).
- **The launch** is `LaunchFacts.launch(run, text)`, which `Runs` calls: Claude's (`claude`) unless the thread's config
  is Codex's. The Codex half gathers the old launch's Codex facts: the model (the task's, else the first of its
  project's, profile's and host's that isn't Claude's), the effort as the model takes it (`codexEffort` over
  `CodexQueries.models`, unchanged when they can't be listed), the git directory and package caches as writable roots, a
  reviewer's read-only sandbox (`git ls-files`/`check-ignore` for the ignored folders it may write), the rules, whether
  the session has the board's tools as dynamic tools (`RunRepo.sessionBoardTools`), and a rewind's `before_turn` when
  the rewind is for the task's session (4.3 clears it). `codexLaunch` runs `<launcher> codex-run <dir>/codex.json`,
  feeds the prompt as the first stream-json user message (no `awaited`: the adapter echoes only steered messages), and
  sets `CODEX_HOME`, `TMPDIR`, `HUNTAWAY_TASK_ID` and `HUNTAWAY_CODEX_BIN`. `RunDir.prepare` writes `codex.json` (before
  `spec.json`); `RunDir.codexSpec` and `isCodex` read it. The run records its effort and `board_tools`. A server not
  started by its launcher (`HUNTAWAY_EXE` unset) refuses Codex runs.
- **The line handler** is `runs/codex/output.ts`. `CodexOutput` is the follower's `RunOutput` for both agents: a run whose
  folder has `codex.json` (looked at once per run) goes to the Codex handler, the others to `ClaudeOutput`, which it is
  built over (`Main.ts`). A request goes to `AgentRequests.handleCodex`, a resolution to `AgentRequests.cancel` as request
  `codex:<id>`, `huntaway/model` only moves the offset (tokens read `out.jsonl`); a notification is translated and
  written with what it tells the run and the offset in one transaction, as a Claude line is (one line to a transaction:
  no chunks), and a turn's end closes the input even when recording it failed. After the commit: the reply being written,
  `Usage.setLimits` from `account/rateLimits/updated`, `ContextMeter.onCodexUsage`/`onCompacted`/`recordTurn`, a
  subagent's end on the wait (`RunWaits.subagentEnded`), and a usage-limit refusal (`Usage.codexRefused`, the task's
  `limit_reset_at`). `// 4.3: Checkpoints.afterTurn` marks where a turn's checkpoint goes.
- **The translator** (`translate.ts`) is the old driver's `map` and the thread half of `handle` and `finish_turn`, pure:
  `translate(state, line, ctx) → { state, events, metas, effects, warnings }`, with `observe` and `stateFromItems`. Its
  state is the thread's tool calls with their places and the ids of its other items (what the old `View` read), so a line
  read again adds nothing. A turn's end is a `turn_result` (`legacy:<writeNo>`, only `turn/completed` and
  `thread/compacted` take a write number) as Claude's result would make it for the old Codex result line; Codex's
  `/compact` reporting its end twice makes one. Its effects: `SessionStarted`, `TurnStarted` (the turn id, `agent_at`),
  `TurnEnded`, `PreviewReset`/`PreviewText`, `Working` (the run's wait ends), `SubagentEnded`, `Notice` (the board's
  warnings, written with `Threads.notice`), `RateLimits`, `TokenUsage`, `Compacted`, `ToolDone`, `Echoed`,
  `BoardToolsRefused`. The 20 recorded Codex sessions pass unchanged (`agents/codex/fixtures.test.ts`).
- **Requests**: `AgentRequests` gained `registerCodex(kind, handler)` (`prompt`, `tool`), `handleCodex` and
  `respondCodex` (a `codex_response` line). `Permissions.onCodex` (registered by `Permissions.registered`) asks a Codex
  approval or question as `stdio:<run>:codex:<id>` through the same `answerControl` as `can_use_tool`, answering with
  `promptAnswer`; the request it opens keeps what answering needs (`metadata.codex`), so `Permissions.resume` answers it
  as Codex takes it after a restart. Codex's questions are question requests (`requestForPrompt` takes
  `request_user_input`, ids from the questions, no forced answer of one's own). The dynamic-tools transport is
  `mcp/transport/codex.ts` (`McpCodexRegistered`): `ToolCalls.call` with `answer: { request_id, rpc_id, codex: true }`,
  answered with `codex_response` and recorded with `codex`, so `ToolCalls.resume` takes it up again.
- **`Wait`**: a Codex run's waits are its reviewer's to approve when `codex.json` says `review_waits`.
- **Queries (5.3)** are the service `agents/CodexQueries` (`models`, cached 10 minutes per config folder; `skills`, a
  minute; `rateLimits`; `title`; `configModels`), live in `agents/codex/CodexQueriesLive.ts` on short-lived app-servers
  (20 s, 60 s for a title), `CodexQueries.layerTest` in tests (models from `CodexModelsScript`, nothing else). It is
  `ModelCalls.codex` in `Main.ts`. `TitleModel` asks it for a Codex config's titles; `Usage` reads a Codex config's plan
  and limits through it (`Usage.provideCodex`, registered by `CodexQueries.registered`, since `profiles/` is above
  `agents/`). `configs.models { id } → AgentModel[]` (new: `NotFound`, `Unavailable`) lists a config's models (none for
  a Claude config); the web's model pickers (the thread's, the new task's) read them through the client's
  `configModelsAtom`. `host.info`'s `agent_clis` lists `codex` when its program is there.
- **Decided**: the board's namespace's description is cut to the whole sentences of the board's instructions that fit
  1024 characters (`fitted`): codex-cli 0.167 refused `thread/start` with the whole text (found by the run on the real
  Codex, below). Codex runs use the stream-json input Claude's do (`RunInput` unchanged): a user message, an `interrupt`
  control request, and the `codex_response` answers.
- **Left out**: a Codex run's skills in the composer (`CodexQueries.skills` is there; the composer's skills are
  `AgentTools`, 6.4); telemetry's `config_overrides` (6.9); `documents.follow` on a tool's end (6.2); refusing to start a
  Codex run on a host without the CLI (the run fails at its start, with the adapter's error); the old `codex_run_effort`
  fallback when models can't be listed is the effort as given.
- **Tests**: the 20 sessions; the old driver, adapter, launch, requests and `tests.test.ts` cases (`agents/codex/*.test.ts`,
  `runs/codex/output.test.ts`); the queries against `fake-codex` (`packages/testing/bin/fake-codex.ts`, its markers
  and knobs at its top); and `tests/e2e/codex.test.ts`, a whole server running a task with Codex as its agent
  (fake-codex under `codex-run` under ia-shim: an approval, a board tool as a dynamic tool, the reply, In review). One
  run on the real `codex` (codex-cli 0.167.1, `gpt-6-luna`, low effort, the default mode) on a test server called
  `list_projects` as a dynamic tool, replied, and ended in In review.

## Prompts

Every piece of text the board gives an agent is in `apps/server/src/prompts/`, one file per piece, **copied from the
old server word for word**: the system prompt per thread kind, the first prompt of a task, the review, merge and
summary prompts, the notes on `gh`, documents, temp folders and other profiles, the title prompts, the plan format.
Inventory 02, section 3.6 lists the pieces and when each is included. `Prompts.system(threadKind, context)` is a
table over `ThreadKind` in place of the old 350-line function with a branch per kind. Wording changes are separate
tasks from the port, so that a behaviour change can be traced to one or the other.

As built in HE-4 (2.5):

- `prompts/` holds each piece as a constant or a plain function of the values it interpolates, including the ones
  later tasks send (review, fixes, summary, merge, merge approval, restack, titles, stack title, workflow step, todo
  nudge, late plan answers, question replies, the assistant's memory); each file names the plan task that uses it.
  Left with their areas, as they are built from those areas' own state: the pull request watcher's wake message (4.5),
  the routines' reports and the brief's message (6.5, 6.7), the approval hook's reasons (3.6), board tools'
  descriptions and results (3.x).
- The builders are pure functions in `agents/prompts/` over a plain `PromptContext`: `systemPrompt(kind, ctx)` (with
  `basePrompt` and `instructions`), `taskStartPrompt`, `runPrompt` (the launch's composition: `/plan`, the first
  prompt, the lost background work's note, the mentions note), `mentionsNote`. `Prompts` (`agents/Prompts.ts`) gathers
  the context: `system(task, run)`, `start(task, text)`, `preview(project, options)`.
- The context's fields for later areas hold the old value with the feature off until their task fills them: the gh
  server and GitHub remote (4.4), the workflow's PR and start text (6.6), the docs server (6.3), the desktop (6.10),
  the temp folder (2.8), the assistant's memory (6.7), the lost background work (2.8). The preview names the
  worktree as setup would, but its base branch only when the project names one (git reads the checked-out one, 4.1).
- The legacy subproject paragraphs are gone with subprojects. A document task of a group is keyed `G` in its prompts,
  as the old `key_prefix` did (`keyLetter` in the contracts gives it `T`).
- The goldens in `agents/prompts/fixtures/systemPrompts.ts` are what the old builder gave for each case of
  `system.test.ts`, recorded by running it.

## Titles, usage, tokens, context

`Titles` (a small model call writes a title from the description and reconsiders it after each prompt unless
pinned), `Usage`, `Tokens` (counting a session's tokens across resumed runs: keep the snapshot-and-tail algorithm
and its tests as they are) and `ContextMeter` are ported as they stand; inventory 02 sections 2.2, 2.3 and 2.11.

As built in HE-4 (2.8), with the services the runs area calls that don't need `Runs`:

- **Where they sit**: `profiles/Usage` (and the pure `profiles/usage/limits.ts`); `agents/` has `Tokens` (+ `TokenRepo`,
  pure `tokens/count.ts` and `tokens/counts.ts`), `ContextMeter` (+ `ContextStatsRepo`), `SideCalls` (`call_usage`:
  titles and window restarts), `Titles` over a replaceable `TitleModel`, and `UsageWindow` over a replaceable
  `WindowPrompt` — **moved from `profiles/` to `agents/`**, as it runs `claude` and records a side call;
  `agents/configEnv.ts` gives a one-off `claude` its config folder and proxy (the old `api_env`). `tasks/TaskTmp` and
  `tasks/Leftovers` (stopping what a done task left running; worktree teardown, M4, uses it too). `runs/DevServers`.
- **Tokens are counted after a run exits**, from `out.jsonl`, as before (not per line, which the snapshot-and-tail
  algorithm cannot do): `Tokens.runEnded(task)` at the end of a run, `countPending(null)` in `Recovery` and before the
  run pruner removes folders. Telemetry's `run_usage`, `run_end` and `side_call` wait for `Telemetry`.
- **The context meter and the servers column** write the task's row with a `task` event (`TaskRepo.write` +
  `Events.emit` in one transaction), not `Tasks.change`: they change on every reply or scan and nothing in the
  reactor depends on them. Titles go through `Tasks.change` (a compare-and-set under the task's lock).
- **What the line handler calls** (2.5's Claude `RunOutput`): `ContextMeter.onAssistant(run, line)` for each
  assistant line; `onCompacted(run, metadata)` for a compaction; `onControlResponse(task, line)` for a control
  response; on a `result`: `onResult(task, line)`, append `ContextMeter.requestLine` to the run's input,
  `RunRepo.addCost`, then `recordTurn(run, turnCost)`; `Usage.onRateLimit(config, line)` for a rate limit, and on a
  usage-limit refusal `Usage.outUntil(config)` into `tasks.limit_reset_at`. `/new` calls `ContextMeter.clear(task)`.
- **What `Runs` calls**: `Usage.outUntil(config)` is the gate of `send` (the old `before_run`: `limit_switch` and
  `limit_wait`, with `isResetDue` and its 60-second grace from `profiles/usage/limits.ts`); the 30-second loop that
  starts tasks whose reset is due, and `tasks.waitForLimit`, are `Runs`' (they need tasks and runs). The launch calls
  `TaskTmp.ensure(task)` (the run's `TMPDIR` and the prompt's temp folder) and puts `HUNTAWAY_TASK_ID` in the agent's
  environment for `DevServers`. A user prompt calls `Titles.refreshLater(task)` when `worthAsking(text)`; a new task
  whose title is to be written calls `Titles.generateLater(task, sendTheStart)`.
- **What the end of a run calls**: `Tokens.runEnded(task)`, `DevServers.notifyRunEnded(task)`; the reactor calls
  `TaskTmp.changed` when a task moves or its `running` changes and `TaskTmp.deleted` when it is deleted, and
  `Titles.refreshLater` when a title is unpinned.
- **Decided**: the per-task temp root of tests is `ServerConfig.taskTmpRoot` (`<data dir>/task-tmp` in
  `ServerConfig.layerTest`), not an environment check; the test board (`packages/testing`) asks no model (titles from
  `TitleScript`, window prompts fail) and `layerTest`'s `claudeBin` names no program. Codex titles, Codex rate limits
  and the window's Codex case are M5; stack titles are 4.8. A failed usage request's error shows the status number
  only (the old one added its text).
- **Wired into the run (HE-4, after 2.6)**: the line handler makes the calls above after the line's commit (the
  context request before `turnEnded` closes the input; `CompactMetadata` keeps `duration_ms`); the launch gives the task's
  temp folder as `TMPDIR`, an `--add-dir` and `Prompts.system`'s `tmp` (`RunTold.tmp`); `Runs.send`'s gate is
  `usageGate` (`waitForLimit` keeps the message queued with `waiting` and `limit_reset_at`); `Runs.limitResets` (a layer
  in `RunsArea`) runs `startUnblocked(null)` every 30 s, and `Dependencies.ready(project, nowMs)` includes the tasks whose
  reset is due; `/new` clears the meter; a user's prompt refreshes the title; the end of a run (`RunEnds`) calls `Tokens`
  and `DevServers`. RPCs: `host.usage { refresh? }`, `tasks.stopServer { id, port }`, `tasks.context { id }`. Not wired:
  `tasks.waitForLimit` (the "Carry on then" button; no contract yet) and `Titles.generateLater` on task creation (in
  `tasks.create`'s handler, another piece's).
- **`Compaction`** (`runs/Compaction.ts`): `compactIdle`, one pass, compacts (`Runs.compact`, the board's own, with
  its notice) each Claude session whose latest run, a prompt run, ended 50 to 60 minutes ago (`RunRepo.idleSessions`,
  the old `idle_sessions`); the loop runs it at start and every minute. It and `Runs.limitResets` are `RunLoops` in
  `Main.ts`, part of `AreasLive` but not of `areasLayer`, so a test board's clock moves without them (tests run a pass).
- **`BackgroundWork`** (`runs/BackgroundWork.ts`, the rules plain in `runs/background.ts`): the run's `background`,
  `background-killed`, `background-ended` and `background-calls` files through `RunDir.readFile`/`writeFile` (read
  leniently, the older formats too), `background-waited` as 3.5's `background_wait` writes it; `sync(run)` shows
  `Task.background_work` (idle: between turns, no steer waiting, nothing that `holds` — a subagent, or a shell waited
  on); `runEnded(run)` (from `RunEnds`) clears it and adds what the end stopped to `lost_background` (the latest ten),
  which the next launch takes (`takeLost`) into `Prompts.start`'s note (once; dropped for a new session). The line
  handler gives it the Bash/Monitor calls and `task_started`. **What it means for the input is `RunInput`'s**:
  `backgroundChanged` (the old `background_changed`), `tookIn`, `turnEnded` with HA-187 (open while tasks go, unless
  stopped) and `FOLLOW_UP_GRACE` (15 s), `BACKGROUND_GRACE` (120 s, re-armed while the output grows), `rearm` after a
  restart, and the run's stop (`RunInput.stop`, which `Runs.stop` calls once a launch is over: between turns with only
  background work going it kills rather than interrupts). `Runs.stopBackground(task, shell)` (`tasks.stopBackground {
  id, background_id? } → { stopping }`) sends `stop_task` requests (`bgstop-…`), the run's stop if one can't be sent,
  is refused, or the shells are still there 10 s later. "Asks on its output" is now "takes input" (every Claude run of
  this board; Codex's is M5). A run's kill and reap keep what was going as `background-killed` first.
- **Also**: `tasks.waitForLimit { id }` (`Runs.waitForReset`, the old `wait_for_reset`); `Runs.created(task, input)`,
  which `tasks.create` calls: `start` starts the agent, and a task with only a description gets its title written
  first (`Titles.generateLater`, starting it after if asked); `tasks.create` can then fail as `tasks.send` does
  (`Unavailable` added to its contract).

### As built in 4.8 (HE-5): stack titles

- **`agents/StackTitles.ts`** (the old `agent/stack_title.ts`, HA-387) writes a stack's title and description with the
  model task titles use (`TitleModel`, the bottom's config: Claude, or Codex's cheapest model; its tokens a `title` side
  call), kept on the stack's bottom (`stack_title`, `stack_description`, `stack_pinned`, through `Tasks.change`). The
  stack is `tasks/lanes.ts`' `stackOf` over the tasks of the task's project (or its profile's in no project) of its
  profile. The pure parts are `agents/stackTitles/text.ts` (`stackInput`, `parseStackReply`), the prompt
  `prompts/stackTitle.ts`.
- **`changed(change)`** is the reactor's step for every `TaskChanged` (after the merge step): a task made, deleted, or
  changed in what a stack reads (its title, description, status, kind, target, the task it lands after) has the stacks it
  was and is in settled at once (the fields moved to the bottom, cleared elsewhere, a split's handed to the part split
  off) and written after a pause. A deleted task's fields come from its last row in the change (its hidden input isn't
  known by then, so an unpinned stack is written again, which its lost level would cause anyway).
- **The pause is 5 s on the clock** (`STACK_DEBOUNCE_MS`): a fiber per bottom in a `FiberMap` sleeps until the time due
  (taken when it's scheduled, so a fiber that starts late doesn't wait longer), a new change replacing it; then the
  stack is queued and written by a writer fiber under a one-permit semaphore (never two writes at once; a stack queued
  twice is written once, from what it says by then). `settled` (tests) waits, on a `SubscriptionRef` of what's waiting,
  queued and being written, until none is; tests move the clock past the pause first.
- **What a stack was written from** is the hidden `stack_input` column (`agents/StackTitleRepo.ts`; the column was in
  the initial migration, not on the wire). **Decided**: it keeps the input text itself, not the old SHA-256 prefix (the
  server has no digest service; the text is at most 30 levels of 1,000 characters). An imported board's stacks therefore
  don't match their old keys and are each written once more after the switch (the pass after a start), unless pinned.
- **`update(id, edit)`** is `tasks.updateStack` (the old `PATCH /tasks/{id}/stack`): through any level, answered with
  the bottom; `title`/`description` pin them (blank clears), `regenerate` unpins, forgets the input and writes again
  forced (also for a stack whose tasks are all done). `StackInvalid` (both, neither, over 200/2,000 characters, a task in
  no stack, another profile's task naming one of this one's) is the wire's `Invalid`; `TaskNotFound` is `NotFound`.
- **`resume`** (Recovery, last): a minute after start, on the clock, in the service's scope, the open levels' stacks are
  queued (not forced): those already written from what their levels say cost nothing.
- **Tests**: `agents/StackTitles.test.ts`, every case of the old `agent/stack_title.test.ts` on the test board with
  `TitleScript`, but the wire and MCP parts it names at its top.
