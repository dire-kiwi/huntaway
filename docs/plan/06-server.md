# 6. The server's services

Every service of `apps/server`, what it owns, and what it replaces. The agent machinery (runs, threads, board tools,
permissions) has a page of its own, [07-agents.md](07-agents.md); hosts have [08-hosts.md](08-hosts.md). For each
area the inventory note named in its heading has the behaviour in full: capabilities, timers, rules and the bugs
behind them. **An area is done when every capability in its note is either implemented or listed in
[14-dropped-and-open.md](14-dropped-and-open.md).**

## Dependency order

A service may depend on the platform and on areas above its own line in this list, never below. Layers cannot be
built in a circle, and the old server's circles (the runner calls the engine, which calls `update_task_inner`, which
calls the engine) are where its hardest rules hid.

```
platform      ServerConfig · DataDir · Identity · Db · Migrations · Backup · Events · Changes · KeyedLock · Proc
              Secrets · Telemetry · Lag
settings      HostSettings
profiles      Profiles · AgentConfigs · Usage · UsageWindow
projects      Projects · Relocation
tasks         TaskRepo · Tasks · TaskRefs · Pens · Attachments · TaskTmp
threads       ThreadStore · Threads · ThreadReaders
git           Git · Worktrees · TaskBase · ChangesTab · Checkpoints · Restack · StatusScripts
github        Gh · PullRequests · PrWatch · GithubRepos · GhStacks
agents        AgentCli · ClaudeDriver · CodexDriver · Prompts · AgentTools · ApprovalRules · ContextMeter · Tokens · Titles
runs          RunRepo · RunDir · Shim · RunFollower · Runs · BackgroundWork · DevServers · Compaction
permissions   Permissions · Questions · Approvals
review        Reviews · Summaries · ReviewStats · Fanout
merge         Merges · MergeGate · MergedWatcher
workflows     WorkflowStore · WorkflowEngine
automations   Automations · Scheduler · Webhooks · Routines
docs          TaskDocuments · Docs · DocImages · HostedDocs
assistant     Assistant · Memory · Tracked · Brief
mcp           BoardTools · ToolCalls · Wait · GhTools · DocsTools · DesktopTools · McpEndpoint
push          Push
hosts         Links · LinkConnections · Relay · Discovery · Ssh · Uplink · SettingsSync
terminal      Terminals · Pty
desktop       CuaDriver · DesktopClaims
update        Supervisor · Updater · Releases · Service
analytics     Analytics · Disk
lifecycle     Reactor · Recovery
transports    rpc/* · http/* · mcp/transport/*
```

### How an area reaches upward: `Changes` and the `Reactor`

A service that changes state puts a record on the `Changes` queue after its commit: `TaskChanged { before, after,
cause }`, `RunExited { run, outcome }`, `ReviewFinished`, `PrNews`, `PromptSettled`, `WorkflowRunSettled`.
`lifecycle/Reactor` is the one consumer. For each record it gathers facts from the areas, calls a pure decision
function where there is a choice to make, commits, and calls the reconcilers the change could affect, in an order
written in one file:

| Change                         | The reactor does, in order                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `TaskChanged`, status moved    | settle a replaced merge approval · apply a new permission mode to pending prompts · `Dependencies.reconcile` · `Merges.reconcileLane` · on entering In review, `Reviews.reconcile` · `WorkflowEngine.onStatus` · on Done, `Terminals.killAll` and `Restack.reconcileDependants` · `StatusScripts.run` · `TaskTmp.changed` |
| `TaskChanged`, other           | title refresh if unpinned and the text changed · stack title · `Usage.configChanged` · retarget follow-ups            |
| `RunExited`                    | `decideFinish` ([07-agents.md](07-agents.md#when-a-run-ends)) with facts from workflows, merges, reviews, todos and usage · send what is queued · write the task's column · then as `TaskChanged` |
| `ReviewFinished`               | combine verdicts · send a round of fixes or settle the review · merge-gate summaries · stats                          |
| `PrNews`                       | wake an idle agent in review, per the project's setting                                                               |
| `PromptSettled`                | clear attention and restore the working status when none is pending                                                   |
| `WorkflowRunSettled`           | release a task the run was holding in its column                                                                      |

Changes about one task are handled in order, under that task's lock; different tasks proceed in parallel. A step
that starts something slow (a run, a worktree) registers it and returns; the slow part is a fiber in that area's
`FiberMap`. A command's RPC returns after its own commit, without waiting for the reactor: the board redraws from
events. Tests wait with `Reactor.idle`.

`lifecycle/Recovery` runs once at startup and calls every reconciler: [Startup](#startup).

## Platform

| Service        | Owns                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ServerConfig` | Flags and environment, read once through `Config`: host, port, data dir, UI dir, source dir, name, hubs, hub token, token, demo, open token, discovery, update sources, profiles to ensure. The only place `process.env` is read |
| `DataDir`      | Every path under the data folder as a function (`runDir(id)`, `attachments()`, `projectDir(id)`…), and the guard that refuses to remove a folder something else still uses |
| `Identity`     | `host_id`, the board token, the hub token (files, 0600, made on first start), the host's name, the internal URL                                               |
| `Db`, `Migrations`, `Backup` | [04-database.md](04-database.md)                                                                                                               |
| `Events`       | The board's event bus: `emit` (buffered inside a transaction), `subscribe`, a numbered in-memory tail for replay, the boot id                                  |
| `Changes`      | The queue the reactor reads                                                                                                                                   |
| `KeyedLock`    | <a id="keyedlock"></a>`withLock(key)(effect)`: one holder per key at a time, waiters in order, released on any exit. Keys are `["project", id]`, `["task", id]`, `["run", id]`, `["workspace", profile]`. Backed by a map of semaphores that drops an entry when nobody holds or waits |
| `Proc`         | Run a command to its end with a timeout, a size cap on what is kept, and a process group that dies with the server (`ChildProcessSpawner`); `agentEnv()`, the environment agents and scripts get: the server's without its own configuration and secrets |
| `Secrets`      | `Redacted` values by name (the VAPID key, telemetry password)                                                                                                 |
| `Telemetry`    | The durable outbox to ClickHouse, the OTLP receiver for agent CLIs, logs and metrics. `Effect.log*` goes to stderr in the old line format and, by level, to the outbox |
| `Lag`          | Event-loop delay histogram and the stall log                                                                                                                  |

<a id="events"></a>`Events.emit` is the only way anything reaches a client. It numbers each event, appends it to the
tail and publishes it. A subscriber that cannot keep up is cut off with `resync`
([05-protocol.md](05-protocol.md#the-board)).

## Areas

### Settings, profiles, configs, usage — [inventory 02](inventory/02-agent-support.md), [07](inventory/07-server-root-api.md)

| Service         | Owns                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `HostSettings`  | The typed host settings (default model, effort, permission mode, public URL, terminal tools, scratch host, switches). One schema; the `settings` table is its store |
| `Profiles`      | Profiles and what hangs off them: config lists, reviewers, summarizers, GitHub account, access for other profiles' agents, tint            |
| `AgentConfigs`  | Config folders and their agent; proxy settings; listing Codex models; exporting and importing a login as an archive                        |
| `Usage`         | Plan limits per config (Anthropic's usage endpoint, Codex's rate limits, a proxy's accounts), "out until", tasks waiting for a reset. In memory, with the durable part on the task |
| `UsageWindow`   | Restarting a 5-hour window with a throwaway prompt                                                                                         |

### Projects — [inventory 07](inventory/07-server-root-api.md), [04](inventory/04-git-review.md)

`Projects`: create (a folder, a clone, a new GitHub repository), keys and former keys, settings, archive, delete.
Changes to one project are serialised by its lock. `Relocation`: recognising a moved repository by its fingerprint
and moving worktrees and sessions with it.

### Tasks — [inventory 07](inventory/07-server-root-api.md) (7.7–7.9), [09](inventory/09-data-model.md)

```ts
export class Tasks extends Context.Service<Tasks, {
  get(id: TaskId): Effect.Effect<Task, TaskNotFound>
  list(filter: TaskFilter): Effect.Effect<ReadonlyArray<Task>>
  create(input: NewTask, by: Actor): Effect.Effect<Task, Invalid | ProjectArchived | ProjectNotFound>
  update(id: TaskId, patch: TaskPatch, by: Actor): Effect.Effect<Task, TaskNotFound | Invalid | Conflict>
  /** For other services: change columns the patch does not expose, with the same derived-column rules. */
  change(id: TaskId, decide: (task: Task) => TaskColumns | null, cause: Cause): Effect.Effect<Task, TaskNotFound>
  delete(id: TaskId, options: { deleteBranch: boolean }): Effect.Effect<void, TaskNotFound | Conflict>
}>()("huntaway/tasks/Tasks") {}
```

- `tasks/decide.ts` holds the rules as plain functions: `decideUpdate` (field rules, what a status move sets, the
  refusals), `deriveColumns` (the old `update_task` side effects: resolution and `done_at`, `restack`, `stack_run`,
  `remerge`, `merge_approval`), `decideCreate`. They are the old `api/tasks.ts`, `api/new_task.ts` and
  `db/tasks/write.ts`, without the orchestration, which the reactor now has.
- `Actor` is who asked: the user, a device, an agent (with its task), an automation, the board. It decides what may
  be set and is recorded as the change's cause.
- `TaskRefs` resolves `KEY-n`, former keys, `<profile>:<key>` and ids, for board tools and the CLI.
- Deleting a task is by hand and in order, not by cascade alone: abort its runs, expire its prompts, kill its
  terminals, tear down its worktree under the lock, fix what pointed at it, then the row.
- `Pens`, `Attachments` (upload, read, the pruner that finds references by scanning text), `TaskTmp` (the per-task
  temp folder and its sweeper, with leftover test servers stopped first).

### Threads — [inventory 08](inventory/08-threads.md); [07-agents.md](07-agents.md#threads)

`ThreadStore` (rows), `Threads` (writes, the live stream, previews), `ThreadReaders` (what review, waits and push
read out of a thread).

### Git — [inventory 04](inventory/04-git-review.md)

| Service         | Owns                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `Git`           | Running git: the environment that keeps hooks and prompts off, `GIT_OPTIONAL_LOCKS=0` for status polling, typed failures                   |
| `Worktrees`     | A task's worktree: branch naming, setup (fetch, branch from the right start, copy and link ignored files, the setup script), teardown with its safety checks, removing merged worktrees. One at a time per task, under its lock |
| `TaskBase`      | Where a task's branch starts and what its own work is: `start_from`, `merges_into`, the start refs, stacks, `carries`                       |
| `ChangesTab`    | Every operation of the Changes tab: status, diffs, stage, unstage, discard, apply, commit, stash, reset                                    |
| `Checkpoints`   | A commit per run start and per turn under `refs/huntaway/checkpoints/`, the turn list and diffs, rewind of files and conversation          |
| `Restack`       | Rebasing stack levels when the one below changes or merges, with the three re-checks for a running agent and force-push with a lease       |
| `StatusScripts` | The project's script on a column move: its environment, one at a time per task, five-minute limit, output into the thread                   |

`git/shell.ts` (the reader of shell commands behind "did the agent change code" and the gh hook) moves to
`packages/shared`, because the hook loads it.

### GitHub — [inventory 03](inventory/03-mcp.md) (2.9, 2.10), [04](inventory/04-git-review.md), [06](inventory/06-integrations.md)

`Gh` (running `gh` with one account's token and nothing else, target checks, the unsandboxed-git hardening),
`PullRequests` (finding a task's PR, approval, preview URLs, the three-minute poll that notices a merge),
`PrWatch` (one GraphQL read, comparing with what the agent has been told, the in-review watcher, failed-check logs),
`GithubRepos` (list, search, clone, create), `GhStacks`.

### Agents, runs, permissions, board tools — [07-agents.md](07-agents.md)

### Review — [inventory 04](inventory/04-git-review.md) (2.12–2.13, 2.18–2.19)

`Reviews`: reviewers each in their own thread and run, read-only in the task's worktree; `submit_review`; combining
verdicts; rounds of fixes against the project's limit; extend; supersede. `Summaries`, `ReviewStats`, `Fanout`
(comparing and picking among tasks made from one prompt). `Reviews.reconcile(task)` starts a review that is due and
is safe to call at any time.

### Merge — [inventory 04](inventory/04-git-review.md) (2.14–2.17)

`Merges`: the agent merges, the server queues, gates and observes. Lanes and slots are worked out from task rows,
never kept in memory. `merge/decide.ts` has the lane rules as a pure function over the lane's tasks, with the old
tests' cases as its table: who holds a slot, who waits, what steps out and rejoins, whole-stack runs.
`Merges.reconcileLane(lane)` starts the next merge when the slot is free. `MergeGate` (approval before a merge, and
the check the `gh` tools make), `MergedWatcher`.

### Workflows — [inventory 06](inventory/06-integrations.md) (2.1–2.2), `docs/guide/workflows.md`

`WorkflowEngine`: `start`, `advance`, `settle`, `stop`, `resume`. The graph semantics are pure functions in
`workflows/graph.ts` (which nodes are ready, joins, rounds, values from earlier runs, a column ends a path), taken
with their tests. A run's state is one row rewritten under the run's lock, so concurrent `advance` calls queue
instead of relying on nothing awaiting. The engine never moves a task itself: it calls `Tasks.change` and lets the
reactor carry the consequences, which removes the old `MOVING`, `CHAIN` and `QUIET` guards against its own echoes.

### Automations — [inventory 06](inventory/06-integrations.md) (2.3)

`Scheduler` (a five-second tick that claims a due run in one conditional transaction before doing anything; no
backfill), `Webhooks` (the check order: token, rate limit, signature, enabled, ping, filters, dedupe, coalesce;
answered 202 before the action runs), `Routines`, `Automations`. Cron and time-zone arithmetic use `Cron` and
`DateTime` from `effect` in place of the hand-rolled versions, with the old DST cases as tests.

### Documents and docs — [inventory 02](inventory/02-agent-support.md) (2.7–2.8)

`TaskDocuments` (a plan, artifact or diagram a task's agent writes, a version per turn, answers sent back),
`Docs` (published documents: versions, folders, labels, comments), `DocImages` (AVIF conversion with `sharp`),
`HostedDocs` (publishing to a docs site).

### Assistant — [inventory 02](inventory/02-agent-support.md) (2.12)

`Assistant` (one thread per profile, optionally on a host of its own), `Memory` (the workspace under git with the
git folder outside it, no symlinks, a lock per workspace), `Tracked`, `Brief`. Google stays a set-up helper around
an MCP server.

### Push — [inventory 06](inventory/06-integrations.md) (2.4)

`Push` subscribes to `Events` and decides, per event and per subscription, what notifies (the seven rules), and
sends by Web Push (VAPID, RFC 8291). With Telegram gone, `AssistantReplied` is emitted by `Assistant` itself. Expo
push and answering from a lock screen wait for the phone app.

### Terminal<a id="terminal"></a> — [inventory 05](inventory/05-hosts-update.md) (2.5)

`Terminals`: a tmux session per task and per terminal tool on a tmux server private to the data folder, leases for
tool sessions, the reaper. `Pty`: the pseudo-terminal that attaches to a session. Node has no `openpty`; the old
server uses an inline Python helper. Keep that helper in M6 and replace it with a 60-line Rust binary beside the
shim (`ia-pty`) if Python proves a burden on a release host. Flow control by acknowledgements (384 KiB) is kept.

### Desktop, update, analytics — [inventory 05](inventory/05-hosts-update.md), [07](inventory/07-server-root-api.md)

`CuaDriver` and `DesktopClaims` (computer use: one driver process, one task at a time, an operation journal).
`Supervisor` (the restart file and exit 75), `Updater` (rebuild from a checkout, follow a deployment, take a bundle
from a hub), `Releases` (check GitHub, download, verify, stage, try, settle, roll back; `app/state.json` shared with
the desktop shell), `Service` (the systemd user unit with `KillMode=process`). `Analytics`, `Disk`.

## Hook commands<a id="hook-commands"></a>

`huntaway approval-hook`, `gh-hook` and `gh-run` are started by an agent CLI for a tool call, the first two for
every matching call. They must start in tens of milliseconds and fail closed (exit 2), so:

- `bin/huntaway` execs their entry files (`apps/server/src/hooks/*.ts`) directly, without loading `bin.ts`.
- They import only `node:` modules and `@huntaway/shared`. A structural test walks their import graphs and fails on
  `effect`.
- Their logic is the old one, kept with its tests: rule matching (strongest decision wins), the shell reader, `gh`
  argument refusal.

## Startup

`Main.ts` builds the layers in dependency order; building a layer starts its loops. Then `Recovery` runs, then the
server says it is ready. This is the old order ([inventory 07](inventory/07-server-root-api.md), section 6) with
the one-off moves removed:

1. `Supervisor.take` (restart file and parent PID out of the environment) · data folder · `Releases.execInstalled`
   (hand over to a newer staged release) · `Identity`.
2. `Backup.beforeStart` · `Db` · `Migrations`.
3. The HTTP listener binds; requests wait until step 6.
4. Every area's layer, bottom up. Loops that start here: telemetry exporter, usage, window restarts, PR watcher,
   terminal reaper, attachment pruner, run pruner, dev-server scan, temp-folder sweeper, permission sweeper,
   scheduler, merged watcher, relocation recorder, update and release checks, push, settings sync.
5. `Recovery`: resume kills left half done · for each run that had not exited: re-ask its open prompts and tool
   calls, then follow it from its saved offset, re-arm its timers · tasks marked running with no run · expire
   prompts with no live run · `Merges.reconcileAll` · `Dependencies.reconcileAll` · `Reviews.reconcileAll` ·
   `WorkflowEngine.resume` · `Restack.resume` · `Releases.settle`.
6. Open the gate: links dial, discovery answers, the RPC and HTTP routes serve. Print `HUNTAWAY_READY
   {"port":…,"token":…}` on stdout (the desktop shell and test scripts read it), and tell the launcher it started.

Shutdown (SIGTERM, SIGINT, or the launcher gone) closes the root scope: the listener stops, fibers are interrupted,
the database closes. A two-second fallback exits regardless. Agents and tmux sessions are untouched.

## The CLI

`effect/cli` commands in `apps/server/src/cli/`, one file each, each a thin call into a service or the RPC client:

| Command                                   | Does                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `serve` (default)                         | The server. Flags as now ([inventory 07](inventory/07-server-root-api.md), section 5), each with a `HUNTAWAY_*` variable |
| `token [--hub]`                           | Print the board or hub token                                                                 |
| `rpc <method> [json]`, `dev …`            | The typed client over HTTP, and the helpers on top of it                                     |
| `import-legacy --from <old db>`           | [11-migration.md](11-migration.md)                                                           |
| `ssh-host`, `install-service`             | As now                                                                                       |
| `telemetry init \| test \| backfill`      | As now                                                                                       |
| `codex-run <spec>`                        | The Codex adapter, started under the shim (not through `effect/cli`: it is a run's process)  |
| `approval-hook`, `gh-hook`, `gh-run`      | The hooks, dispatched by the launcher before any of this loads                               |
| `--version`                               | `huntaway <version>`: the release smoke test depends on the exact form                       |
