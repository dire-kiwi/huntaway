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
docs          TaskDocuments (published documents: the docs plugin, 15-plugins.md)
assistant     Assistant · Memory · Tracked · Brief
mcp           BoardTools · ToolCalls · Wait · GhTools · DocsTools · DesktopTools · McpEndpoint
plugins       InstalledPlugins · Plugins (HE-34, 15-plugins.md)
push          Push
hosts         Links · LinkConnections · Relay · Discovery · Ssh · Uplink · SettingsSync
terminal      Terminals · Pty
desktop       CuaDriver · DesktopClaims
spaces        Docker · Spaces · TeleportRepo · Teleport · SpacesTools
browser       ChromeInstall · Browsers · BrowserTools
update        Supervisor · Restarts · Systemd · Releases · Service · Updater
analytics     Analytics · Disk
board         Board
lifecycle     Reactor · Recovery · Demo
transports    rpc/* · http/* · mcp/transport/*
```

As built in M1 (HE-3): `hooks/` sits below everything and `prompts/` right after `platform/` (the structural test
needs every folder placed). `lifecycle/Board` (the board snapshot and `board.watch`) reads every area, so it is in
`lifecycle/`. (9.1, HE-8: it moved to an area of its own, `board/`, just above `lifecycle/`: the read-only server serves
`board.watch`, and its imports must reach nothing under `lifecycle/`.) `Pens` uses `Tasks` (a pen's thread is deleted with it) and `Tasks` uses `PenRepo`. `Profiles` and
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
| `Usage`         | Plan limits per config (Anthropic's usage endpoint, Codex's rate limits, a proxy's accounts), "out until", tasks waiting for a reset. In memory, with the durable part on the task. A fetch emits `usage` too (the old one left the client to keep `GET /usage`'s answer; HE-14) |
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
  themselves) records them at start and hourly. Beside it since 9.2, `Projects.gitSweeper` reads `is_git` and
  `has_commits` again (`refreshGits`, over `ProjectRepo.unready`): every 3 s for a project that wants worktrees and
  isn't ready for them, every 5 minutes for all, so a folder that becomes a repository gets worktrees (nothing read them
  again after a project was made).
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
- **New in review** (HE-65): `review_unread` is set by `deriveColumns` each time a task's status moves into In review
  (its run ending, its agent moving it), and cleared when it moves out; `decideUpdate` leaves it clear when the user or
  a device moves it there. Opening the task (the web app's `TaskView` while the page is shown, the phone's task screen)
  sends `tasks.update` with `review_unread: false`. The board marks such a task (`unreadInReview`): a violet border,
  tint and dot on its card, a dot on its list row and its stack's card, "New in review" on the phone's list.
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
  `workScope` (4.6's reviews), `keepStarts`, `diff` (`git.taskDiff`), `hasWorkToMerge`, `mergeWork` (HE-51,
  `git.mergeWork`: the same count of commits not on the base branch, and of uncommitted files, with a branch or worktree
  that's gone said rather than failed), `forgetStart`; `startRef(id)`.
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
  `git.taskDiff`, `git.mergeWork` (HE-51) (`read`); `projects.branches` (`read`), `projects.removeMergedWorktrees`, `projects.setupThread
  {message?}` (`runs/SetupThread`; the instructions are `prompts/setupThread.ts`). Arrays are returned as they are, not
  in the old `{branches}`/`{results}` objects.
- **Web**: the Details panel's Set up and Tear down… (the old `TeardownModal`) are back. HE-51: a task in review is
  marked on its card (and list row) with what it has to merge, from `git.mergeWork` (`board/MergeWork.tsx`): the
  commits not on its base branch and the uncommitted files in the merge colour, "nothing to merge", or "branch gone" /
  a worktree that's gone; its key items and Details say it in words. One query per task, read again as its run, worktree,
  branch or column changes, after a Changes tab action, every minute while the page is visible and on focus: no git on
  a render. The board's setup thread for a
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

#### As built in HE-79: `FilesTab`, the Code tab's reads

- **Files.** `git/FilesTab.ts` (the service), with the definition patterns in `packages/shared/src/symbols.ts` (plain,
  shared with the web app's outline). The wire is three more `read` methods in `packages/contracts/src/rpc/git.ts`:
  `git.files` (`GitTree`), `git.readFile` (`GitFileContent`), `git.symbol` (`GitSymbol` of `GitSymbolHit`s), with the
  Changes tab's errors; the handlers are `rpc/git.ts`, the layer is on Main's (and ReadOnlyMain's) git line beside
  `ChangesTab`.
- **Where.** The folder the Changes tab is of (`TaskBase.changesDir`), from the top of its repository, only the
  project's folder when that is part of one; git with no optional locks and the location variables cleared.
- **`git.files`.** `ls-files -z --cached --others --exclude-standard`, less `--deleted`, sorted, at most 50,000.
- **`git.readFile`.** Read from the working tree as it is (not from the index or a commit). Refused (`Invalid`, field
  `path`): a path with `..`, absolute, with a `.git` component, outside the project's folder, a link whose target is
  outside the repository (`realPath` compared with the top's), a folder, a missing file. Over 2 MiB is `too_large` with
  no text; a NUL in the first 8,000 bytes is `binary`; text that isn't UTF-8 is decoded lossily with `not_utf8`.
- **`git.symbol`: search, not a parser.** `grep -n -z -I -w -F --untracked -e <name>` (a name must be letters, digits,
  `_` and `$`, not a keyword, at most 200 characters, so it is never an option or a pattern). Each line found is a hit,
  a definition when one of `symbols.ts`'s patterns matches it (`function N`, `class N`, `def N`, `fn N`, `type N`,
  `const N`, Go's `func (r T) N(`, a method's `N(…) {`, a top-level `N = …`, a field with a modifier, C's `int N(` in
  C-like files) and it isn't an import or a comment. Definitions first, the file it was looked up from first in each;
  at most 1,000 hits (`truncated`), a line's text cut to 400 characters around the name.
- **Decided.** GitHub's precise navigation needs an index built per language (stack graphs); its search-based
  navigation is what this is: no index, no grammar per language, nothing to keep up to date as the agent edits. The cost
  is that it knows no scopes or types (a local `const x` defines every `x`; a string that reads like a definition is
  one). Tree-sitter (`web-tree-sitter` with each language's grammar and tags query) would tell definitions from uses
  exactly and could replace the patterns without changing the wire; it was left out for the megabytes of grammars and
  the queries to keep per language.
- **The read-only server** runs `git grep` (a reading form in `platform/ReadOnly.ts`), but never with `-O` or
  `--open-files-in-pager`, which would run a program.
- **Tests.** `git/FilesTab.test.ts` (the list with untracked, ignored and deleted files; reads, binary, too large, not
  UTF-8, a link in and one out, `.git`, a folder; a symbol's hits and order with an untracked file; a folder inside a
  bigger repository; a folder that isn't one), `packages/shared/test/symbols.test.ts` (the patterns per language, the
  outline), `ReadOnly.test.ts` and `ReadOnlyMain.test.ts` (the three methods answer on a rehearsal).

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
  HE-67: it goes through the host's SOCKS proxy (below, Browser) when it has one and the page isn't on this machine
  (`platform/socks.ts`: `proxiedTo`, `socksClient`, an undici `Socks5ProxyAgent` under `NodeHttpClient.makeUndici`).
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
- **Web (step 1).** `components/task/Review.tsx` (the card's badge, the Review tab's dot, the Review and Summary tabs (HE-55: the summary is now `SummaryBar`, folded at the bottom of the thread over the composer, and a task whose review passed opens on its thread),
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
  stacks. **Recovery**: `Restack.resume`, then `GhStacks.linkAll` once the server listens (`Listening.up`, HE-71), in
  the background: it reads the projects with an open, unlinked pull request (`TaskRepo.unstackedPrProjects`) and each
  of their tasks once. **Launch**: `LaunchFacts.prepareWork`
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

#### As built in 6.6 (HE-7): `WorkflowEngine`, `Workflows`, the workflow tools

- **Files.** `workflows/graph.ts` (pure: the model's questions — ports, wires, `agentWorks`, `afterDone`, `afterMerge`,
  `opensPr`, `upstream` — and a run as a value: `plan`, `settle`, `reachable`, `endNodes`, the reasons a run leaves a
  task where it is, `pickPath`, `keptPath`, `changedSince`, and the values: `render`, `inputValue`, `outputValue`,
  `columnText` over a `ValueSource` with the earlier runs read beside it), `workflows/check.ts` (`checkGraph`,
  `checkName`, `cycle`, `dataCycle`), `workflows/read.ts` (a graph an agent gives, read leniently: defaults, null as not
  given, the old `trigger on status|finished` and `set_status` as column nodes), `workflows/reviewSettings.ts`
  (`reviewSettingsGraph`, `hasReviewStep`), `WorkflowStore` (the two tables and `thread_tools.disabled_mcp_servers`),
  `Workflows` (CRUD, a column with the agent's work in one workflow that's on, `moveReviewSettings`), `WorkflowEngine`
  with its parts in `workflows/engine/` (`start.ts`: start, `onStatus`, `onFinished`, `onMergeFinished`, `resume`;
  `advance.ts`: the loop and the board's own steps — condition, A/B test, send, an edge into a column, `open_pr`;
  `agentStep.ts`: the step's thread, `submit`, `stepEnded`; `stop.ts`: `stopRun`, `release`, `unheld`, `mergeLeft`;
  `facts.ts`: what `WorkflowFacts` reads), `WorkflowApprovals` (the tools' asking), `mcp/tools/workflows.ts`, and
  `rpc/workflows.ts` (`workflows.*`, contract `packages/contracts/src/rpc/workflows.ts`, types in `workflow.ts`).
- **Locks.** `KeyedLock` gains `["workflows", task]` (one start per task at a time: the old global `STARTING`) and
  `["workflowRun", run]` (a run's row read and rewritten by one at a time, `withRun`); neither is held across a step's
  work (a push, an agent's start), as the old engine didn't hold `STARTING` while advancing.
- **No echo guards.** A move a step makes is `Tasks.update` with the new `Actor` `Workflow { run, chain }`; the reactor's
  `TaskChanged` (status moved) calls `WorkflowEngine.onStatus`, which stops runs waiting at a column the task left and
  starts the new column's workflows in the engine's `FiberSet` (the reactor isn't held up by a push). `CHAIN` is the
  move's `chain` + 1 (still stopping at `MAX_CHAIN` = 10); `MOVING` is gone; `QUIET` is "a move a run that has ended
  made back into the column it started at doesn't start it again" (`release`'s move to In review carries its run).
- **Changes.** `WorkflowWorkDone { task, due, mergeFinished }` (from `RunEnds`, after the column is written: the column
  that held the task goes on, `onFinished`; or the merging agent said it's merged, `onMergeFinished`) and
  `WorkflowRunSettled { run, task, why }` (from the engine when a run ends or is stopped for good: `release`). A workflow
  step's thread's `ReviewFinished` goes to `stepEnded` (and `Reviews.finished` ignores it); `PromptStarted` also
  `supersede`s (runs but those waiting at a column); `ProjectChanged` (now also offered when `use_workflows` turns on)
  moves the Review tab's reviews into a workflow. Recovery calls `resume` after the reviews' reconcile.
- **`WorkflowFacts`** (`agents/WorkflowFacts.ts`, a seam the engine registers, as `MergeFacts`): `startInstructions`
  and `boardOpensPr` for `Prompts`, `finishDue`, `mergeFinish` and `withDueFinish` for `RunEnds` (its new facts:
  `finishDue`, and `mergesToDone` read for real), `mergeInstructions` and `mergeFinish` for the merge request
  (`MergeRequestInput.workflow`). `decideFinish` gains the old `finish_due` rows: held for the column (`workDone`), or
  "The agent ended its turn without saying its work in … is done (with finish_work)"; a plan waiting for the user and an
  unfinished todo list come first.
- **Decided.** The task's Stop is `WorkflowEngine.stopTask` (it calls `Reviews.stopTask`, then stops the workflow runs,
  "Workflow stopped"); `tasks.stop`'s handler calls it. A run by hand refused says `Conflict` (`changed_meanwhile`, the
  old 409 text as detail) or `Invalid` (a task of another project). A column clash is `Conflict` `in_use`. Agent-step
  threads are made with `ReviewRepo.insertThread` (`task_type` `workflow`). Workflow events say "read again":
  `workflows_changed { project_id, workflow_id }` and `workflow_runs_changed { task_id }` (the client's `workflowsAtom`
  and `workflowRunsAtom` read them again, as turns are). The board tools' `graph` parameter keeps the old JSON Schema
  (its enums refuse the old kinds an agent could still name there; stored rows are converted by the importer).
- **Not here.** The one-time startup move of every `use_workflows` project's reviews (`workflows_reviews_moved`:
  [14-dropped-and-open.md](14-dropped-and-open.md)); telemetry of runs (6.9).

### Automations — [inventory 06](inventory/06-integrations.md) (2.3)

`Scheduler` (a five-second tick that claims a due run in one conditional transaction before doing anything; no
backfill), `Webhooks` (the check order: token, rate limit, signature, enabled, ping, filters, dedupe, coalesce;
answered 202 before the action runs), `Routines`, `Automations`. Cron and time-zone arithmetic use `Cron` and
`DateTime` from `effect` in place of the hand-rolled versions, with the old DST cases as tests.

#### As built in 6.5 (HE-7)

- **Files** (`automations/`): `schedule.ts` (pure: the host's zone, `Cron` with the old five fields, `@daily`-style
  aliases and Sunday as 7; a daily time is a `Cron` too; `align`, active hours, `at`), `model.ts` (the checks, with the
  old texts as `Invalid`'s reasons), `delivery.ts` (templates, filters, untrusted-data wrapping), `stored.ts` (rows read
  leniently: left-out fields take their defaults, a label as `task_type` is a label), `AutomationRepo.ts`,
  `Automations.ts` (CRUD, what the board shows, Run now, runs; `act.ts` the guards and the action, `receive.ts` a
  delivery's checks, dedupe and coalescing in one transaction), `Scheduler.ts` (`startDue`/`tick`, `markInterrupted`,
  `prune`; `Scheduler.loop` is `Main`'s `AutomationLoops`, outside `areasLayer` so tests tick it), `Webhooks.ts` (token,
  rate, then `receive`; the answers' statuses), `Routines.ts`, `RoutineHost.ts`, `precheck.ts`,
  `AutomationApprovals.ts` (the board tools' asking). The route is `http/webhooks.ts` (`POST /api/hooks/:id/:token`, 1 MiB,
  413 past it); the tools `mcp/tools/automations.ts`; the RPCs `automations.*` (one `list` for a project's or a
  profile's, by `project_id` or `profile_id`). Event `automations_changed {project_id, profile_id, automation_id}`.
- **Time.** The zone is `DateTime.CurrentTimeZone` if the layer has one (tests: Pacific/Auckland, whose rules the old
  tests made by hand), else `DateTime.zoneMakeLocal()`. `Cron.next` alone runs a time in a DST gap as long after the gap
  as it was into it (3:30 for a 2:30 that doesn't exist); `cronNext` moves it to the gap's end (3:00), as before. A
  repeated time runs at its first, once (`Cron`'s default). The rate limit and every timestamp are on `Clock`.
- **Decided.** Costs: the run that takes an automation's message in is charged with it as it's registered or steered
  (`RunRepo.chargeAutomationRuns`, from `Runs.register` and `RunInput.steered`); the reactor's `RunExited` step calls
  `Routines.runEnded` after `RunEnds.ended` (the cost split, and a routine thread's report). A report is a notice with
  code `routine_report` and the old report as its metadata (`Threads.report`); read is `metadata.read`
  (`Threads.updateItem`). The old `STARTING` and `IN_FLIGHT` sets are `Ref`s; a claim taken before a database error is
  given up (the old test). A routine thread is a `TaskRepo.insert` of family `assistant` (it isn't on the board: no
  `Changes` offer). The routine whose assistant runs elsewhere is refused `Conflict` (`in_use`) on create, and fails
  its runs, with the old text (the link's name is its id until M7). The approval input has every key the contract's
  `AutomationChange` has (null where the old one left a key out).
- **What 6.7 adds.** The assistant area sits below automations, so routines reach it through `RoutineHost`: 6.7 calls
  `RoutineHost.register({ assistant, workspace, google })` when its layer is built (`assistant`: get or create the
  profile's assistant; `workspace`: its checked workspace, no symlinks; `google`: the `{{google}}` line). Until then the
  profile's existing assistant row is used and none is made. 6.7 also prefaces the assistant's prompt with
  `Routines.unreadReports(assistant)` and calls `Routines.markRead` once its agent has started with them (the old
  launch's `unread_reports`/`mark_read`), and ports `task/Routines.tsx` (the editor and row take the owner as props).
- **Added since (HE-24).** A daily trigger's `time` may be several times, `11:00, 16:30` (`parseDailyTimes`; checked
  as each time, sorted, each once, at most `MAX_DAILY_TIMES`; `nextAfter` takes the soonest). It stays one string on
  the wire, so a reader that knows only one time still decodes it. A routine's precheck gets
  `HUNTAWAY_MINUTES_SINCE_USER_MESSAGE` (`precheck.ts`'s `SINCE_USER_MESSAGE_ENV`; `act.ts` from
  `Routines.userLastWrote`, the assistant's latest user message that isn't `auto`, `from_agent` or `routine`), unset
  when there's none. Templates that name them get `{{last_run}}` and `{{quiet_runs}}` (`act.ts`'s `history`, from the
  latest 50 runs: those with status `ok`; a run whose agent hasn't ended is passed over, any outcome but `quiet` ends
  the streak).
- **Not here.** Telemetry's `automation_run` event (6.9); deleting the assistant's routine threads with it and refusing a
  thread under an assistant being deleted (the assistant is never deleted here; 6.7, with its profile); the read-only
  server's not mounting the route (`ReadOnlyMain` doesn't exist yet).

### Documents and docs — [inventory 02](inventory/02-agent-support.md) (2.7–2.8)

`TaskDocuments` (a plan, artifact or diagram a task's agent writes, a version per turn, answers sent back),
published documents, which are the docs plugin's since HE-42 ([15-plugins.md](15-plugins.md#the-docs-plugin-he-42)).
They were `Docs`, `DocImages` and `HostedDocs` until then.

As built in 6.2 (HE-7), `docs/TaskDocuments.ts` (+ `TaskDocumentRepo.ts`, the `documents` table of the initial schema):

- **Following the runs**: `runs/TurnHooks` (new, in the runs area, `register(hook)`, `toolDone(task)`, `turnEnded(task)`),
  as the areas below `runs/` register with `AgentRequests`: the Claude line handler calls `toolDone` after a `user` line
  with a `tool_result` and `turnEnded` after a turn's `result`, the Codex one on `ToolDone` and `TurnEnded`, both after
  the line's commit; `RunEnds.ended` calls `turnEnded` first of all (what a stopped or failed run wrote is kept before
  the plan rule reads `documents` in `Checkpoints.planOnly`). `TaskDocuments.registered` registers `follow` and
  `turnEnded`.
- **Keeping** (`keepOne`, the old `keep_one`): the file's size and modification time (ms) as a stamp in a `Ref` (lost on
  a restart, as `SEEN` was), a read outside the transaction, then one transaction that reads the latest version and
  updates the open one or inserts the next; the end of a turn closes every open version of the task (a label taken off
  mid-turn included); a change writes `document_at` and emits the task. Over 5 MiB isn't kept, and the turn's end says
  so as a `warning` notice in the thread. One keep at a time (a semaphore), as the old synchronous ones were.
  `keepFile(task, label, file, { endOfTurn, daily })` is the same for a file that isn't a label's: the assistant's brief
  (6.7) with `daily` (one version a day in the host's time zone, `DateTime.zoneMakeLocal`).
- **`tasks.document`** (`TaskDocumentRpcs`, a group of its own in `packages/contracts/src/rpc/taskDocuments.ts`, scope
  `read`): `{ id, label?, version? }` → `TaskDocument { label, file, versions, version, content }`; `NotFound` for the
  task, or a version (`what: "version"`). Its label is a `DocumentLabel`: the brief's (`brief`, with its `items`) is
  6.7's to add.
- **Deleting**: a `task_deleted` event removes the task's folder; a `project_deleted` one sweeps `documents/` of the
  folders whose task is gone (a project's deletion emits no event per task).
- **Demo**: the old demo's diagram, plan and artifact tasks, each with its file written and its turn ended.
- **Already there before 6.2**: the prompts (`agents/Prompts`, `prompts/labels.ts`…), `/plan` (`runs/Runs`), writing the
  own folder without asking (`Permissions`; the old case is now in `Permissions.test.ts`), the labels' checks
  (`tasks/decide.ts`). Plan answers are the user's message (`tasks.send`), as before: nothing on the server.
- **Tests**: `docs/TaskDocuments.test.ts` (the old `documents.test.ts` cases for versions, labels and the turn's end; the
  5 MiB notice; `tasks.document`; the daily document; removal and the sweep), the Codex edit's case in
  `runs/codex/output.test.ts`, a tool result's in `runs/claude/output.test.ts`, the demo's in `lifecycle/Demo.test.ts`.

As built in 6.3 (HE-7), published documents. **Replaced in HE-42**: published documents are the docs plugin's now ([15-plugins.md](15-plugins.md#the-docs-plugin-he-42)); what follows is what the board had built in until then, and is gone.

- **Services** (`docs/`): `DocRepo` (docs, versions, pages, labels, images, comments) and `DocsSiteRepo` (the docs
  site's clients, connections and publish records; tokens read as `Redacted`); `DocsRender`, the hosted app's renderer
  (`@dire-kiwi/docs-render` 0.2.0, WebAssembly) loaded once on first use; `DocImages` (`take`: the `images` argument and
  the pages' inline `data:` images, `convert`: `sharp` to AVIF one at a time, `sha256` on `effect/crypto`'s `Digest`,
  which `platformLayer` now provides); `Docs` (the board's reads and changes, the comments and sending them, and each
  docs tool's answer; a publish's body is `docs/publish.ts`); `HostedDocs` (the device flow, pasted tokens, renewals,
  publishing). Rules that read no state are `docRules.ts` (slugs, labels and their spelling, the label tree, folder
  renames, the comments' message) and `imageRules.ts` (names, signatures, inline images, code spans, `<img>` refs), each
  the old function's cases as tests. `--demo`'s "Rollout plan" is `Docs.seedDemo` (`docs/demo.ts`), called from
  `lifecycle/Demo.ts`.
- **The wire**: `docs.*` (05-protocol.md's list; payloads by `profile_id` and `slug`, a version by its number, null the
  latest). Scopes: reads `read`; moving, relabelling, deleting, renaming folders, publishing and the docs site
  `settings`; comments and sending them `operate` (they send a message to an agent, as `tasks.send` does). Events `docs
  {profile_id, slug, deleted?}`, `doc_comments {profile_id, slug}`, `docs_site {profile_id}`; `@huntaway/client` keeps
  the latest of each per profile (`HostBoard.docs`, `docsSeqAtom`), which the Docs page reads again on. A rendered
  page's `<img>` keeps the old route's address (`/api/profiles/<id>/doc_images/<sha>`) as a marker the page swaps for
  `docs.image`'s data, as there is no such HTTP route. New `ConflictReason`s: `not_connected`, `no_task`,
  `nothing_to_send`; `KeyedLock` has `["docs", …]` (a profile's renewal, a document's publishes).
- **Decided**: errors are the contract's (`Invalid` was 400, `External` 502, `Conflict` 409), with the old messages as
  their text. A docs site under test is the fake of `packages/testing` (`fakeDocsSite`, an HTTP server in the process);
  its tests run on the live clock with the intervals shortened (`DocsSiteTiming`, a reference), as they talk to a socket.
  Sending comments goes through `Runs.send` as the board (`source: "board"`): on a host that runs no agents it is
  refused (`Unavailable`), where the old server kept the message.
- **Not here**: a project's own `docs` server or one turned off (6.4: the prompt's docs note is given whenever the board
  serves it); the old 10-minute memory of docs answers (calls are in `mcp_calls`, 3.1).

### Assistant — [inventory 02](inventory/02-agent-support.md) (2.12)

`Assistant` (one thread per profile, optionally on a host of its own), `Memory` (the workspace under git with the
git folder outside it, no symlinks, a lock per workspace), `Tracked`, `Brief`. Google stays a set-up helper around
an MCP server.

#### As built in 6.7 (HE-7)

- **Files** (`assistant/`): `Assistant.ts` (get or make the profile's assistant in one transaction that looks first;
  `send` settles open questions; `open` = refused elsewhere, checked, seeded, with history; the memory API's methods;
  `whoseWorkspace`), `Memory.ts` (`checked`, `ensure`, `forRun`, `turnEnded` in a `FiberSet` with `idle` for tests, the
  API's reads and writes) over `memory/workspace.ts` (git with the old environment and `-c` options, gitlinks dropped,
  `O_NOFOLLOW` opens, the list) and `memory/text.ts` (seeds, `cap`, paths, days on `DateTime`, git's output, the import
  message), `Brief.ts` (`add`, `feedback`, `document`, `keep`) over `briefText.ts`, `Google.ts` (`status`, `setup`,
  `line`, the refresh-token check over `HttpClient`) over `googleText.ts`, `Tracked.ts` (`remove`; the list's rules were
  `tracked.ts`, now `trackedList.ts`), `AssistantHooks.ts` (what it registers). `cli/googleAuth.ts` is `huntaway
  google-auth`: Node's HTTP server on the loopback is given by `bin.ts`, which also provides `FetchHttpClient`,
  `SecureRandom` and `Digest`.
- **Reaching up.** `runs/AssistantLaunch` (new, as `TurnHooks`): `workspace(task)` gives the assistant's and its routine
  threads' cwd (refused, `WorkspaceRefused`, when it isn't its own) and memory, which `LaunchFacts` passes to
  `Prompts.system` (`RunTold.memory`, last) for both agents and to a task's terminal (`workEnv`). HE-25: Claude Code
  (`--system-prompt-snapshot`, on by default) and Codex keep the instructions a conversation started with, so
  `workspace(task, { compact })` also gives `update`, put first in a later prompt run's text: what changed since the
  thread's conversation was last told (`Memory.forRun`'s record per thread: session, time, day, the four files as
  shown; in memory, set by `told` once the agent has started, with `Prepared.started`): lines added at a log's end
  (`memoryChanges`), else the files as they are now; all four (`memoryUpdate(facts, null)`) when there's no record (a
  restart), the session or day differs, a rewind is pending, or `ContextStatsRepo.lastCompaction` is later than the
  record. A compaction run is told nothing. `reports(task)` is the
  routines' unread reports in front of a prompt run's text, marked read by `Prepared.started` once the agent is spawned
  (`Runs.launch`). `TurnHooks.turnEnded(task, end?)` gained `end` (`{ compact }`, from the line handlers; none from a
  run's end): a turn of the assistant or a routine thread keeps the brief (also after each tool call) and commits the
  workspace; the assistant's own non-compaction turn emits `assistant_reply`. `RoutineHost.register` gets the assistant
  (made if need be), its checked workspace and `Google.line`. `Routines.finished` emits `routine_report` after posting.
  `Permissions` lets the assistant and its routine threads write its workspace without asking.
- **The wire.** The `assistant` group (`contracts/rpc/assistant.ts`): `get`, `send`, `memory`, `memoryFile`,
  `writeMemoryFile`, `memoryHistory`, `memoryDiff`, `restoreMemory`, `importMemory`, `google`, `setupGoogle`,
  `addBrief`, `addCheckIn` (HE-24, below), `briefFeedback`, and `tasks.removeTracked`; types in `contracts/assistant.ts`. `tasks.document` takes
  `TaskDocumentLabel` (`brief` too) and gives the brief's `items`. Errors: `NotFound`, `Invalid`, `Conflict` (`in_use`
  for an assistant elsewhere, `changed_meanwhile` for a stale save), `Unavailable` (a workspace that isn't its own, git
  failing, an assistant host before M7).
- **Decided.** A new assistant's `work_dir` is `assistants/<id>` (relative, as before); `checked` takes that or the
  importer's absolute form. Its config is the profile's `assistant_config_id` if it still has it, else its first.
  A routine thread's turn commits the workspace too (the old server waited for the assistant's next turn). The brief's
  document is refused (`NotFound`) for any task but the assistant.
- **Left out.** Moving a workspace's own `.git` (HA-160): dropped (14-dropped-and-open.md). The assistant on a host of
  its own came with HE-8 (below).
- **As built (HE-8): the assistant on a host of its own** (7.4; the old `on_its_host`). `assistant.get` and
  `assistant.send` are `hosts/AssistantHost.ts`'s: for a profile whose `assistant_host` is another host, the call goes
  over that link (`LinkConnections.live(...).client`) to the host's profile of the same name, with `here: true`, and
  answers with that host's task and `host_id` (`AssistantTask`); offline or on another protocol is `Unavailable`
  ("…'s assistant runs on homeserver, which is offline"), no profile of that name there `Conflict` (`no_profile`).
  `here` (the old `?local=1`) asks for this host's own whatever the profile says, which `Assistant.get(profile, true)`
  makes; without it, `Assistant.get` and `send` stay `Unavailable` for a profile whose assistant is elsewhere and that
  has none here, and memory, Google and the brief `Conflict`, as before. The board asks the host `assistantHome` found
  with `here: true` (HA-120: a host whose own profile names the hub doesn't send it back). Routines on this host for
  such a profile fail with the link's name (`RoutineHost.elsewhere`), and the assistant's Routines tab lists them
  (`RoutinesLeftBehind`) with a Delete for this host. Tests: `Assistant.test.ts` (`here`), `Routines.test.ts` (the
  link's name), `tests/e2e/hosts-assistant.test.ts` (two linked servers: no profile, sent there and not back, a message
  answered there, `here`, offline), and the browser check `assistantHost.test.mjs`.
- **Tests**: `assistant/Memory.test.ts` (real git in temp folders), `memory/text.test.ts`, `Assistant.test.ts`,
  `Brief.test.ts`, `briefText.test.ts`, `Google.test.ts` (a token endpoint of the test's own), `googleText.test.ts`,
  `cli/googleAuth.test.ts` (the flow with the test as the browser), the workspace's case in `Permissions.test.ts`.

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
  prompt as a baseline (nothing about them notifies; of a task only what `taskEvent` reads, `TaskRepo.states`, and the
  whole task is read when a notification needs it), and handles each event in order; after `resync`, again from a
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
  `hub.hosts.openRelay`; the client's side came with HE-74). The pty is still the Python helper (`terminal/Pty.ts`);
  `ia-pty` was not needed. Its command starts only once the helper has set the first size (HE-74: the child set it
  after the fork, and could undo a resize the helper had already taken).

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

As built in 8.1 and 8.2 (`apps/server/src/update/`):

- **`Supervisor`** is the launcher as the server sees it: its pid, `started` (the marker the launcher's crash restarts
  wait for, written after `HUNTAWAY_READY`), `exec` (the restart file, written to a temp file and renamed, then exit 75
  at once, as the old server did: no graceful close, the database is safe in WAL), and a 1 s watch that stops the
  server when the launcher has gone. `ServerConfig` takes `HUNTAWAY_RESTART_FILE`/`HUNTAWAY_SUPERVISOR_PID` out of
  `process.env` as it reads them (it is the one place the environment is read), so step 1's "take" happens there.
  `Supervisor.layerTest` records an exec and fails as an unsupervised server's does. There are no one-shot serve flags
  any more (`--recopy-db` went with the two-file database); `restartArgs` keeps the rule for the next one.
- **`Restarts`** (not in the plan's list): the one restart job (`Conflict` `restart_in_progress` for a second), its
  phase and log tail, the `restart` and `restart_log` events, and `restartInto` (phase `restarting`, 300 ms for the
  last events, exec). `Updater`, `Releases` and `Service` all run their jobs through it. Once it has exec'd, the new
  process says nothing to the board until it listens; under the desktop app, its `HUNTAWAY_PROGRESS` lines (startup
  step 2) reach the launcher's stdout, which the app reads and passes on to the board's restart dialog (09-frontend.md,
  The desktop shell, HE-44).
- **`Updater`**: `status` (`admin.status`), `restart` (rebuild: `pnpm install --frozen-lockfile --filter
  huntaway-server... --filter huntaway-web...`, the web build, `cargo build --release -p ia-shim` unless there's no
  cargo and a prebuilt `apps/server/bin/ia-shim`; output streamed into the log; a failed step ends the job and the
  server carries on), `update` (a hub's push: refusals are `Unavailable`, a bad payload `Invalid`), `bodyFor(hostCommit)`
  (what a hub sends a linked host: an incremental bundle `^<host commit>` from a checkout, else its commit, and always
  its version; for `hub.hosts.pushUpdate`), and the `--update-from` check every 5 minutes.
- **`Releases`**, with its rules as pure functions in `update/releases/` (`semver`, `installed` for `app/state.json`,
  `github` for picking and the desktop shell, `tarball` for the safety rules). `execInstalled` is a layer that
  `Main.ts`'s platform builds between `DataDir` and `Identity` (with `Supervisor` under it); `settle` runs in `serve`
  once the server listens and the hubs and discovery have started, before the ready line (step 6; it was the last step of
  `Recovery`, until review of HE-6: a release that failed binding or after would have been current already). "A backup, or room for one" before an Update or Roll back is a room check only (the backups folder can be
  made, and `df` says the database fits), since every release backs the database up itself before it migrates;
  `--skip-db-backup` goes on without it. A changed "Include prereleases" checks again by watching `settings_changed`
  (`HostSettings` is above the update area). Digests are taken with `effect/crypto`'s `Digest` over the downloaded file.
- **`Service`** and **`Systemd`**: everything outside the process (systemctl, loginctl, booted, the cgroup, lingering,
  the detached hand-over) is `Systemd`, which tests replace. The unit is `huntaway-<port>.service` on every port (the
  old server named its default port's `huntaway.service`; this one never writes that name, so it cannot replace the old
  server's unit on a machine that runs both). A server on `--port 0` has no service status and can't install one.
  `huntaway install-service [serve flags…]` (`cli/installService.ts`) needs `--port N` and the launcher.
- **A release package** carries `build.json` (`{ version, commit }`) beside its launcher: `ServerConfig` reads it for
  the version, the commit (never the deployment's `HUNTAWAY_COMMIT`) and the default UI folder (`<release>/ui`), and
  `--version` prints its version. `About` reports `updates_from` (`checkout` when there's a source checkout, else
  `releases` with `--release-updates`) and a checkout's HEAD at startup as `commit`. The launcher runs a release's own
  `node/bin/node` before `HUNTAWAY_NODE`.
- `admin.update` takes at most the server's request body limit (16 MiB, `http/routes.ts`), not the old 256 MB: bundles
  are incremental since HA-185.
- Tests: the old cases in `update/*.test.ts` (a fake GitHub as an `HttpClient` layer, real `tar` and git in temp
  folders), the launcher's in `tests/e2e/launcher.test.ts`, and `tests/e2e/releases.test.ts`, which stages a release of
  this checkout from a fake GitHub on a free port, updates onto it through the launcher, refuses one that fails its
  smoke test, marks bad one that never comes up (started again, the server runs the good one), and rolls back to the
  server the host was installed as.

#### As built in 6.9 (HE-7): `Telemetry`, `Lag`, `Analytics`, `Disk`

- **Files.** `platform/Telemetry.ts` (the outbox, the exporter's loop, the config and status, the agents' variables, the
  logs tee's logger and its queue, the minute's metrics), `platform/TelemetryRepo.ts` (its settings, the password as a
  `Redacted`, the outbox, a task's and a profile's columns), `platform/telemetry/{clickhouse,schema,otlp,backfill}.ts`
  (the HTTP client over `HttpClient`, the old schema unchanged, the OTLP mapping and the runs' variables, backfill's
  rows), `platform/Lag.ts`, `http/otlp.ts` (`POST /api/otlp/<run>/v1/<signal>`, the run's secret from
  `Identity.isRunSecret`), `analytics/{Analytics,Disk,AnalyticsRepo}.ts`, `cli/telemetry.ts` (`init`, `test`,
  `backfill`), `rpc/{telemetry,analytics}.ts`; contracts `rpc/telemetry.ts` (`admin.telemetry`, `updateTelemetry`,
  `testTelemetry`, `eventLoop`, all `admin`) and `rpc/analytics.ts` (`report`, `contextStats`, `tokenStats`,
  `diskUsage`, `read`); `@huntaway/testing`'s `fakeClickHouse`. `--telemetry-url` (`HUNTAWAY_TELEMETRY_URL`) and
  `HUNTAWAY_LAG_LOG_MS` are in `ServerConfig`, with the server environment's own OTEL variables and `CLAUDE_CONFIG_DIR`/
  `CODEX_HOME`; the CLI reads `HUNTAWAY_TELEMETRY_PASSWORD` (the old `IA_TELEMETRY_PASSWORD`).
- **Layers.** `Telemetry`, `Lag` and the logs tee (`Telemetry.logs`, a logger beside the stderr one) are in
  `platformLayer`, so every area can send; nothing sends unless the host has a ClickHouse. The exporter's loop (flush
  every 10 s, or at once at 1000 rows, backing off on failures), the minute's metrics and `server_start`
  (`Telemetry.exporter`), and the 20 ms ticker (`Lag.ticker`) are `PlatformLoops` in `AreasLive`, not in tests, which
  flush and sample themselves. The logger can't run an effect, so it queues lines (at the host's level, never the
  `telemetry` module's) and the loop puts them in the outbox, at most 100 a second.
- **Events sent** (each where its fact is recorded): `task_status` (the reactor, on a status move), `run_start`
  (`Runs`, once the shim started the agent; `LaunchFacts` says its runtime, model, effort and mode), `run_usage` and
  `run_end` (`Tokens`, once a run is counted), `side_call` (`SideCalls`; a window restart with the first profile that
  sends and has the config), `permission` (`ApprovalRules`: decided at once, or when a prompt is settled, with its
  wait), `review` (`ReviewStats`), `merge` requested (`Merges`) and merged (`MergedWatcher`), `board_tool`
  (`ToolCalls`, only for a call that began once the host sent), `telemetry_dropped`, `server_start`. Not here:
  `automation_run` (6.5: `Telemetry.profileEvent`), `link_up`/`link_down` (M7), `server_update` (M8), and `error`
  (the old crash handler's: this server has none; its error lines go to `logs`). A board tool call resumed after a
  restart is judged by when this delivery recorded it, not when it first began.
- **Decided.** Telemetry is in the platform, so its row columns (a task's key and title, a profile's flags) are read
  with SQL of its own over the areas' tables. The password stays in `settings.telemetry_password` (stored as typed),
  read only by `TelemetryRepo`, as `04-database.md` says for secrets; there is no `Secrets` service yet. `PATCH`'s
  checks are `Invalid { field, reason }`. The gzip of a batch and the gunzip of an agent's body are the web streams
  (`CompressionStream`), as Node's modules are the entry points'. `Lag` measures the ticker's lateness with
  `Clock.currentTimeNanos` into a histogram of its own (no `monitorEventLoopDelay`); the routes' times on the thread and
  a stall's "busy" label are gone (requests are fibers that interleave), and so is `route_ms`; the stall log line and
  `GET /api/debug/event-loop` (now `admin.eventLoop`) remain. `Disk` walks folders with the asynchronous `FileSystem`
  (`lstat`, blocks, hard links once), not in a worker; the disk's size and free space come from `df -Pk`. Analytics'
  reads run on the board's connection (no worker either: `04-database.md`'s "slow reads go to a worker" is not built).
  A finished run's folder is reported kept 14 days (`Disk.RUNS_KEPT_DAYS`), the old constant. The CLI does not ask for
  a password on a terminal.

### Spaces<a id="spaces"></a> (HE-35)

Linux desktops in Docker, after [Cua Spaces](https://cua.ai/docs/spaces), built on Cua's own daemon rather than a
streamer of ours: each Space is a container of Cua's Linux image (`ghcr.io/trycua/linux:24.04`: Ubuntu, XFCE, Cua
Driver and **spacesd**, which streams the screen as H.264 and takes input through Cua Driver) with Claude Code and Codex
added. **Decided** (with the user, HE-35): the board sees a Space through spacesd's `/media` WebSocket, relayed by the
host's Node server; spacesd's QUIC media (UDP 3212, ALPN `rcdp/2`) is for native clients, and neither a browser nor
Electron's Node can speak it. A Rust or worker-thread relay waits for a measurement that calls for it.

- **`spaces/`** (below `desktop/`): `Docker` (the CLI through `Proc`: `HUNTAWAY_DOCKER`, else `docker`; tests replace
  the service, or give `fakeDocker`'s CLI), `Spaces` (status, create, start, stop, remove, `syncAgents`, `view`,
  `settled`, `relayTarget`; HE-37's `setAgentTools`, `toolsEnabled`, `toolsAvailable`, `find`, `bash`, `driver`),
  `SpacesTools` (the `spaces` MCP server, below), HE-48's `SignIns` and `SignInRepo` (below). Pure
  parts: `containers.ts` (`docker run`'s arguments, labels, `docker inspect` read back, the image's Dockerfile and tag),
  `spacesd.ts` (`CreateViewerTicket` over gRPC-Web, hand-written protobuf; the relay's header rules), `agentFiles.ts`.
- **No table**: a Space is a container named `huntaway-space-<id>` and labelled with the host's id, its name, its
  configs and when it was made. What isn't a container yet (pulling, building, starting, copying sign-ins) or failed is
  a `Ref` in `Spaces`, with the work in a `FiberMap` by id, so a server restart forgets a Space being made (its container,
  if there is one, stays and shows as Docker has it).
- **The image**: Huntaway builds `huntaway-space:<revision>-<base>` on `HUNTAWAY_SPACES_IMAGE` (default Cua's) the
  first time a Space needs it: `npm install -g @anthropic-ai/claude-code @openai/codex`, linked into `/usr/local/bin`.
- **spacesd's token** is a random 24 bytes given to the container as `CUA_ENV_TOKEN` and read back from `docker
  inspect`; only the server uses it. Its port is published on `127.0.0.1` unless the Space was made with a direct link.
- **Sign-ins** (`agentFiles.ts`): a Claude Code config gives `.credentials.json` **without `refreshToken`**,
  `settings.json` without `hooks`, `statusLine` and `apiKeyHelper` (they name the host's programs) and with its proxy in
  `env` (a loopback proxy becomes `host.docker.internal`), and `CLAUDE.md`; a Codex config gives `auth.json` with
  `refresh_token` emptied and `config.toml`. Refresh tokens rotate when used, so a Space that refreshed would sign the
  host out. Copied at create, at start, and by `syncAgents`; written as the desktop user (`cua`) through `docker exec`.
- **Viewing**: `view` asks spacesd for a viewer ticket (an hour; `ALLOW_ACTIVATION` with clipboard and `~` for files, or
  `VIEW_ONLY`) and makes a relay ticket (an hour, many requests: the viewer makes many) for `/api/spaces/v/<ticket>/`
  (`http/spaces.ts`), which passes the rest of the path to spacesd: its page, its gRPC-Web calls and its media
  WebSocket, piped by `hosts/pipe.ts` with each side's pace passed on and no compression. spacesd's viewer ticket travels
  in the URL's fragment and never reaches a server.
- **Every relayed answer is sandboxed** (`spacesd.ts`'s `responseHeaders`, found on review): whatever answers on the
  Space's port is the Space's to choose (its user has passwordless sudo, so anything in it can replace spacesd), and it
  is served from the board's origin, where the board's token is in `localStorage`. So the relay splits the Space's CSP
  (every header of it) into its comma-separated policies, takes `sandbox` and `frame-ancestors` out of each, and adds
  its own policy last: `frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-popups allow-downloads
  allow-pointer-lock` (no `allow-same-origin`). A `sandbox` added to the Space's last policy instead would lose to one
  the Space put there first. It also drops `Set-Cookie`, `Service-Worker-Allowed` and `Clear-Site-Data`. The page then
  has an opaque origin however it is opened (the board's frame, which is sandboxed too, or a window of its own), and
  spacesd's viewer works there: it keeps its ticket in the fragment and reaches the relay by relative URLs.
- **Nothing from a Space is followed or trusted** (also from review): the relay asks with `redirect: "manual"`, so a
  redirect goes back to the browser (a path kept under the relay) and can't make the host fetch its own loopback; the
  health check and `CreateViewerTicket` refuse redirects (`redirect: "error"`); and `parseViewerTicket` reads frame
  lengths unsigned and stops at one longer than the answer, where a negative length had looped forever on the event
  loop.

#### Agent tools for Spaces (HE-37)

Runs get a `spaces` MCP server beside `desktop`, after Cua Spaces' own tools
([use from an agent](https://cua.ai/docs/spaces/guides/use-from-an-agent)). A server of its own, not more tools on
`huntaway`, so runs without it don't pay for its tool list.

- **Gated** like `desktop`: `McpServers.serveWhen("spaces", Spaces.toolsAvailable)`, asked at each launch: the host
  page's switch (`spaces_tools`, off by default; `spaces.setAgentTools`, `SpacesStatus.agent_tools`) and Docker
  answering `docker version` (not asked while it's off). Turned off since a run started, every call refuses.
  `served.spaces` flows through `control.ts`, both launches (Claude's `mcp.json` with a one-hour `timeout`, Codex's
  `tool_timeout_sec` 3600: the first Space builds its image) and `mcp-run.json`'s `spaces`, which `http.ts` checks; it
  is written only when true, so a run without it writes the file as the old server did. The run's prompt gets
  `prompts/spacesNote.ts` (as `desktopHost` is told, `spacesHost` in `PromptContext`).
- **Tools** (`spaces/tools.ts`, handlers in `spaces/SpacesTools.ts`, registered from `Main.ts` as `DesktopTools` is):
  `list_spaces`; `create_space {name, reuse?}` (reuse, the default, takes a Space of that name, started if it's stopped;
  either way it waits with `Spaces.settled`); `start_space`, `stop_space`, `delete_space`; `space_bash {space, command,
  timeout?}`; `space_list_tools {space, tool?}`; `space_call_tool {space, tool, args?}`; `space_view`. A Space is named
  by id or name (`Spaces.find`; a name several share is refused with their ids, and `create_space` reuses only on
  NotFound, so it doesn't make another of an ambiguous name). A Space found `failed` before it had a container (its
  pull, build or `docker run` failed: it is only in `Spaces`' pending map) is removed and made again rather than
  started (found on review). Agents make Spaces without sign-ins.
- **`space_bash`** (`Spaces.bash`): `docker exec --user cua` under `timeout --kill-after=5 <n>` (at most 600 s), so the
  command stops in the container and not only Docker's CLI; HOME is looked up (`docker exec` keeps the image's
  `/root`) and the command runs with `bash -l` in it. The agent gets the exit code and the last 30,000 characters of
  each stream.
- **The driver** (`Spaces.driver`, plain parts in `spaces/driverMcp.ts`): JSON-RPC to spacesd's `POST /mcp` with
  `authorization: Bearer <CUA_ENV_TOKEN>` (`tokenOf`, `portOf`), redirects refused, answered as JSON or an event stream.
  Checked on Cua's image (spacesd with cua-driver 0.49.1): it answers a request without a session, but the driver ties
  what it saw to the MCP session, so a pixel click after a screenshot in another request was refused ("No screenshot of
  window … in this session", found running an agent). So `Spaces` keeps an MCP session per Space and task (`initialize`,
  `notifications/initialized`, then `mcp-session-id` and `mcp-protocol-version` on each request: without the version it
  answers 400), in a `Ref`, opened again once when spacesd answers 404 or 400 for it (it restarted). Cua's named
  sessions (`session: "…"`) are refused on this transport. Its tool list is some 200 KB of schemas, so
  `space_list_tools` gives a line a tool (name, read-only, arguments, first sentence) and one tool's schema when asked.
  spacesd's own Spaces tools in that list (`create_space`, `space_bash`, `share_tcp_port`…, `HIDDEN_TOOLS`) are left
  out and refused. Results reach the agent as `desktop`'s do (`forAgent`: images as MCP image content).
- **Who may act**: reviewers and threads in plan mode (checked per call) only look: `list_spaces`,
  `space_list_tools`, `space_view` (a view-only ticket) and the driver's tools whose `readOnlyHint` is true. Claude
  runs get the three that look and `delete_space` in `--allowedTools`, reviewers the ones that change a Space in
  `--disallowedTools`; Codex's config approves the same and disables the same. The others ask as any tool does.
- **`delete_space` asks the user itself**, whatever the mode, with the generic tool card: `McpHooks.askRule` with no
  rule (`Permissions.askRule`'s `rule` is nullable for it; Don't ask denies it). A card of its own, as `delete_task`
  has, waits for a need.
- **Not journaled**: driver actions aren't put in `DesktopOpRepo` (its rows are the host desktop's, which its viewer
  shows); a Space has no one at it to share with, and `mcp_calls` keeps each call's arguments and answer.
- **Tests**: `SpacesTools.test.ts` runs the server through `ToolCalls` on `TestBoard` over `packages/testing`'s
  `fakeDocker` (bin/fake-docker, state in a folder) and `fakeSpacesd` (health, a viewer ticket, `/mcp`).

#### Sign-ins for Spaces (HE-48)

Passwords for websites in a Space, after Cua's Keyvault and `request_site_login`
([Keyvault](https://cua.ai/docs/spaces/guides/keyvault)), which ship with the Cua Spaces app and its host daemon, not
with the `cua` CLI or the Space's image. **Decided** (with the user, HE-48): the board keeps them and types them itself
through the Space's own Cua Driver; Cua's teleport (a browser's signed-in state moved into a Space) is HE-49.

- **Kept per profile** in `sign_ins` (migration `2026-11-16-sign-ins`: origin, the sign-in page the user gave
  (`login_url`, on that origin: where the board opens the site, since a site's root rarely has the form), username,
  password, label, when made, changed and last used; cascades with its profile). `SignInRepo` is the only reader of `password`, as a `Redacted`
  (04-database.md, secrets); the RPCs' `Password` is `Schema.RedactedFromValue(Schema.String)`, so a password is a
  `Redacted` from the decoded payload to the driver's `browser_type`, and no answer has it. Stored as typed, as the
  telemetry password is: encrypting it with a key the same server holds would add nothing.
- **`SignIns`** (`spaces/SignIns.ts`): `list`, `create` (the address's origin is kept: `scheme://host[:port]`, http(s)
  only), `update`, `remove`, `forSite`, and `signIn(space, key, id, {url?, tab?})`, which runs `signInFill.ts` on the
  driver's MCP session `key` (the agent's task, or `board`).
- **The fill** (`spaces/signInFill.ts`, Cua's sequence, checked on Cua's image with cua-driver 0.49.1): the caller's tab
  (`session`, `target_id`, `tab_id`), or a fresh Chromium of the server's own (`browser_prepare` with `isolated_new`,
  `list_windows`, `get_browser_state` with the window, `browser_navigate`); a snapshot whose URL must be on the sign-in's
  **exact origin** with a password field (else nothing is typed: `Invalid`, field `page`); the first password input,
  the username-like input before it and the submit button after it from the snapshot's refs; `browser_type` each, then
  `browser_click` in the foreground (Linux Chromium refuses trusted input in the background). The driver's refusals
  are scrubbed of the password (as typed, `encodeURIComponent`d and form-encoded). The tab's address after is told as
  its origin and path only, never its query or fragment: a form sent by GET puts the password there, encoded as the
  browser chooses (form encoding escapes `!'()~`, which `encodeURIComponent` doesn't: found on review), so no matching
  by hand is trusted with it. When the decoded parameters carry it, the tab is navigated to the same page without them
  (the caller's next `get_browser_state` would read the address) and the answer says so (`password_in_address`). Found running it: the driver's browser tools need a session label; a label belongs to the MCP
  session that first used it ("session is not available to this transport" on another, such as the board's after a
  restart); a named profile's browser belongs to the session that launched it, and each refusal counts toward a pause in
  launching any browser. So each fill of its own takes a fresh label (`huntaway-sign-in-<8 hex>`) and a fresh profile,
  and returns the tab for the caller to carry on in. Nothing the driver answers shows an input's value (snapshots,
  `get_window_state`, `page`).
- **`space_sign_in {space, url, sign_in?, session?, target_id?, tab_id?}`** on the `spaces` server: the task's profile's
  sign-ins for the URL's origin (none: the agent is told to ask the user to add one, never for the password; several:
  it names one by id); then it **asks the user**, whatever the mode, as `delete_space` does (`McpHooks.askRule` with no
  rule; in `SPACES_ASKS_ITSELF`, so Claude and Codex don't ask first too; reviewers and plan mode are refused). The card
  shows the Space, the site, the masked username and the sign-in's label. One approval is one sign-in, as in Cua: an
  allow-always answer adds the tool to the thread's list, which `askRule` doesn't read, so the next one asks again. The
  agent gets the origin, the masked username, whether it submitted, the scrubbed URL and the tab.
- **RPCs** (in `SpacesRpcs`, `admin`): `signIns.list {profile_id?}`, `signIns.create`, `signIns.update` (a new `url`
  moves it to that page and its origin), `signIns.delete`, and `spaces.signIn {id, sign_in_id}` (the board's own, on the
  MCP session `board`, at the saved sign-in page).
- **The web**: Settings → Profiles → a profile's **Site sign-ins** (`settings/SiteSignIns.tsx`: add, change, delete; a
  password is never shown again and can only be replaced), and **Sign in** on a running Space on the host's page.
- **What it protects**: the password stays out of the model's context, the transcript, `mcp_calls`, the prompt's row
  and the log. It doesn't stop an agent set on getting it: the Space's user has passwordless sudo, so a command in it can
  watch the browser. The Site sign-ins dialog says so in a line. Two-factor codes are the user's, in the viewer.
- **Tests**: `signInFill.test.ts` (a scripted driver: the sequence, the origin check, the scrubbing) and
  `SpacesTools.test.ts` (the tool through `ToolCalls` over `fakeSpacesd`'s scripted login tab, `LOGIN_REFS`: asked in
  Bypass, denied, allowed, and no row the board kept has the password).

#### Teleport: a host browser's sign-ins into a Space (HE-49)

Teleport brings a signed-in browser's state from the host that runs the server (where you also browse, on this setup)
into a Space, so its browser starts out signed in, after Cua Spaces' teleport. Only cookies and local storage move;
saved passwords do not (Sign-ins, HE-48, cover those). Design:
[docs/he-48-passwords-and-teleport-for-spaces](http://127.0.0.1:7879/docs/ae5dff1f-2fe6-4339-825d-0aa572897dba/d/he-48-passwords-and-teleport-for-spaces/),
section 2.

- **`Teleport`** (`spaces/Teleport.ts`, beside `Spaces`): `sources` (the host's browsers and their profiles), `sites`
  (a profile's sites with cookie counts, nothing decrypted), `bring` (send the chosen sites in), `imports` (what landed
  in a Space), `remove` (wipe one). Its RPCs (`rpc/teleport.ts`, `teleport.*`) are `terminal` to read and `admin` to
  bring or remove. The host page's **Bring sign-ins…** dialog (`settings/TeleportDialog.tsx`) uses them.
- **Reading the host** (`spaces/teleport/`, pure where it can be): `browsers.ts` is the catalog and the profile lists
  (Chromium's `Local State`, Firefox's `profiles.ini`). Each browser's roots are tried in order (`rootsOf`), and the
  first with a profile holding cookies is used: its folder under the config folder (`$XDG_CONFIG_HOME`, else
  `~/.config`: `google-chrome`, `chromium`, `BraveSoftware/Brave-Browser`, `microsoft-edge`, `vivaldi`, and
  `mozilla/firefox`, where Firefox 147 and later keep new profiles), then the older and packaged places (Firefox's
  `~/.mozilla/firefox`, snap's and flatpak's; Chromium's snap and flatpak). Cookies come from the profile's `Cookies` SQLite (the newer of `Cookies`
  and `Network/Cookies`) read through a private copy with an ephemeral `SqliteClient` (so a running browser's lock
  doesn't matter); `expires_utc` is read as text because it overflows a JS number. Local storage comes from
  `Local Storage/leveldb`, read whole by `leveldb.ts` (its logs and tables, newest value per key, Snappy via
  `snappy.ts`; an index block's entries are followed whatever their separator key's type, as a block's last key may be a
  deletion) and interpreted by `chromiumStorage.ts`. A profile is offered only when its folder holds a cookie store.
  A site (`sites.ts`) is a registrable domain by the public suffix list (`tldts`, ICANN and private sections, as
  browsers read it: `amazon.com.mx`, `someone.github.io`); a host without one (an IP address, `localhost`, a name under
  an unknown last label like `foo.local`) is a site of its own. A cookie or origin belongs to the site `siteOf` names
  for its host and to no other: listing, counting and sending go by that one rule, so a site nested under another by
  the private section (`mybucket.s3.amazonaws.com` under `amazonaws.com`) is listed and sent on its own. Only a
  profile's own first-party cookies are read: not partitioned ones (Firefox's `originAttributes` `^partitionKey=`,
  Chromium's CHIPS `top_frame_site_key`, where the column exists) nor a Firefox container's (`^userContextId=`), which
  the bundle would carry as first-party rows and could replace the real cookie with. A site that looks signed in is
  pre-ticked, an identity provider never is: Google, Microsoft, Apple, Okta and Auth0 by the name before the public
  suffix (so `google.co.nz` and every other Google country domain, which hold the account's session cookies), and
  `live.com`, `office.com`, `icloud.com`, `oktacdn.com` by domain. Nothing is decrypted to list sites. `bring` sends only sites the
  profile's own list has (what `sites` showed), so whatever the dialog lists can be sent and nothing wider can be asked
  for.
- **Decrypting** (`chromiumCrypto.ts`, with Effect's `Kdf`/`Cipher`/`Digest`): a Chromium `v10` value uses the fixed
  `peanuts` key, `v11` the browser's own libsecret Safe Storage secret (`secret-tool lookup application <name>`: `chrome`,
  `chromium`, `brave`… per catalog entry); both derive an AES-128-CBC key by PBKDF2-HMAC-SHA1 over `saltysalt` with a
  16-space IV. App-bound `v20` is skipped. In a `Cookies` database of version 24 or later (Chrome 130+) every value
  starts with its host_key's SHA-256, which is checked and stripped, so a wrong key's rare padding pass isn't sent as
  garbage. Cookies that couldn't be read are counted in the result's `skipped`. Firefox cookies are plaintext; from
  `moz_cookies` schema 16 (Firefox 142, its `PRAGMA user_version`) `expiry` is in milliseconds, before it in seconds.
  SameSite 0, 1 and 2 are kept, anything else (Firefox's `SAMESITE_UNSET`, 256) goes as unspecified (-1), not Strict. Values are decrypted only for the sites the user sends, and never
  logged, returned or stored on the host.
- **Sending** (`bundle.ts`, `wire.ts`): the server closes the Space's browser (spacesd refuses to on Linux, and its
  importer assumes the profile is free): `pkill -x` on the browsers' process names, waiting up to 10 s, then KILL, and
  the teleport fails with `Unavailable` if one is still running. Then it calls
  `cua.env.v1.TeleportService` over gRPC-Web with hand-written protobuf as `spacesd.ts` does: `GetManifest` to check
  the provider and bundle version, then `ImportSession` in chunks of at most 4 MiB, committed with the bundle's
  lowercase-hex SHA-256 and `options.expires_at_ms` (the **Wipe after** choice). The bundle is a tar
  (`cua-teleport-bundle` v1) whose first entry is `manifest.json` (each entry's sha256), then `cookies.json` (decrypted
  rows, values base64), `localstorage.json` and `tabs.json`. The receiver re-encrypts the cookies under the Space's own
  key. The `import_id` is kept in `space_teleports` (`TeleportRepo`) so **Remove sign-ins** can `WipeImport`.
- **An agent can ask** with `space_request_sign_ins {space, sites[]}`, which asks the user itself whatever the thread's
  mode (`McpHooks.askRule` with no rule, which now returns the input as allowed). Its prompt is `USER_ONLY`
  (`permissions/prompts.ts`): Bypass doesn't answer it, and it can't be always allowed; Don't ask denies it. It is in
  `SPACES_ASKS_ITSELF`, so neither CLI asks first too, and in `SPACES_WRITES`, so reviewers don't get it. The sites
  must be sites as `siteOf` names them (`teleport/request.ts`: a public suffix such as `com` or `co.kr`, or a
  subdomain, is refused) that a host profile holds; the
  profile holding most of them is picked. The card (`task/thread/SignInsCard.tsx`) names the Space, the browser
  profile and the sites with their cookie counts, identity providers unticked; the user unticks what shouldn't go (or
  ticks a provider back) and allows it, and only the sites left ticked, of those offered, are sent. A denial sends
  nothing.
- **Honest limits**: the bundle crosses the wire as plaintext inside the Space's own request; anything that controls the
  Space (its user has sudo) can use a teleported session, as in Cua Spaces. The dialog says so.
- **Tests**: `teleport/plain.test.ts` (the wire messages, the tar bundle, Snappy, the LevelDB/localStorage reader, the
  site grouping, the browser catalogs and roots, the agent request's checks), `teleport/crypto.test.ts` (the `v10`
  derive/decrypt round trip and the host_key digest check), `Teleport.test.ts` (a schema-17 Firefox profile under the
  config folder: millisecond expiry, unset SameSite, `localhost`, and `com` refused) and `RequestSignIns.test.ts` (the
  agent tool through `ToolCalls` over `fakeSpacesd`'s teleport service: asked in Bypass, denied, trimmed, removed);
  `tests/ui/signInsCard.test.mjs` draws the card. The wire and bundle were checked end to end against the real
  spacesd receiver in the image.

### Browser<a id="browser"></a> (HE-62)

Each task has a web browser of its own, which its agent drives with the `browser` MCP server and the board shows beside
the thread. **Decided** (HE-62, after reading T3 Code's, which does the same: a downloaded chrome-headless-shell on the
host, streamed to the app as screencast JPEGs, and the desktop app's own <webview> for its own host): one page per task;
the board's desktop app shows its <webview> and gives it to the server to drive, and every other client watches the
host's headless Chrome as a stream. Everything is driven over the DevTools protocol (CDP) alone, so the two kinds of page
take the same code, with no Playwright in the server.

- **`browser/`** (below `spaces/`): `cdp.ts` (a CDP connection over any carrier of whole JSON messages: commands by id,
  events to a `PubSub`; gone when its messages end), `chrome.ts` (one Chrome over `--remote-debugging-pipe`, its fd 3
  and 4 through `effect/process`' `additionalFds`, NUL-ended messages; no port another program could reach; the
  flags that keep every page painting), `ChromeInstall` (the program: `HUNTAWAY_CHROME`, else Chrome for Testing's
  chrome-headless-shell pinned in `CHROME_VERSION` with each platform's size and SHA-256, downloaded on first use into
  `<data>/browser/chrome/<version>`, unpacked with `unzip` into a folder of its own and renamed into place, older
  versions removed; `HUNTAWAY_CHROME_RELEASE` replaces the pin in tests; a failed install isn't tried again for five minutes, as each try
  downloads it again), `page.ts` (the agent's actions on a `CdpPage`),
  `snapshot.ts` (the accessibility tree as an outline with refs `e<backend node id>`), `keys.ts` (key names as CDP's
  events), `Browsers` (below), `viewer.ts` (one viewer's stream), `tools.ts` and `BrowserTools` (the MCP server).
- **`Browsers`**: a `Tab` per task in a `Ref` (its headless page or the desktop pane, its address and title in a
  `SubscriptionRef`, its viewers, the size viewers asked for, the last dialog). `page(task)` is the desktop pane while
  one is attached, else the headless page, opened (with Chrome, if it isn't running) at the tab's last address. Each
  Chrome start has an id, and a page of an earlier one counts as gone. A headless page nobody used or watched for 30
  minutes closes (a loop every minute, `reap`), and Chrome closes when no page is left: decided under the lock a page
  being opened holds until it's in `tabs` (Chrome's download and start included), so a Chrome just started for a page
  is never closed as idle. A window a headless page opens (a `target="_blank"` link, `window.open`) is closed once it
  has a web address, which then loads in the task's page, as the desktop pane does (`popups`, over
  `Target.setDiscoverTargets`). A headless page's dialogs are accepted, and each is told to the agent once (`takeDialog`;
  forgotten on a new page). Profile: `<data>/browser/profile`, cookies shared by every task.
- **Tickets and the socket**: `browser.open {task_id}` (`operate`) gives a viewer's ticket and `browser.pane {task_id}`
  (`terminal`, as the host's desktop view: only the board's own app hands over a pane) the desktop pane's (single use, a
  minute, as `terminal.open`), for `GET /api/browser/<ticket>` (`http/browser.ts`). Role `view`: `relayViewer` attaches a CDP session of its own to
  the page, starts its screencast (JPEG 70, the viewer's size), and sends one frame at a time: the next after the
  viewer's `ack`, only the newest waiting, and Chrome's own ack after the viewer's, as T3 Code does; a still
  (`Page.captureScreenshot`) when a new screencast sends nothing within 300 ms (an idle page doesn't repaint). The
  page's address and title go as JSON as they change, and its title is read every 2 seconds while watched (a script's
  title change has no event). The viewer's mouse, wheel, keys and text are replayed with `Input.dispatch*`; its size
  becomes the page's (`Emulation.setDeviceMetricsOverride`), kept in a `SubscriptionRef` on the tab that every viewer
  follows: when one gives the page its size, each is sent `viewport` and its screencast starts again at it, so its
  pointer maps onto the page as it is. An address the viewer gives (its socket's `url`, a
  `navigate` frame) goes through `browserUrl` on the server too: web pages only, never `file:` or `chrome:`, answered
  with an `error` frame. When the page goes (the agent's `close`, a reap, Chrome gone), the relay ends and the socket
  closes with 1012; the viewer asks for a new ticket, which opens the page again where it was. `browser.open` needs
  `operate`, so a paired phone can watch and use a task's browser: it reaches what the host's network does, web pages
  only. The tab keeps only a web page's address (`keptAddress`): Chrome's error page records the address that failed
  (`unreachableUrl`), and an address a pane reports that isn't a web page's (`file:`) is dropped, since a page opened
  again loads the tab's address. Role `desktop`: the socket carries CDP itself, the
  server's commands to the app's pane and its answers and events back (`attachDesktop`, a `makeCdp` over the socket);
  the pane sends a message over 1 MiB in parts, under the listener's 16 MiB a message (`paneParts`, `paneText`, HE-71).
  On attach the pane loads the address the headless page was on, the headless page closes, and its viewers are told
  `desktop` and let go. When the pane's socket closes, the tab falls back to headless at the pane's last address.
- **The `browser` MCP server** (`BuiltInServer`, served while `HUNTAWAY_CHROME` is set or Chrome for Testing has a build
  for the platform; `mcp-run.json`'s `browser`): `navigate` (a URL, a host, or a port on this host; or back, forward,
  reload; waits for the load), `snapshot`, `click` (a ref, or x and y), `type`, `press`, `hover`, `scroll`,
  `evaluate`, `screenshot`, `close`. Every run gets it without asking (`--allowedTools mcp__browser`, Codex's approved
  servers); reviewers and plan mode too: the page is a sandboxed web page, not the task's work. A call's timeout is 15
  minutes (the first downloads Chrome). An action waits for a navigation it starts (to its load, or the main frame
  stopping, for a back/forward-cache page). Chrome holds a page's commands until a navigation commits, so one that
  doesn't commit in 15 seconds (a host that never answers) is stopped (`Page.stopLoading`), and the page goes on. The run's system prompt says the browser is there (`prompts/browserNote.ts`).
- **Tests**: `chrome.test.ts`, `page.test.ts` (the actions on a real page) and `Browsers.test.ts` (the tools through
  `ToolCalls`, a viewer over `fakeSocket`, and the desktop pane played by a second Chromium's page relayed as the app
  relays its <webview>) run in this machine's Chromium (`systemChrome` in `@huntaway/testing`: `$CHROMIUM`, else
  `/usr/bin/chromium`) and are skipped without one; nothing downloads Chrome in a test. Test servers
  (`scripts/test-server.sh`) run the same Chromium without its sandbox.
- **The host's SOCKS proxy** (HE-67): `socks_proxy` in the host's settings (`socks5://host:port`; `socks5h://` and
  `socks://` are taken as that, port 1080 by default, no user or password since Chrome can't give one: `checkSocksProxy`
  in `platform/socks.ts`), for previews only reachable over a VPN or an SSH tunnel. Not synced (each host's own). The
  headless Chrome starts with `--proxy-server` (names resolved at the proxy; Chrome leaves loopback pages out), and the
  preview checks (`previewStatus`) go the same way, loopback pages direct. `Running` keeps the proxy Chrome started
  with: a change of the setting (`settings_changed`) closes a Chrome with another, and a page of one counts as gone
  (`alive`), so each page opens again where it was, through the new one, when it's next used or watched. The desktop
  pane's session gets it from the board (`BrowserWebview`, the preload's `setBrowserProxy`, `huntaway:browser-proxy`:
  only from the board's frame, only when the server is on this machine, only a `socks5://host:port`), before its first
  page loads. Settings → the host's page has the field (`hosts/SocksProxy.tsx`, shown when the host reports the key).
  Tested with `fakeSocks` (`@huntaway/testing`): the setting, the client, `previewStatus`, and the headless browser.
- **Not yet**: copy from the page to the viewer's clipboard, file uploads and downloads through the viewer, touch
  scrolling on a phone (taps work: the browser makes them mouse events), input methods, more than one tab a task,
  `t3 browser setup`'s AppArmor profile for Ubuntu's blocked sandbox (`HUNTAWAY_CHROME_SANDBOX=0` instead), and a task on
  another host from a board that isn't its own (as with terminals, the socket goes to the page's own server).

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
and strips nothing. `serve` and the other subcommands use the same cache, turned on in the process (`src/entry.ts`,
[The CLI](#the-cli)), not in the environment.

## Startup

`Main.ts` builds the layers in dependency order; building a layer starts its loops. Then `Recovery` runs, then the
server says it is ready. This is the old order ([inventory 07](inventory/07-server-root-api.md), section 6) with
the one-off moves removed:

1. `Supervisor.take` (restart file and parent PID out of the environment) · data folder · `ImportGuard` (below) ·
   `Releases.execInstalled` (hand over to a newer staged release) · `Identity`.
2. `Backup.beforeStart` · `Db` · `Migrations`. As it goes, `serve` prints how far it has got on stdout for the desktop
   app (HE-44): `HUNTAWAY_PROGRESS {"step":…}`, contracts' `StartupStep`. `backup` before the `VACUUM INTO`, with the
   pages in use as `total` bytes and the backup's `file` (the copy holds the one thread, so the app watches the file
   grow rather than the server saying); `migrate` with `done` of `total` before each migration; `start` once the
   database is ready and the rest is built. `StartupProgress` is a `Context.Reference` (does nothing by default: tests,
   the read-only server), which `serve` sets to the printer around `Layer.build`.
3. (Moved to step 6, HE-3: the listener binds once every area is built and recovery has run, so no request can
   reach a server that is still starting, and no gate is needed. A client sees "connection refused" until then,
   which it already treats as "not up yet".)
4. Every area's layer, bottom up. Loops that start here: telemetry exporter, usage, window restarts, PR watcher,
   terminal reaper, attachment pruner, run pruner, dev-server scan, temp-folder sweeper, permission sweeper,
   scheduler, merged watcher, relocation recorder, update and release checks, push, settings sync.
5. `Recovery`: resume kills left half done · for each run that had not exited: re-ask its open prompts and tool
   calls, then follow it from its saved offset, re-arm its timers · tasks marked running with no run · expire
   prompts with no live run · `Merges.reconcileAll` · `Dependencies.reconcileAll` · `Reviews.reconcileAll` ·
   `WorkflowEngine.resume` · `Restack.resume`. Each reconciler reads only the rows it acts on (`TaskRepo`'s
   `worktreesInFlux`, `restacksDue`, `unstackedPrProjects`; Push's baseline `states`), never every task decoded to be
   filtered (HE-71: on a copy of a board of 2,900 tasks, a restart's ready line came after 1.15 s rather than 2.4 s).
   `GhStacks.linkAll` waits for the listener (`Listening.up`, step 6) and runs in the background.
6. Open the gate: links dial, discovery answers, the RPC and HTTP routes serve. Then `Releases.settle` (a release that
   got this far is current; one that failed before stays `trying` and is marked bad at the next start). Print `HUNTAWAY_READY
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

#### As built in 9.1 (HE-8)

- **`ImportGuard`** (`platform/ImportGuard.ts`) is built by `serve` (`serve.ts`) over `ServerConfig` alone, before
  anything else: no `import.json`, the board as usual; `rehearsal: true`, `ReadOnlyMain`; otherwise it fails with a
  `StartupError` naming the process ids that have `<from>/<database>` open (`ImportRecord.processesWithOpen`: on
  Linux one synchronous pass over `/proc/*/fd` in `platform/procFds.ts`, the one server file allowed `node:fs`, since
  Effect's asynchronous `FileSystem` took twice the time over some 30,000 links, HE-71) and saying
  to stop the old server for good, or to stop this one and start only the old one. An `import.json` that does not read
  is a `StartupError` too: a damaged rehearsal record must not start a board that acts.
- **Listening address.** `--host`/`HUNTAWAY_HOST` has no default in the flags any more (`serveArgs`): the board takes
  `0.0.0.0`, a rehearsal `127.0.0.1`, unless one was given.
- **`ReadOnlyMain.ts`** is a second composition root (an entry point for the lint, as `Main.ts`). It builds the same
  services as `Main.ts`, area by area, and none of their loops (pruners, sweepers, watchers, `UsageWindow.loop`,
  `Scheduler.loop`, `Push.watcher`, `Projects.recorder`, `Telemetry.exporter`, `Lag.ticker`…), none of the layers that
  register one area with another (`*.registered`, `AssistantHooks`, `Approvals.projectsDeleted`), no
  `Profiles.ensureFromConfig`, and nothing of hosts, terminals, desktop, update, MCP, webhooks, the reactor, recovery
  or the demo. `Supervisor` is left out too: the launcher is not told a rehearsal started, so it does not restart one
  that crashed. `CodexQueries.readOnly` starts no Codex; `About.readOnly` reads the guard's record.
- **Handlers**: the board's own handler layers for every group that has a read (so a read answers exactly as on the
  board), between `refuseAll` (a handler for every RPC that dies with `RefusedOnReadOnly`: what an RPC without a read
  handler meets, which the service test catches) and `refuseChanges` (the same over every RPC that is not a read, so
  a change that got past `Auth` still meets a handler that does nothing). Groups with no read (`admin`, `desktop`,
  `link`, `settingsSync`, `telemetry`, `terminal`, `tools`) are only refused, so nothing they need is built. `public.*`
  and `hub.hosts.*` have read-only handlers of their own (`rpc/readOnly.ts`): the open token is never given, and the
  directory is this host with any linked host offline; `hub.hosts.openRelay` is `Invalid`.
- **`AuthReadOnly`** (`rpc/AuthLive.ts`): only the board token, as `read`. The hub token and a hub's sealed sessions are
  `Unauthorized`: a rehearsal accepts no links.
- **Processes**: `ReadOnlySpawner` (`platform/ReadOnly.ts`) is the spawner of the whole read-only graph (`Git`,
  `Worktrees`, `Gh`, the shim… spawn without `Proc`), over the machine's; `Proc.readOnly` checks the same before it
  runs. Both take git only, under `GIT_OPTIONAL_LOCKS=0`, with the plan's subcommands plus what the Changes tab, a
  task's diff and the branch facts read: `rev-list`, `ls-tree`, and the reading forms of `stash` (`list`, `show`),
  `worktree list`, `grep` (not with `-O`, HE-79), `remote` (names, `get-url`; not `remote show`, which asks the remote), `symbolic-ref` (one
  argument) and `config` (a key's value, the list). Before the subcommand only `-C`, a few printing options and a short
  list of `-c` settings that turn things off (`core.fsmonitor=false`, `core.hooksPath=/dev/null`…) pass; after it,
  `--output`, `--ext-diff` and `--exec*` do not. Everything else fails as `PermissionDenied` (`ProcFailed` through
  `Proc`, "unavailable: … not run on a read-only server"), which each caller answers as it answers a command that
  failed. `Proc.run`'s error type stays `ProcFailed` rather than the contract's `Unavailable`: callers match on it.
- **Network**: `RefusingHttpClient` replaces whatever client the environment has.
- **Structural test**: `tests/structure/read-only.test.ts` walks the graph for `lifecycle/`, and finds every loop's
  layer from the sources (a class's static whose initialiser forks, `Effect.forkScoped`/`forkIn`/`forkDetach`/
  `forkChild`, within at most the layer's own generator) and fails if a file of the graph names one. What it cannot
  see: a loop a layer starts through a function the graph calls under another name.

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

As built in HE-71 (startup time; on a fresh board most of the time to `HUNTAWAY_READY` was Node loading code):

- **The entry file.** The launcher runs `src/entry.ts` (`entry.js` in a release, which is also how it tells a
  release's layout) for `serve` and every subcommand but the hooks and `codex-run`. It calls
  `module.enableCompileCache()` on `$TMPDIR/node-compile-cache` (the hooks' folder) and only then imports `bin.ts`:
  Node keeps what it compiled (TypeScript with its types stripped, and V8's code) and the next start reads it back.
  It is turned on in the process rather than with `NODE_COMPILE_CACHE`, which agents and their children would
  inherit. `serve` writes the cache (`module.flushCompileCache()`) once it has printed `HUNTAWAY_READY`, as a server
  seldom exits the way that has Node write it; a short command writes it as it exits.
- **Each command loads what it runs.** `bin.ts` has every command's flags and help, and imports what runs one with
  `import()` when it runs: `serve` is `serve.ts` (`ImportGuard`, then `Main.ts` or `ReadOnlyMain.ts`, whichever the
  folder is served by), `token` the identity, and the others their `cli/` file, which exports the command's function
  (`rpc`, `sshHostMain`, `importLegacyMain`, `install`, `init`/`test`/`backfill`, `googleAuth`). `--version`, `--help`
  and `rpc --list` no longer load the server.
- **`@effect/platform-node` by module.** Its index re-exports `NodeRedis` and `NodeCluster*`, and so loads the redis
  client (about 650 modules) wherever it is imported: its modules are imported one by one
  (`import * as NodeServices from "@effect/platform-node/NodeServices"`), and `no-restricted-imports` refuses the index
  under `apps/server/src` and `packages/testing`. `undici` (with `NodeHttpClient`) is loaded by `socksClient` when a
  host with a SOCKS proxy first needs it.
- Measured from a checkout on the reference machine (a fresh board, `scripts/test-server.sh --no-agents`, medians):
  `HUNTAWAY_READY` 863 ms before, 815 ms with an empty cache, 473 ms with a warm one (a restart); 2,109 modules loaded,
  now about 1,120. `huntaway --version` about 800 ms before, 170 ms after (240 ms with an empty cache), `rpc --list`
  800 ms before, 210 ms after.
