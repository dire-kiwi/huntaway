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
profiles      Profiles · AgentConfigs · Usage
projects      Projects
tasks         TaskRepo · Tasks · TaskRefs · Pens · Attachments · TaskTmp · Leftovers
threads       ThreadStore · Threads · ThreadReaders
git           Git · Worktrees · TaskBase · ChangesTab · Checkpoints · Restack · StatusScripts · Relocation
github        Gh · PullRequests · PrWatch · GithubRepos · GhStacks
agents        AgentCli · ClaudeDriver · CodexDriver · Prompts · AgentTools · ApprovalRules · ContextMeter · Tokens · SideCalls · Titles · UsageWindow
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
lifecycle     Reactor · Recovery · Board · Demo
transports    rpc/* · http/* · mcp/transport/*
```

As built in M1 (HE-3): `hooks/` sits below everything and `prompts/` right after `platform/` (the structural test
needs every folder placed). `lifecycle/Board` (the board snapshot and `board.watch`) reads every area, so it is in
`lifecycle/`. `Pens` uses `Tasks` (a pen's thread is deleted with it) and `Tasks` uses `PenRepo`. `Profiles` and
`Projects` delete what hangs off them with SQL in their repositories, because they sit above `Tasks`; when runs,
worktrees and terminals exist (M2 on), those deletes move up to `lifecycle/` or go through the reactor.

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

In M1 the reactor handles changes one at a time, in commit order (which also keeps one task's in order); handling
different tasks in parallel, each under its lock, comes with the slow reconcilers. `Dependencies.reconcile` finds the
waiting tasks whose dependencies are merged and, until runs exist (M2), leaves them waiting, as the old server did
when it could not run agents.

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
| `UsageWindow`   | Restarting a 5-hour window with a throwaway prompt. In `agents/` (2.8): it runs `claude` and records a side call, as `Titles` does         |

#### As built in 6.11 (HE-7): Asana and config archives

- **Asana** is `profiles/Asana.ts` (`me`, `task`, `search`; `taskGid` and `asanaLabel` pure), the old `integrations/asana.ts`
  over `HttpClient` (15 s), its address `ServerConfig.asanaUrl` (`HUNTAWAY_ASANA_URL`, in `SERVE_ENV`; tests have none
  unless they give the fake's). `Profiles.update` checks an `asana_token` with Asana (`Invalid` `asana_token` with Asana's
  words when it's turned down) and stores `asana_user` ("Name (email)"); `Profiles.asanaTasks` is the search
  (`profiles.asanaTasks`, `AsanaRpcs`, `read`): `Unavailable` (`asana`) when it's off or not connected (the old 409s),
  `External` (`Asana`) for Asana's failures (the old 502), and none for a task URL the token can't see. The fake is
  `packages/testing/bin/fake-asana.ts` (`fakeAsana` in `src/`); `scripts/test-server.sh` gives a test server
  `$HUNTAWAY_ASANA_URL` or an address that answers nothing.
- **Config archives** are `profiles/ConfigArchives.ts`: `exportArchive(id)` and `importArchive(id, archive, overwrite)`
  (`configs.exportArchive`, `configs.importArchive`, `ConfigArchiveRpcs`, scope `admin`, the old board-only), `tar czf -`/`xzf
  -` through `ChildProcessSpawner` with the old entry lists, strict base64 (`decodeArchive`), the folder made 0700, a login
  there `Conflict` `in_use` unless `overwrite`. Plain calls of one host: copying a config between hosts (7.5, HE-6's
  `copyConfig`) exports on one and imports on the other. **Decided**: an archive is bounded by the RPC's 16 MiB message
  (about 12 MiB of tar), not the old route's 256 MiB; the old profile archive (`/profiles/{id}/claude-config`, a
  profile's own `claude_config_dir`) is gone with that column (configs have it).

### Projects — [inventory 07](inventory/07-server-root-api.md), [04](inventory/04-git-review.md)

`Projects`: create (a folder, a clone, a new GitHub repository), keys and former keys, settings, archive, delete.
Changes to one project are serialised by its lock. `Relocation`: recognising a moved repository by its fingerprint
and moving worktrees and sessions with it.

#### As built in 6.11 (HE-7): Relocation

- **Where.** `git/Relocation.ts` (`Relocation`), not `projects/`: it needs the tasks' rows, git, the worktrees' linked
  folders (`git/worktree/files.ts` `relink`) and `folderName` (moved to `git/worktree/folder.ts`, re-exported by
  `Worktrees.ts`), and `Worktrees` holds the folder through it. Its rows besides the projects' are `git/RelocationRepo.ts`
  (a project's tasks and review threads, the tasks working in a folder, the config folder a conversation started in
  from `runs`). `Projects` keeps what is the project's: `relocate(id, patch, move)` (under the project's lock: the rest of
  the patch written and rolled back first, then `move`, then the change stored with the new paths, which are stored
  alone if the change then fails), `fingerprint`, `repoRoot`, `recordFingerprint(s)` and the `recorder` loop; a plain
  `update` still refuses a new folder. `ProjectRepo` gained `repoRoot`, `folders`, `unrecorded`, `recordRoot` (only
  where `repo_path` is still the one looked at).
- **What it does** is the old `relocate.ts` step for step: `update(id, patch)` (`projects.update`'s handler and an
  agent's approved `update_project`) checks the folder (`check`: absolute; with `move_repo` the old refusals, `Conflict`
  `in_use` for another project on it or a setup holding it, `agent_running` for a running agent; else the same
  repository by its worktrees, its root commits with the shallow-clone ancestor check, or its tasks' branches, all
  `Invalid` `repo_path` with the old texts), moves it (`rename`, the EXDEV hint), rewrites tasks' `worktree_path` and
  scratch chats' `work_dir` through `Tasks.change`, runs `git worktree repair`, fixes `.git`/`gitdir` and submodule links
  by hand, relinks linked folders, copies Claude transcripts newer-only keeping their times (Codex threads skipped), and
  returns the paths that moved with it and the new fingerprint. `Approvals` checks a new `repo_path` with
  `Relocation.check` before asking (`Projects.preview` now shows the path as given).
- **Moving and holding** are a `Ref` in the service: a move marks the project moving (a `Deferred` its waiters await)
  and is refused while a setup holds the folder; `hold(project)` (around `Worktrees.setup`'s lock, nested setups
  included) waits for a move under way, then counts itself in; `settled(project)` is what both launches
  (`LaunchFacts.claude`/`codex`, before the project is read) wait on. No polling. `isMoving` is for tests.
- **Fingerprints.** `Worktrees.setup` records the project's fingerprint once its folder is a repository (the old
  `record_fingerprint`). `Projects.recorder` (Main's `ProjectLoops`, beside `RunLoops`/`PrLoops`, so tests run a pass
  themselves) records them at start and hourly.
- **Tests.** `git/Relocation.test.ts` has every case of the old `git/relocate/tests.test.ts` and the old
  `worktree_files.test.ts` case that moved a repository with its links. Changed: the two key races can't be interleaved
  as the old ones were (the key is checked where it's stored): one key goes to one project whichever commits first, and
  a rename meanwhile waits for the move under the project's lock; "a change that can't be stored" uses `review_rounds: 99`
  (`use_worktrees: null` doesn't decode); the setup hold uses named pipes, not a polling script. The recorder's hourly
  timing isn't tested (its pass is). The 4.1 note "Not here: relocation's hold on the project's folder during a setup"
  above is done by this.
As built in 6.12 (HE-7), for the project settings' Prompts tab: `projects.systemPrompt` (`{ id, options }`, the old
`GET /projects/{id}/system-prompt`'s query as `SystemPromptOptions`; `NotFound`) is `Prompts.preview`, already built in
2.5; `host.defaultPrompts` gives `PROJECT_PROMPT_DEFAULTS` (`prompts/projectDefaults.ts`) as `DefaultPrompts`, the texts
themselves, with no service to ask. Both read scope; `rpc/projects.test.ts` calls them in process.

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
`packages/shared`, because the hook loads it. As built in 3.6: `packages/shared/src/shell.ts` has the command reader
(`runsProgram`, `commandChangesCode`, `tokenize`, `substitutions`); the old `changes_code` (which tool calls count, an
edit only if it succeeded, a Bash command unless it was denied) is the git area's, over `commandChangesCode`, with its
two tool-call test cases.

#### As built in 4.1 (HE-5)

- **`Git`** (`git/Git.ts`) runs every git command (`run`, `bytes`, `ok`, and the old helpers); `git/paths.ts` has the
  path and text helpers (`pathStartsWith`, `slugify`, `truncate`, `expandHome`). Hooks are not switched off: the old
  server ran them for `worktree add` too (a test relies on a `post-checkout` hook).
- **`GitHubAccess`** (`git/GitHubAccess.ts`) is what the git area needs of GitHub, which is below it: `fetchEnv(cwd,
  account, remoteUrl)` (the old `authenticate_fetch`) and `pullRequest(cwd, account, ref, repo)` (`gh pr view … --json
  state,headRefName,baseRefName,headRefOid,isCrossRepository,url`), with `GitHubUnavailable`. Main's git line has
  4.4's live layer (`github/GitHubAccessLive`, built under the git area's services: it only needs `Gh`, which only needs
  `Git`); tests may give `GitHubAccess.layerNone` (unauthenticated fetches, no pull request read).
- **`TaskBase`** (`git/TaskBase.ts`, bodies in `git/worktree/{upstream,start,remote,stacks,changes}.ts`): `account`,
  `upstream`, `fetch`/`fetchBase` (60 s, through `fetchEnv`, none for remote `.`), `startPoint` (the four cases and the
  fast-forward), `compareRef`, `pickStart` (the four `start_from` kinds; a task stacked on one with no branch sets that
  one up through a `setUp` the caller gives), `branches`, `github`/`pushRemote`/`pushRepo` (the old `remote.ts`, `ssh -G`
  through `Proc` for SSH aliases; 4.5 builds pull requests on them), `taskBase`/`stackedBase` (`merges_into` and
  `start_from` followed through merged tasks, 16 deep), `remoteBase`, `unstack`, `changesDir`, `changesBase`,
  `workScope` (4.6's reviews), `keepStarts`, `diff` (`git.taskDiff`), `hasWorkToMerge`, `forgetStart`; `startRef(id)`.
  `unmerged` is 4.5's (it needs the pull request's state).
- **`Worktrees`** (`git/Worktrees.ts`): `setup`, `teardown`, `removeIfMerged`, `removeMerged`, `agentInWorktree` (its
  `running` column or a review thread's), `forDeletion`, `deleteProject`, `deleteProfile`, `recover`, `withLock`. One at a time per task
  under **`KeyedLock` `["worktree", id]`**, a key added for it, not `["task", id]`: a setup script may run 30 minutes,
  and a stop, a message or an update takes the task's lock meanwhile (each write inside a setup takes it briefly
  through `Tasks.change`). The order is project, worktree, task, run. A setup goes on in the layer's scope when its
  caller goes (a launch stopped meanwhile), as the old one ran to its end: one cut short would leave git's worktree half
  made. Failures are `WorktreeFailed { reason }` with the old texts; asked by hand while an agent works there,
  `AgentInWorktree`. Files brought in (`git/worktree/files.ts`, with `relink` for `Relocation`), scripts
  (`git/worktree/scripts.ts`: `bash -c` in a process group of its own, `SIGKILL` to it after the limit; a script that
  succeeded keeps what it started; one that fails has its group stopped, which the old one didn't), the removal checks
  (`git/worktree/remove.ts`). A path that isn't UTF-8 in a marked file's index entry can't be compared, so it counts as
  changed (kept) rather than skipped.
- **Deleting a task** goes through `runs/TaskDeletion` (the one place `tasks.delete` and an agent's approved
  `delete_task` both reach, the lowest area that sees the runs to stop and the worktree to remove): the task's and its
  reviewers' runs aborted, `Worktrees.forDeletion` (the worktree as it is once a setup under way is done, torn down
  forced, its branch deleted when asked; `unstack`; the start ref dropped), then `Tasks.delete`. **Deleting a project**
  is `Worktrees.deleteProject` (refused while an agent runs; each task's worktree removed forced once a setup under way
  is done, branches kept; then `Projects.delete`), which `projects.delete` calls; deleting a profile is
  `Worktrees.deleteProfile` (its projects' worktrees the same way, then `Profiles.delete`), which `profiles.delete` calls.
- **At launch** (`runs/LaunchFacts`, one block): a review thread whose task uses a worktree that isn't ready fails with
  "the task's worktree isn't set up"; a task with `use_worktree` (not documents-only) gets "Setting up worktree…" and
  `Worktrees.setup`; a failed setup fails the launch (`RunExited` with `WorktreeFailed: <reason>`), as the old
  `Failed: <reason>`.
- **The reactor**: `StatusScripts.changed(after, before.status)` on every status move (a `kind=task`'s, queued per task,
  first in first out, in the background; `StatusScripts.idle` for tests); `TaskBase.keepStarts` as a run ends
  (`RunExited`) and as a task moves to Done.
- **Recovery** repairs what a stopped server left: `setting_up` becomes `error` ("the server stopped while the worktree
  was being set up"), so the next run or the button sets it up again; `tearing_down` becomes `ready` if the folder is
  there, else `none`. The old server left both as they were.
- **RPCs**: `git.setupWorktree` (`Conflict` `agent_running`; `Invalid` `worktree` with the reason, the old 400),
  `git.teardownWorktree {force?, delete_branch?}` (`Conflict` with the new reason `worktree_kept`, the old 409),
  `git.taskDiff` (`read`); `projects.branches` (`read`), `projects.removeMergedWorktrees`, `projects.setupThread
  {message?}` (`runs/SetupThread`; the instructions are `prompts/setupThread.ts`). Arrays are returned as they are, not
  in the old `{branches}`/`{results}` objects.
- **Web**: the Details panel's Set up and Tear down… (the old `TeardownModal`) are back. The board's setup thread for a
  folder that isn't ready (the old `task/WorktreeSetup`) is not: its RPC is there.
- **Not here**: relocation's hold on the project's folder during a setup and its fingerprint (`Relocation`);
  terminals killed at teardown (M6, marked in `teardown`); checkpoints dropped at teardown and at a project's deletion
  (4.3, marked); `Tasks.update`'s `gitWork`, `worktreeFolderExists` and `startCommit` facts are still `false`/`null`
  (`TaskBase.hasWorkToMerge` and `startRef` are what 4.7 and 4.8 fill them from); the restack wait at launch (4.8,
  marked); subprojects (dropped).

#### As built in 4.3 (HE-5): `Checkpoints`

- **Files.** `git/Checkpoints.ts` (the service), `git/CheckpointRepo.ts` (the `checkpoints` rows, and what the plan rule
  reads beside them: a plan document written since a run started, tasks it created), `git/checkpoints/` (`model.ts`
  the row, limits, refs and errors; `git.ts` running git for checkpoints, the scratch index and `snapshot`; `changed.ts`
  "files git brought in", stats and patches; `restore.ts`; `conversation.ts`, pure). The wire is
  `packages/contracts/src/rpc/checkpoints.ts` (`CheckpointRpcs`: `checkpoints.turns` and `turnDiff` at `read`,
  `rewind` and `cancelRewind` at `git`) and the board event `{type: "checkpoints", task_id}`.
- **A message is its thread write number.** The old `message_id` of a turn is `checkpoints.write_no`, taken from
  `runs.write_no`; the wire keeps the name `message_id` (the turns list, `RewindResult`, `task.rewind`), and the web
  app's rewind marks find a user message's turn by its item's `legacy:<n>`. The turn's end clears `runs.write_no` in
  the result line's transaction, as the old `after_turn` cleared `turn_message_id`.
- **The queue** (the old `QUEUES`): a worker fiber per task with jobs, in the service's `FiberSet`, taking them in the
  order asked and going once there are none; `beforeRun`, `rewind`, `forget` and `settled` wait for theirs, `afterTurn`
  does not. A failed job is logged. Captures run git with the location variables cleared, `GIT_OPTIONAL_LOCKS=0` and a
  ten-minute timeout. The cap is `CheckpointCap` (a `Context.Reference`, 200; tests provide 5).
- **Where it is called.** `LaunchFacts.claude` takes the run's checkpoint after the worktree is known (4.1's setup goes
  before it) and reads the task again for its rollback (`pendingRewind` → `resumeAt`); `Prepared.rewind` carries it
  to `Runs.launch`, which calls `Checkpoints.rewound` once the agent has started (the rollback is done with, also one
  for another session, and "The conversation goes on from before turn N" when it was made). The Claude line handler
  hands the turn's end to `afterTurn` after the result line commits (`afterCommit`), with the run's row as the line
  left it. `RunEnds.ended` gives a turn the agent never ended (the run was running, not between turns, not a
  compaction) its checkpoint, `failed` or `stopped`, before anything else, and then asks `planOnly`.
- **The plan rule (HA-198) is whole here**: `Checkpoints.planOnly(task, run)` is the old `candidate` (the plan label,
  a plan document written since the run started, no task created by it) and `changed_only_plan` (a task working in
  its own folder: yes; one in its project's repository: no; else every turn of the run left the files and HEAD as they
  were, once its checkpoints are taken). `RunEnds` computes it before its first transaction, so the column is written
  once, with the rest of the run's end. There is no unsettled state for a restart to find: the old `settle_plans`
  existed because the old `finish` wrote the run's end and left the column for later; here a server that stops before
  `RunEnds` committed has the run still live, and re-attaching ends it again. Recovery has nothing to add.
- **Paths.** Git's paths are kept as byte strings for git; the file system (Effect's `FileSystem`, which takes text)
  gets them as UTF-8, and a path that isn't UTF-8 is left alone by a rewind and listed in its `skipped` (the old one
  wrote and removed such paths through `Buffer`s). An empty folder a removal leaves is removed after reading it empty
  (`FileSystem` has no `rmdir`).
- **Errors.** `CheckpointFailed` (git or the file system: the wire's `Unavailable`), `RewindRefused` (`Conflict` with
  `agent_running` for the agent or a review running, `in_use` for a merge, rebase, cherry-pick or revert in progress,
  `changed_meanwhile` for a checkpoint gone, a rewritten branch, a conversation that can't go back or a rewind that
  stopped part way), `CheckpointInvalid` (`Invalid`: no worktree, no turn for that message), `CheckpointNotFound`.
- **Not here.** Codex's `thread/revert` to `rewind.before_turn` is 5.2's (the turn list already says `agent: "codex"`
  and the conversation rule has Codex's case). `forget` is called by 4.1's teardown. The web app's Changes tab and
  review views read turns (`turnsAtom`, `checkpoints.turnDiff`) when 4.2 and 4.6 bring them back.
- **Web (step 1).** `components/task/turns.ts` (`useTurns` over @huntaway/client's `turnsAtom`, which reads
  `checkpoints.turns` again on the task's `checkpoints` event and when its run, worktree or session changes),
  `Rewind.tsx` (`RewindDialog`, `RewindNote`), the thread's rewind marks and dialog, and the rewound message put back
  in the composer's draft (`rewound` in `thread/Composer.tsx`). The old suite had no `tests/ui` check of a rewind; it
  was looked at in a browser on a test server with a hand-made worktree and the fake agent (two turns, a rewind with
  the branch and the conversation, "Keep the conversation", the next run's `--resume-session-at`, marks following a
  live run).

#### As built in 4.2 (HE-5): `ChangesTab`

- **Files.** `git/ChangesTab.ts` (the service: every operation of the old `git_view.ts`) and `git/changes/parse.ts`
  (pure: the porcelain v2 `-z` status reader, `git log`/`stash list`/`show` formats, `apply --numstat -z` paths, path and
  hash checks, the limits). The wire is in `packages/contracts/src/rpc/git.ts`: `git.status`, `git.diff`, `git.show` at
  `read`; `git.stage`, `unstage`, `discard`, `apply`, `commit`, `stash`, `reset` at `git` (`GitStatus`, `GitFile`,
  `GitCommit`, `GitStash`, `GitFileDiff`, `GitShown` keep the old field names); the handlers are `rpc/git.ts`, the layer is
  on Main's git line.
- **How git runs.** At the top of the folder `TaskBase.changesDir` gives (its worktree once ready, else the project's
  repository), through `Git.bytes` with `-c core.quotePath=false`, `GIT_EDITOR=true`, `GIT_OPTIONAL_LOCKS=0` and the
  location variables cleared (the old view didn't clear them; nothing it ran should follow another repository). A diff
  is read as bytes: past 4 MiB (`maxBytes`) it is `too_large`, and output that isn't UTF-8 is `{ not_utf8, preview }`
  with no patch.
- **Errors.** `ChangesRefused` is the old 409, the wire's `Conflict`: `git_refused` (git's own message, and a commit
  that would take what's staged outside the project's folder), `whole_repository` (amend, reword, stash, reset when the
  project's folder is a subfolder of a repository), `changed_meanwhile` (a stash's index and sha no longer match). Both
  new reasons are added to `ConflictReason`. `ChangesInvalid` is the old 400, `Invalid` with its field (`paths`, `rev`,
  `message`, `index`, `repository` for a folder that isn't a git repository). Git that can't run is `Unavailable`.
  `git.status` of a folder that isn't a repository is `{ available: false, reason }`, as before.
- **Decided.** Arguments are a schema's, so the old 422 texts for a body of the wrong shape are gone (the RPC's decode
  error). The apply body's 32 MiB limit was the old route's; here a patch is bounded by the RPC's 16 MiB message (see
  `http/routes.ts`), so the method has no limit of its own. The writes take no lock, as the old ones didn't: git's index
  lock is what keeps two of them apart, and the agent may be working in the same folder (the tab says so). Nothing is
  emitted: the tab reads the status again as before (see 09-frontend.md, "Step 1 as done for changes/").
- **Tests.** `git/ChangesTab.test.ts` has every case of the old `git/git_view/tests.test.ts` (the porcelain reader,
  path and hash checks, staging lines and files and discarding them with HA-341's folder, commits/amend/reword with
  stash push/show/pop by index and sha and a soft reset, HA-42's folder inside a bigger repository, unstaging before the
  first commit, non-UTF-8 files staged whole), on the whole board's services with worktrees from `Worktrees.setup`,
  plus the 5,000-file cut, `numstat` paths of a rename, a diff over 4 MiB and a folder that isn't a repository.

### GitHub — [inventory 03](inventory/03-mcp.md) (2.9, 2.10), [04](inventory/04-git-review.md), [06](inventory/06-integrations.md)

`Gh` (running `gh` with one account's token and nothing else, target checks, the unsandboxed-git hardening),
`PullRequests` (finding a task's PR, approval, preview URLs, the three-minute poll that notices a merge),
`PrWatch` (one GraphQL read, comparing with what the agent has been told, the in-review watcher, failed-check logs),
`GithubRepos` (list, search, clone, create), `GhStacks`.

As built in 4.4 (HE-5):

- **What the board and `gh-run` share is plain TypeScript in `packages/shared`**: `gh.ts` (`refuse`, `GhAccount` with
  `parseAccount`/`accountName`/`ownsHost`, `checkTargets`, `checkGitUrls`, `gitCredentialConfig`, `UNSANDBOXED_GIT` and
  `noRepoCommands` as `GIT_CONFIG_*` variables, `REPO_COMMANDS`/`repoCommands`, `extraHeaderResets`, `hostsYml`,
  `accountEnv`, `notSignedIn`, `shimScript`) and `ghTargets.ts` (`parseHelp`, `helpTargets`, `helpCommand`,
  `fallbackTargets`, `positionalHost`, `urlHost`, `repoHost`), the old modules' rules unchanged. Failures are returned as
  messages, not thrown.
- **`github/Gh.ts`** (`Gh`): `run(tool, args, { cwd, account, mergeGate })` is the old `run` (the merge gate first, then
  `pr_merge`'s resolve to number and repository, the stacked merge, then the command; `GhRefused { message }` for what the
  old code threw), `gh(args, { cwd, account, repo, timeout })` for the board's own gh calls (4.5, 4.7, 4.8), `token`,
  `shellEnv(account)` (a wait's), `fetchEnv` (`GitHubAccess`'s). The pure part (`command`, `merges`, `branchName`,
  `prFromUrl`, `clip`, `exitStatus`) is `github/gh/commands.ts`. gh runs through `ChildProcessSpawner` over the agents'
  environment, 600 s for a tool call; gh's help is cached per `command sub` in a `Ref`; the private config folder is a
  scoped resource under `<cache>/huntaway/gh-account/<uuid>` (made 0700, `hosts.yml` 0600 with `wx`, removed when the
  call ends; folders over a day old swept first). The stacked merge's poll is `MergePoll` (a `Context.Reference`, 2 s
  for 10 min; tests shorten it), on the clock.
- **Decided**: an account the profile or project names that isn't one (`parseAccount` fails) is refused ("the GitHub
  account X isn't one gh can use") rather than run as gh's active account, as the old tools did. `GitHubAccess.fetchEnv`
  has no error channel (the seam's signature), so a missing login gives the fetch no helper at all (`credential.<url>.helper`
  emptied), which fails it rather than letting another login fetch; it is logged.
- **Names**: the old `IA_GH_*` variables are `HUNTAWAY_GH_ACCOUNT`, `HUNTAWAY_GH_BIN` (the real gh, which is also the
  `--gh-bin` fallback and so in `SERVE_ENV`), `HUNTAWAY_GH_GIT_TOKEN` (the credential helper's), and
  `HUNTAWAY_GH_CONFIG_ROOT` (new: where `gh-run` makes its config folders, the server's root, so one sweep covers both).
- **`github/GithubRemote.ts`** is the old `remote.ts`: `github(repo, base)`, `pushRepo`, `pushRemote`, with
  `remoteRepo` and `isGithubCom`; `ssh -G` with 5 s and `ServerConfig.sshConfig` (`-F`; `/dev/null` in tests).
  `Prompts` fills the prompt context's `github` with it (a task with its own branch in a project; its base is the task's
  `base_branch`, else the project's, until 4.1's `TaskBase` gives the old `remote_base`) and `ghTools` true (6.4 adds the
  project's switch).
- **`git/GitHubAccess.ts`** was written here as the seams file specifies (4.1's interface, not on this branch's base);
  its live layer is `github/GitHubAccessLive.ts`. **`merge/MergeGate.ts`** is the stub (nothing blocked) 4.7 fills.
- **`ServerConfig`**: `ghBin` (`--gh-bin`/`HUNTAWAY_GH_BIN`, default `gh`; tests `<data dir>/no-gh-in-tests`, so no
  test runs the real gh), `path`, `cacheDir`, `sshConfig`.
- **Main**: `GithubLive` (`GitHubAccessLive` over `Gh` and `GithubRemote`) under the git line, the agents' line built
  over it; `MergeGate.layer` above the permissions' line; `GhTools` on `mcpLayer`'s first line. When 4.1's `Worktrees`
  needs `GitHubAccess`, `GitHubAccessLive`'s line moves under it (it needs only `Gh`, which needs only `Git`).
- **`gh-run`** is `hooks/gh-run.ts` (the entry, failing with exit 1 and its reason) and `hooks/ghRun.ts` (plain Node:
  the refusals, gh's help read with `spawnSync`, the host check, the token, the config folder, gh with `stdio:
  inherit` and its exit code). The launcher already dispatched it. A wait's command gets `Gh.shellEnv`: the shim
  `<data dir>/gh-shim/gh` (written aside and renamed when it differs; it runs `HUNTAWAY_EXE gh-run`) first on `PATH`,
  the account, the real gh and the config root; the token is checked first so the command doesn't run at all when the
  account isn't signed in. No `HUNTAWAY_EXE` (a server not started by `bin/huntaway`): the wait is refused.
- **The fake gh** (`packages/testing/bin/fake-gh.ts`, its state's schema and `fakeGitHub`/`fakePull` in
  `src/fakeGitHub.ts`; `scripts/test-server.sh --fake-gh`) answers the board's and agents' gh calls from a JSON file:
  accounts and tokens, repositories with pull requests (checks, reviews, comments, stacks, merge-async), issues, runs,
  gh's help texts, exact-argument routes, and a log of every call (the account it acted as, whether a token was in its
  environment, its config folder's modes). Its `graphql` answers a pull request by `owner`/`name`/`number`; 4.5 shapes it
  to `PrWatch`'s query.

As built in 4.5 (HE-5):

- **Pure parts** are `github/prWatch/`: `target.ts` (the five forms a wait names a pull request by, `targetKey` the
  `pr_watches.pr` key, `previewFor`), `pr.ts` (`QUERY`, `THREADS`, `CHECKS`; the answer read leniently through
  `Schema.is` over plain JSON, as the old reader was, into `Pr`; `checksOf` with the HA-393 "jobs still to start" check;
  `compare`, the news as a `News` schema so a stored wait's is decoded, `note`), `seen.ts` (the row: `Seen`, `Pending`,
  `WatchRow`), `failed.ts` (`boardChecks`, `logTail`, `toldFailures`), `inReview.ts` (`wakeEvents`, `idle`,
  `decideWake`, `woke`), `merged.ts` (the aliased many-pull-request query and its answer). The texts the agent reads
  (the wait's note, the wake, Fix broken checks, the untrusted-data tags and `defang`) are `prompts/pullRequests.ts`.
- **`github/PrWatchRepo.ts`**: `pr_watches` and `pr_states` rows, and the two watchers' task queries.
- **`github/PrWatch.ts`** (`PrWatch`): `request` (a wait's `pull_request` and `pull_request_events`, the account's host
  checked), `readerFor`/`readerOf` (the target and the task's account, `TaskBase.account`), `read` (the GraphQL query
  through `Gh.gh` as the account, 60 s, review threads paged up to ten), `poll` (one read, news kept pending for the
  call in one transaction with what isn't news), `watch` (a wait's reads every `PrPoll`, 60 s, a `Context.Reference`
  tests shorten; backoff ×2ⁿ to ×10; five failures record `unreadable`), `delivered`, `last`, `told`, `recordChecks`
  (`pr_checks`, only when changed and only for the task's own pull request, in one transaction), `failedLogs` (`gh run
  view --job N --log-failed -R repo`, five at most), `toldFailures`, `graphql`. gh's private config is made per call by
  `Gh.gh` (the old kept one per watcher): nothing of the token stays on disk after a read.
- **`github/PullRequests.ts`** (`PullRequests`): `find`/`findLater` (the old `find_pr`: `gh pr view <branch> --json url
  [--repo R]` where the branch is pushed, as the task's account, kept unless set meanwhile through `Tasks.change`, so
  its preview follows), `unmerged` (`TaskBase.hasWorkToMerge` and the pull request's state, five seconds), `approval`
  (the old `pr_approval_required` and `pr_approved` as `PrApproval`, with `approvedByReviews`), `previewStatus`
  (`HttpClient`, 5 s), `followPreviews`.
- **The in-review watcher and Fix broken checks** are `review/InReview.ts` (`sweep`, `fixChecks`; `InReview.watcher` is
  the 15 s loop): in `review/`, the first area above `runs/` (both send through `Runs.send`) and where a task in review
  belongs. **Decided**: the watcher sends the wake itself rather than through a `PrNews` change for the reactor, since
  it must check the agent is still idle right before sending (`stillWakes`, HA-53) and the reactor would add a hop with
  no other step to take. A wake is `{source: "board", auto: true}` (the old `send_as(auto)`); Fix broken checks is
  `{source: "board"}` (the old `send_for_user`, not re-titled). `AfterLogs` (a `Context.Reference`) runs between the
  logs' fetch and that check, for the HA-53 tests (the old fake gh's `hold` file). Which tasks were seen when is in a
  `Ref` (the old `watched` map), rebuilt after a restart.
- **The wait** (`mcp/Wait.ts`, `mcp/tools/wait.ts`): see 07-agents.md, `wait`.
- **A run's end** (`RunEnds.ended`) calls `PullRequests.findLater` for any run that wasn't superseded (it skips tasks
  with no branch or a `pr_url` already, and review threads).
- **Previews**: `Tasks`' `deriveColumns` already had the preview follow `pr_url` (3.x). Saving a project's
  `pr_preview_url` offers a new change, **`ProjectChanged { before, after }`** (`Projects.update`, only when the
  template changed), which the reactor hands to `PullRequests.followPreviews` (the old `follow_pr_previews`: previews it
  made move, hand-set ones stay, done tasks without one get none).
- **RPCs**: `tasks.fixChecks` (`operate`; `Invalid` `pr_url` without a readable pull request, `Conflict` with the new
  reasons `pr_not_open` and `nothing_failed`, a refused message as `tasks.send`), `tasks.unmerged` (`read`),
  `board.previewStatus` (`read`; `Invalid` `url` for one that isn't http(s); `PreviewStatus` in the board contract).
- **Main**: `GithubLive` has `PrWatch`, `PullRequests` and `PrWatchRepo`; `areasLayer` has `InReview` and
  `MergedWatcher` above the merge gate; their loops are `PrLoops`, beside `RunLoops` in `AreasLive` (not in
  `areasLayer`: tests run `InReview.sweep` and `MergedWatcher.check` themselves).
- **The fake GitHub** answers `PrWatch`'s query from a pull request's fields (checks with job ids, required flags,
  suites, conclusions and statuses; comments, reviews and review threads with ids, bots and associations;
  `threadsPage`; `unreadable`, which fails as gh does, its errors on stdout), the merged watcher's aliased query, and
  `run view --job N --log-failed` from the repository's `jobs`.
- **Not here**: the merge facts `Tasks.update` decides a move to Ready for merge with (`approval` with
  `hasWorkToMerge`, read before the task's lock) are 4.7's, with the other merge facts; linking GitHub stacks when
  `pr_url` is set is 4.8's (`GhStacks`).

#### As built in 6.11 (HE-7): `GithubRepos`

- **Files.** `github/GithubRepos.ts` (the old `integrations/github.ts` and `api/projects.ts`' clone and create) and
  `github/repos/model.ts` (pure: `checkRepo`, `checkName`, `searchQuery`, `restRepo`/`graphqlRepo`, `latestFirst`, `ghError`,
  `accountsFromStatus`). The wire is `packages/contracts/src/rpc/githubRepos.ts` (`GithubRepoRpcs`): `profiles.githubAccounts`
  and `profiles.githubRepos {account?, q?}` (`read`; gh's failures are the list's `error`, as before), `projects.clone
  {clone}` and `projects.createOnGithub {project}` (`settings`; the latter answers `{project, github}` rather than the
  project with `github` in it). gh's failures are `External` (`GitHub`); a folder that is the profile's project already is
  `Conflict` `in_use`.
- **How gh runs.** Through `Gh.gh` as the profile's account (gh's active one without), which gains `plain` (no
  `UNSANDBOXED_GIT`: the board's own clone and push are the user's git, hooks and all, as the old `gh_vars`) and `env`.
  Lists: `api user`, three pages of `user/repos`, the `repositoriesContributedTo` query, a search among the login and its
  organizations (kept 5 minutes in a `Ref`, on the clock). Clone 60 min, create 15 min, `config get git_protocol` 10 s;
  gh's process group goes when it's over its time (the spawner's default).
- **Folders.** The old `FOLDERS` is a `KeyedLock` key, `["folder", <folder>]` (the folder however it's written: each part
  resolved as it would be once made). The clone or creation and the project's adding run in the service's `FiberSet`
  under it, so they carry on when the caller goes, and a second request for the folder waits and finds the project. The
  key is checked before anything is made, and again as the project is added. A failed clone or creation takes away only
  what it made (the old rollback rules).
- **The fake gh** (`packages/testing/bin/fake-gh-repos.ts`): `api user/repos`, `user/orgs`, `search/repositories`, the
  contributed query, `repo clone` (from a repository's `source` folder; `cloneFails`, `cloneBreaks: checkout | after`),
  `repo create` (adds the repository, `created`/`private`/`pushed`; `createFails`, `pushFails`), `config get git_protocol`
  (`gitProtocol` by host). Repositories have `description`, `private`, `fork`, `archived`, `pushed_at`, `collaborators`,
  `contributors`; the state has `orgs`.
- **Tests.** `github/repos/model.test.ts` and `github/GithubRepos.test.ts` (the old `integrations/github.test.ts` and the
  GitHub cases of `api/projects.test.ts`, on the fake). Not ported: two creations interleaved in one new folder (the old
  `slow-fails`, which needs a gh paused mid-call; the rule it checks, parents taken away only while empty, is in the
  folders-above case) and the old `fake_gh_create`'s real push to a bare repository (the fake records the push).

### Agents, runs, permissions, board tools — [07-agents.md](07-agents.md)

#### As built in 6.4 (HE-7): `AgentTools`

- **Files.** `agents/AgentTools.ts` (the service), `agents/AgentToolsRepo.ts` (the six tables' rows: `agent_skills`,
  `agent_mcp_servers`, `agent_tool_switches`, `project_agent_tools`, `skill_sources`, and `thread_tools` read for a
  thread's skills and the servers a workflow step turns off; no migration), `agents/agentTools/validation.ts` (the old
  checks and their messages: frontmatter, `SKILL.md`, a server's name and config, others' skill names, what to clone),
  `effective.ts` (what's on: own, then global by switch, then a thread's extra skills; `google` never for a project; the
  `/` menu's rules; merging what a run reported), `files.ts` (`discover`, `copySkill`, `syncSkills`: links never
  followed or copied), `sourcePlan.ts` (a fresh clone's effect on a source's skills, as a plan the repository carries out
  in one transaction: matched by folder then by name, renames in two steps), `taskSkills.ts` (a Claude task's skills:
  folders, plugins' installations, synced descriptions, aliases).
- **Methods.** `global`, `project`, `updateProject`, `setSwitch`, `addSkill`/`updateSkill`/`removeSkill`,
  `addServer`/`updateServer`/`removeServer` (owner `null` for the host's), `addSource`/`updateSource`/`removeSource`
  (one at a time: a `Semaphore`; git through `Git` with `GIT_ALLOW_PROTOCOL`, ssh in batch mode, 180 s), `forRun(task)`
  (skills written, then `RunTools`), `preview(task)` (the same unwritten), `recordSeen(task, init)` (database only: the
  Claude line handler calls it in the `init` line's transaction), `taskSkills(task)` (Codex's from `CodexQueries.skills`),
  `removeThreadSkills`. Errors: `ToolInvalid`, `ToolNotFound`, `ToolConflict`, `SourceFailed`; `rpc/agentTools.ts` maps
  them to `Invalid`, `NotFound`, `Conflict` (`duplicate_name`) and `External` (`git`).
- **RPCs.** The `agentTools` group (`get`, `project`, `updateProject`, `setSwitch`, `addSource`, `updateSource`,
  `removeSource`, `addSkill`, `updateSkill`, `removeSkill`, `addServer`, `updateServer`, `removeServer`; the project-scoped
  routes are the same methods with a `project_id`), `tasks.skills`. Nothing is emitted, as before: the settings read again
  after a change.
- **Where runs get them.** `LaunchFacts` gives `forRun(task)` to both launches (it was `noRunTools`); `Prompts` tells a
  run of the gh server unless its project has its own `gh` or turns it off (`usesServer(preview(task), "gh", true)`;
  `docsTools` is 6.3's, the same way); `TaskDeletion` removes a deleted task's review threads' skill folders.
- **Decided.** A task's config for `seen` and the `/` menu is its own, else (no conversation yet) its first available,
  as `LaunchFacts` picks it; `recordSeen` keys by the task's `claude_config_id` (written at launch). The `/` menu reads a
  task's cwd as the old `skill_places` did (a ready worktree, else the repository), its documents folder and its group's
  repositories as added folders. Skill, server and source ids are branded in `contracts/agentTools.ts` (not `ids.ts`).
- **Left for others.** The assistant's `google` server helpers (`add_global_mcp_server`, `set_profile_switch`) are
  `addServer` and `setSwitch` (6.7); writing a workflow step's `thread_tools.disabled_mcp_servers` is 6.6's.

### Review — [inventory 04](inventory/04-git-review.md) (2.12–2.13, 2.18–2.19)

`Reviews`: reviewers each in their own thread and run, read-only in the task's worktree; `submit_review`; combining
verdicts; rounds of fixes against the project's limit; extend; supersede. `Summaries`, `ReviewStats`, `Fanout`
(comparing and picking among tasks made from one prompt). `Reviews.reconcile(task)` starts a review that is due and
is safe to call at any time.

#### As built in 4.6 (HE-5)

- **Files.** `review/Reviews.ts` (start, `submit`, a part's end, acting on the combined review, supersede, the user's
  Stop, extend, Recovery's `reconcileAll`), `review/Summaries.ts`, `review/ReviewStats.ts` (the `review_stats` rows),
  `review/ReviewRepo.ts` (review and summary threads' rows, a thread's skills in `thread_tools`, the stats rows and the
  effort the work was done at, the order of a thread's runs), `review/model.ts` (the pure rules: who reviews and
  summarises, a part's end, `combine`, what a submission records, `decideIssues`, `decideExtend`, `mentionsMinor`,
  `variantKey`, stopping; and `ReviewRefused { reason, invalid }`), `review/work.ts` (HEAD, `TaskBase.workScope`, "no
  commits of its own"), `review/taskWrites.ts` (a task's write under its lock with what decides it read in the same
  transaction, the `task` event and a `TaskChanged`), `review/changesCode.ts` (the old `changes_code`: here, not in
  `git/`, because it reads the permissions area's `DONT_ASK_DENIAL`, which is below git), `mcp/tools/review.ts`
  (`submit_review`: `ForReviewers`, `ReviewersOnly`, `ForPlanning`, `Rerunnable`; a list given as one string is a list of
  one, as the old tool took it). The prompts are `prompts/{review,reviewFixes,summary,reviewThread}.ts` as 2.5 copied them.
- **Changes and the reactor.** Two new members of `Changes`: `ReviewFinished { thread, run, outcome, attention }`, which
  `RunEnds` offers for a `review` run once its end is recorded (a review thread's run only stops running there), and
  `PromptStarted { task, run }`, which `Runs.start` offers after registering a `prompt` run of a `kind=task` (the old
  `supersede` call in `send_message`; workflows' supersede joins it in 6.6). The reactor hands the first to
  `Reviews.finished` (a summary thread's to `Summaries.finished`; a workflow step's is left for 6.6), the second to
  `Reviews.supersede` (the review and the summaries stop), and on a `TaskChanged` of a task that entered In review, or
  whose run ended there (`running` true → false, as the old run end called `on_in_review` whatever the column was
  before), `Reviews.reconcile`, inline (its git reads are short; the reviewers' runs are registered and launched in the
  background as any run). A passed review starts the summaries from `Reviews` (`Summaries.reviewPassed`), not from the
  reactor: the same path serves a reviewer that fails to start after the others have finished.
- **Locks.** `KeyedLock` has `["review", task]` and `["summary", task]` (before the task's lock): one review and one
  summary start per task at a time, in place of the old global `STARTING` mutexes. `supersede` and Stop don't take them:
  a reviewer that starts as its review is stopped is stopped after its send (the start reads the review again then), so
  the old "no await between check and send" holds without them. The later-run check and the recording of a review (or
  the summaries) are one transaction under the task's lock, so a run registered meanwhile is either seen there or finds
  the review to stop. The old race hooks (`review:last-run`, `review:recording`, `review:reviewer-started`) have no
  counterpart.
- **Recovery** (`Reviews.reconcileAll`, after `Runs.reattach`): a review or summary left `running` whose thread has no
  run going ends as its latest run since the round started did (its row: stopped, failed, a turn ended), or as "Couldn't
  start the review: the server stopped first" when the round's run never started. A run still live has its end come
  through `RunEnds` as usual. Reviews that were due but never started (the server stopped between the move to In
  review and the reactor) are not started at startup, as the old server didn't: Review now covers it.
- **RPCs** (`tasks`): `tasks.review` (Review now / Review again; the task after), `tasks.extendReview`, `tasks.summarize`,
  all `operate`, failing `Conflict` (`changed_meanwhile`, with the old "Can't review: …" text as its detail),
  `Invalid` (HEAD unreadable), the send's errors (`Unavailable` with no agents); `tasks.stop` is `Reviews.stopTask`: the
  agent, the review ("Review stopped") and the summaries.
- **Decided.** An `after_run` of `""` (the thread had no run before the round) accepts any run of that thread; a part or
  summary with no `after_run` at all (from before it was kept) accepts any run, as the old `reviewed_by`. A review with no
  `started_at` (from before rounds were kept) has its `updated_at` as its round in the stats, not the old backfill's
  worked-out round (`run_round`: the importer brings the old rows, which migrations 79 and 82 had already filled). The
  telemetry event `review` waits for `Telemetry`. A thread's skills are written to `thread_tools.skills`; 6.4's
  `AgentTools` turns them on.
- **Web (step 1).** `components/task/Review.tsx` (the card's badge, the Review tab's dot, the Review and Summary tabs,
  More rounds of fixes, what each round of fixes changed from `checkpoints.turnDiff`, shown as a plain patch until 4.2's
  `PatchBox`), `components/task/view/ReviewThreadView.tsx`, and their places in `TaskView`, `TabContent`,
  `StatusSection` and `TaskCard`. Not ported: `ReviewVerdict` (only the fan-out compare view used it, 2.18 `Fanout`).
- **Not here.** `Fanout` (2.18) and the merge gate's approval summary (4.7); a workflow's verdict step (`submit_review`
  from a `task_type=workflow` thread, 6.6); the analytics report of `review_stats` (6.x).

#### As built in 6.11 (HE-7): `Fanout`

- `review/Fanout.ts` (`facts`, `pick`; the old `review/fanout.ts`) and `review/FanoutRepo.ts` (siblings by profile and
  `fanout_id`, run time). The wire is `packages/contracts/src/rpc/fanout.ts` (`FanoutRpcs`): `tasks.fanout {id}` (`read`;
  the facts as an array, not the old `{tasks}`) and `tasks.pickFanout {id, pick}` (`git`); a task not made from one prompt
  with others, or with none, is `Invalid` `fanout_id`; picking one completed as not done is `Conflict` `changed_meanwhile`.
- A pick is one at a time (a `Semaphore`). The others' runs and their reviewers' are aborted (`Runs.abort`), their
  prompts expired, and waited for by polling (`FanoutStopWait`, a `Context.Reference`: 20 s every 200 ms; tests shorten
  it) until neither a run is live nor the task is marked `running` (the run's end is written to the task after it exits,
  HA-51). Then `Tasks.update` to Done/not done as the board, `gh pr close` as the task's account through `Gh.gh`,
  `Worktrees.teardown` (forced only with `discard_uncommitted`; kept with commits on no branch), the pushed copy deleted
  (only under its own name, HA-341) and the branch, cleared on the task through `Tasks.change`. Notes go to the threads.
- **Tests.** `review/Fanout.test.ts` (the old `review/fanout.test.ts`). Not ported: `an_agent_at_work_is_stopped_…`
  (a live run; `Runs.abort` is the runs area's, and the wait is the case of one that doesn't stop) and
  `a_task_is_completed_only_once_the_runner_has_written_its_runs_end` (a hook between the run's exit and its end on the
  task; here the pick waits on the task's `running` too, which the run's end clears).

### Merge — [inventory 04](inventory/04-git-review.md) (2.14–2.17)

`Merges`: the agent merges, the server queues, gates and observes. Lanes and slots are worked out from task rows,
never kept in memory. `merge/decide.ts` has the lane rules as a pure function over the lane's tasks, with the old
tests' cases as its table: who holds a slot, who waits, what steps out and rejoins, whole-stack runs.
`Merges.reconcileLane(lane)` starts the next merge when the slot is free. `MergeGate` (approval before a merge, and
the check the `gh` tools make), `MergedWatcher`.

As built in 4.5 (HE-5), `merge/MergedWatcher.ts`: `check` reads the pull requests of the tasks `PrWatchRepo.withOpenPrs`
lists (In review or Needs attention, not merging or running, no `task_type`, `done_when_merged`), skipping those whose
agent or a reviewer runs, by account and host (an account on another host than the pull request's reads none of it),
50 to a query, as each task's account (`TaskBase.account`). It records open pull requests' checks, and acts once per
change of state: merged moves the task to Done through `Tasks.change` (only if it's as it was read), says so, and
`Worktrees.removeIfMerged(fetch)` with the reason it was kept; closed flags a task in review (Needs attention with the
old reason) or only says so for one already there. `pr_states` is written only after acting, so a move refused is
tried again. What follows a move to Done is the reactor's (`startUnblocked` now; restacks, the next merge, workflows
and terminals join with 4.8, 4.7, 6.6 and 6.1); telemetry's `merge` event is 6.9's. Subprojects' rules are gone with
them. `MergedWatcher.loop`: first 30 s after start, then 180 s after each check ends.

#### As built in 4.7 (HE-5): `Merges`, `merge/decide.ts`, `MergeGate`

- **The rows' model is `tasks/lanes.ts`** (pure, the old `db/tasks/merges.ts` and `db/tasks/stacks.ts`): `firstTarget`,
  `targetState`, `reaching`, `stackedBelow`, `stackState`, `stackWaits`, `stackedLevels`, `mergeHeld`, `heldReason` /
  `heldReasonOf`, `mergeLane`, `isHandoff`, `activeMerge`, `queuedMerges`, `mergeLanes`, `stackRunTasks`, `stackRunLanes`,
  `stackOf`, `stackLine`. It is in `tasks/` (the lowest area that has the rows), so `runs/` (the active merge of a lane,
  a held merge at a run's end, a stack level talked to) and `git/`/`github/` (stacks, 4.8) read the same functions;
  `tasks/decide.ts` re-exports the three it had (`reaching`, `stackedLevels`, `heldReason`). Lanes are a task id or null
  (the project's own); subprojects' lanes are gone with subprojects.
- **`merge/decide.ts`** is the old `start_next_merge` as one pure function: `decideLanes({ tasks, finished, archived,
  approvalRequired }) → { leaveRun, summarise, start }`, with `settleStackRuns`, `awaitsApprovals`, `needsSummary`; its
  table is `merge/decide.test.ts` (the lane cases of the old merge, tasks, incoming, stacks and stack-merge tests). What
  a merge request says is `merge/request.ts` (`intoMerge`, `stackedMerge`, `mergeRequestText`, over `prompts/merge.ts`;
  a request that can't be made fails with the old reasons). The merge handoff (a workflow's, HA-276) is in the rules
  (`TaskRepo.finishedLast`: the tasks whose latest run said `finish_work`), though nothing makes one before 6.6.
- **`merge/Merges.ts`**: `reconcileLane(project)` takes **`KeyedLock` `["merges", project]`** (a new key, after the
  project's and before any task's), reads the rows, decides, and carries the plan out: levels leave their stack's run
  (`Tasks.change`, with the old notice), merges needing approval are marked `pending` and summarised
  (`MergeGate.requestSummary`; one that can't be asked needs attention, "Couldn't ask for a summary of the merge: …"),
  and each lane's next task is asked to merge (`Runs.send`, `source: board`, `auto`), which registers its run (the task
  `running`) before the lock is let go: two looks can't both give a slot away. A request that can't be made or sent leaves
  the task in Needs attention, still merging ("Couldn't start the merge: …"), holding its lane. Nothing on a host that runs
  no agents. `reconcileAll` (Recovery, after `Runs.reattach`) looks at every project. `taskChanged` is the reactor's
  merge step for every `TaskChanged`: a pending approval that isn't any more has its card settled `replaced`; a merging
  task whose summary run ended in Needs attention with "Approve or deny the merge" gets the card (`MergeGate.ask`); and
  the project's lanes are looked at when a column the queue reads changed (status, resolution, merging, running,
  approval, remerge, restack, stack run, target, the task it lands after) or the task is new or deleted.
- **`MergeGate`** (`merge/MergeGate.ts`): `blocked` (the gh tools' check), `required` (the project's `merge_approval`,
  else the profile's), `requestSummary`, `ask` (a question request, `legacy:<n>`, its metadata the old card with
  `merge_approval: true` and `call_id: "merge-approval"`), `settle`, `decide` (approved: `merge_approval` approved and
  Ready for merge; denied: out of the merge, In review; refused unless still pending and merging with no agent running:
  `ApprovalRefused` `not_pending` / `agent_running`, the wire's `Conflict`). **The card's answer goes to the gate through
  `Questions`**: `Questions.answer` hands a card with `merge_approval` to the decider the merge area registers
  (`Questions.onMergeApproval`, `MergeGate.registered`), so `threads.answerQuestion` stays one call; the card is answered
  (compare-and-set) first and opened again if the decision is refused, as before. A user's message settles it `replied`
  like any other card, as the old `replied` did. `openGate()` is a gate that blocks nothing, for tests.
- **`Tasks.update`'s git and GitHub facts come through `tasks/MergeFacts.ts`**, a seam in the tasks area that the merge
  area fills (`Merges.registered`, as areas below `runs/` register with `AgentRequests`): `needsGitFacts(task, patch)` says
  whether a change needs them (a move to Ready for merge, a new target for a task with a branch, worktree settings of one
  whose setup failed); they are read before the task's lock (`TaskBase.hasWorkToMerge`, `PullRequests.approval` for the
  pull request the change leaves it with, the start ref's commit, whether the failed worktree's folder is there), and the
  change is refused `changed_meanwhile` if the task moved, started merging, changed target, branch or pull request
  meanwhile (the old `still`). Without the merge area (or when nothing is needed) the facts are the old defaults.
  `UpdateFacts.running` is the task's `running` column (it was always false), so `remerge` works.
- **Notes.** `TaskChanged` has `notes` (`ChangeNote`: level and text), which the reactor writes to the task's thread first:
  `decideUpdate`'s "Nothing to merge…", "Stepped out of the merge queue…", "Merges into … now…", a stack level's "Waits
  for …" (4.8), and `Tasks.update`'s warning that agents can't run on this host.
- **Runs.** `decideSend`'s active merge is `lanes.activeMerge` of the task's lane (a message to a task queued behind
  another merge is refused `merge_queued`); a message to a stack level waiting in Ready for merge takes it out (In
  progress, `remerge`, "Out of Ready for merge while its agent works…") before anything else. `RunEnds` gives
  `decideFinish` its `mergeHeld` (`heldReasonOf` over the project's rows).
- **The fake agent** plays the merge with `HUNTAWAY_FAKE_CLAUDE_MERGE` (`branch`, `pr`, `refuse`; its header says how).
- **Tests.** `merge/decide.test.ts` (the table), `merge/request.test.ts` (what a request says), `merge/Merges.test.ts` on
  the board (queued before agents can run, lanes one at a time, stepping out and rejoining, a message refused behind a
  merge, a request that can't be made, approval asked/approved/denied/replaced and the gate's refusals). Not ported as a test:
  two moves at once (`two_moves_to_ready_for_merge_at_once`), which needs the two to interleave: the second one, having
  read the task before the first committed, is refused `changed_meanwhile` (the old 409), and one that reads it after finds
  it in Ready for merge already, which is no move. The old usage-wait refusal for a merge is `Runs.waitForReset`'s
  (2.x). Not here: telemetry's `merge` event (6.9); workflows' merge prompts and `merges_to_done` (6.6); the GitHub
  approval case's gitlab/github remotes (`PullRequests.approval`, 4.5's tests).

#### As built in 4.8 (HE-5): stacks, `Restack`, `GhStacks`, merge targets, whole-stack merges

- **The stack model** is `tasks/lanes.ts` (4.7's: `stackedBelow`, `stackState`, `stackWaits`, `stackOf`, `stackLine`).
  What follows from it is **`merge/MergeTargets.ts`** (`MergeTargets`, pure parts in `merge/targets.ts`):
  `taskChanged` (the reactor's step: a task closed without being merged holds the open tasks reaching it and the levels on
  it, unless their agent runs, which `RunEnds`' `mergeHeld` catches at its end; a held task is told its reason; a new
  target or base has its branch's `gh-merge-base` follow, `TaskBase.followBase`), `setTarget` (`tasks.mergeTarget`: the
  old `set_merge_target` and `set_stack_target`: `onward`, `close`, or an heir by id or key; `carries` from the start
  ref; a level sent elsewhere starts from its start ref's commit and is restacked there; Conflict `nothing_to_choose` and
  `agent_running`, Invalid `to`), `mergeStack` (`tasks.mergeStack`: the old `stack_to_merge` checks, each moving level's
  work and GitHub approval read first, then, under the project's `["merges", project]` lock so the queue isn't looked at
  meanwhile, every open main-line level moved bottom first and given one `stack_run`; Conflict `stack_not_ready` /
  `pr_not_approved` / `changed_meanwhile` with the old texts), `askToRestack` (the reactor's `RestackAsk`). Two new
  `ConflictReason`s: `nothing_to_choose`, `stack_not_ready`.
- **`git/Restack.ts`** (`Restack`, git in `git/restack/git.ts`): `reconcileDependants(merged)` (marks the open levels
  with a branch `due`, says so, schedules them), `schedule(id)` (a fiber in the service's `FiberSet`, taking **`KeyedLock`
  `["restack", repo]`** — one at a time per repository, in the order asked — then the level's `["worktree", id]` lock),
  `afterRun(id)` (a level's or its review thread's run ended), `settled(id)` (what a launch waits for), `resume`
  (Recovery). The restack is the old one step for step: later while an agent or reviewer is in the worktree (checked at
  the start, after GitHub's wait, after the rebase); its upstream pushed only when it's its own name; GitHub's own rebase
  of a linked level waited for and taken in; a fetch of the new base; refusals for remote commits not here, a dirty
  worktree, no start ref, a start no longer in the branch; the rebase in a detached worktree under a temp folder
  (`huntaway-restack-`) with `-c core.hooksPath=/dev/null`, `--no-autosquash --no-update-refs`, five minutes; the branch
  moved (`reset --keep` in its worktree, else `update-ref` with the old value), pushed with `--no-verify
  --force-with-lease=<ref>:<remote head read>` (120 s, authenticated as fetches are) and put back if the push fails; the
  start ref moved to the merge-base; `restack` cleared and `base_branch` set; `gh-merge-base`; the pull request
  retargeted; GitHub's stack linked again; then the levels above follow. A conflict sets `restack: conflict` and, the first
  time, offers **`RestackAsk { task, text, reason }`** (a new `Changes` member): the reactor has `MergeTargets` take a
  merging task out of the queue (`remerge`) and send the agent `prompts/restack.ts`; a second conflict, or a send that
  fails, leaves it in Needs attention ("Couldn't restack it onto …"). `AfterRebase` (a `Context.Reference`) is the old
  `restack_testing.reached("rebased")`.
- **`github/GhStacks.ts`** (`GhStacks`, the old `gh_stack.ts`): `link(id)` (the level and the levels on it, in the
  background, one link at a time under a semaphore, a failure said once per pull-request pair), `linkAll` (Recovery),
  `settled` (tests), `restacked` (GitHub's rebase waited for, `GhStackWait`: 90 s, every 3 s, a `Context.Reference`),
  `retarget` (unstacking first when GitHub says it's in a stack). It is built on the git line beside `Gh` (it needs only
  `Gh` and the task rows: the GitHub account is the project's, else the profile's, read directly) and reaches the
  restack through **`GitHubAccess`**, which gains `restacked`, `retarget` and `linkStacks` (`noGitHubStacks()` for
  fakes; `GitHubAccessLive` is without them, `GitHubAccessStacked` with, Main's). The reactor links a task whose `pr_url`
  was set or changed.
- **The reactor** (shared edits): `RunExited` → also `Restack.afterRun`; `RestackAsk` → `MergeTargets.askToRestack`; on a
  `TaskChanged` of a task that became merged, `Restack.reconcileDependants` **before** the merge queue is looked at (so a
  level waiting in Ready for merge waits for its restack, as the old `update_task_inner` marked it before
  `start_next_merge`), then `MergeTargets.taskChanged`, then 4.7's `Merges.taskChanged`; a `pr_url` set links GitHub
  stacks. **Recovery**: `Restack.resume`, `GhStacks.linkAll` (after the reviews'). **Launch**: `LaunchFacts.prepareWork`
  waits for `Restack.settled` of the task (or a review thread's task) first. **Prompts**: `Prompts.system` tells the
  agent the task as the old `as_told` did (merged below: not stacked any more, its base where that went).
- **The fake GitHub** (`packages/testing`): `POST repos/O/R/stacks` and `…/stacks/N/add` with `pull_requests[]` (each on
  the one below's head), `POST …/stacks/N/unstack`, a pull request's `stack` with its place and size and
  `mergeable_state`; a base change refused while it's in a stack (`pr edit --base`, PATCH); merging one in a stack
  retargets the level above to where it went and moves its head to its `rebasedTo` (GitHub's own rebase; `dirty`
  without one). fake-gh.ts's state types moved to `bin/fake-gh-state.ts` (the file passed 1,000 lines).
- **Tests.** `merge/Stacks.test.ts` (the old `api/stacks.test.ts` restack and target cases on the board: squash-merged
  below, an upstream that's another branch, three levels, a conflict to the agent then the user then finished, remote
  ahead and uncommitted, no remote, an agent running, a waiting level merging once restacked, the agent told after a
  restack, a restack due at a restart, a waiting level talked to; levels on a closed or deleted level going onward, an
  heir, closing; a target closed and sent onward with `carries`; a whole stack's merge and its refusals) and
  `github/GhStacks.test.ts` (linking, a second level not stacked and said once, the level below linked first, not on one
  whose base will change, GitHub's restack taken in, unstacking before a retarget, recorded or not). The lane cases of the
  old `api/stack_merge.test.ts` (a level stepping out or denied taking those above out, a restack conflict freeing the
  lane, approvals up front, a run surviving a restart) are rows in `merge/decide.test.ts`. 4.1's TaskBase case "a stacked
  task keeps its own changes…" now has its second level's agent running while the first is merged, so the restack 4.8
  adds doesn't move what it looks at. Not ported: the old `a_level_isnt_stacked_on_github_on_a_task_started_from_a_pull_request`
  and `…_merging_into_another` (the same check as the one whose base will change, which is ported); the parts of the
  `incoming` cases that read `summarize`'s view (`merging_into_it`, `merges_into`, `carries`), which is 3.x's
  `mcp/tools/taskJson.ts` and has its own tests (it keeps its own `targetState`/`stackState`, which could use
  `tasks/lanes.ts` now).
- **Not here.** Relocation's hold at launch (6.x); a GitHub stack's merge through `pr_merge` is 4.4's (`merge-async`).

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

#### As built in 6.8 (HE-7)

- **Files.** `push/Push.ts` (subscriptions and the watcher), `push/PushRepo.ts` (`push_subscriptions`), `push/WebPush.ts`
  (the VAPID key and one delivery over `HttpClient`, 30 s), `push/crypto.ts` (RFC 8291 `aes128gcm` and the RFC 8292
  token on `effect/crypto`: `KeyAgreement`, `Kdf`, `Aead`, `Signature`, `Digest`, whose WebCrypto layers `Main`'s platform
  provides; checked against RFC 8291's example), `push/rules.ts` (the rules and texts as plain functions). No migration.
- **`Secrets`** (`platform/Secrets.ts`, the smallest one): `get` and `getOrMake` over the `settings` table, as
  `Redacted`. The VAPID key is `vapid_key`, a JWK `{d, x, y}`: WebCrypto can't import the old bare scalar
  (`vapid_private_key`) without its public point, so the importer converts it (11-migration.md).
- **The watcher** (`Push.watcher`, in `areasLayer`, so tests have it) subscribes to `Events`, takes every task and pending
  prompt as a baseline (nothing about them notifies), and handles each event in order; after `resync`, again from a
  fresh baseline. Task events notify by `taskEvent` (attention, review after 5 s still so, merge, done). **Prompts** are
  found on the task's own event (a prompt's raise writes the task's attention in its transaction): each pending prompt of
  a task in Needs attention not seen before is pushed once (body from `promptText`, never the tool's input, tag
  `<host>:<task>:<request>`), and the devices it went to aren't told the task needs attention while it waits; a task
  whose run ended lets its prompts go. **Replies and reports** are two new board events, `assistant_reply {task_id,
  profile_id}` (for 6.7's `Assistant` to emit at the end of a turn) and `routine_report {id, task_id, automation,
  outcome, text}` (for 6.5's `Routines` to emit as it posts a report); the web client ignores both. Sends run in the
  background, one device at a time; `noted` changes a subscription only while it has the endpoint the push went to.
  `Push.idle` is for tests.
- **Own moves.** The `tasks.update` handler calls `Push.noteMove` before a status change (the old hub endpoints' place):
  any RPC move is the user's own, so `huntaway rpc tasks.update` doesn't push either; agents', automations' and the
  board's moves do. 15 s, on `Clock`.
- **RPCs**: `hub.push.info` (`read`), `subscribe`, `update`, `unsubscribe`, `test` (`operate`; `test` fails with
  `External` `push` and why, the old 502). In `HostRpcs` until `HubRpcs` exists (M7). Web subscriptions only: `kind`
  `expo` isn't taken.
- **Left out**: Expo push, its receipts, device ownership and answer tokens (the phone app, 14-dropped-and-open.md);
  linked hosts' events and `hosts_changed` readiness (M7); `IA_PUSH_SUBJECT` (dropped).
- **Tests**: `push/crypto.test.ts`, `push/rules.test.ts`, `push/Push.test.ts` against `packages/testing`'s
  `fakePushService` (a push service on 127.0.0.1 that keeps what it's sent) and `pushDevice` (a browser's keys,
  decrypting on `node:crypto`).

### Terminal<a id="terminal"></a> — [inventory 05](inventory/05-hosts-update.md) (2.5)

`Terminals`: a tmux session per task and per terminal tool on a tmux server private to the data folder, leases for
tool sessions, the reaper. `Pty`: the pseudo-terminal that attaches to a session. Node has no `openpty`; the old
server uses an inline Python helper. Keep that helper in M6 and replace it with a 60-line Rust binary beside the
shim (`ia-pty`) if Python proves a burden on a release host. Flow control by acknowledgements (384 KiB) is kept.

#### As built in 6.1 (HE-7): `Terminals`, `Pty`

- **The tmux server is the data folder's own, by its socket's path**: every tmux command is `tmux -S <data
  dir>/tmux.sock …` (`terminal/tmux.ts`), never `-L` and never without one, so it is never the default server, the live
  board's (the old server's `-L ia-<host>`) or another test server's, and `TMUX` in the server's environment can't send a
  command to the tmux it runs in. A test records every tmux the service and the pty run and checks each. A data folder
  whose path is too long for a socket (over 103 bytes) has no terminals and says why. Session names stay `ia-<task>` and
  `ia-<task>~<tool>`. `scripts/test-server.sh stop` ends the tmux server of the data folder it removes.
- **`Terminals`** (`terminal/Terminals.ts`): `status`, `open` (a ticket), `serve`, `kill`, `killAll`, `keepalive`, `reap`,
  and the reaper (`Terminals.reaper`, every 30 s, in `AreasLive` beside the other loops). A session is made where the
  task's agent works with its config's environment (`LaunchFacts.workEnv`, added: the worktree while it is there, else
  the repository or the profile's scratch folder; `CLAUDE_CONFIG_DIR` or `CODEX_HOME` and the proxy), `TMPDIR` the task's
  temp folder until it is done, tmux's environment the agents' (`SERVE_ENV` removed) without `TMUX`. Leases and tickets
  are `Ref`s of the service. The reaper also ends the sessions of tasks that are gone (deleted with a project or a
  profile, or while the server was down), which the old server left.
- **The socket** is `GET /api/terminal/<ticket>?cols=&rows=` (`http/terminal.ts`), as 05-protocol.md has it, not the old
  `/tasks/<id>/terminal/ws` with the board token: `terminal.open` (scope `terminal`) gives a ticket for the task and tool,
  single use, for a minute. A bad ticket is a 403, a task that's gone a 404, no tmux a 503, before the upgrade. The relay
  (`terminal/attach.ts`, tested on the test clock with a socket and a pty in memory) is the old one: `ready`, output as
  binary frames until 384 KiB is unacknowledged, `ping` every 15 s, a board that answered one and then went silent for a
  minute closed (1001). There is no websocket-level ping: `Socket` has none, and the old one only fed proxies.
- **RPCs**: `terminal.status`, `open`, `kill`, `keepalive` (`packages/contracts/src/rpc/terminal.ts`, with
  `TerminalStatus` and the control frames' schemas). The status always has `cwd`, `reason` and `tool` (null for none).
- **Who ends a task's terminals**: the reactor on Done and on deletion (`TaskDeletion`'s note), and a worktree's
  teardown before its script (`Worktrees.beforeTeardown`, added to the git area for areas below it to register with:
  `Terminals.registered`). A project or profile deleted with its tasks is left to the reaper.
- **Left out**: the assistant's workspace and a documents-only task's folder as a terminal's place (they come with their
  areas: the terminal opens where `LaunchFacts` puts their agent until then); a relayed terminal on another host (M7,
  `hub.hosts.openRelay`). The pty is still the Python helper (`terminal/Pty.ts`); `ia-pty` was not needed.

### Desktop, update, analytics — [inventory 05](inventory/05-hosts-update.md), [07](inventory/07-server-root-api.md)

`CuaDriver` and `DesktopClaims` (computer use: one driver process, one task at a time, an operation journal).
`Supervisor` (the restart file and exit 75), `Updater` (rebuild from a checkout, follow a deployment, take a bundle
from a hub), `Releases` (check GitHub, download, verify, stage, try, settle, roll back; `app/state.json` shared with
the desktop shell), `Service` (the systemd user unit with `KillMode=process`). `Analytics`, `Disk`.

#### As built in 6.10 (HE-7): computer use

- **`desktop/`** (below `mcp/`): `CuaDriver` (the one `cua-driver mcp`: found from `HUNTAWAY_CUA_DRIVER`, the newest
  `<data>/cua-driver/<v>/cua-driver`, or PATH; started by the first call that needs it, under a semaphore; stopped after
  10 minutes idle by a `FiberHandle` sleep, on the test clock; stopping closes stdin, then the process's scope (a child of
  the layer's, so a server that stops kills it) after 5 s; the stdio client is `driverProcess.ts`, shaped as
  `agents/codex/rpc.ts`; the session's variables come from the server's `Config`, else `systemctl --user
  show-environment`, else a `wayland-N` socket; the lock from logind and `pgrep`, kept 2 s), `DesktopClaims` (holder
  and viewer targets in `Ref`s, lease 120 s), `DesktopOpRepo` (the journal; `boot` is `Events.boot`; **decided**: a
  second call with an `op_id` already there is found in the insert's transaction, not by matching SQLite's UNIQUE
  message), `CuaInstall` (download through `HttpClient`, size refused as it passes, SHA-256 with `effect/crypto`'s
  `Digest` over the whole archive in memory, `tar -t` checked before `tar -x`, unpacked aside then renamed, older versions
  removed, the driver stopped; `settled` waits for the install going), `Desktop` (the page's and the viewer's: status,
  on/off, install, uninstall, stop, check, `frame` with a 400 ms cache, `ops`), `DesktopTools` and `tools.ts` (the
  server's 11 tools, word for word, through `ToolCalls`; refusals and the driver's failures are error results with the
  old words, not `ToolError`'s `Error: …`). Pure parts in `cua.ts` (the pinned 0.41.3 archives, `sessionEnv`,
  `forAgent`, `actSummary`).
- **How runs get the server**: `McpServers` has `serveWhen(server, gate)` and `serves(server)`; `DesktopTools`
  registers its tools and the gate (computer use on and a driver found), and `mcp/transport/control.ts`'s
  `served.desktop` asks it at each launch. `LaunchFacts` reads `served` once and gives the system prompt `desktopHost`
  (`RunTold.desktopHost`), so the desktop note appears exactly when `mcp.json` has the server.
- **Configuration** (`ServerConfig`, all three in `SERVE_ENV`): `HUNTAWAY_CUA_DRIVER` (`cuaDriver`),
  `HUNTAWAY_CUA_DRIVER_RELEASE` (JSON `cuaRelease`, a fake download), `HUNTAWAY_DESKTOP_LOCKED` (`desktopLocked`; when
  set, the session and the lock aren't asked of the machine). `layerTest` names a driver that isn't there, a release on
  an unreachable port and an unlocked screen, so no test reaches this machine's desktop or GitHub.
  `scripts/test-server.sh --fake-desktop` runs `packages/testing/bin/fake-cua-driver` (logging to
  `<data>/fake-cua.log`); tests use `fakeCuaDriver` (a folder with the call log and a `fail` file).
- **RPCs**: the `desktop` group (05-protocol.md): `status`, `frame`, `ops` are `terminal`; `setEnabled`, `install`
  (`Unavailable` with no release for the platform), `uninstall` (`Conflict` `in_use` while installing), `stop`, `check`
  are `admin`. No events: the page and the viewer poll, as before.
- **Changed**: an argument a desktop tool doesn't have is refused (`ToolCalls`' argument check), where the old server
  dropped it; `act` loses `destructiveHint` and `initialize` its `title` (`McpServers` gives `readOnlyHint` only); the
  answers kept 10 minutes for a reconnect are `mcp_calls`' (07-agents.md).
- **Not here**: no host capability names computer use (the task view asks `desktop.status`; capabilities come with M7's
  hosts). Not run: a real Cua Driver, a real screen lock, a real download from GitHub, Claude Code or Codex taking the
  server's schemas.

## Hook commands<a id="hook-commands"></a>

`huntaway approval-hook`, `gh-hook` and `gh-run` are started by an agent CLI for a tool call, the first two for
every matching call. They must start in tens of milliseconds and fail closed (exit 2), so:

- `bin/huntaway` execs their entry files (`apps/server/src/hooks/*.ts`) directly, without loading `bin.ts`.
- They import only `node:` modules and `@huntaway/shared`. A structural test walks their import graphs and fails on
  `effect`.
- Their logic is the old one, kept with its tests: rule matching (strongest decision wins), the shell reader, `gh`
  argument refusal.

As built in 3.6: `hooks/approval-hook.ts` and `gh-hook.ts` are the entries; each installs its fail-closed handlers and
only then imports its logic (`hooks/approval.ts`, `hooks/gh.ts`), so a hook that cannot load exits 2. The matcher and
the hook's answer are `packages/shared/src/approvalRules.ts` (the web client decides by the same `decide`). `gh-hook`
now refuses a call whose input is not JSON (exit 2); the old one let it through. The launcher sets
`NODE_COMPILE_CACHE` (in the temp folder) for the hooks: from a checkout, Node otherwise loads its TypeScript stripper
on every call. Measured on the reference machine through `bin/huntaway`: about 57–60 ms with an empty cache (the first
call), 25–33 ms after; `tests/e2e/hooks.test.ts` holds the median under 60 ms. A release runs the precompiled `.js`
and strips nothing.

## Startup

`Main.ts` builds the layers in dependency order; building a layer starts its loops. Then `Recovery` runs, then the
server says it is ready. This is the old order ([inventory 07](inventory/07-server-root-api.md), section 6) with
the one-off moves removed:

1. `Supervisor.take` (restart file and parent PID out of the environment) · data folder · `ImportGuard` (below) ·
   `Releases.execInstalled` (hand over to a newer staged release) · `Identity`.
2. `Backup.beforeStart` · `Db` · `Migrations`.
3. (Moved to step 6, HE-3: the listener binds once every area is built and recovery has run, so no request can
   reach a server that is still starting, and no gate is needed. A client sees "connection refused" until then,
   which it already treats as "not up yet".)
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

### `ImportGuard` and a read-only server<a id="a-read-only-server"></a>

A folder filled by `import-legacy` has an `import.json`. `ImportGuard` reads it before anything else is built, for
the reasons in [11-migration.md](11-migration.md#the-guard):

- **An import that was the switch**: the server refuses to start while a process has the old folder's database
  open. Two servers never act as one host.
- **A rehearsal** (`rehearsal: true`): `Main.ts` builds `ReadOnlyMain` and nothing else. No flag overrides it.

`ReadOnlyMain` is a second, short composition root in `apps/server/src/`, not a set of `if`s spread through the
areas. It is made of the same services with four differences, and steps 4 to 6 above become "serve reads":

| Normal                                           | Read-only                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `Auth` gives a session its token's scopes        | `Auth.readOnly`: every session has `read` only                                                    |
| The loops of step 4, the `Reactor`, `Recovery`   | Not in the layer graph at all                                                                     |
| `Proc` runs any command                          | `Proc.readOnly`: `git` with a fixed list of reading subcommands and `GIT_OPTIONAL_LOCKS=0`; all else fails `Unavailable` |
| `HttpClient`, links, discovery, hub, webhook, MCP and hook paths | `HttpClient` that fails every request; the rest not built or not mounted             |

`host.info` reports `read_only: true`. The test that holds this is in
[11-migration.md](11-migration.md#rehearsal); a structural test also fails if `ReadOnlyMain`'s imports reach a
module under `lifecycle/` or a loop's layer.

## The CLI

`effect/cli` commands in `apps/server/src/cli/`, one file each, each a thin call into a service or the RPC client:

| Command                                   | Does                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `serve` (default)                         | The server. Flags as now ([inventory 07](inventory/07-server-root-api.md), section 5), each with a `HUNTAWAY_*` variable |
| `token [--hub]`                           | Print the board or hub token                                                                 |
| `rpc <method> [json]`, `dev …`            | The typed client over HTTP, and the helpers on top of it                                     |
| `import-legacy --from <old folder> [--rehearsal] [--check]` | [11-migration.md](11-migration.md). `--rehearsal` makes a board that only a read-only server will open |
| `ssh-host`, `install-service`             | As now                                                                                       |
| `telemetry init \| test \| backfill`      | As now                                                                                       |
| `codex-run <spec>`                        | The Codex adapter, started under the shim (not through `effect/cli`: it is a run's process)  |
| `approval-hook`, `gh-hook`, `gh-run`      | The hooks, dispatched by the launcher before any of this loads                               |
| `--version`                               | `huntaway <version>`: the release smoke test depends on the exact form                       |
