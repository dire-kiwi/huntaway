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
  The old one exited after its first result, which let a server that never closes the input pass.

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
- **`McpHooks`** stands in for what is not built: `callMade` (ends the run's wait, `Wait` 3.5), `askRule` (the user's
  answer, `Permissions`) and `cancelled` (a call the agent gave up on: its prompt expires, its wait ends).
  `McpHooks.layerNone` ends nothing and refuses an ask, with the reason, until those pieces replace it.
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

### As built in 3.2 (HE-4)

- **`mcp/tools/<area>.ts`** declare and handle the board's tools: `questions.ts` (`request_user_input`, `finish_work`),
  `projects.ts` (`list_projects`, `get_project`), `tasks.ts` (`list_tasks`, `get_task`, `get_task_field`,
  `create_task`, `update_task`; `send_to_task` with `Runs`), `pens.ts` (`list_pens`). `taskJson.ts` is the task as the
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
- **Starting agents waits for `Runs` (2.5)**: until it is merged, `create_task` with `start` (said or by default) makes
  the task and adds the note that this host can't run agents, `update_task` moves a task into In progress without
  starting it, and `send_to_task` is not registered.

### `wait`

`Wait` owns the blocking tool: a wait is a fiber in a `FiberMap` keyed by run, racing a deadline, changes to watched
tasks, a subagent finishing, a command's exit, pull request news, a message for the run, a stop, and an explicit
move of the task. It subscribes to `Events` **before** it reads state. The stored wait (`tasks.agent_wait`) is what
a resumed call picks up after a restart: same deadline and watched set, the command started again, the pull request
read again. The nine end conditions and the "told" bookkeeping for PR news are inventory 03, sections 2.8 and 2.9.

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
`replyText` (the user's message an answer sends) are plain functions. `answer(task, requestId, …)` and the
`threads.answerQuestion` RPC send that message through `Runs.send`, and come with it; whoever sends a user's message
(`tasks.send`) calls `settle(task, "replied")`.

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
- **Not built yet: `BackgroundWork`** (Claude's `background_tasks_changed`, the `background*` run files,
  `Task.background_work`, the idle-vs-working rule, `BACKGROUND_GRACE`/`FOLLOW_UP_GRACE` at the hooks in
  `RunInput.turnEnded`, `tasks.stopBackground`, the lost-background note in `Prompts.start`, the method 3.5's
  `background_wait` needs).
