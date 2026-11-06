# T3 Code: source control, code review, workspaces and developer tools

Part of the T3 Code inventory: [t3code-overview.md](t3code-overview.md) has the summary and links the other areas.

Source: shallow clone of `pingdotgg/t3code` at commit 9b1d351 (2026-10-30, release v0.1.5), read only.
Paths are relative to the repository root. "(from code)" marks things found in source but not in
`docs/`. Terms: an *environment* is one running T3 Code server (machine + credentials + state); a
*project* is a workspace root on an environment; a *thread* is one agent conversation; a *turn* is one
user-to-agent cycle (`docs/internals/glossary.md`).

## 1. Workspaces: projects, threads and worktrees

### Where a thread works

- **Two workspace modes per thread: Local or New worktree.** The branch toolbar's workspace menu
  offers the current checkout, a new worktree, and the previous worktree when there is one
  (`mod+shift+x` opens it, `mod+shift+l` reuses the previous worktree, `mod+shift+g` picks the
  branch). `docs/user/keybindings.md`, `docs/user/thread-sidebar.md`,
  `apps/web/src/components/BranchToolbarEnvModeSelector.tsx`
- **Not every thread gets a worktree by default.** The setting `defaultThreadEnvMode`
  (`local` | `worktree`) resolves project override → environment setting → the repository's
  `t3.json` → built-in default `local`. So out of the box threads run in the project's main
  checkout. `packages/contracts/src/t3ProjectFile.ts` (`PROJECT_FILE_BACKED_SETTINGS`),
  `packages/contracts/src/environment.ts`, `docs/user/project-settings.md`
- **Several threads can share one worktree.** "New thread in this worktree" in the branch toolbar
  continues in an existing worktree; the launch strategy `existing_worktree` takes a path.
  `docs/user/thread-sidebar.md`, `packages/contracts/src/orchestrationV2.ts`
  (`OrchestrationV2ThreadLaunchWorkspaceStrategy`: `root` | `existing_worktree` | `worktree`)
- **Background starts and multi-model fan-out.** `Cmd/Ctrl+Enter` starts a thread and opens the
  next draft; with New worktree each submission gets its own worktree. Shift-clicking several
  models in a new thread's picker starts one thread **and one worktree per model** from the chosen
  base branch (needs a Git project). `docs/user/thread-sidebar.md`
- **Threads without a project** work in `~/.t3/scratch/<date>-<first words>-<id>` (not a Git repo;
  branch, worktree and diff controls hidden). **Turn into project** promotes the folder in place;
  **Initialize Git** (`vcs.init`) then enables branch and diff controls.
  `docs/user/thread-sidebar.md`, `apps/server/src/project/ScratchThreadPromotion.ts`
- **Agents can move themselves into a worktree.** MCP tool `t3_worktree_handoff` moves the current
  thread into a new worktree on a new branch (optional `baseRef`, `startFromOrigin`,
  `runSetupScript`, `continuationPrompt`); it ends the live session and resumes there next turn.
  `t3_worktree_status` and `t3_worktree_list` report the thread's worktree and refs. Agents can
  also launch another thread in a worktree with `t3_thread_launch` + `workspaceStrategy`.
  `apps/server/src/mcp/toolkits/worktree/tools.ts`, `packages/contracts/src/worktreeMcp.ts`
- **CLI:** `t3 thread start . "<prompt>"` runs in the project folder unless `--worktree
  <base-branch>` is passed. `docs/user/outside-agents.md`

### How a worktree is created

- **Location:** `<T3 home>/worktrees/<repo name>/<branch with "/" replaced by "-">`, e.g.
  `~/.t3/worktrees/myrepo/t3-1a2b3c4d`. Directory names over 40 chars are cut to 23 chars plus a
  16-hex SHA-256 suffix (Windows path length). `apps/server/src/vcs/GitVcsDriverCore.ts`
  (`createWorktree`), `apps/server/src/config.ts` (`worktreesDir`) (from code)
- **Custom location:** Settings → Worktrees → **Worktree location** takes an absolute path (`~`
  allowed; drive roots refused); per machine. Old locations are remembered
  (`previousWorktreesDirectories`) so cleanup and review diffs still cover them.
  `apps/server/src/worktreesDirectory.ts`, `docs/user/project-settings.md`
- **Commands:** creates the branch first, then `git worktree add -- <path> <branch>` with
  `checkout.workers` honoured, no timeout (long post-checkout hooks), and checkout progress parsed
  (`GIT_PROGRESS_DELAY=0`) into a percentage. `apps/server/src/vcs/GitVcsDriverCore.ts` (from code)
- **Base ref and "start from remote":** `newWorktreesStartFromOrigin` (default **on**) fetches the
  base branch's tracked remote branch and starts from its latest commit, falling back to the local
  branch if the remote branch is missing. Overridable per project and per launch.
  `apps/web/src/components/settings/WorktreesSettings.tsx`,
  `apps/server/src/orchestration-v2/ThreadLaunchService.ts`
- **Submodules:** new worktrees run `git submodule update --init --recursive` by default; the
  **Submodules** setting (`recursive` | `top-level` | `none`, also `"worktreeSubmodules"` in
  `t3.json` of the branch being checked out) changes that. `docs/user/project-settings.md`
- **Visible setup progress:** a per-thread setup tracker streams stages *Fetch base branch → Check
  out files → Init submodules → Run setup script → Start agent* with status, percent and an output
  tail; setup can be cancelled (`worktreeSetup.cancel`). `packages/contracts/src/worktreeSetup.ts`,
  `apps/server/src/project/WorktreeSetupTracker.ts`
- **Setup script:** the project action marked "run on worktree create" runs in a terminal in the new
  worktree; `async: true` (default) lets the agent start meanwhile, `false` holds the agent until it
  exits. See §8.

### Branch naming

- New worktrees first get a temporary branch `t3/<8 hex>`; after the first message a model names
  it and the branch is renamed (descendant threads sharing the branch are updated). The worktree
  **directory keeps its original name**. `apps/server/src/orchestration-v2/ThreadLaunchService.ts`,
  `packages/shared/src/git.ts`
- Settings → Worktrees → **Worktree branch naming**: `static` prefix (default `t3/`, slashes
  optional, empty adds nothing), `semantic` (model picks `feat/`, `fix/`…), or `custom` instructions
  for the whole name (issue IDs, namespaces, casing). If generation fails or the name is taken the
  temporary name stays. `docs/user/project-settings.md`, `packages/contracts/src/settings.ts`
  (`branchNamingMode`, `branchNamePrefix`, `branchNameInstructions`)

### Worktree cleanup

- **Policies** (Settings → Worktrees → Cleanup, off by default, per machine or all environments,
  per-project Inherit/Off/Custom): remove after N inactive days; N days after the thread settles
  (0 = next cleanup); after merge; when the worktree has no commits beyond the default branch;
  **Delete worktrees with deleted threads**. Runs at startup, when changed and hourly; **Delete
  now** runs it immediately and shows removed/kept/failed with reasons, sizes and orphan folders
  (never auto-removed). `docs/user/project-settings.md`, `apps/server/src/storageCleanup.ts`,
  `packages/contracts/src/settings.ts` (`WorktreeCleanupRules`, `StorageCleanupReport`)
- **Safety rules:** only T3-managed worktrees (path must be exactly `<managed dir>/<repo>/<name>`
  after resolving symlinks); active sessions and shared worktrees block removal; **Keep worktrees
  with local changes** = `uncommitted-changes` (default; ignored files such as `.env` and build
  output are deleted) | `any-local-files` (protects ignored files except `node_modules`) |
  `tracked-changes`. Merge cleanup needs a merged PR whose commits are in the remote default branch
  (squash/rebase merges on GitHub count if the worktree is still at the PR's last commit).
  **Branches and thread history are kept**; starting another turn recreates the checkout.
  `apps/server/src/worktreesDirectory.ts` (`makeIsManagedWorktreePath`),
  `apps/server/src/vcs/worktreeRemoval.ts`
- Manual: `vcs.removeWorktree` (optionally forced) and prompts when deleting a thread.
  `packages/contracts/src/git.ts`, `apps/web/src/worktreeCleanup.ts`
- **Settle hooks:** a project action with **Run in the thread's worktree when the thread settles**
  (`runOnSettle`, e.g. `cargo clean`) runs whenever a worktree thread settles; settling also closes
  terminals idle at a prompt. `docs/user/thread-sidebar.md`

### VCS drivers

- Git is the only implemented VCS. Jujutsu (`jj`) is detected and listed in Settings → Source
  control but marked `implemented: false`; `VcsDriverKind` = `git | jj | unknown`. A project can
  pin its VCS in `.t3code/vcs.json` (`{"vcs":{"kind":…}}`). (from code)
  `apps/server/src/sourceControl/SourceControlDiscovery.ts`, `apps/server/src/vcs/VcsProjectConfig.ts`,
  `packages/contracts/src/vcs.ts`

## 2. Git operations in the UI

### Status, refs and fetching

- **Live status stream** per checkout (`subscribeVcsStatus`): branch, default-branch flag, changed
  files with +/- counts, branch-vs-base +/- totals, upstream, ahead/behind, ahead-of-default count,
  and the branch's PR (number, state, draft). `packages/contracts/src/git.ts` (`VcsStatus*`)
- **Automatic background fetch** every 30 s by default (`automaticGitFetchInterval`), tuned by the
  Background activity profile (balanced / performance / battery-saver / custom; can pause on
  battery, low power or locked host), with exponential back-off on failures.
  `packages/contracts/src/settings.ts`, `apps/server/src/vcs/VcsStatusBroadcaster.ts`
- **Branch picker:** searchable, paged list of local/remote refs with which worktree each is checked
  out in; create-and-switch or switch ref (`vcs.createRef`, `vcs.switchRef`, `vcs.listRefs`); copy
  branch name/path. `apps/web/src/components/BranchToolbarBranchSelector.tsx`, `BranchPicker.tsx`

### Commit, push, create PR (one "stacked" action)

- **Git actions control** in the thread header with a context-aware primary button: *Commit*,
  *Commit & push*, *Commit, push & PR*, *Push & create PR*, *Create PR*, *Pull*, *Publish
  repository*, or a disabled hint ("Branch has diverged from upstream. Rebase/merge first.").
  Menu items: Commit, Push, Create PR/MR (label follows the host's terminology).
  `apps/web/src/components/GitActionsControl.logic.ts`
- **Server action** `git.runStackedAction` with `commit | push | create_pr | commit_push |
  commit_push_pr`; optional custom commit message (≤10 000 chars), **a subset of files to commit**
  (`filePaths`), and `featureBranch` (create a `feature/…` branch first). Progress events stream per
  phase (branch, commit, push, pr) including **git hook start/output/finish** with exit codes; the
  result toast offers "Open PR" or a follow-up action. `packages/contracts/src/git.ts`,
  `apps/server/src/git/GitManager.ts`
- **Default-branch guard:** pushing or opening a PR from the default branch asks for confirmation
  and offers to create a feature ref instead. `apps/web/src/components/GitActionsControl.logic.ts`
- **Generated text:** commit messages, PR titles and descriptions are model-written from the diff;
  PR descriptions also use the thread's work, including checks it ran. Settings → Source control:
  writing style `repo_conventions` (recent commit subjects + `AGENTS.md`, and `CLAUDE.md` when the
  writer is Claude) | `conventional_commits` | `custom`; **follow PR/MR templates** (default on);
  writer model (`sourceControlWriterModelSelection`). Subjects are capped at 72 chars.
  `docs/user/source-control.md`, `apps/server/src/git/GitManager.ts` (`resolveStylePolicy`),
  `packages/contracts/src/settings.ts`
- **PR base branch:** taken from a per-branch git config key (`branch.<name>.t3-merge-base-ref`),
  then the recorded branch base, then the upstream, then the host's default branch. (from code)
  `apps/server/src/git/GitManager.ts` (`resolvePrBase`)
- Fork PRs: an existing fork PR can be shown beside the branch even without an upstream.
  `docs/user/source-control.md`

### Pull and auto-pull

- **Pull** (`vcs.pull`) fast-forwards the current branch from its upstream.
- **Automatically pull** (Source control setting, per environment or project, default off): keeps
  the default-branch checkout current, only when it can fast-forward and there are no changed,
  untracked files or local commits; skips other branches and branches without upstream.
  `docs/user/project-settings.md`, `apps/server/src/serverRuntimeStartup.ts`

### Publishing and remotes

- **Publish Repository** for a local repo with no remote: pick host, owner/name, visibility
  (private/public), remote name (default `origin`) and protocol (ssh/https); creates the hosted
  repo, adds the remote and pushes. All seven host integrations implement repository creation.
  `apps/web/src/components/GitActionsControl.tsx`, `packages/contracts/src/sourceControl.ts`,
  `packages/source-control-*/src/server/*SourceControlProvider.ts`

### Not present

- **No git stash UI or API** (the only "stash" in Git code is an error telling the user to commit
  or stash before a local PR checkout). The composer's `Cmd/Ctrl+S` "prompt stash" saves draft
  prompts, not code. `apps/server/src/git/GitManager.ts`, `docs/user/composer.md` (from code)
- **No local merge into the base branch, rebase UI, staging/unstaging or per-hunk discard.**
  Merging happens on the code host through the PR actions (§7). (from code: no such RPCs in
  `packages/contracts/src/rpc.ts` `WS_METHODS`)
- Git failures are reduced to fixed reasons (`authentication_failed`, `branch_checked_out_in_worktree`,
  `push_rejected_non_fast_forward`, `host_key_unverified`, …) so stderr cannot leak credentials.
  `packages/contracts/src/git.ts` (`GitCommandFailureReason`)

## 3. Checkpoints, turn diffs and rewind

- **A checkpoint per turn**, stored as a hidden Git ref under
  `refs/t3/orchestration-v2/checkpoints/…`. Capture writes tracked **and untracked (non-ignored)**
  files into a temporary index (`GIT_INDEX_FILE`), then `write-tree` + `commit-tree`; the user's
  index and branch are untouched. `apps/server/src/orchestration-v2/CheckpointService.ts`,
  `apps/server/src/vcs/GitVcsDriver.ts` (`checkpoints.captureCheckpoint`) (from code)
- **Turn diffs show only the turn's own work.** Files Git brought in by a pull/merge/rebase during
  the turn are left out; a file stays if the turn edited, committed or conflict-fixed it (remerge
  diffs keep conflict fixes). Full-thread diffs (`getFullThreadDiff`) and turn ranges
  (`getTurnDiff`) are available, with an ignore-whitespace option. `docs/user/source-control.md`,
  `packages/contracts/src/checkpointDiff.ts`, `apps/server/src/checkpointing/`
- **Rewind ("Edit from here")** under a sent message: **Revert and keep changes** (conversation
  only) or **Revert files too** (restore the workspace to the checkpoint before that message, via
  `git restore --source <checkpoint> --worktree --staged` + `git clean -fd`). File restore is only
  offered for threads in a worktree and is refused if another thread/agent session uses that
  directory, a sub-folder or a parent. Only when the provider supports rewind; ACP agents get a
  fresh session after rollback. `docs/user/composer.md`, `docs/user/providers-acp.md`,
  `apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts`

## 4. Diff pane (thread-level code review)

- **Sources** in the Diff pane picker: **Changes** (branch vs base), **Uncommitted** (working tree),
  **Latest turn**, **Turn N**, and **Commits** (newest 100 commits in the branch comparison, one at a
  time; merge commits against first parent). Diffs of a single tool call can also be opened.
  `apps/web/src/components/DiffPanel.tsx`, `docs/user/source-control.md`,
  `packages/contracts/src/review.ts` (`working-tree | branch-range | commit`)
- **Viewer options:** stacked (default) or split layout; hide whitespace (default on); word wrap;
  files collapsed by default; collapse/expand all; **file tree**; hide test files; find across all
  files including folded/unchanged lines (`mod+f`); full old/new file contents loaded on demand to
  expand context; open file in external editor; copy path. Rendered with `@pierre/diffs` and
  `@pierre/trees` in worker threads. `apps/web/src/components/DiffPanel.tsx`,
  `apps/web/src/components/diffs/`, `packages/contracts/src/settings.ts` (`diffLayout`,
  `diffIgnoreWhitespace`, `diffFilesCollapsed`), `docs/user/keybindings.md`
- **Line comments go to the agent.** Selecting lines in a diff (or in a file) and commenting adds a
  *review comment* chip to the composer carrying the file path, line range, the selected diff and
  your note; sending delivers it to the agent. `apps/web/src/components/diffs/AnnotatableCodeView.tsx`,
  `apps/web/src/reviewCommentContext.ts`, `docs/user/composer.md` ("Context in your message")
- **Commit links** from a supported host open in the Diff pane when the commit exists locally.
  `docs/user/source-control.md`
- Keybinding `diff.toggle`. `packages/contracts/src/keybindings.ts`

## 5. Adding, cloning and creating projects

- **Clone from the command palette** (Add Project): choose a host and `owner/repo`, or paste any Git
  URL; pick destination (base folder `addProjectBaseDirectory`) and protocol `auto | ssh | https`.
  The project opens immediately while the clone runs; the first prompt can be written and sending
  waits for the files. A toast shows stages (*Connecting, Counting objects, Receiving objects,
  Resolving deltas, Checking out files*), percent, speed, "Stalled", and offers cancel/retry. If
  the host refuses the SSH key it retries over HTTPS with Git's credentials.
  `docs/user/source-control.md`, `packages/contracts/src/projectClone.ts`,
  `apps/server/src/project/ProjectCloneTracker.ts`
- **New project** from nothing: creates `~/.t3/projects/<slug>` with a README, icon and first commit,
  optionally a **private GitHub repo**, and opens a thread. `docs/user/source-control.md`,
  `apps/server/src/project/ManagedProjectFolders.ts`
- Agents can do the same via MCP: `t3_project_clone`, `t3_project_create`, `t3_project_list/read/
  update/delete`. `apps/server/src/mcp/toolkits/project/`
- **Prompt links** (`app.t3.codes/…?repo=…&pr=…&prompt=…`): `repo` opens the latest project for that
  repository or offers Clone; `pr` opens the thread linked to that PR or drafts one on the PR branch
  in a new worktree after confirmation (because the setup script will run). `docs/user/prompt-links.md`
- Welcome wizard can import existing repos, including linked worktrees of bare repositories.
  `docs/user/welcome-wizard.md`

## 6. Code host integrations

### Capability matrix

From each provider's `CAPABILITIES` and `definition.changeRequestActions`
(`packages/source-control-<host>/src/server/*PullRequestProvider.ts`, `src/shared/definition.ts`):

| Host | Auth / transport | PR actions | Merge methods | Branch update | Line review | Reply / resolve | Verdicts | Viewed marks | Other |
|---|---|---|---|---|---|---|---|---|---|
| GitHub (+ GHES) | API (GraphQL/REST) with saved token > `GH_TOKEN`/`GH_ENTERPRISE_TOKEN` > `gh` ≥2.81 login | merge, ready, draft, close, reopen, delete-branch, update-branch, enable/disable auto-merge, revert, approve-workflows | merge, squash, rebase | merge, rebase | yes, incl. ranges | yes / yes | comment, approve, request changes | on host (GitHub's own) | stacks + stack actions, labels, reactions, reviewers, edit title/body/comments, maintainer edits, search |
| GitLab | `glab` CLI | merge, ready, draft, close, reopen, update-branch, auto-merge on/off | merge, squash, rebase | rebase | yes | yes / yes | comment, approve (no "request changes") | kept by T3 server | reactions, reviewers, search |
| Forgejo / Gitea / Codeberg | `fj` (preferred) or `tea` ≥0.16 | merge, close, reopen, update-branch | merge, squash, rebase | merge, rebase | yes | no / no | comment, approve, request changes | kept by T3 server | labels, reactions, reviewers |
| Bitbucket | REST API with access token, or Atlassian email + API token (Settings or `T3CODE_BITBUCKET_*` env) | merge, close (no reopen of declined) | merge, squash, rebase | — | yes | yes / yes | comment, approve, request changes | kept by T3 server | reviewers, search |
| Azure DevOps | `az` + `azure-devops` extension | merge, ready, draft, close, reopen, auto-merge on/off | merge, squash | — | no | no / no | none | kept by T3 server | request reviewers (no candidate list); comments must be changed on the website |
| GitCafe (git.cafe) | `cafe` CLI login, saved token or `CAFE_TOKEN` | ready, draft, close, reopen, merge, update-branch | merge, squash, rebase | rebase (restacks layers above) | no ("not available yet") | yes / yes | approve, request changes, comment | — | stacks + stack actions, labels, reactions, search |

- **Discovery:** Settings → Source control lists each host's CLI (found/missing, version, install
  hint) and auth status with accounts; **Rescan** after signing in on the server machine. Hosts
  are recognised from Git remotes. `packages/contracts/src/sourceControl.ts`,
  `apps/server/src/sourceControl/SourceControlDiscovery.ts`
- **Credentials live on the server machine** (remote environment = remote machine). Saved tokens go
  to the server's secret store and are never shown again. `docs/user/source-control.md`

### GitHub specifics

- Per-host account choice when `gh` has several logins; hosts can be turned off; any server name is
  treated as GitHub (Enterprise) once it has a credential. `docs/user/source-control.md`
- **"T3 Code for GitHub" app sign-in** by device code (lifts per-user rate limits; reports whether
  the app's installation covers a repo). Only enabled when the server has
  `T3CODE_GITHUB_APP_CLIENT_ID`; undocumented. (from code)
  `packages/source-control-github/src/server/GitHubAppSignIn.ts`,
  `packages/source-control-github/src/shared/definition.ts`
- **GitHub stacks:** stack position badges, navigate layers; **Merge stack** submits the selected PR
  and all unmerged layers below it together (honours branch rules and merge queues); **Rebase
  stack** updates remote branches bottom-up without touching the local checkout.
  `docs/user/source-control.md`, `packages/source-control-github/src/server/githubStackActions.ts`, `githubStackRebase.ts`
- Auto-merge while checks run; **approve waiting fork workflows**; **open a revert PR** for a merged
  change; **Remove agent credits when merging** (strips agent `Co-authored-by`/"Generated with"
  lines from GitHub merge/squash messages; off by default, project-overridable).
  `docs/user/source-control.md`, `packages/source-control-core/src/server/mergeMessage.ts`
- Rate-limit aware: a watch first asks whether anything changed; previously verified credentials
  stay usable for routing for 10 minutes during a GitHub outage.
  `packages/source-control-core/src/server/SourceControlRateLimit.ts`, `docs/user/source-control.md`

### Pull request sharing across environments

- Off by default. Per environment, **Read PRs** or **Read and act** lets another connected
  environment signed in to the same account on the same host answer review reads/actions, so a
  browser or phone can use a paired machine's GitHub credentials. Credentials stay on their
  machine; uncertain actions are never retried elsewhere. `docs/user/source-control.md`
  ("Pull request sharing"), `packages/contracts/src/pullRequest.ts` (`PullRequestRouting*`)

## 7. Pull requests inside T3 Code

### Pull requests page

- Lists PRs/MRs across all projects and hosts (GitHub reads every repo on a host in one search),
  with state (open/closed/merged/all), involvement (all/reviewing/authored), filters for draft,
  review decision, checks passing/failing, labels (AND of OR-groups, exclusions), author
  (`author:me`), project, host, server; text search, sort, grouping, lazily loaded +/- stats.
  `packages/contracts/src/pullRequest.ts` (`PullRequestListInput`, `PullRequestListFilters`),
  `apps/web/src/components/pullRequest/PullRequestListFilters.tsx`
- **Speed actions:** hold Shift in the GitHub list for quick Close/Merge/Ready/Reopen; drag across
  rows to close several; failed closes stay for retry. `docs/user/source-control.md`,
  `apps/web/src/components/pullRequest/PullRequestSpeedActions.tsx`
- PR links in chats open in the in-app PR view (setting **Open pull requests in T3 Code**,
  `pullRequestLinksOpenInApp`, default on); `mod+shift+c` / `mod+shift+k` copy URL / `#number`.
  `docs/user/keybindings.md`

### PR detail view

- **Tabs:** Summary (description, labels, reviewers, comments with filter and sort), **Code**
  (diff), Timeline (activity, newest/oldest first), **Guide** (when review guides are on).
  `apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx`
- **Header/actions:** checks popover (status, required flag, link to host's checks page; "No checks
  reported"); mergeability and behind-base state; Merge now / Enable or disable auto-merge with the
  chosen merge method (server default `pullRequestMergeMethod`, per-client overrides); Ready for
  review / Convert to draft; Close / Reopen; Update branch (merge or rebase); Delete branch; Revert
  changes; Approve workflows; Allow edits from maintainers; Refresh; Link to thread; edit title and
  description; request reviewers; set labels; reactions; copy checkout command.
  `apps/web/src/components/pullRequest/PullRequestActionsMenu.tsx`, `PullRequestDetailActions.tsx`
- **Code tab:** stacked/split, whitespace toggle, line wrapping, file tree, hide test files,
  expand/collapse all, scope to one commit ("All commits" picker), paged loading for large PRs
  (GitHub refuses >300 files per read), outdated conversations listed separately ("Conversations
  not on the current diff"), and a **change breakdown** of +/- lines into code / tests / mocks /
  generated / docs. `apps/web/src/components/pullRequest/PullRequestCodeTab.tsx`,
  `packages/contracts/src/pullRequest.ts` (`PullRequestChangeBreakdown`)
- **Reviewing:** select lines to **Add to review** (draft inline or range comment, submitted later as
  one review with verdict comment/approve/request changes) or **Add to agent** (composer chip);
  reply to and resolve threads; edit your own comments where the host allows.
  `packages/contracts/src/pullRequest.ts` (`PullRequestSubmitReviewInput`,
  `PullRequestReviewPosition`)
- **Mark files as viewed:** ticked files collapse with a running count; ticks belong to the PR not a
  commit; a file pushed to after you cleared it returns as **Changed**. On GitHub these are
  GitHub's own viewed marks (sync both ways); on other hosts the T3 server keeps them ("viewed in
  T3 Code") and asks the host for each file's revision to detect pushes.
  `docs/user/source-control.md`, `docs/internals/pull-request-file-revisions.md`,
  `apps/server/src/pullRequest/pullRequestViewedFiles.ts`

### Handing a PR to an agent

- **Check out** a PR locally (refuses if tracked changes exist) or **in its own worktree**
  (`git.preparePullRequestThread`, modes `local | worktree`), materialising fork heads and
  configuring the upstream; runs the project's setup script for the thread.
  `apps/server/src/git/GitManager.ts`, `packages/contracts/src/git.ts`
- **Ask a question:** opens a thread that already has the PR attached (or adds it to the current
  composer). **Fix in a thread:** packages unresolved review threads, review remarks and
  failing/cancelled checks into a prompt (marked as untrusted text). **Resolve conflicts:** opens a
  thread on the prepared checkout asking the agent to update from the base, resolve every
  conflict, build, and push. `apps/web/src/components/pullRequest/pullRequestDetail.logic.ts`
  (`buildFixFindingsHandoff`, `buildResolveConflictsPrompt`)
- **Mobile "Work on PR":** opens a chat with the review attached; sending prepares a worktree from
  the PR branch. `docs/user/source-control.md`
- **`#` in the composer** browses/searches the repo's PRs and inserts a PR chip.
  `docs/user/composer.md`

### Linked PRs and thread lifecycle

- A thread can hold **several linked PRs**, also from other repos on the same host. Sources:
  `manual`, `created` (from Git actions), `agent` (auto-linked when an agent runs `gh pr create` or
  `glab mr create`, or via the `link_pull_request` tool), `stack` (native stack layers).
  **Linked pull requests** panel lists and groups them, with unlink and watch controls; the PR
  header lists threads that link to it. `docs/user/source-control.md`,
  `packages/contracts/src/threadPullRequest.ts`
- The server finds each unsettled thread's branch PR even with apps closed; open PRs refresh on the
  server, closed ones periodically. Merged PRs **settle the thread** (default on), closed PRs can
  settle idle threads, and agent `gh pr merge/close` commands are detected per host.
  `docs/user/thread-sidebar.md`, `packages/source-control-core/src/shared/definition.ts`
  (`changeRequestCloseCommand`)
- **PR watch / babysit:** ask the agent to watch a PR and it calls `watch_pull_request`; every two
  minutes the server checks and **wakes the agent** when a check fails, required checks pass,
  someone else comments/reviews, or the branch starts to conflict. Ends on merge/close, after 10
  comment-only wakes in a row, 8 failed reads, or Stop; a watched thread counts as working.
  `docs/user/source-control.md`, `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts`

### Review guides (beta)

- Off by default (`reviewGuidesEnabled`). **Write guide** has a model read the PR in a temporary
  checkout (nothing changed) and produce a tour: ordered stops, each with summary, excerpts to read,
  file notes, line notes, suggested questions, and an optional **Look closely** flag (kinds:
  tradeoff, contract, product, risk, accessibility). Mechanical changes are grouped at the end and
  every changed file appears. Stored per server, marked stale after a push; **Rewrite guide**.
  Claude and Codex can write guides; model and **Review guide instructions** are configurable per
  project. While reading a stop you can add review comments or ask an agent about it; **Finish
  review** opens the collected review. Agents: `write_pull_request_guides` (≤20 PRs),
  `read_pull_request_guide`. `docs/user/source-control.md`,
  `packages/contracts/src/pullRequestReviewGuide.ts`,
  `apps/server/src/pullRequest/PullRequestReviewGuideService.ts`

### Mobile

- PR list across environments, description/activity/commits/files, viewed marks, draft line
  comments, review guides with Next/back; previously loaded lists, details, guides and diff pages
  stay readable offline. `docs/user/source-control.md`

## 8. Project settings and configuration

### Settings layering

- Settings page has a scope line "Applying settings for <project> on <environment>": edit one
  environment, all connected environments at once (shows **Mixed** when they differ), or a
  project's overrides; a layers icon shows built-in → environment → project origin, with Reset /
  Reset all. `docs/user/project-settings.md`
- Project-overridable keys include: `worktreeCleanup`, `defaultModelSelection`, `defaultRuntimeMode`,
  `defaultThreadEnvMode`, `newWorktreesStartFromOrigin`, `worktreeSubmodules`, `defaultAutoPull`,
  `defaultProjectScripts`, `enableAgentBrowserAccess`, `enableAgentDeviceAccess`,
  `sourceControlWriterModelSelection`, `reviewGuideModelSelection`, `reviewGuideInstructions`,
  `sourceControlWritingStyle`, `removeAgentCreditsOnMerge`, branch naming keys,
  `pullRequestMergeMethod`, auto-settle rules, plus per-project provider on/off.
  `packages/contracts/src/settings.ts` (`PROJECT_SCOPED_SERVER_SETTING_KEYS`)
- Resolution for repo-declarable settings: project override → environment → `t3.json` → built-in.
  `docs/user/project-settings.md`

### Project actions (scripts)

- Each action: `name`, `command`, `icon` (play, test, lint, configure, build, debug),
  `runOnWorktreeCreate` (setup script), `runOnSettle`, `async`, `previewUrl` (opens in the in-app
  browser when run; desktop only), `autoOpenPreview`. Run from the thread header/scripts menu in a
  T3 terminal; each has a bindable `script.<id>` keybinding. Scripts get `T3CODE_PROJECT_ROOT` and
  `T3CODE_WORKTREE_PATH`. Environment-wide default list plus per-project lists.
  `packages/contracts/src/project.ts` (`ProjectScript`), `packages/shared/src/projectScripts.ts`,
  `apps/web/src/components/ProjectScriptsControl.tsx`
- Setup scripts are skipped for threads started through restricted links (only T3's tools are
  granted there). `apps/server/src/project/ProjectSetupScriptRunner.ts`

### `t3.json` (checked-in project file)

- At the repository root, schema `https://t3.codes/schema/t3.json`: `iconPath`,
  `defaultThreadEnvMode` (`worktree` | `local`), `worktreeSubmodules`, `scripts[]` (max 50, same
  fields as actions). Actions can be **imported** from it in Settings → Projects.
  `packages/contracts/src/t3ProjectFile.ts`, `apps/server/src/project/T3ProjectFileLoader.ts`

### Other project settings

- Name, icon (auto-detected favicon/logo, emoji, monogram, image), checkouts across environments
  (a project group can span machines), removal. `docs/user/project-settings.md`
- Scheduled tasks and webhook automations (e.g. run a prompt on a GitHub `pull_request` webhook,
  with HMAC signature check, filters, replay/coalesce keys). `docs/user/project-settings.md`

### Not present

- **No per-project environment variables / `.env` handling** in project settings (from code: none
  in `ProjectSettingsOverrides` or `t3.json`). Environment variables exist per *provider instance*
  (agent CLI config), optionally read from 1Password (§14). `packages/contracts/src/providerInstance.ts`
- **No devcontainer support for user projects.** `.devcontainer/` and
  `docs/internals/devcontainer.md` only describe a container for developing T3 Code itself
  (Ubuntu 24.04, Node, pnpm, Rust, forwarded port 5733, Codespaces prebuilds). (from code: no
  devcontainer/docker code in `apps/server/src` beyond process/env detection)

## 9. Integrated terminal

- **Server-owned PTYs** (node-pty) per thread, several terminals per thread, opened in the thread's
  cwd/worktree; clients attach, observe, write, resize, clear, close; any client (web, desktop,
  mobile, remote) can reconnect to or share a running terminal. `docs/internals/terminal-runtime.md`,
  `packages/contracts/src/terminal.ts`, `apps/server/src/terminal/Manager.ts`
- **Rendering:** `libghostty-vt` (Ghostty's VT core) compiled to WebAssembly for web/desktop and used
  natively on Android; React stays out of terminal frames. `native/libghostty-vt/VERSION`,
  `apps/web/src/terminal/ghostty/`
- **History:** 5 000 lines / 8 MiB per terminal kept on the server and restored on reconnect and
  after restarts (client buffer 512 KiB); terminal query/response traffic is stripped so replay
  can't inject junk. Select-all copies all retained output. `docs/user/terminal.md`
- **Layout:** drawer under the chat, split horizontally or vertically, new/close/toggle shortcuts
  (`mod+g` toggle, `terminal.split`, `terminal.splitVertical`, `terminal.new`, `terminal.close`).
  `apps/web/src/components/ThreadTerminalDrawer.tsx`, `packages/contracts/src/keybindings.ts`
- **Into chat:** "Add to chat" puts a terminal excerpt chip in the composer; URLs in terminal
  output can open in the in-app browser. `apps/web/src/components/ThreadTerminalDrawer.tsx`,
  `apps/web/src/components/preview/openTerminalLinkInPreview.ts`
- **Process awareness:** each terminal reports whether a subprocess is running; listening servers
  started from terminals are discovered (§10); settling a thread closes terminals idle at a prompt
  but keeps ones running a command. `packages/contracts/src/terminal.ts` (`hasRunningSubprocess`),
  `docs/user/thread-sidebar.md`
- Scrollback keys (Shift+PageUp/Down, Ctrl/Cmd+Shift+Home/End); fish started with
  `no-query-term`; multiplexer variables (tmux/screen/Zellij) not inherited (from code). `docs/user/terminal.md`,
  `apps/server/src/terminal/Manager.ts`

## 10. Built-in browser and previews

- **Browser panel per thread** with tabs, back/forward, URL/search bar (DuckDuckGo default; Google,
  Bing, Brave, Kagi, Ecosia, custom), zoom (25–500 %), light/dark/system appearance override,
  viewport presets (iPhone, Pixel, Galaxy, iPad, Surface, folds, Nest Hub…) or freeform size, hard
  reload, clear cookies/cache, DevTools (desktop), open in system browser, floating "mini player".
  `packages/contracts/src/preview.ts`, `apps/web/src/components/preview/`
- **Two runtimes:** the desktop app embeds tabs (Electron `<webview>`); every other client, and
  the desktop app for other environments, **streams a headless Chromium running on the server**
  (~120 MB download into T3 home, sandboxed; `sudo t3 browser setup` on some Linux hosts). Tabs
  belong to the environment, keep working with no client connected, and reach `localhost` on the
  host. `docs/user/remote-access.md`, `apps/server/src/preview/ServerBrowser.ts`
- **Dev server discovery:** the thread details card lists web servers started by the thread's
  terminals or its Claude agent, with ports; click to open in the browser; **Stop** kills that
  server's process group (not on Windows). Configured local server URLs can be added.
  `docs/user/thread-sidebar.md`, `apps/server/src/preview/PortScanner.ts`
- **Feedback to the agent:** **Annotate preview** picks elements, regions or drawings; each becomes
  a composer chip with a cropped screenshot. Screenshot capture and **screen recording** (30/60 fps,
  optional key/mouse press overlay) from the toolbar (desktop tabs).
  `apps/web/src/components/preview/PreviewChromeRow.tsx`, `PreviewView.tsx`,
  `packages/contracts/src/settings.ts` (`browserRecording*`)
- **Agent browser tools** (gated by **Agent browser access**, default on, overridable per project;
  applies when an agent session next starts): `preview_open`,
  `preview_navigate` (URL or `environment-port`), `preview_snapshot` (accessibility tree with
  `aria-ref` locators, optional PNG), `preview_act` (click, type, hover, select, drag, upload,
  press, scroll), `preview_evaluate` (JS), `preview_wait_for`, `preview_resize`,
  `preview_set_appearance`, `preview_dialog`, `preview_status`, `preview_recording_start/stop`
  (≤50 MiB), plus `t3_preview_list/close`. Tabs have an owner; a human must **take control**
  before typing into an agent's tab and release it; the agent's cursor is drawn on the page.
  `apps/server/src/mcp/toolkits/preview/tools.ts`, `docs/user/remote-access.md`,
  `apps/web/src/components/preview/AgentBrowserCursor.tsx`
- **Profiles:** built-in Default (persistent) and Incognito plus up to 24 named profiles; agent tabs
  have separate storage. **Import browser sessions** copies cookies once from Chrome, Edge, Brave,
  Vivaldi, Opera, Arc, Helium, Firefox, Zen or Safari (keychain/Full Disk Access prompts; native
  `browser-secret` helper reads Chromium's key from libsecret on Linux). `docs/user/browser-import.md`,
  `packages/contracts/src/browserImport.ts`, `packages/contracts/src/browserProfile.ts`,
  `native/browser-secret/main.c`
- **Default browser (macOS):** T3 Code can be the system browser; links open as a tab in the
  current thread's browser panel or start a project-less thread with the page maximized; PR links
  open in the PR view. `docs/user/default-browser.md`
- Browser captures have their own retention in Storage cleanup. `docs/user/project-settings.md`

## 11. Visual replies (HTML renders) and MCP Apps

- Agents (any provider) can answer with a **self-contained HTML page** (chart, table, diagram,
  collage, mockup) shown in the thread above the reply, themed, sandboxed, zoomable/full screen.
  Tools: `html_preview` (screenshot + console output + content height via the server's headless
  Chromium) then `html_render`. Local images are embedded at publish time; pages are deleted with
  the thread. The headless Chromium that `html_preview` uses reaches the network only through a
  proxy that blocks private/local address ranges (from code).
  `docs/user/html-renders.md`, `apps/server/src/mcp/toolkits/html/tools.ts`,
  `apps/server/src/htmlRender/publicProxy.ts`
- **MCP Apps** (interactive UIs returned by MCP tools) render in place of the tool call; Codex only
  today. `docs/user/html-renders.md`

## 12. SnapShots (window capture into the prompt)

- Desktop feature, **off by default**: a global shortcut (default both Shift keys on macOS/Windows)
  captures the active window of any app and attaches it to the current draft with app name, window
  title, icon and optionally the window's **accessibility tree** ("Include app text") so agents
  can reason about controls and text. macOS, Windows and Wayland (GNOME extension, KDE helper,
  Hyprland/Omarchy helper with config edit review, Niri via gdbus, portal fallback); X11
  unsupported. `docs/user/snap-shot.md`, `docs/internals/linux-snap-shot.md`,
  `native/hyprland-snap-shot`, `native/kde-snap-shot`

## 13. Devices (mobile simulators) — brief

- **Device panel** streams a live iOS Simulator or Android Emulator next to a thread (start, tap,
  type, rotate, 3D view, fold controls, tools drawer for appearance, location, permissions).
  Agents use `device_*` MCP tools and the `agent-device` CLI when **Agents can use devices** is on
  (default off). Remote SSH device hosts; EAS hosts; Simlock hosts are **alpha** behind
  `simlockDeviceHostsEnabled`. `docs/user/devices.md`, `packages/contracts/src/settings.ts`

## 14. Files, search and editors

- **File browser and viewer** in the right panel: tree explorer, breadcrumbs, syntax-highlighted
  source, rendered Markdown/HTML/PDF/CSV/TSV/notebooks/Mermaid/fonts/Office/audio/images, large-file
  viewer, ZIP listing. Files outside the workspace open read-only. `docs/user/composer.md`,
  `apps/web/src/components/files/`
- **Editing workspace files in-app** with debounced autosave through `projects.writeFile`, and line
  comments that become review-comment chips. (from code)
  `apps/web/src/components/files/FilePreviewPanel.tsx`, `fileSaveSessions.ts`
- **Search:** file picker (`filePicker.toggle`, fuzzy path search ≤200 results) and project content
  search (`projectSearch.toggle`; case-sensitive, whole-word, regex; ≤500 matches); ignored-file
  listing. `packages/contracts/src/project.ts` (`ProjectSearchContentsInput`),
  `apps/server/src/workspace/WorkspaceSearchIndex.ts`
- **Open in external editor** (`shell.openInEditor`): Cursor, Trae, Kiro, VS Code, VS Code
  Insiders, VSCodium, Zed, Antigravity, JetBrains IDEs (IDEA, Aqua, CLion, DataGrip, DataSpell,
  GoLand, PhpStorm, PyCharm, Rider, RubyMine, RustRover, WebStorm), or reveal in the file manager;
  last-used editor remembered, `editor.openFavorite` shortcut. For remote environments it builds
  `vscode-remote://ssh-remote+…`, Zed `ssh://` and JetBrains Gateway URLs over Tailscale/mDNS
  hosts. (from code) `packages/contracts/src/editor.ts`, `apps/web/src/editorPreferences.ts`
- `filesystem.browse` / `filesystem.getMetadata` for path completion when adding projects.
  `packages/contracts/src/filesystem.ts`

## 15. Secrets

- **Code-host tokens** (GitHub, Bitbucket, GitCafe) are saved in the server's secret store,
  redacted in settings and never shown again. `apps/server/src/settingsSecrets.ts`,
  `packages/source-control-core/src/shared/definition.ts` (`hostCredentialSettingsFields`)
- **Secret providers:** 1Password is the only one. Configure an account (Settings → Secrets); then a
  provider instance's environment variable can be a reference like `op://vault/item/field`,
  resolved on the server with `op read`/`op inject` at launch, never stored. Values can also be
  marked sensitive. `packages/secret-provider-onepassword/`, `packages/contracts/src/providerInstance.ts`,
  `apps/web/src/components/settings/SecretsSettings.tsx`
- **`request_secret` agent tool:** the agent asks the user for a secret in a private card; the
  agent never sees it and gets a one-use `secretRef` (24 h TTL) for a tool that accepts it, or with
  `delivery: "file"` a path to an owner-only file to read in a shell command.
  `apps/server/src/secrets/SecretRequests.ts`, `packages/contracts/src/secretRequest.ts`,
  `apps/server/src/mcp/toolkits/orchestrator/tools.ts`

## 16. Points worth noting for a feature-by-feature comparison

- Worktree per thread is a choice, not the default (`local` unless configured), and worktrees can
  be shared and reused; cleanup is policy-driven and keeps branches.
- The integration is PR-centric: commit/push/PR from the thread, then review, merge, auto-merge,
  stack merges and branch updates happen **on the code host** through T3's PR view; there is no
  local "merge into master" step, no stash, no staging UI.
- Per-turn hidden-ref checkpoints give turn-scoped diffs and file rewind for worktree threads.
- Agents get first-class tools for PRs (link, watch with wake-ups, review guides), worktrees
  (handoff), projects (clone/create), the browser (Playwright-like automation), devices and
  secrets.
- Seven host integrations with very uneven depth: GitHub is the most complete (viewed marks on
  host, stacks, workflows approval, revert, agent-credit stripping); Azure DevOps has no comments;
  GitCafe has no line comments yet; Jujutsu is detected only.
