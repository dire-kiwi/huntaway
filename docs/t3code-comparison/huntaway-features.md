# Huntaway: feature inventory

What Huntaway does, area by area, written to be read next to the T3 Code inventory
([t3code-overview.md](t3code-overview.md)). Gathered from `README.md`, `app/src`, `app/electron` and
`server/src` at commit `90bb99b` (host API version 61, database schema 53). Paths are relative to the
repository root. More detail is in [huntaway-ui-details.md](huntaway-ui-details.md) (every page, card
badge, menu and shortcut) and [huntaway-server-details.md](huntaway-server-details.md) (CLI, API routes,
data model, how runs are launched).

## 1. What it is

- A **kanban board for coding agents**: every task is an agent thread (Claude Code's `claude -p`, or
  Codex through `codex app-server`) that moves through *Backlog → To do → In progress → Needs attention
  → In review → Ready for merge → Done*, usually in its own git worktree and branch. Clicking a card
  opens the thread, its changes, its review, a terminal and its details.
- **Self-hosted**: one Rust binary (`huntaway serve`: axum, SQLite, the agent runner, worktrees, the
  MCP helpers and the hub) serves a React + Vite UI on port 7878. An Electron shell
  (`app/electron/main.cjs`) wraps the same UI and starts the server if none is running. There's no
  hosted service, account system or telemetry.
- **Agents outlive the server.** Each run is started under `ia-shim` (`server/shim`), a tiny supervisor
  that detaches the agent and writes its output, pid and exit status to `<data dir>/runs/<run id>/`.
  The server only follows those files, so stopping, crashing, rebuilding or updating the server
  doesn't interrupt agents: the new process picks every unfinished run back up from where it had read.
  Board tool calls are retried under the same id and recorded, so none runs twice; permission prompts
  pending across a restart reappear.
- **One board across machines**: every `huntaway serve` is a *host* (its own database, runs its own
  agents) and a *hub* (serves the UI and can show other hosts). See §11.
- **Profiles** (e.g. *work* and *personal*) scope projects, tasks, agent logins, GitHub accounts and
  Asana tokens. The board shows every profile at once.

## 2. Agent runtimes and configuration

### Runtimes
- **Claude Code**: `claude -p --output-format stream-json --input-format stream-json` with
  `--append-system-prompt` (the board's instructions), `--permission-mode`,
  `--permission-prompt-tool mcp__huntaway__permission_prompt`, `--resume <session>`, `--model`,
  `--effort`, `--mcp-config`, `--allowedTools`/`--disallowedTools` and `--add-dir`
  (`server/src/runner.rs`). Partial messages stream to the UI token by token.
- **Codex**: `huntaway codex-run` drives `codex app-server` over JSON-RPC (`thread/start|resume`,
  `turn/start|steer|interrupt`, `thread/compact/start`, `model/list`, `skills/list`,
  `account/rateLimits/read`) and answers Codex's approval requests through the board
  (`server/src/codex.rs`). Its events are shown like Claude's: commands as Bash calls, file changes as
  diffs, the plan as a todo list, MCP calls under their server's name.
- No other runtimes: no Cursor, OpenCode, Gemini/Antigravity, ACP agents or direct API models.

### Agent configs and profiles
- An **agent config** is a Claude config directory (`CLAUDE_CONFIG_DIR`) or a Codex home (`CODEX_HOME`)
  on a host, so logins, settings and history stay separate. A thread's config decides which runtime
  runs it. Logging a config in is done on the host's CLI, or by **Copy login** from another host
  (credentials, settings, `CLAUDE.md`/`AGENTS.md`, skills, agents, commands, plugins, hooks, rules).
- A **profile** lists the configs its agents can use (the first is the default); a project can pick its
  own. The new task dialog asks which to use when there's more than one; a thread keeps its config, which
  can be changed until its agent first starts.

### Models, effort and permission modes
- **Model**: task → project → profile → host default. **Effort**: task → host default (`low`…`max`, and
  Codex's `minimal`/`ultra`). Codex configs list their models with efforts; Claude models are aliases or
  free text.
- **Six permission modes**, per host default, project and thread (selector under the composer;
  Shift+Tab cycles): *Ask* (`default`), *Accept edits*, *Auto* (Claude's classifier, Codex's
  `auto_review`), *Plan*, *Don't ask*, *Bypass*. They map to Claude's `--permission-mode` and to Codex
  approval policies and sandboxes, whose writable paths include the worktree, the repository's git
  directory and package caches (`~/.npm`, `~/.cargo/registry`, pnpm's store). A change applies from the
  next message; switching to Bypass or Don't ask also settles open prompts. Approving a plan
  (`ExitPlanMode`) drops the thread out of Plan mode.
- **Approvals**: in *Ask* mode a tool call becomes an approval card in the thread (*Allow*, *Always allow*
  for that thread, *Deny*, optionally with a note back to the agent). Prompts raised inside a subagent
  show on the parent thread and name the subagent.

### Skills, MCP servers and prompts
- **Skills and MCP servers kept on the host**, global (on or off per profile) or per project (stdio,
  HTTP or SSE servers; a server can allow all its tools). Skills and servers from elsewhere (the config,
  plugins, claude.ai connectors, the repository) can be turned off per project, using what recent runs
  reported having.
- **`/` skills menu** in the composer lists the skills the task's agent has, with descriptions
  (`$` for Codex). `/compact` summarises the conversation.
- **Prompts per column**: a project can replace the instructions sent when a task starts, when it's
  reviewed and when it's merged; the board keeps the parts it relies on around them.

### Threads, steering and context
- **Steering**: a message sent while the agent works goes to it after its current tool call, in the
  same turn (Claude stream-json input, Codex `turn/steer`). **Queued messages** are used where it can't
  steer and are sent as the next prompt; the ✕ takes one back for editing. **Stop** interrupts the turn
  (the session stays resumable) and kills the process after 10 seconds if needed.
- **Compaction**: `/compact` by hand, and on its own after 50 minutes idle while the prompt cache is warm
  (Claude only). The thread marks where it happened, and clicking that line shows the summary.
- **Context pill**: how full the context window is, with Claude Code's `/context` breakdown.
- **Usage**: what's left of each config's plan limits (session, weekly, per-model weekly), from
  Anthropic's usage endpoint or Codex's rate-limit reads, in the sidebar. Opt-in per config.
- **Cost** per run and task from Claude's `total_cost_usd` (Codex tasks show no cost); boards sort by it.
- **Titles follow the work**: a title is generated from the description (Haiku, or the Codex config's
  model) and asked again after each of your messages, keeping it unless the goal changed. A title renamed
  by hand is pinned.
- **Subagents** (Claude's and Codex's native ones) are rows in the thread with their state, prompt and
  transcript, can be opened as their own thread, and are counted by the **Agents** pill.
- **Attachments**: paste, drop or pick files (10 MB each) in the new task dialog or the composer. They're
  saved on the agent's host and listed by path in the prompt; the agent gets read access to them.
- **Paging**: long threads load the latest page and fetch older ones as you scroll up.

## 3. The board

- **Boards**: per project, per subproject, per project group, and per profile (every task of the profile
  across projects and hosts). Each has a kanban view and a list view (with collapsible sections and an
  *Archived* section).
- **Cards** show the key (`IA-12`), type and subproject badges, dependency and merge-queue state, the
  model of a fan-out sibling, the review state (*reviewing 1/2*, *N issues*…), star and reminder marks,
  a live working timer or *waiting* with the agent's reason, the attention reason (the agent's question,
  the permission it wants, the failure), branch and PR icons, the preview dot, Asana marks and cost.
- **Drag and drop** between columns and within one. Dropping into *In progress* starts the agent, into
  *Ready for merge* starts the merge, into *Done* sets the resolution. A right-click menu completes a task
  as *Done*, *Not done* or *Won't fix*, stars it, or sets a reminder.
- **Search, filter and sort** on every board (`/` focuses search): statuses, task types, projects, tasks
  with a running agent, a star, a PR or a reminder; sort by board order, activity, age, title or cost.
- **Archiving**: tasks done for two days leave the *Done* column for the list's *Archived* section.
  Projects can be archived (off every board, no new runs; tasks and worktrees kept).
- **Sidebar**: profiles with a bar of their tasks per state; *Starred* tasks; *Reminders* (an hour,
  tomorrow, next Monday or a picked time, with a note); the active profile's projects with running dots
  and *needs attention* / *ready to check* counts; groups (collapsible folders whose board shows all their
  tasks), pinned and hidden projects; plan usage; *N new commits · Restart*.
- **New task dialog** is a token editor: `/plan` (or `/subproject`, `/scratch`, `/artifact`, `/diagram`)
  picks the type, `@KEY` the project (`@group`, `@none`), `!model` the model (one task per `!`),
  `^high` the effort and `#IA-3` a dependency, with autocomplete, highlighting and a *Reads as* row that
  shows what will be made. Drafts are kept per destination; *Add another* keeps it open.

## 4. Kinds of task

- **Code task** (the default): its own worktree and branch, reviewed and merged.
- **Subproject**: a task whose branch collects the work of its own tasks. Its agent plans and creates
  them; each branches from and merges into the subproject's branch; it has its own board, and its column
  follows its tasks. Merged as a whole when they're done.
- **Group task** (`G-<n>`): plans work across a group's projects, creating and starting their tasks,
  without changing the repositories itself.
- **Scratch task** (`S-<n>`, or in a project): for questions, experiments, or running work with the board
  tools, in its own folder with read-only access to the project. No worktree, review or merge.
- **Document tasks**: **Plan** (`plan.html`, with the board's components and `<ia-question>` form fields
  you answer in place and send back), **Artifact** (`artifact.html`, a designed page) or **Diagram**
  (`diagram.mmd`, Mermaid, drawn with zoom, SVG download and a *Fix* button that sends parse errors back).
  Shown sandboxed as the agent writes, with a version per turn. An approved plan's agent can break it
  into tasks and its card counts them.
- **One prompt, several agents** (fan-out): each `!model` in a description makes its own task with that
  model and worktree (`!opus !gpt-5.5` gives one Claude and one Codex task). Siblings show each other's
  state and cost, to compare.
- **Dependencies**: a task waits (*queued*) until the tasks it depends on are *Done*, then starts.

## 5. Lifecycle automation

- **Automatic columns**: running → *In progress*; a question (`request_user_input`), a permission
  prompt, a failure or Stop → *Needs attention*; a clean finish → *In review*.
- **Reviews**: moving to *In review* starts reviewer agents on the branch's PR (or diff), read-only in the
  task's worktree, each in its own review thread, reporting with `submit_review`. Up to six reviewers per
  project (for example one Claude and one Codex, each with a model and effort). Serious issues go back to
  the task's agent as one round of fixes; after the project's fix rounds (default 2) it goes to *Needs
  attention*. Tasks without code changes aren't reviewed. *Review now* on demand. The review prompt quotes
  what you told the agent, so reviewers don't re-raise what you accepted.
- **Ready for merge**: the task's agent merges its PR (or branch) following the project's instructions,
  and moves the task to *Done*. One merge at a time per project (and per subproject), in column order.
  A task with nothing to merge goes straight to *Done*.
- **Status scripts**: bash run in the task's worktree when it moves into a column (or on every move), with
  `IA_OLD_STATUS`, `IA_NEW_STATUS`, `IA_TASK_KEY`, `IA_PR_URL`… (5-minute limit, output in the thread), for
  notifications, other trackers or clean-up.
- **Preview URLs**: a task's preview URL shows as a dot that turns green once it answers 200.
- **Restart and rebuild**: when the source checkout has new commits, *Restart* runs `npm install`, `npm run
  build` and `cargo build --release`, then re-execs the server; running agents carry on.

## 6. Agents orchestrating agents (board MCP tools)

- Every run gets the `huntaway` MCP server: `list_projects`, `list_tasks`, `get_task`, `get_task_field`,
  `create_task`, `update_task`, `send_to_task`, `delete_task`, `get_project`, `update_project`,
  `create_project`, `request_user_input` and `wait` (reviewers also get `submit_review`).
- Agents can create, start, message and update other tasks (with dependencies, subprojects, models,
  stars and reminders), so a subproject, group task, plan or scratch task can run a whole piece of work.
- **`wait`** blocks until watched tasks change status, a subagent finishes, a shell `command` exits (e.g.
  `gh pr checks 12 --watch`), a message arrives or the time is up, while the card shows *waiting* and the
  reason. It survives server restarts.
- **Across profiles and hosts**: a profile can let other profiles' agents use its board (off by default,
  one way). Board tools reach projects and tasks on linked hosts, so an agent can work across machines.
- **Guard rails**: project changes that matter (permission mode, scripts, repository path, worktree
  settings) and task deletions ask the user in a dialog over the whole app, whatever the thread's mode.
  Agents can't change a project's agent configs or GitHub account.

## 7. Git, worktrees and GitHub

- **Worktree per task** (`ia/<key>-<n>-<slug>`), created on first run from the latest base branch (its
  upstream is fetched first). Setup and teardown scripts get `IA_REPO_PATH`, `IA_WORKTREE_PATH`,
  `IA_BRANCH`, `IA_TASK_ID`… Teardown refuses with uncommitted changes unless you discard them and keeps
  the branch unless asked. A project can turn worktrees off; a task can too.
- **Remove merged worktrees** removes done tasks' worktrees when nothing would be lost (clean, and HEAD in
  the base branch or the head of a merged PR, squash and rebase merges included); it reports each one as
  removed or kept and why.
- **Changes tab**: one cumulative diff of the worktree against the merge base (commits, uncommitted and
  untracked files), with a commit list and per-file blocks. Read-only: no per-turn diffs, checkpoints,
  rewind, comments to the agent or git actions.
- **Pull requests**: on a GitHub repository the agent is told to commit, push and open a PR into the
  task's base branch before it finishes; the board finds the PR with `gh pr view` if the agent didn't set
  it and shows it on the card.
- **`gh` MCP server** for agents (`pr_create`, `pr_view`, `pr_checks`, `pr_merge`, `issue_*`, `run_*`,
  `api`, `gh`, `git_push`), run outside the agent's sandbox. Read-only calls run without asking. Claude
  runs get a hook that blocks `gh` in Bash. **Per-profile and per-project GitHub accounts** (GitHub
  Enterprise too): each call runs with that account's token only and is refused if it targets another
  host.
- **Projects**: add a folder or **clone from GitHub** (lists and searches the account's repositories);
  rename, change key (old keys still resolve), or move the repository folder (worktrees reconnected,
  conversations still resumable).
- GitHub only: no GitLab, Bitbucket or other forges, and no in-app PR review UI.

## 8. Terminals

- A task's **Terminal** tab is a shell in its worktree: a tmux session on the task's host (its own tmux
  server), so it outlives the browser and server restarts. Relayed through the hub for linked hosts.
  Copy reaches the browser's clipboard (OSC 52).
- **Terminal tools**: TUI programs (`lazygit`, `nvim`, a script) set up per host show as buttons next to a
  task's tabs and open in the task's directory.

## 9. Integrations

- **GitHub** through `gh` (§7).
- **Asana**: link tasks to Asana tasks (search as you type or paste a link); a picked task fills in the
  description, and the agent's first prompt lists the links. Per-profile token; can be turned off.
- Anything else through status scripts, project MCP servers and skills.

## 10. Analytics

- **Report**: time you spent prompting, per project and task, over a range, built from the threads'
  history (so it covers work from before it existed), with a chart per day, a prompt log and CSV export.
- **Calendar**: months or weeks, each day's timeline of your prompts and the agents' runs.
- **Disk**: space per project (repository, `.git`, worktrees, run folders, scratch folders) and per host
  database, with reclaimable worktrees marked.

## 11. Hosts and multi-machine

- **Three ways to link a host** (Settings → Hosts): *Add host* (the hub calls the host's URL with its
  token), *Connect from elsewhere* (`huntaway serve --hub … --hub-token …`: the host dials out, so no
  inbound port, suiting cloud VMs and NAT) and *Over SSH* (the hub gets a restricted `authorized_keys`
  line, starts `huntaway` on the target if needed and tunnels to it).
- Nothing about another host is stored on a hub beyond how to reach it, so any number of boards can show
  the same host. Events from every host arrive on one websocket tagged with the host.
- **Agent configs and profiles merge by name** across hosts; *Copy login* copies a config to another host.
- **Versions**: each host reports its API version and the oldest UI it serves; the board hides newer
  features for older hosts and marks them *outdated*, *too old* or *board too old*.
- **Update to <commit>** sends the hub's checkout to a host as a git bundle over the link, which then
  rebuilds and restarts with its agents running.
- A hub that can't run agents sends new scratch tasks to a chosen host.

## 12. Running it

- `huntaway serve` (`--host`, `--port`, `--data-dir`, `--name`, `--hub`, `--hub-token`, `--token`,
  `--demo`, `--open-token`), `huntaway token`, `huntaway ssh-host`; built from source with `npm` and
  `cargo` (no installers or packages yet; AppImage packaging is untested).
- **Access**: one bearer token per host (`?token=` once in the browser). Plain HTTP, so the README says to
  expose it only on a trusted network (Tailscale, VPN) or behind TLS.
- **Electron**: one window; starts or reuses a local server, or points at a remote one
  (`~/.config/huntaway/desktop.json`).
- Under systemd, `KillMode=process` keeps agents alive across service restarts.

## 13. UI conveniences and what's missing

- Task panel as a side panel beside the board or expanded into a dialog; Escape or a click outside closes
  it unless something is unsaved. Composer drafts and new-task drafts are kept per task in the browser.
- Live updates over one websocket; reconnects with backoff and refetches; offers *Reload* when the server
  serves a newer UI.
- Missing (from the UI sweep): browser, desktop or mobile notifications; sounds or badges; a mobile app or
  mobile layout; a light theme; a command palette or global shortcuts; bulk actions; syntax highlighting
  in threads; images from tool results; a structured card for `request_user_input`, `AskUserQuestion` or
  plan approval (they're answered by replying, or in a permission card); message copy, edit, retry, fork
  or rewind; in-app file browsing or editing; a built-in browser.
