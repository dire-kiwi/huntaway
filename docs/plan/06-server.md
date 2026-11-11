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
projects      Projects · Relocation
tasks         TaskRepo · Tasks · TaskRefs · Pens · Attachments · TaskTmp · Leftovers
threads       ThreadStore · Threads · ThreadReaders
git           Git · Worktrees · TaskBase · ChangesTab · Checkpoints · Restack · StatusScripts
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

### Agents, runs, permissions, board tools — [07-agents.md](07-agents.md)

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
