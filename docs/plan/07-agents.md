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

`Runs.send` takes the task's lock and decides with a pure function (`decideSend`: steer, queue, wait, or start). A
message sent with `queue` (HE-113) is queued rather than steered while the agent is in a turn, and the turn's end
(`RunInput.turnEnded`) steers what is queued into the same run, which starts its next turn.
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
- **Who the caller is**: run → task → profile. Access to other profiles' boards and `<profile>:<key>` references are
  `mcp/resolve.ts`, falling through to linked hosts when something is not found here `mcp/acrossHosts.ts`, kept rule
  for rule (inventory 03, section 2.3). An agent on another host is a caller with no run or thread here (7.4,
  [08-hosts.md](08-hosts.md#board-tools-across-hosts)): the thread's own tools and anything that must ask the user
  refuse it.
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

### Hops between agents (HE-26)<a id="hops-between-agents"></a>

New (bot-hq's rule, from HE-17's write-up): two agents that answer each other with `send_to_task` could keep each other
running for as long as nobody looks, each run on someone's usage. So a message one agent sends another counts **hops**:

- A message's hops are one more than the hops of the sending agent's turn; the user's messages and the board's own
  prompts (merge requests, review fixes, PR news, workflow steps, automations' and routines' messages) are 0. A turn's
  hops are those of the message it took in last: the run's start (the fewest hops of the messages it takes at once, so
  a run that starts with the user's message among them is at 0), then each steer as the agent takes it in
  (`RunInput.steered`), so the user's message steered in starts the count again.
- They are kept where the message is: `task_queue.hops`, `task_steers.hops` (a steer the run never took in goes back to
  the queue with its hops), and `runs.hops` (set by `Runs.register` and `RunInput.steered`). Nothing is in memory, so a
  restart keeps the count. `ToolCalls` reads the run's row on each call; `McpCaller.hops` is its `hops`.
- Across hosts and boards: another profile's board on this host is the same `Runs.send`. To another host, the call
  carries the caller's hops (`RemoteToolCall.hops`, optional: a host on a build before it sends none, read as 0) on
  `tools.call` and `link.upcalls`, and that host's caller (`remoteCaller`) has them.
- **`MAX_HOPS` = 3** (`mcp/tools/common.ts`), bot-hq's number: A→B→A→B goes (an ask, an answer, a follow-up and its
  answer), and the next is refused. That is enough for the exchanges agents have on this board (a task asking another
  for something and hearing back, a task reporting to the one that made it), while two agents caught answering each
  other stop after two rounds rather than after the usage runs out. A constant, not a setting, until someone needs
  it higher.
- Past it, `send_to_task` fails (a tool error in the thread, as any refusal) with: "The message wasn't sent: agents
  have been waking one another without the user (by messages or tasks they start) 3 times in a row, as many as the
  board lets go. Stop messaging other tasks' agents and report to the user instead…". It is checked before the task is
  looked for, so it holds wherever that task is.

What else counts, and why:

- **`create_task` with a start, and `update_task` starting a task**: one hop each, as they wake another agent on the
  agent's behalf; otherwise a loop could go on through new tasks (A makes B, B messages A, A makes another…). Past the
  limit the task is made (or moved) all the same, its agent not started, and the result's `note` says why, as for
  the other refusals of a start.
- **`run_workflow`**: refused past the limit, as it wakes agents too. The workflow's own prompts are the board's (0):
  they come from the user's graph, which bounds them, and carrying a count through a workflow run's steps would be
  state of its own for a path no one has seen loop.
- **Automations' `send_to_task` and `create_task` actions, routines**: 0. They are the user's rules (an agent's change
  to one needs the user's approval), sent as the board.
- **The todo-list nudge** at a run's end carries the ended run's hops: it carries on that agent's own work, and an
  agent told to stop shouldn't get a fresh count from the board asking it to finish its list.
- **The assistant and pens' threads** are agents with the same tools, so their messages count the same way; the user's
  messages to them are 0.

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
- **A message from the user skips what is open** (HE-27, bot-hq's rule): an agent holding a prompt can't read a
  message until the prompt is settled, so the user's message settles it as skipped (below).

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
- **An edited input** (HE-23, for the drafts experiment): `permissions.answer`'s `input`, an object, is what a tool call
  allowed runs with in place of the one it asked with. Only a `tool` prompt of a Claude run takes it (not a question,
  a plan, the board's approvals, or a Codex prompt, whose request metadata has `codex`: Codex's MCP approval is an
  elicitation answered `accept` or `decline`, with no arguments); else `Invalid` (`input`). An input the same as the
  one asked (by its JSON) isn't an edit. An edit is written to the row (so `allowed` tells Claude `updatedInput` with
  it), the thread's request (its `input`, and `edited: true` in its metadata) and the action log
  (`ApprovalRules.settle`'s `edited` rewrites the entry's `summary`).

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
  were (`agent/assistant/tracked.ts` → `assistant/trackedList.ts` (renamed in 6.7 beside its service `Tracked.ts`): `owner`, `track`, `untrack`, `effectiveStatus`; each
  change one `Tasks.change` of the assistant's `tracked`). The board's `Tracked` service (the user's removal) is 6.7's.
  `update_project` keeps an explicit null `reviewers`/`summarizer`/`summarizers` (back to the profile's; `summarizer`
  is a list of one), and checks `status_scripts`' keys ("unknown status … in status_scripts"). Still missing of the old
  33: the automation tools (6.5), the workflow tools (6.6), `submit_review` (4.6). Calls from another host, which have
  no thread to ask in, are M7's.
- **Web** (step 1): `apps/web/src/components/task/thread/approvalDetails.tsx` has the old `ProjectChangeDetail`,
  `ProjectCreationDetail` and `TaskDeletionDetail`; the approval card shows them while it waits (or once opened) and a
  line otherwise. The browser check is `apps/web/tests/ui/boardApprovals.test.mjs` (the old suite had none).

As built in HE-27, a message skips the prompts that are open (`Permissions.skipFor(task)`):

- **When**: after the user's message is sent (`Runs.send` with `source: "user"`, so a live run has it on its input
  first) and isn't blank, in `tasks.send` and `Assistant.send`, beside `Questions.settle(task, "replied")`. Not
  `Runs.send` itself: another agent's `send_to_task`, the board's own prompts (review fixes, an automatic
  `/compact`) and a late answer's message also go through it, and none of them is the user choosing not to answer.
- **What**: the task's pending prompts but questions and plans (`skippedByMessage`: `kind` not `tool`, or a tool that
  isn't `AskUserQuestion`, `request_user_input` or `ExitPlanMode`), so a subagent's (the parent thread's task) too.
  Each is one conditional update `pending → skipped` (the new `PromptStatus`, and `ApprovalStatus`), so of it and an
  answer only the first is taken; its request is written again from the row with `{ outcome: "deny", message:
  SKIPPED }`, its waiter woken (the call is denied with `SKIPPED`: "Skipped: the user did not approve this. They sent
  you a new message instead of answering, so read it now, and don't retry this unless their message asks you to."),
  a rule's entry settled as `skipped` by `message` (new in `ActionOutcome` and `AnsweredBy`), and the task back to
  work once nothing is pending. Claude's `can_use_tool` is answered `deny`; Codex's approval `decline` (its turn goes
  on, with the message steered into it).
- **Decided**: the board's own approvals (project changes, deletions, automations, workflows) are skipped too: the
  agent's tool call waits on the card just as a `can_use_tool` does, so the message would sit behind it; the agent is
  told "The user didn't approve …: Skipped: …" and can ask again if the message says to. **Stop** skips nothing: it
  interrupts the turn, Claude Code cancels the open request (`control_cancel_request`, and Codex resolves it), so the
  prompt expires with the turn (`onCancel`, or the run's `ended`); answering it first would let the agent take its
  next step before the interrupt lands.
- **Web**: a skipped card (`PermissionCard`, `ApprovalCard`) shows the `skipped` badge and _Skipped: you sent a
  message_ (`SkippedLine`); the Actions log's outcome says "Skipped: you sent a message instead of answering".
- **Tests**: `permissions/Permissions.test.ts` (what is skipped and what waits, the action log, first wins, a
  subagent's `can_use_tool` denied on the input), `assistant/Assistant.test.ts` (`Assistant.send`), and on a whole
  server with the fake agents: `tests/e2e/permissions.test.ts` (fake-claude's reply has the deny and the message, in
  one run) and `tests/e2e/codex.test.ts` (declined, and the message steered into the same turn).

### As built in HE-28: `request_connection`

The assistant (and the threads under it, routines' too: `trackedList.owner`'s rule, as for tracked work) asks for a
connection it needs and doesn't have with the board tool `request_connection` (`mcp/tools/connections.ts`;
bot-hq's `request_app_connection`): `{ connection: "google", reason }`. It's listed after `finish_work`, is a thread
tool (`THREAD_TOOLS`: an agent on another host is refused), rerunnable and allowed in plan mode, not for reviewers.

- **What it does**: `Connections.state(kind, profile)` first; for Google that is `Google.status(profile, true)`, its
  files and then its refresh token tried with Google, so a token Google turns away isn't connected. Connected: no card,
  and the agent is told so (try the tool again). In a routine's turn (its user message `routine`, as for a prompt's
  expiry): no card either: nobody is there, so the agent is told to carry on without it and say in its report that it
  isn't connected (and where to set it up). Otherwise the run's `attention` is `Connect Google` (it ends in Needs
  attention) and `Connections.ask` opens the card once per call.
- **The card** is a board question (`legacy:<n>`, one question `q`, its one option `Skip`, no answer of one's own) whose
  metadata is `{ connection, reason, problem, call_id }` (`assistant/connectionText.ts` `connectionRequest`).
  `Questions.answer` refuses it (not found): it is settled with its own RPCs. Its resolution: `answer` with `answers.q`
  `["connected"]` and `answers.account` (message `Connected as <address>`), or `["skipped"]`; a `cancel` as a
  question's (`Questions.settle`: a message from the user settles it, as replied).
- **Settling it** (`assistant/Connections.ts`): `check` (`threads.checkConnection`, Check again) reads the state and,
  if connected, settles it; `skip` (`threads.skipConnection`). Both refuse a settled card or one the conversation moved
  past (`QuestionClosed`), resolve it (the compare and set), send the agent `connectedText` ("Google is connected now
  (as …). Carry on with what you were doing.") or `skippedText` ("… Carry on without it.") with `Runs.send(task,
  { source: "board" })` (on a failure the card opens again), then settle the thread's other open questions as replied.
  `sweep` is the board noticing on its own: `Connections.watcher` (in `AreasLive`, not in tests, which run `sweep`)
  every 30 seconds reads the open cards of the assistants' and routines' threads (`ThreadStore.openConnections`, only
  while one may be open: a flag set when a card is opened and at start) and settles those whose connection is made,
  reading each profile's state once a pass. A card the conversation moved past without settling it (a message that
  doesn't settle questions: a routine's run, a routine in `thread` mode, another agent's `send_to_task`) is closed by the
  sweep first, unanswered (`movedOnResolution`, a `cancel` the web app shows as not answered), before any state is read,
  so it isn't read (or Google asked) again every pass.
- **Another connection** (an MCP server switched off for the profile, say) is a kind in `CONNECTION_KINDS` with a
  label, a branch of `Connections.state`, and a card in the web app's `LABELS` with its own set-up dialog.
- **Web**: `components/task/thread/ConnectionCard.tsx` (an item `connection` in the thread model): what's missing (the
  problem when asked, or the last Check again's), the reason, **Set up Google** (the profile's Google card from Settings
  → Assistant in a dialog, which checks again when closed), **Check again**, **Skip**; settled, _Connected as
  <address>_, skipped, or answered in the thread. Browser check: `apps/web/tests/ui/connectionCard.test.mjs`.

### As built in HE-61: `suggest_task_actions`

The assistant helps the user curate the board: it lists tasks, each with why and what it suggests doing with it, and
the user settles each from a card. The board tool `suggest_task_actions` (`mcp/tools/suggestions.ts`) is the
assistant's and its routines' (`trackedList.owner`, as for tracked work; a project's agent is refused), a thread tool
(`THREAD_TOOLS`), listed after `send_to_task`; not rerunnable, not for reviewers or plan mode.

- **Arguments**: `{ title?, suggestions: [{ task, reason, actions, remind_at?, message? }] }`, 1 to 30 rows, 1 to 4
  actions each from `SuggestionAction` (contracts' `assistant.ts`): `done`, `wont_fix`, `merge`, `remind`, `backlog`,
  `start`, `message`, `delete`; the first is the one it recommends. `task` is found as `get_task` finds it, on this
  host's boards only (no other host: the card's buttons act here); a task twice is refused. `suggestionRow`
  (`assistant/suggestionText.ts`) checks the rest: a reason (at most 500 characters, as it's the reminder's note), no
  action twice, a message for `message`, a `remind_at` that `reminderTime` reads (kept as written, `1d` if left out, and
  read again when it's picked, so a delay counts from the click). The heading defaults to "Tasks to tidy up".
- **The card is a notice, not a request** (`Suggestions.post`, `Threads.card`): an info notice with code
  `task_suggestions`, its `metadata` the card (`TaskSuggestions`: `title`, `suggestions[]` with `task_id`, `key`
  (qualified `<profile>:KEY-n` for another profile's board), `title`, `reason`, `actions`, `remind_at`, `message`,
  `outcome`), its `text` a line for a client that doesn't draw it (the phone app shows it as a notice). A request would
  hold the run (`Needs attention`) and be settled once, and by any reply; a curation list waits for nobody, nothing
  but the user settles it, and its rows are settled one at a time, whenever the user gets to them. It always goes in
  the assistant's own thread: a routine's too, since the user reads routines' reports there and nobody watches the
  routine's thread. The agent is told it's up and that it won't hear what's picked, and ends its turn.
- **Settling a row** (`Suggestions.act`, `threads.actOnSuggestion { task_id, item_id, index, choice }`): under the
  thread's `["suggestions", thread]` lock (before the row's task's own), the row must be open (`SuggestionClosed`, a
  conflict) and offer the choice (`keep`, Leave it, always does). Then, as the user (the session's actor): `done` and
  `wont_fix` are `Tasks.update { status: "done", resolution }`, `merge` `{ status: "ready_for_merge" }` (the merge queue
  takes it from there, as for a drag), `backlog` likewise, each noted first with `Push.noteMove` as the user's own move
  (the handler passes it in: push is below the assistant); `remind` sets `remind_at` and the reason as `reminder`;
  `start` and `message` are `UserMessages.send` (permissions area), the board's own `tasks.send`: `Runs.send` as the
  user's (empty, which starts a task that hasn't run, or the message), and for a message, the agent's open questions
  settled as replied and its permission prompts skipped, so it reads it now; `delete` is `TaskDeletion.delete` (not the
  branch). The row's `outcome` (`{ choice, at, remind_at? }`) is written with `Threads.updateItem` once that worked; a
  refusal (an agent running, PR approval) leaves the row open and the card shows why.
- **What asks first is the card's**, as it is the board's own buttons' (the server checks neither for a user's move):
  Move to Done and Close as won't fix go through `useConfirmDone` (Done with work that isn't merged; tasks merging into
  it or landing after it), and every move through `useConfirmTodos` (leaving In progress with the agent's todo list
  unfinished), which, told to move it anyway, sends `todos_override` with the pick (`ActOptions.todosOverride`). A
  Done the assistant recommends rests on its word (say, that the pull request merged), so this is where a wrong claim
  is caught.
- **Web**: `components/task/thread/SuggestionsCard.tsx` (an item `suggestions` in the thread model): the heading, how
  many rows are left, and per row its key (opens the task), its title and live column from the board, the reason, the
  message to send, a button per action (the first highlighted; Delete asks again; a move asks as above) and Leave it; settled, what was
  done. Browser check: `apps/web/tests/ui/suggestionsCard.test.mjs`.

### As built in HE-77: interactive replies (A2UI)<a id="interactive-replies"></a>

An agent can put UI in a reply: an [A2UI](https://a2ui.org) v1.0 **Express** block between `<a2ui>` and `</a2ui>` lines
(the contract `@a2ui/agent`'s prompt generator teaches). The board draws it in the thread with its own controls
([09-frontend.md](09-frontend.md#interactive-replies)), and a click comes back to the agent as the user's message. The
plain parts are in `packages/a2ui` (`@huntaway/a2ui`, [02-repository.md](02-repository.md)); the server adds what the
agent is told and two board tools.

- **Told only while the `a2ui` experiment is on** (`prompts/a2uiNote.ts`, `PromptContext.a2ui` from
  `HostSettings.experiments`): one paragraph saying what a block is, when to use one (a choice, a short form, a
  confirmation, a card; not an ordinary answer, and not in place of `request_user_input` when the turn must stop), and
  to read the rules first. Threads under a task (reviewers, summaries, workflow steps) aren't told. Blocks are drawn
  whether it's on or not: an agent may write one anyway, or a thread may hold one from when it was on.
- **`a2ui_rules`** (`mcp/tools/a2ui.ts`; rerunnable, for plan mode, not for reviewers): the board's rules
  (`BOARD_RULES` in `packages/a2ui/src/rules.ts`: where a block goes, `surface("<id>")` first, how a click comes back,
  `surface("<id>", update=true)` to change a surface after it, the check tool) and then `ExpressPromptGenerator`'s
  contract for the board's catalogs (`boardCatalogs()`: A2UI's basic catalog and the board's macros). It's some 20 KB,
  which is why the system prompt only points at it.
- **`a2ui_check { text }`**: checks a reply's blocks as the board will draw them: `check` (`packages/a2ui/src/check.ts`)
  runs the same `ThreadSurfaces` the web app draws a thread with, over the basic catalog, so each block that names no
  surface gets one of its own and the macros are lowered and checked as drawn. The caller's thread's earlier blocks
  (its main conversation's replies from `Threads.stored`; a subagent's, an item with a `parent_id`, the board doesn't
  draw as blocks) come first, so an `update=true` of an earlier surface checks and a second `surface("<id>")` of one is
  refused. A reply with `<a2ui>` in it and no block the board draws (the tag mid-line or in a code fence) fails, as
  does one whose block doesn't close. Says `{ ok, blocks, surfaces }` or `{ ok: false, block, error }`. An agent on
  another host is checked without its thread. The server loads `@huntaway/a2ui/express` on the first call of either
  tool (it takes some 150 ms); a release packages `@huntaway/a2ui` compiled, as it does the other workspace packages
  (`scripts/package-server.sh`).
- **A click** is the user's message (`tasks.send`, so it starts, steers or queues a run as any message does): a line
  the user reads (`Clicked “Save”`, the button's text when it has one) and the action as JSON in an ```` ```a2ui-action ````
  fence: `{ surfaceId, name, sourceComponentId, context }`, the context being what the `Event` named, resolved from
  the surface's data (`actionMessage` in `packages/a2ui/src/message.ts`). Messages sent while a run is busy are
  joined into one, so a user's message can hold several clicks and other text: `clicksOf` finds every fence in it.
- **The board's macros** (`packages/a2ui/src/boardMacros.ts`): `Choice(question, options, event="choose",
  button="Choose", multiple=false)` (a ChoicePicker and a button sending `{choice: [values]}`, disabled by a
  `required` check until there's a pick; its pick is kept at `/choice/<its component id>`, so several on a surface
  would keep theirs apart, though agents are told to give each question a surface (a click locks the whole surface,
  below): the port gives `render` the instance, `{ id }`, which Python's macros don't have; a block that draws a
  `Choice` on a surface already there clears `/choice` first, as the update keeps the surface's data and the new
  `Choice` usually has the old one's id) and `Confirm(title,
  detail?, confirm="Go ahead", cancel="Cancel", event="confirm")` (two buttons sending `{confirmed: true|false}`): the
  two things agents ask most, as one line of Express each. `boardCatalogs()` is the basic catalog and the macros'
  sidecar catalog (`MacroExpander.transformCatalogs`), so the rules list them and the parser takes them;
  `boardTransform()` lowers them to basic components (`transformToTransport`) before a block is checked or drawn, so
  the renderer only knows the basic catalog. The expander writes the envelope keys bare (`catalogId`): the published
  `@a2ui/web_core` 0.15 refuses the `@catalogId` that A2UI's main (and the Python SDK the port follows) has moved to.
  A call that doesn't lower is an error on its block (`onError: "raise"`).
- **The macros port** (`packages/a2ui/src/macros/`, `src/builder/`): A2UI's `MacroExpander`, `@macro` and v1.0
  builder from the Python agent SDK (a2ui-project/a2ui `5ff1b05f`, `python/a2ui_agent/src/a2ui/transformers/macros`,
  `builder/{core,v1_0}`), which upstream has only in Python. TypeScript has no runtime annotations, so a macro names
  its parameters' types (`macro({ name, description, params: { title: param.dynamicString("…") }, render })`) and the
  JSON Schema, the coercion of the model's arguments and `render`'s argument type come from them. The upstream
  conformance suite (`conformance/agent/macros/macros.yaml`, copied to `test/conformance/fixtures/`) runs: its 46 v1.0
  cases pass; the 24 v0.9 cases are skipped, each listed with its reason (the v0.9 builder and macros aren't ported:
  Express targets v1.0).
- **The fake agent** (`packages/testing/bin/fake-claude.ts`) answers a prompt containing `fake-a2ui` with a form,
  `fake-a2ui-choice` with the `Choice` macro, and a click with that surface updated to say what was sent, for trying it
  on a test server.

### As built in HE-78: HTML pages in the thread<a id="html-pages"></a>

After T3 Code's html_render and html_preview: an agent shows a self-contained HTML page in its thread, and checks it
first in the host's headless Chrome. Both are board tools (`huntaway` server) registered with the browser area
(`browser/renderTools.ts` the definitions, `browser/HtmlRender.ts` the handlers, `HtmlTools` merged with `BrowserTools`
in `Main.ts`), since the previews use its Chrome and the browser area is above `mcp/`; `BOARD_TOOLS` lists them last.
Thread tools (`THREAD_TOOLS`: the page is the caller's thread's, the files are its host's), `ForPlanning`, not for
reviewers; `html_preview` is rerunnable, `html_render` not (a second page would show).

- **What they share** (`packages/shared/src/htmlRender.ts`): the theme a page gets (`HTML_RENDER_THEME`, the board's
  colours under the names an `<ia-html>` has, plus `--chart-1..6`, `--radius`), its base style (`htmlRenderStyle`: no
  background, the board's type, body margin 0 and `display: flow-root` so the body's extent is the page's), the page as
  a frame loads it (`htmlRenderPage`), the check that refuses a viewport height unit (`viewportHeightUnit`: a frame that
  fits its page would grow forever), the local images a page names by absolute path (`localImages`, `inlineImages`,
  `isImageBytes`), the file name from the title, and `htmlRenderAttachment`, which finds the kept page in the call's
  answer. The tools' shared description is `HTML_RENDER_PAGE_RULES`. `FRAME_CSP` moved to `frameCsp.ts` beside it, so a
  preview loads under the policy the board shows the page with.
- **Preparing a page** (`preparePage`): a viewport unit is refused; each absolute image path is read (at most 5 MiB, one
  byte past it at most, after a `stat`), kept only if its bytes are an image (so a renamed key can't go into a page), and
  put in as a data: URI; the page with them must fit an attachment (10 MiB). `html_render` refuses a page with an image
  it couldn't read; `html_preview` loads it and says which.
- **`html_render { title, html, height? }`** keeps the page with `Attachments.save` (a new method: `upload` without the
  base64) as `attachments/<id>/<title>.html`, and answers `SHOWN` with that path. The path in the thread's tool result is
  both how the web finds the page and what keeps it (`Attachments.referenced` scans thread items): it goes when the
  task does. No table, no new RPC (`attachments.get` reads it).
- **`html_preview { html, width? }`** loads the page in `Browsers.scratch` (a new method: a page of its own in the
  headless Chrome, closed after; `reap` keeps Chrome up while one is open) at `width` (240 to 1600, 760 unless given),
  held as the thread holds it (`previewDocument`): a wrapper whose policy is only `frame-src
  'none'` (a srcdoc frame inherits its parent's policy, so anything more would hold the page to it too; a test checks an
  inlined image, eval and a blob: worker still work) holds a sandboxed srcdoc frame (`allow-scripts allow-forms`: no popups, no navigating the top, no dialogs)
  with the page under the documents' policy and theme. So a page can't make the host's Chrome load another address
  (with its profile's cookies, or one on this machine) and get a screenshot of it back, which a top-level page could
  (found in review; the test points every way out at a local server and checks it's never asked). The page's console
  reaches the wrapper by script (`CONSOLE`, first in the frame: its console calls, uncaught errors and rejections,
  `securitypolicyviolation` events, and its dialogs, which the thread's frame ignores), not over the protocol: Chrome
  runs the sandboxed frame in a process of its own, which the protocol would have to follow
  (`Target.setAutoAttach`). The wrapper loads from an address of its own, `https://preview.huntaway.invalid/`, whose
  request the preview answers (`Fetch.enable` for it alone, `Fetch.fulfillRequest` with the wrapper and its policy as a
  header), not written into the page's about:blank with `Page.setDocumentContent`: that document has no site, and CI's
  Chromium aborted placing the sandboxed frame's process beside it (`Check failed: has_site_`,
  site_instance_impl.cc), after hanging in `setDocumentContent`. A Chrome
  that exits other than cleanly logs the stderr kept (its last 4,000 characters), and its error names the line a crash's
  report starts with (`lastSaid`). The page reports its height to the wrapper as
  `fitFrame` does; the preview waits for the wrapper's load, that height, two frames and 200 ms for what the page logs as it starts (10 s at most), and answers a PNG
  of up to 4000 px with its height, the console as the page told it, and the images it left out. A dialog on the
  wrapper (should anything get one up) is dismissed with a line saying so, rather than holding the page. Trusted Types aren't
  required in a preview: the board's default policy lets every string through, so a page behaves the same.
- **Content results on the board's server**: a board tool's result is JSON text, so these two return MCP content marked
  `_meta: { "huntaway/content": true }` (`BoardContent`, `boardContent` in `mcp/tool.ts`), which `callResult` gives as it
  is (without the mark); no other board tool's JSON can be taken for content. Refusals are error results with the reason.
- **Tests**: `browser/HtmlRender.test.ts` (the attachment and its inlined image, the refusals, a preview in this
  machine's Chromium with its height, console and a CSP refusal), `packages/shared/test/htmlRender.test.ts`.

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

## ACP agents (HE-69)<a id="acp"></a>

A third agent kind, `acp`: any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com)
(JSON-RPC 2.0 over newline-delimited stdio), with Google's Antigravity CLI (`agy acp`) as the default, which is how the
board supports Google's models. t3code (`~/personal/t3code`, `packages/effect-acp`, `apps/server/src/provider/acp/`)
was the reference for the protocol and Antigravity's dialect.

- **The config**: `AgentConfig.agent = "acp"` and `command`, its command line (null or blank for `agy acp`); its
  `config_dir`, when set, is the agent's home (`GEMINI_HOME` for Antigravity), blank for the agent's own. No proxy.
- **`acp-run`, the adapter**: `apps/server/src/acp-run.ts` over `agents/acp/adapter/`, exec'd by the launcher as
  `codex-run` is, reading `acp.json` (`agents/acp/spec.ts`' `AcpSpec`, which also marks the run as an ACP agent's). It is
  a Codex run to the rest of the board: the same stream-json input (user message, `interrupt`, `codex_response`) and
  Codex-shaped output lines, so `runs/codex/output.ts`, the Codex translator, `Permissions.onCodex` and `ToolCalls`
  handle it. The mapping is at the top of `spec.ts`. What ACP has no counterpart for: a steer (a message during a turn
  starts the next turn), compaction (an ACP run is never compacted), a rewind of the conversation (refused; files
  still rewind), a system prompt (put before the first prompt of a new session).
- **The board's tools** reach the agent as MCP servers in `session/new`: the board's own server over HTTP (as for an
  older Codex session: `in_process` false) and the others of `mcp.json`. An agent that doesn't take http MCP servers
  (Antigravity doesn't) gets each through `huntaway mcp-stdio <url>`, a stdio-to-HTTP MCP bridge (`apps/server/src/mcp-stdio.ts`),
  with the run's bearer secret in its environment. The board's tools run unasked only when the agent named the board's
  server: `acp/requestPermission` carries the call's `server` and `server_tool` each, and the board accepts only an
  exact board server name with one of `BOARD_TOOLS` (a project's server may be named `huntaway__x`; a title
  `mcp__a__b__c`, which splits two ways, names no server).
- **Permissions**: the board's permission mode picks one of the agent's session modes, every run
  (`bypassPermissions` → `yolo`, `acceptEdits` → `auto_edit`, `plan` → `plan`, else `default`). Every mode but
  `bypassPermissions` falls back to `default`, so a resumed session left in `yolo` by an earlier run is taken out of it
  (Antigravity offers only `default` and `yolo`); an agent with modes but none of these is a warning in the thread.
  Out of `bypassPermissions` the run fails, before a turn, when the session is in a mode that asks nothing (one of
  `bypassPermissions`' candidates) and can't be taken out of it, or was resumed and its mode change failed; a resumed
  session that reports no modes is sent `session/set_mode default` all the same (only `-32601` is let pass). Nothing
  sandboxes an ACP agent, so a mode that asks nothing would run its commands and edits without the board.
  Every `session/request_permission` is asked in the thread as a Codex approval is, its request's metadata
  `agent: "acp"` (the run has `acp.json`) so the card says "The agent" and not "Codex". `dontAsk` is the agent's
  `default` mode, so the board denies what isn't allowed already: ACP has no sandbox like the one that makes Codex's
  `dontAsk` safe.
- **Sign-in** is the agent's own: the adapter never calls `authenticate` interactively. A `session/new` refused with
  `-32000` (Antigravity signed out) fails the run with "sign in by running `agy` once".
- **Tests**: `packages/testing/bin/fake-acp` (an ACP agent with fake-codex's markers), the adapter's tests against it,
  and `tests/e2e/acp.test.ts`.

### As built (HE-69)

- **Config** (migration `2026-11-21-acp-command.ts`, `agent_configs.command`): blank is null; a command on a Claude or
  Codex config is `Invalid`, and a config that stops being ACP loses it; only Claude configs take a proxy. `command`
  is optional on the wire (absent from older servers). `ConfigArchives` copies Antigravity's login
  (`antigravity-acp/acp_token.json`, `antigravity-acp/settings.json`, `settings.json`, `GEMINI.md`, `config`; folder
  `~/.gemini`), a best guess from t3code.
- **Launch** (`agents/acp/launch.ts`, the ACP half of `LaunchFacts`): the model is the task's own, not the project's or
  profile's defaults, which name other agents' models; the effort is the task's. The adapter decides on the model where
  the session's are known: one the agent offers is set whatever its name (Antigravity serves `claude-*` and `gpt-*`
  models); one it doesn't is a warning, unless it is a Claude or Codex model (`gpt-*`, `codex*`, `o<digit>`), a pick
  left from another config, which is the agent's own unsaid. The new-task dialog drops a Claude-named pick only when the
  config's listed models don't have it (`ownModelPick`). A compaction is refused before any work is set up, and `Compaction` skips every
  config that isn't Claude's. A rewind of an ACP task's conversation is refused (`checkpoints/conversation.ts`); its
  files still rewind.
- **The adapter** (`agents/acp/`: `protocol.ts` lenient schemas, `map.ts` the pure mapping, `session.ts` model, effort
  and mode, `rpc.ts` the JSON-RPC client, `adapter/{setup,run,models}.ts`): item ids start with a random seed per run
  (`<seed>:tool:<toolCallId>`), so a resumed session's next run reuses none. `thread/started` is written for a resume
  too. Resume is `session/resume`, else `session/load` (its replayed history dropped), else a new session with a
  warning. A `usage_update` gives the context (`last.totalTokens` = `used`, `modelContextWindow` = `size`) and counts no
  tokens; the prompt's `usage` adds to the run's total. An `interaction_` tool call is Antigravity's question: no item,
  asked as `item/tool/requestUserInput` with one question `answer`. `acceptForSession` answers `allow_always`. After a
  `session/cancel` the turn has 10 s to end, then the agent is killed and the turn written as interrupted. The agent's
  `BROWSER` is `true`, so a sign-in never opens one.
- **Robustness** (after review): the agent runs as `sh -c LAUNCH <program> <args>` (`agents/acp/rpc.ts`) in its own
  process group, with a watchdog on a pipe the adapter holds, so the group dies with the adapter however it ends; at
  the end its input closes and it has 3 s to exit before the group is stopped. Setup calls time out (60 s; resume and
  load 120 s, then a fresh session). Antigravity's MCP calls (`Run wait?`, `_meta.is_mcp_tool_call`, the server and
  tool in `rawInput`) are named by `rawInput`, and a bare tool name of the board's (`BOARD_TOOLS`, now in
  `packages/shared`) is the board's server's. Text after a turn's end is still written; a cancel the agent answers
  with an error ends the turn interrupted; an agent dying mid-turn ends it failed. The http MCP servers'
  `Authorization` headers (the run's bearer secret) are redacted from the strings of everything the adapter writes;
  other headers and a stdio server's environment are paths and ports a thread shows, and are left. A config's command takes simple quotes (`commandWords`, no shell).
- **`acp-run --list-models <spec.json>`** prints one line, `{models: [{id, name, description}], current, efforts,
  default_effort}` (the `model` config option, else the legacy `models`; efforts from a `thought_level` option); exit 3
  is a sign-in refusal. `AcpQueries` (`agents/AcpQueries.ts`, live in `agents/acp/AcpQueriesLive.ts`) runs it in a temp
  folder (30 s, cached 10 minutes per config) for `configs.models`.
- **`huntaway mcp-stdio <url>`**: each stdin message is its own POST (concurrent, so a `wait` holds up nothing) with
  the headers in `HUNTAWAY_MCP_HEADERS` and the server's `Mcp-Session-Id`; every JSON-RPC message of a JSON or SSE answer
  goes to stdout; an HTTP failure is a JSON-RPC error; a broken stream reconnects with `Last-Event-ID`.
- **Requests**: `acp/requestPermission {threadId, turnId, itemId, tool, title, input}` is asked as Read, Edit, Grep,
  WebFetch, Bash or Think by the ACP kind, else as `mcp__acp__<kind or title>` (a title never passes for another
  server's tool); a board tool (`mcp__huntaway__*`) is allowed at once only when the agent named the board's server
  (`server_named`), not when the board's server was guessed from a bare tool name a project's server may have too. A
  call's kind (`execute`, an edit, a diff) decides what it is before its title, and only a bare `mcp__<server>__<tool>`
  title names an MCP call.
- **Elsewhere**: an ACP run's tokens are `countAcp` (Codex's counting, runtime `acp`, no rollout file, each run on its
  own: the adapter's totals start at zero every run, a resumed session's too); it never reviews
  its own waits; its titles are written by Claude Code as when there's no config; no usage limits or window restarts;
  no Claude skills (`AgentTools.taskSkills` gives none); its prompts are the non-Claude texts (`codex: true` and `acp`:
  no Codex `wait` or apps notes); `host.info`'s `agent_clis` has `acp` when `agy` is on the PATH.
- **Web**: `AGENTS` has `acp` ("ACP agent (Antigravity)", short "ACP", `~/.gemini`, `GEMINI_HOME`); helpers
  `listsModels`, `agentSuffix`, `askerName`, `modelPlaceholder`. The effort pickers (`effortOptions`) offer the
  model's `thought_level` values that are `Effort`s, in its order (a task carries no other, so "none" or "extra-high"
  is left out), and only the default effort when none are. The config form has a Command field for ACP (help
  behind its `?`), the list an ACP badge with the command; usage, the 5-hour window, copying the login and `/compact`
  are hidden for ACP; its skills are `/` commands. Its mark (`ui/AgentIcon.tsx`) is the board's own drawing of two
  four-pointed sparkles.
- **Left out**: approval rules and a reviewer's restrictions (Codex's read-only sandbox and gh's write tools turned
  off) are not applied to an ACP run, which runs in the task's permission mode. Antigravity was never run for real (it
  was signed out where this was built): how it names MCP tools (a call without a server name is server `mcp`, which
  would also hide the board's `wait`), whether its `inputTokens` include cached ones, and whether a signed-in `agy acp`
  wants `authenticate` before `session/new` are unverified. The system prompt goes before the first prompt, though
  Antigravity advertises `_meta.antigravity.systemPrompt.append`, whose shape t3code doesn't show.
- **Tests**: `agents/acp/map.test.ts` (every line decodes and translates), `agents/acp/adapter/adapter.test.ts`
  (`acp-run` against `fake-acp`), `mcp-stdio.test.ts` (against the board's real MCP route), `agents/acp/launch.test.ts`,
  `AcpQueries` tests, `tests/e2e/acp.test.ts` (a whole server: permission, Bash, `list_projects` over `mcp-stdio`, the
  reply, In review, `configs.models`, signed out), the web's `tests/ui/acpConfig.test.mjs`. fake-acp's markers and knobs
  are at its top.

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
- **Dev servers left running (HE-56, the old HA-409)**: `RunInput.turnEnded` with only background tasks that
  `detachable` allows (Bash shells not waited on that `mayOutliveTurn` lets go: a dev server never holds its task in
  In progress, a test, build, check or wait does. The command's words decide (a server word such as `dev` or `serve`,
  a name ending in `-server` or `_server` even as the program's path after `exec` or `nohup`, or `start` after a
  package manager or `expo`, `next` or `react-native` (HE-95, KIW2-5's) make it a server; `test`, `build`, `cargo`,
  `timeout`, an `until` loop or a script named so, `scripts/build.mjs`, one waited on); a command that says neither is
  read by its Bash call's description the same way, and one whose description says neither may be left too (HE-106:
  ODS-92's `node --input-type=module < $TMPDIR/email-dev.mjs`, "Restart the email template preview server", held its
  task in In progress). Listening on a port is what makes it a server), of a task `lastingOf` says goes to
  review, on Linux, arms a `detach` fiber: after `DETACH_AFTER` (1.5 s), and once `DevServers.shellsListen` sees each
  of the agent's shell sessions listening on a port (again every `DETACH_RETRY`, up to `DETACH_FOR_MS`), it writes
  `background-detached` and `Shim.killAgentOnly` (SIGKILL to the agent's group). `outcomeOf(…, detached)` makes the
  killed run's end Ok; `BackgroundWork.runEnded` notes them as left running (`LostBackground.running`), and the next
  prompt says so. A steer, a stop or a new turn meanwhile leaves the run be. `DevServers.stopLeft(task, why)` (the old
  `stop_task_processes`) stops what a task's agents left running, from the reactor once the task is done with no agent
  left, or deleted. The banner's Stop buttons call `tasks.stopBackground` and `tasks.stopServer`.
- **Forward port (HE-81, new)**: `tasks.forwardServer { id, port }` (`runs/PortForwards`) shares a server the task lists
  with tailcat: `tailcat --json serve --key=new <port>` under the watchdog (`Proc.WATCHDOG`, as SSH links' tunnels), its
  address (`PortForward`) read from stdout, one share per task and port in a `FiberMap`, ended when the task no longer
  lists the port (looked at every `CHECK_EVERY`) or tailcat exits. `HUNTAWAY_TAILCAT` (`ServerConfig.tailcatBin`) names
  it; test boards have none. The desktop app's `forwardPort(address, port, host)` (preload, `main/forwards.ts`) runs
  `tailcat forward <address> 0:<port>` and answers its `127.0.0.1` URL; a browser shows the command instead. HE-82: the
  app keeps one forward per board, task host (`host_id`) and port, so the host's next share of the port (a new address,
  once the server or the board restarted) stops the forward of the last one, which leads nowhere: tailcat prints
  nothing when its peer is gone (only `--verbose` logs, a failed dial on each connection), so that is the only sign. A
  board that gives no host gets a forward per address and port, as before. Each runs under the same watchdog (bash, not
  on Windows), so they die with the app, even when it crashes. Mobile has no servers banner yet, so no Forward port.
  HE-84: a start holds a lock for its share alone (`KeyedLock` `["forward", "<task>:<port>"]` on the server, an
  `RcMap` of semaphores by forward on the desktop), so two clicks start one tailcat while a slow start (up to
  `START_TIMEOUT`) holds up no other port or task. When `tailcat serve` stops before its address, its reason is read
  from the end of its stderr once that has ended, not as its exit is seen, which can come first.
  HE-85: tailcat proxies a bare port to `localhost`, so a server listed (`TaskServer.address`) only on another address
  (`--host 192.168.1.5`) is served through a port mapping, `tailcat serve <port>:<address>:<port>` (IPv6 in brackets),
  when `tailcat serve --help` tells of port mappings (after v0.7.0, which has none); with a tailcat without, Forward port
  fails `Unavailable` with why ("listens only on 192.168.1.5; tailcat v0.7.0 can only share servers on localhost",
  its version from `tailcat version`) rather than share an address nothing answers on. A server on `127.0.0.1`, `::1`,
  `0.0.0.0` or `::` is served as before, without asking tailcat. A task lists one server per port, so one listening on
  several addresses (`192.168.1.5` and `127.0.0.1`, a socket each) is listed on one of those four if it has one
  (`DevServers`' scan, `shown`), whichever socket the scan meets first: it's shared as localhost, not refused.
  HE-92: the banner leaves Forward port out where the server is localhost already: in the desktop app whose board's
  server runs on its machine (no `serverUrl`, so the preload has `paneDebugger`, as for the browser pane), for that
  server's task (`localHostId`), not a linked host's (`forwardPort.onTaskHost`). A browser keeps it, even at
  `localhost`: that may be a tunnel from another computer (`ssh -L`, docs/guide/server.md), and so may the app's
  `serverUrl` at `localhost`, where Forward port is the board's way to reach the server.
- **Shown shared (HE-83, new)**: while a share lasts, the task's server says so: `TaskServer.forwarded`, the time the
  share started (`PortForward.since` too), written by `PortForwards` as tailcat prints its address and cleared by the
  share's finalizer, however it ends (tailcat exits, the server goes, the board stops), each as a `task` event. A scan
  (`devServers/proc.shown`) keeps it by port; one that missed the server for a pass and wrote it without, the share's
  next `CHECK_EVERY` writes back. `PortForwards.reset` (in `RunLoops`, not the layer: a read-only server builds that)
  clears what a board that stopped left, as its shares died with it. The banner shows "Shared with tailcat" from the
  task, and the command or local URL it was given only while `forwarded` is that share's `since`, so it goes when the
  share does; Forward port then asks again, and gets the same share while it lasts. The task says only *that* it's
  shared, never the address: a task goes to every client and every agent that reads the board (`get_task`, the
  `huntaway` MCP tools of other profiles' agents, the phone's cache, logs of events), while the address is a key to
  the server, so it comes only from `tasks.forwardServer`, to a client that asks for it.
- **Also**: `tasks.waitForLimit { id }` (`Runs.waitForReset`, the old `wait_for_reset`); `Runs.created(task, input)`,
  which `tasks.create` calls: `start` starts the agent, and a task with only a description gets its title written
  first (`Titles.generateLater`, starting it after if asked); `tasks.create` can then fail as `tasks.send` does
  (`Unavailable` added to its contract).

### Model fallback (HE-59)<a id="model-fallback"></a>

Claude Code can move a session to another model: when Opus 5.5's safeguards flag it (`system`/`model_refusal_fallback`,
`scope: "session"`), Opus 4.8 answers it from then on, also when a later run resumes it; when the model fails
(`system`/`model_fallback`: overloaded, retired, no access) another answers that turn. Both carry `original_model` and
`fallback_model`.

- The translator (`agents/claude/translate.ts`) writes a warning notice ("Opus 5.5's safeguards flagged this session,
  so Opus 4.8 answers it from here.", Claude Code's own text as its detail) and says `ModelFallback { from, to, reason }`
  to the run. The notice has no `code`: a coded notice is the agent's own words (the web draws it as its text), and this
  is the board's warning. A refusal with `scope: "local"` (a subagent's or side question's one
  answer) gets the notice only: the session's model is unchanged.
- The line handler writes it to the task's `model_fallback` (`ModelFallback { from, to, reason, at }`, a JSON column
  added by `2026-11-19-model-fallback.ts`). Every main-conversation `assistant` line says `ModelAnswered { model }`
  (not Claude Code's `<synthetic>` ones); one from another model than `to` clears it, so a new session back on the
  model it asked for, or a model the user picked since, ends the mark without the board having to know which. The line
  handler keeps each followed task's `to` in memory (read once, kept as it commits), so a reply reads and writes nothing
  while the task has no mark, and stays `deferrable`: only one that takes the mark off ends its chunk's transaction.
- The web app marks the task, amber, with the model answering (`ModelFallbackBadge`, "Opus 4.8") on its card and list
  row and beside its thread's model picker; hovering says why and since when. `modelName` (contracts) names a model
  as people say it (`claude-opus-4-8` is `Opus 4.8`).
- Codex has no such line; its tasks never have the mark.

### Output styles (HE-102)<a id="output-styles"></a>

Claude Code's `/output-style` picks how the agent writes its replies (`default`, `Explanatory`, `Learning`, a user's
`<config>/output-styles/*.md`, a project's `.claude/output-styles/*.md`, a plugin's). In `-p` it is not a command, so the
board has its own, for a Claude task:

- **`/output-style <name>`** (`queue.ts` `outputStyleCommand`, handled in `Runs.send` like `/new`, under the task's
  lock) sets the task's `output_style` (a text column, `2026-11-24-output-style.ts`; null is whatever Claude Code's
  settings say) and writes an info notice. It is no message for the agent and starts no run, so it neither answers
  the agent's questions nor skips its permission prompts (`reachesAgent`, in `UserMessages` and `Assistant.send`). The
  name is the rest of its first line: what follows (the composer's line comments, attached files) is sent on to the
  agent as the user's message, as `/new <message>`'s is, and that one does answer and skip. Every later launch gives
  it as a setting (`--settings '{"outputStyle": …}'`, with the hooks when there are any), which outranks the settings
  files; a running agent is also sent `apply_flag_settings { outputStyle }` on its input, which Claude Code takes for
  its next turn (a run whose input has closed is ended, and the next is launched with it).
- **The name** is matched to the styles the task's last run listed, exactly, else in any case (`styleNamed`); one not
  among them gets a warning notice with the list, and nothing changes. Before a run has listed them, any name is
  taken as it is (a plugin's style isn't in the board's own list).
- **`/output-style`** alone says the task's style (or its last run's) and lists them.
- **The list.** Claude Code's answer to the board's `initialize` has `output_style` and `available_output_styles`; the
  line handler keeps them per task in memory (`AgentTools.recordOutputStyles`, lost on a restart). `tasks.skills`
  gives a Claude task's `output_styles` (that list, else Claude Code 2.1's built-in ones and the files'; descriptions
  from the built-ins and the files' frontmatter, `agentTools/outputStyles.ts`) and its last run's `output_style`. Codex
  and ACP tasks have none: the command says so in a warning notice there.
- **The composer** (`task/SkillMenu.tsx`) offers `/output-style` (with the style it has now), and once its name is
  being typed lists the styles, the current one marked; picking one fills in `/output-style <name>`, and Enter sends it.
- **A project's and a profile's (HE-111).** `projects.output_style` and `profiles.default_output_style` (text columns,
  `2026-11-26-default-output-style.ts`; blank is null) are the style of their Claude tasks that have none of their
  own: a launch gives the task's, else its project's, else its profile's (`agentTools/outputStyles.ts` `styleOf`), and
  null leaves it to Claude Code's settings files. A review thread (a reviewer's, a summarizer's) takes only its own, so
  a `Learning` or `Explanatory` default doesn't reach the reports the board reads. A changed default reaches a task's
  next launch, not a running agent. `/output-style` alone names the one given and whose it is ("Output style: Concise
  (the profile's)"). They are set in the profile form's Agents group and the project settings' Agents tab
  (`hosts/profileFields.tsx` `OutputStyleInput`: a text field suggesting Claude Code's built-in styles, which are
  `@huntaway/shared`'s `BUILT_IN_OUTPUT_STYLES`; any other name, a user's, a project's or a plugin's, is taken as typed).
  The profile's syncs between hosts with its other settings (`settingsSync/fields.ts`). On the wire both are optional
  (`Project.output_style`, `Profile.default_output_style`), as a host from before HE-111 sends neither. Codex and ACP
  have no output styles: their launches never read either.

### Code Mode (HE-107)<a id="code-mode"></a>

Claude Code's Code Mode (its own experiment, `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE`) has the agent work through a REPL
tool, writing JavaScript scripts that call its tools, rather than one tool call at a time. The board's `code_mode`
experiment (Settings → Experiments, [09-frontend.md](09-frontend.md#experiments-he-22)) asks for it in new Claude
conversations.

- **Asked for in `--settings`.** A `-p` run takes the variable only from `--settings` (Claude Code's `flagSettings`):
  from the environment or the settings files it refuses it (`not_passed`). `hookSettings` adds
  `env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1" }` beside the hooks and the output style when `claudeLaunch` asks.
  Codex and ACP runs have no such thing.
- **A conversation keeps the mode it started in.** Claude Code decides Code Mode when a session starts. It refuses to
  resume a session that started in Code Mode in a run that isn't asked for it ("This session was started in Code Mode,
  which is off in this run, so it can't be resumed"), and tells a session that didn't, on every run that asks, that it
  goes on with the ordinary tools. So `claudeLaunch` asks for a new conversation (no `session_id`) as the experiment
  says (`codeMode`, read from the host's `experiments` at each launch), and for one it resumes as its session started
  (`sessionCodeMode`), whatever the experiment says now: switching it on or off applies to new conversations.
- **Which sessions are in Code Mode.** A Code Mode session's `system`/`init` lists Claude Code's `REPL` tool (an
  ordinary one doesn't), so the translator's `SessionStarted` says `codeMode`, and the line handler writes it to the
  run's `runs.code_mode` (`2026-11-26-code-mode.ts`). `RunRepo.sessionCodeMode` reads the session's first run's, as
  Codex's `sessionBoardTools` does. Runs imported from the old board have it off.
- **Claude Code decides.** It refuses a new session Code Mode when it goes through a gateway or a cloud provider (a
  config's proxy, `ANTHROPIC_BASE_URL` in the config folder's settings), on a model older than Opus 5.5 or Fable 5.2,
  with tools that leave its REPL out, and for its other reasons; then it starts with the ordinary tools and writes
  `system`/`notification` with `key: "code-mode-opt-in"` and why. The translator turns its `code-mode…` notifications
  into thread notices (a warning when Claude Code colours it one) and drops its other notifications. Only a new
  conversation asks when the session's own mode is ordinary, so the notice comes once per conversation, not every run.
- **A Code Mode conversation that can't go on.** When a resumed Code Mode session can't have it any more (its model
  or its config's gateway changed since), Claude Code refuses to resume it: the run ends with a `result`
  (`error_during_execution`, no turns) whose `errors` starts "Failed to resume session: This session was started in
  Code Mode". The line handler (`recordTurn`, `codeModeResumeRefused`) then clears the task's `session_id`, as for a
  session that was never answered, and writes a warning notice: the next message starts a new conversation.
- **Checks.** `launch.test.ts` (the setting with and without hooks, none when off; a resumed session asks as it
  started), `translate.test.ts` (the notice; `init` with `REPL`), `RunRepo.test.ts` (`sessionCodeMode`),
  `runs/claude/output.test.ts` (the run's `code_mode`; a refused resume clears the session and warns).

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

### Stack threads (HE-105)<a id="stack-threads"></a>

A stack's levels each have their own agent, and restacking (rebasing a level onto the level below after that changed,
force-pushing, putting pull requests' bases right) touches several of them at once: left to the levels' agents, they
each tried to coordinate it (work:ODS-89). So a stack has **one lasting thread of its own** that manages the stack as a
whole, which the user messages, and which the levels' agents are told to hand stack work to.

- **The row** (`tasks/StackThreads.ts`): `task_type` `stack` (`ThreadKind` `Stack`), in the stack's project (numbered
  and keyed as the project's tasks, e.g. `HE-12`), `parent_id` the stack's bottom, `use_worktree` off, titled
  `Stack: <the stack's title>`. `thread(id)` (`tasks.stackThread`, any level) finds the one under any of the stack's
  levels (`stackThreadOf`, the bottom's first) or makes it in the transaction that looked; `Invalid` for a task in no
  stack, or a stack in no project. Off the board: the web board already leaves out a project's rows with a `parent_id`.
- **Made when it's first needed**: from the Stack card (its thread button, or its menu's "Open the stack's thread"), or
  when a level's run is launched (`Prompts.system`), so a level's agent always has a key to send to.
- **What it's told** (`prompts/stackThread.ts`, then `prompts/stackBrief.ts` last, as a pen's thread is told its pen):
  that it is where the stack is managed; how to restack (bottom up, in each level's own worktree, never under a running
  agent, `git rebase --onto <below> refs/huntaway/start/<id>`, the start ref moved after, checks, `--force-with-lease`,
  GitHub's stack keeping its bases); to leave a level whose `restack` is `due` to the board; to hand the levels' own
  work to their tasks; not to merge, move or delete them. The brief lists the levels bottom first with key, state,
  title, id, the level each lands after, branch and base, start ref, worktree (once set up), pull request and GitHub
  stack, and restack state. Its first prompt is the message (a conversation, like the pens threads).
- **What a level is told** (`codeTask`'s `stackNote`, from `agents/prompts/stack.ts` `stackLevelOf`): "This task is
  level N of M of a stack (…), whose own thread, KEY, manages the stack as a whole. Refer any stack management to it…",
  with `send_to_task`; a restack the board itself asks of it (`RestackAsk`) it still does.
- **Where it works**: in the project's repository (`cwdOf` falls through to it), with the open levels' set-up worktrees
  as `--add-dir`s (Claude) or writable roots (Codex, `workDirs`); its permissions are the project's, as a task's.
- **A lasting thread**: its runs end in To do (`lastingOf` `stack`), never reviewed, never in a workflow
  (`workflows/engine/start.ts` skips it), nothing to merge (`decide.ts` `ownFolderKinds`); it can't be moved to In
  review, Ready for merge, Done or Backlog.
- **It stays with its stack** (`StackThreads.settle`, the reactor's step after the stack titles', for a task made,
  deleted, changed in what it starts from or merges into, or closed or reopened; the plan is the pure `settleThreads`).
  A change touches only the threads of the stack the task was in before it (read from the rows with the task as the
  change says it was, so a change the reactor comes to late, after later ones, decides as it would have) and of the one
  it's in now. A thread's home (`homeIn`) is its stack's bottom (which changes when a level is put below it), or a level
  held on a deleted or closed level below (`heldLevel`: its merge waits for the user to say where it goes; its brief
  says so, `heldBrief`). A thread whose part of the old stack has no home, or is all done while another part isn't,
  goes to another part's home (a split, a deleted middle level); with none, it's deleted (`TaskDeletion`, which stops
  its run). Of two threads in one stack (two stacks joined), the older stays, whichever side it came from, and the other
  is deleted.
- **A level deleted** (`TaskDeletion`): the thread of the task's stack and the levels landing on it are read before
  `Worktrees.forDeletion` (which unstacks the levels on a merged task); after it, on the rows as they'll be without the
  task, the thread goes where its part will have a home, else (or when its part is all done and theirs isn't) under the
  home of a level that landed on the task (`beforeDelete`, `rehome`). With no home at all, a thread under the task has
  its run stopped and goes with the row (`Tasks.delete` emits its `task_deleted`); `decideDeleted` moves one under the
  task to the first level on it, for a `Tasks.delete` of its own.
- **Not a task to wait for, start from or merge into**: `checkDependencies`, `checkStartFrom` and `checkMergesInto`
  refuse it (`Invalid`), and the web's dependency and New task pickers leave out a project's rows with a `parent_id`.
- **Not started on nothing**: a conversation (the assistant, the pens threads, a stack's thread) with no session isn't
  started on an empty message (`queue.ts` `decideSend` answers `Nothing`; its composer doesn't offer to), nor by
  `update_task` moving it to In progress.
- **The web**: the Stack card has a thread button (amber while the thread asks something), shows the thread's running
  dot and attention, and its menu has "Open the stack's thread"; the thread opens on its conversation, without Changes,
  Code or Review tabs, with a "Stack thread" section in Details.
- **Tests**: `tasks/StackThreads.test.ts` (made once, from any level; refused for a task in no stack and for In review;
  what a level and the thread are told; kept when its bottom is deleted, a merged one through `TaskDeletion` too; moved
  to a new bottom and with a split; held with a level on a deleted middle level, then restacked; following the levels on a
  deleted middle level that weren't flagged; kept when a merged level above the bottom is deleted; the older of two
  joined stacks' threads kept; gone once no stack is left; refused as a dependency, start or target),
  `tasks/settleThreads.test.ts` (the plan, a change come to late among them),
  `system.test.ts`'s two cases, `queue.test.ts`'s empty start, `threadKind.test.ts`'s row.

## Work across repositories (HE-116)<a id="work-across-repositories"></a>

Sets themselves are built (HE-117, [below](#sets-as-built-in-he-117)), and so are the lead's runs (HE-118,
[below](#set-runs-as-built-in-he-118)), landing together (HE-119, [below](#landing-together-as-built-in-he-119)) and the
web (HE-120, [below](#sets-in-the-web-as-built-in-he-120)). One piece of work that changes several repositories (an API and its client, say) is **one task per
repository, made together as a set**, with one branch name in all of them. This is the first of the three ways compared
in HE-116's research on T3 Code's projects with several repositories (pingdotgg/t3code#35925): it leaves review, the merge queue,
`merges_into`, stacks and pull request watching as they are, because each repository is still its own task. A project
that covers several repositories, as in T3 Code, would make all of those per repository; it is not planned.

- **Made together**: `tasks.create` and `create_task` take `also_in`, other projects of the task's profile (seven at
  most, so eight repositories, T3 Code's default). The board makes one task in each, with the same title and
  description; the first is the set's **lead**, and the others record it in a new `lead_id` column (a named migration;
  null for the lead and for every other task). All of them go in one pen: the one given, else a new one named after the
  title. `also_in` only at creation: a task that has a branch can't join a set. Not for scratch, group, review or
  stack tasks, nor with `merges_into`, `start_from` or `use_worktree: false`.
- **One branch**: the set's tasks share `ia/<lead's key>-<name>`, made free in every repository: no local or remote
  branch of that name, and none that nests with it (`a` beside `a/b`); else `-2` up to `-50`, as T3 Code's
  `freeBranchName`. Each worktree starts from its own project's base branch.
- **One agent per worktree**: only the lead's agent starts. Setting up the lead's worktree sets up the others'
  (`Worktrees.setup` on each; a failure is the lead's too). A lead's run gets the worktrees of the set's tasks that are
  in To do with no run of their own (as the run starts) as `--add-dir`s (Claude) or writable roots (Codex, `workDirs`),
  as a stack thread gets its levels' (`stackDirs`), and its system prompt lists the whole set (key, project, repository,
  worktree, branch, base, column): it works and commits in the worktrees it was given, and opens each of those
  repositories' pull requests on that repository. An ACP lead gets them only once its launch takes extra folders. The
  lead runs in its own project's permission mode; that it can write in the others' worktrees is what making the set
  allowed, as T3 Code grants a folder only after a person chooses it.
- **Never two agents in one worktree**: once a task has left To do, its worktree is its own agent's alone. The lead's
  runs no longer get it, and the lead hands that repository's work to the task with `send_to_task`, as a stack thread
  hands the levels' own work to them (its prompt says so for each task past To do). A follower's runs get no other
  worktree: the prompt lists the set and refers anything outside its own repository to the lead. While a lead's run
  holds a follower's worktree, that follower's own run doesn't start (a message to it is held until the lead's run
  ends, as one is held for dependencies) and it can't be moved out of To do (`Invalid`: "its lead is working in it").
  So every commit in a follower's worktree after it left To do comes from its own runs, whose ends review it as any
  task's, and its checkpoints and rewinds are of one agent's turns.
- **The others** wait in To do, their worktrees ready, with a note that their lead works on them. Their own agents start
  only for what is theirs: a review round's fixes, a merge conflict, the lead's or the user's message. Each is
  reviewed, approved and merged as any task is, once the lead's run has moved it.
- **When the lead's run ends**: a column, a review and a pull request lookup follow only the task whose run ended
  (`decideFinish`; `ReviewDue` or the reactor's review on a move to In review; `PullRequests.findLater(run.task_id)`),
  so the lead's run end does it for the others too (`RunEnds`, after the lead's own move). The trigger is **the lead's
  run ending with its work finished**, wherever it would have gone to In review before HE-66's hold: `decideFinish`
  gives In review, or holds it in In progress for its review (`decision.review`, HE-66; the default, as `auto_review`
  is on by default), or hands it to its workflow column (`decision.workDone`). Then each other open task of the set in
  To do, with no run of its own going, is decided on its work, as the board counts work everywhere else
  (`TaskBase.hasWorkToMerge`, HE-51: commits its base doesn't have, or uncommitted changes in its worktree, ignored
  files left out; when it can't tell, yes). An agent often leaves its edits uncommitted, and they are the set's work too:
  - with work (commits, uncommitted changes, or both) it moves to In review, a board move from To do, so its own
    reviews start as for any such move (the reactor's `reviews.reconcile`; a project that reviews holds it in In
    progress while it's reviewed, `Reviews`), and its pull request is looked up on its own repository (`findLater` for
    that task);
  - with neither, it is closed as not done ("no changes in this repository"), which takes it out of the set's count;
    the lead's thread says so. Reopened, it is in the set again.

  A lead run that ends any other way moves none of them: in Needs attention (a question, a plan only, an unfinished
  todo list asked about once, a failure), held in In progress to finish its todo list, back in the merge queue, or in
  To do or wherever a lasting thread stays. A task already past To do is left alone: the lead couldn't write in it, and
  its own run's end moves it. Each later lead run that ends with its work finished (after review fixes, held again for the next
  round, say) decides again for those still in To do. A pure function of the lead's decision, the set's rows and their
  branches, with table tests.
- **Landing together**: a set's task in Ready for merge waits until every open task of its set is in Ready for merge,
  then each merges through its own project's queue. A task closed as not done or won't fix leaves the set's count. A
  merge that fails once others have merged is the lead's to settle, and the board tells the lead's thread. As built:
  [below](#landing-together-as-built-in-he-119).
- **Leaving the set**: the lead deleted or closed hands the set to the next open task by creation (its `lead_id`
  cleared, the others' moved to it). A set down to one task is an ordinary task.
- **The web**: the New task dialog's "Also in" picker (projects of the profile); a set's card shows "1 of 3" and opens
  a "Set" section in Details listing the others; the lead's Changes tab stays its own repository's. As built:
  [below](#sets-in-the-web-as-built-in-he-120).
- **Tasks**: in [13-milestones.md](13-milestones.md#after-the-port-work-across-repositories).

### Sets as built in HE-117<a id="sets-as-built-in-he-117"></a>

- **The row**: `tasks.lead_id` and `tasks.set_branch` (migration `2026-11-27-task-sets`, `lead_id` with a partial
  index), on `TaskRow` and on the wire `Task` as `lead_id?: TaskId | null` and `set_branch?: string | null` (absent
  from older servers). No foreign key, as `merges_into` has none: what
  happens when a lead goes is HE-119's. `TaskRepo.inSet(lead)` reads a set, its lead first.
- **Asking for one**: `NewTask.also_in` (ids, keys or former keys of the lead's profile's other projects) on
  `tasks.create`, and `also_in` on `create_task`. `Tasks.create` hands it to `createSet`. The refusals are
  `tasks/sets.ts` `checkSet`'s (`Invalid` on `also_in`, each saying why): a scratch or group task, a task in no
  project, `use_worktree: false`, a non-blank `merges_into` or `start_from`, more than seven others, and (not in the
  design above) **a set needs a title**, since its tasks and its pen are named after it and a generated title would be
  each task's own. Review and stack threads can't be asked for through `NewTask` at all. Then the projects: one not on
  the board, the lead's own, one named twice, one whose task would have no worktree (not a git repository, or
  worktrees off), or **two on the same repository** (their common git folder, canonical: one project's folder can be
  another's, or inside it), whose two worktrees can't both be on the set's branch, is refused. `create_task` passes
  `also_in` on every path, so a scratch task in no project is refused too.
- **What each task gets**: the lead is made from the request as any task is. The others get its title, description,
  labels, links, model and effort, but their own project's default config, no dependencies, no fan-out id (`Fanout`
  takes every task with the id for an alternative, so picking the lead would close its own followers), and To do where
  the lead is asked for In progress. `start` (and `create_task`'s default start) starts only the lead's agent.
- **The pen**: `NewTask.pen` is new (a pen by name, made if the profile has none by it, as `TaskPatch.pen`), and
  `create_task` now passes its `pen` there rather than updating the task after. A set without one goes in the pen
  named after its title (cut to 60 characters), which is the profile's existing pen of that name if it has one.
- **The branch**: written to every task's `set_branch` when the set is made. `branch` stays null until a worktree's
  setup makes the branch, since everything else reads `branch !== null` as "git has it" (a task merging into a set's
  task sets that one up first, an unstarted one has nothing to merge, a failed first setup leaves its settings open).
  `Worktrees.setup` makes a task's worktree on its `set_branch` when it has no `branch`, from its own project's base,
  and writes `branch` as it always does. Its folder is named after the branch, not the title, so a renamed task finds
  its worktree again: the lead's as for any branch of its project (`<number>-<slug>`), a follower's
  `<own number>-<the branch without ia/>` (`folderName`).
  The name is `ia/<lead's key, lowercase>-<slug of the title, 40>`, the lead's own branch as it would have been,
  else `-2` … `-50` (`freeBranchName`, a pure function with table tests in `tasks/sets.test.ts`); all fifty taken is a
  `Conflict` (`duplicate_name`). Taken means a local branch or a remote-tracking one (its remote's name taken off) in
  any of the set's repositories, or a `branch` or `set_branch` on a task of those projects, that is the same name
  or one a folder of the other. The git area reads the repositories (`git for-each-ref refs/heads refs/remotes` and
  `git remote`, with `git rev-parse --git-common-dir` for which repository it is, `git/branchNames.ts`) and registers that reader with the tasks area's `RepoBranches`, as the merge
  area registers `MergeFacts`, since the tasks area can't call git. `slugify` moved to `platform/slug.ts` for it.
- **One transaction**: the branches are read first; then every task is decided, the lead inserted (which gives its
  number, so the name), the name picked, the pen made and every other task inserted in one `db.tx`. Any refusal in
  there undoes all of it, the lead's number and the pen included. Events and the reactor's changes follow the commit.
- **What agents see**: `list_tasks` and `get_task` give a set's task `set`, its tasks (key, title, status, merged,
  project, `lead`), the lead first, and `set_branch` until it has a `branch`.
- **Tests**: `tasks/sets.test.ts` (the free name's table, the base name, the pen's name, every refusal),
  `git/branchNames.test.ts` (the branch names of `for-each-ref`'s refs; on real repositories, a set over three whose
  name is taken locally, as a remote's folder and locally again, with its worktrees set up on it; all or none when no
  name is free; the refused projects, two on one repository among them; a task merging into an unstarted set's task, an
  unstarted one moved to Ready for merge, and a failed first setup's settings changed), and `create_task`'s case in
  `mcp/tools/tasks.test.ts` (a scratch task in no project among the refusals).

### A set's runs as built in HE-118<a id="set-runs-as-built-in-he-118"></a>

- **What it holds** (`runs/sets.ts`, pure): a task **leads** a set when it has a `set_branch` and no `lead_id`
  (`isLead`); a follower **waits for its lead** while it's in To do with no run of its own (`awaitsLead`), and **takes
  a grant** when it also has its worktree set up (`takesGrant`). A set down to one task is told nothing of it.
- **The worktrees** (`LaunchFacts.prepareWork`): once the lead's own worktree is set up, `setUpFollowers` sets up each
  open follower that isn't running (`Worktrees.setup`, nothing for one that's ready and there), the lead's thread saying
  "Setting up KEY's worktree…" and the follower's that it waits in To do while its lead works in it. A failure is the
  launch's `WorktreeFailed`: "KEY's worktree (project, repository) couldn't be set up: …", so the lead's run fails
  ("Run failed: …", Needs attention) with the lead's thread saying "Couldn't set up KEY's worktree (…)", and the
  follower's own thread says "Worktree setup failed" with git's or the script's reason.
- **The grants** (`grantSet`, every Claude and Codex launch of a lead's `prompt` run, not a compaction): each follower
  that `takesGrant` and has no live run is recorded in a new table, `run_grants (run_id, task_id)` (migration
  `2026-11-28-run-grants`, both columns cascading), **under that follower's task lock** in one transaction, so its own
  run can't start (`Runs.send` holds the same lock) nor can it leave To do (`Tasks.change`/`update` too) between the look
  and the grant. The granted worktrees join Claude's `--add-dir`s and Codex's writable roots (`workDirs`) after the
  stack thread's; for Codex, each with its repository's git directory (`git rev-parse --git-common-dir` in it), where
  a commit in that worktree writes its index, objects and refs, as the run's own repository's is. An ACP lead calls none (its launch takes no other folders yet) and its prompt says so. A follower's
  runs are never given another worktree.
- **The hold**: `TaskRepo.heldBy(task)` is the lead whose **live** run has a grant of the task (a run that has exited
  holds nothing, so a launch given up on, a restart's reaped run and a run's end all let go without a write).
  - `Runs.send` gives `decideSend` `heldBy` (for a follower with no live run of its own); a held follower's message,
    whatever it is (a Start, a `/compact`, the board's own), is `HoldForLead`: queued, the task left in To do, and the
    first one queued says "Queued until KEY's run ends: its lead is working in this task's worktree". An archived
    project's refusal comes first.
  - `decideUpdate` refuses a held follower's move out of To do: `Invalid` on `status`, "its lead is working in it:
    KEY's run has its worktree, so move it once that run ends" (`UpdateFacts.leadHolds`, read only for such a move).
  - `RunEnds.ended`, as any run of a lead ends (and before it carries on a later run's start, which may take the
    followers again), lets go the tasks that run held (`RunRepo.granted`, only those): each still in To do and not
    running has its queue sent (`Runs.sendQueued`), or, when that holds only blank rows (a Start), a blank board message
    that isn't `auto` (which takes them), so each waits for its dependencies or a usage limit as any message does. Its
    own agent starts then, and it's that run's end that moves it.
  - `Worktrees.agentInWorktree` counts the hold, so a held follower's worktree isn't set up again or torn down by hand
    (`AgentInWorktree`), restacked, or counted idle by `Fanout`; a rewind is refused (`Checkpoints`' busy check: "Its
    set's lead, KEY, is working in its worktree…").
- **What it's told** (`prompts/setNote.ts`, from `codeTask` after the stack note; `Prompts.system` gathers the set with
  `TaskRepo.inSet` and the run's grants, `RunTold.granted`): the set as it was when the run started, lead first, each
  task's key, project, repository, worktree (or "not set up yet"), branch (its `set_branch` until git has it) and base,
  and column ("closed" for one closed unmerged). The lead is told the set's work is its own across the repositories;
  which worktrees this run was given ("given to you for this run"), to work and commit in them each on its branch, and to
  open each of those repositories' pull requests on that repository; what the board does when the run ends; and for
  every other open follower, not to work in its worktree but to hand it its repository's work with `send_to_task`. A
  follower is told its lead's key and title and to refer anything outside its own repository to the lead with
  `send_to_task`. Both texts are in the prompt goldens (`code, a set's lead`, `code, a set's follower`).
- **When the lead's run ends** (`RunEnds`, after the lead's own move, its `ReviewDue` and its `WorkflowWorkDone`):
  `decideFollowers(decision, followers)` (pure) does nothing unless `leadFinished` (the decision's `status` is
  `in_review`, or `review`, or `workDone`); then each follower that `awaitsLead` is decided on
  `TaskBase.hasWorkToMerge`: with work, `Tasks.change` to In review (the board's move from To do, so the reactor's
  `reviews.reconcile` follows) and `PullRequests.findLater` for it; without, closed as `done` / `not_done`. Each move
  re-checks `awaitsLead` under the follower's lock, so one whose own run started meanwhile is left. The lead's thread
  says "Moved KEY to In review: …" or "Closed KEY as not done: no changes in this repository"; a closed follower's
  thread says so too. A lead run whose queued message carries on, or a later run's, decides nothing yet.
- **Tests**: `runs/sets.test.ts` (who leads, waits and is granted; the three triggers and four other ends; followers in
  every state, one with only uncommitted changes among them), `runs/queue.test.ts`'s hold, `system.test.ts`'s two
  goldens and an ACP lead, and on real repositories `runs/SetRuns.test.ts`: a Claude and a Codex lead's launch with a
  follower in To do and one in In review (the whole set set up; only the first given, as `--add-dir` or writable root;
  the prompt), a follower's own launch given nothing, a follower's setup script failing the lead's launch, a held
  follower's message queued, its move, teardown and rewind refused (another follower moving freely), then sent as the
  lead's run ends, and a held Start starting its follower then; only the held tasks let go, a held Start waiting for its
  follower's dependency then and another follower's Start left waiting for its own; the Codex lead's writable roots with the follower's
  repository's git directory;
  the end of a finished lead's run with a follower with a commit, one with only an uncommitted file, one with neither
  and one in Backlog; and a stopped lead's run moving none.

### Landing together as built in HE-119<a id="landing-together-as-built-in-he-119"></a>

- **The rule** is `tasks/sets.ts` `setWaitsFor(set, t)`: the other tasks of `t`'s set that are open and not ready to
  land. Ready to land (`readyToLand`) is in Ready for merge and not waiting for the user's approval
  (`merge_approval: "pending"`): queued, merging, or handed to a workflow once merged. Not ready: any other column, a
  merge waiting for approval (it may yet be denied), a failed merge (Needs attention, still merging), a task that stepped
  out to make changes. Done tasks don't count, merged or closed (not done, won't fix). `setOf(rows, t)` is `t`'s set
  among rows of any project (`leadOf`: `lead_id`, else its own id).
- **The queue**: `decideLanes` takes `sets`, the rows of the sets of the project's tasks waiting in Ready for merge
  (`Merges.reconcileLane` reads each with `TaskRepo.inSet`), and doesn't start a set's task that waits; the next task
  queued in its lane goes instead, so a waiting set doesn't hold its lane. A waiting task's merge is still summarised for
  approval when its project wants one, so the user approves each of the set before any merges. Once none waits, each
  merges in its own project's queue, at its turn there; the queue doesn't hold one project's merge back for another's
  lane to be free. A set's task changing what the queue reads (`lead_id` joined `laneColumns`) has the queues of every
  project of its set looked at again (`Merges.taskChanged`).
- **Why it waits**: as a task of a set reaches Ready for merge and waits, its thread says so (`merge/sets.ts`
  `setWaitText`: "Waits for the rest of its set before it merges: WEB-1 (In review)…"). The web works it out from the
  board's tasks as the stack's wait is (`setMergeWaits` in `@huntaway/client`, `board/SetWait.tsx` `useSetWait`): the
  card's "waits for its set" badge (in place of "queued to merge") and the note in Details' Status.
- **A message** to a set's task waiting for the rest takes it out of Ready for merge while its agent works (In progress,
  `remerge`), as one to a waiting stack level does (`Runs`' `outOfStackWait`); it rejoins the queue when its run ends.
- **A merge failing** after others of its set merged (`merge/sets.ts` `mergeFailed`: it was merging, not waiting on the
  user, and now needs attention there, not for approval, or it left the merge unmerged without stepping out; not a
  merge handed to its project's workflow, which waits in Ready for merge out of the merge, `isHandoff`) is told
  to the lead's thread as a warning notice, with the failed task, its reason (its `attention_reason`, else the column
  it went to) and the tasks merged: `setMergeFailedText`. A notice, not a message: the lead's agent isn't started by it,
  and the lead may be merged and done. The rest of the set not merged yet wait for the failed one again.
- **Leaving the set** is `tasks/sets.ts` `handOnSet(set, gone, how)`, a pure function with table tests, run by
  `Tasks` in the transaction that deletes the lead (`Tasks.delete`) or closes it (`Tasks.update` and `Tasks.change`, a
  move into Done unmerged), each task it changes emitted and offered to the reactor. The heir is the next open task by
  creation (the order `inSet` reads); a deleted lead with no open task left hands it to the next task all the same, a
  closed lead with none keeps it. The heir's `lead_id` is cleared and every other task names it, **a closed lead
  included**: it stays in the set as a follower, so reopened it counts again, as a follower closed by HE-118 does. A set
  down to one task leaves that task with `lead_id` null. A merged lead stays the lead (the thread a failure is told to).
- **Not handled**: deleting a whole project cascades its tasks in `ProjectRepo` without `Tasks.delete`, so a set whose
  lead was in it keeps followers naming a missing lead. That still reads as a set (`inSet` of the missing id finds
  them), lands together and has no lead's thread to tell (the failed task's own is told instead).
- **Tests**: `merge/decide.test.ts` (the table: who waits for what, closed and merged tasks out of the count, approval
  still summarised, the lane left to the next task, a follower whose lead is in another project), `tasks/sets.test.ts`
  (`handOnSet`'s table, `setWaitsFor`, `setOf`), `merge/sets.test.ts` (`mergeFailed`'s table, the workflow's handoff
  among its rows), `@huntaway/client`'s `setMergeWaits`, and `merge/SetsLanding.test.ts` on the
  board and real repositories (two and three): the lead waits and says why, both merge once the follower comes, one
  closed doesn't count; a failure after two merged told to the lead's thread; a message taking a waiting task out; the
  lead closed, then deleted, then a follower deleted; a set of two whose lead is deleted.

### Sets in the web as built in HE-120<a id="sets-in-the-web-as-built-in-he-120"></a>

- **New task**: an "Also in other projects" switch in the options row (`layout/newTask/OptionsRow.tsx`) opens the picker
  under it (`AlsoIn.tsx`): a button for each other project of the task's profile on its host whose tasks get a worktree
  (`worktreesOn`), the others greyed once seven are picked. The state is `useOptions`' (`alsoIn`, `setProjects`). It is
  offered only for a code task in a project with its worktree on, and (not in the design above) not for one made with
  several models (`!opus !sonnet`), which would make a set for each. A `from:` or an `into:`, a scratch type, the
  worktree switched off or an `in:` elsewhere clear what's picked and hide it; taking the token out again doesn't bring
  them back. `useSubmit` sends `also_in` with the project ids.
- **The title** (not in the design above): the dialog has only a description, whose title the server writes later, but a
  set needs its title when it's made (its tasks, branch and pen are named after it, HE-117). So once a project is
  picked the picker asks for "The set's title", sent as `title`, and Create waits for it (`blocks.ts`' `setBlock`).
- **The pen**: opened on a pen's tab or in a pen's row, the dialog sends that pen's name as `pen` with `also_in`
  (`NewTaskModal`'s `pen`, from `TaskBoard`), so the whole set goes in it. The board's own move into the pen after a
  create (`onCreated`) hears only of the lead, which is all `tasks.create` answers, so without it the others went in a
  new pen named after the title. Opened anywhere else, the set gets that pen named after its title.
- **The card** (`board/Sets.tsx`, in `TaskBadges` beside the fan-out badge, so the list view's rows have it too):
  `1 of 3`, its place in the set (the lead first, then the others by creation and, as a set's are made at once, by key: `TaskRepo.inSet`'s order by row isn't on the wire) and the
  set's size, with a crown and (on a wide card) "lead" for the lead, a stack icon for the others; its tooltip names
  every task of the set with its project. The sets are worked out once per change of the board's tasks
  (`setsOf`), by `lead_id` on the same host; a task of an archived project isn't on the board, so isn't counted.
- **Details and the key items** (`task/view/details/TaskLists.tsx`' `SetSection`, in both as Same prompt is): "Set",
  "N repositories", and each task of the set with its status icon, key, project, "lead" for the lead and its column,
  this one marked, each a button that opens it; then the branch they share (`branch`, else `set_branch`).
- **Changes**: nothing new. The Changes tab reads the task's own worktree (`git.status` and `git.taskDiff` on the task's
  id), so the lead's shows its own repository's, and each other's is on its own card.
- **Checks**: `tests/ui/sets.test.mjs` (three projects of a profile and one of another: the picker's projects, a
  `from:` clearing it, the title it waits for, the set made and its `lead_id`s, a set made on a pen's tab all in that pen, `1 of 3` and `3 of 3` with their
  tooltips, the Set section's rows and opening one from there; not offered without a worktree or for a scratch task).
