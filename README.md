# Huntaway

A kanban board for orchestrating Claude Code and Codex agents. Every task is an agent thread
(`claude -p`, or `codex app-server` for Codex) that moves through **To do → In progress → Needs attention → In review → Ready for merge → Done**,
usually in its own git worktree. Click a card to see the full thread, reply to the agent,
approve tool calls, and review the diff.

```
server/        Rust (axum + SQLite): API, events, agent runner, worktrees, MCP helper, hub
server/shim/   ia-shim: tiny per-run supervisor that keeps agents alive across restarts
app/           React + Vite UI, wrapped by Electron (electron/main.cjs)
scripts/       test-server.sh: scratch server on a free port for testing a worktree build
               ia-api: calls to a test server's API (polling, approving prompts); ia-api-test.py
               fake-claude: stub `claude` for test servers (test-server.sh --fake-claude)
               clean-worktree.sh: remove a done task's worktree build output
               ui-profile.mjs: the UI's main-thread time on loads and live events, to compare builds
               copy-live-board.sh: a scrubbed copy of the live board's database for a test server
```

Agents survive server restarts, and one board can span several machines. Each machine runs
`huntaway serve` and keeps its own data; boards connect to each other (see *Hosts*).

Huntaway used to be called Issue Agent. A machine that ran it under that name keeps its data
where it was (`~/.local/share/issue-agent`, `issue-agent.db`, `~/.config/issue-agent/desktop.json`),
and the build still makes an `issue-agent` binary that starts `huntaway`, so hosts updating from an
older build, SSH host commands and desktop configs that name it keep working. Board tools from
before the rename (`mcp__issue_agent__…`) still show as board tools in old threads.

## Running

```sh
# 1. Build the UI (the server serves it) and the server + ia-shim
cd app && npm install && npm run build && cd ..
cd server && cargo build --release && cd ..   # builds huntaway and ia-shim side by side

# 2a. Desktop app: spawns the server if it isn't already running
cd app && npm run electron

# 2b. …or run the server directly and open the printed URL in any browser
./server/target/release/huntaway serve            # 0.0.0.0:7878
./server/target/release/huntaway token            # print the access token
```

UI development with hot reload: run the server, then `npm run dev` in `app/` (Vite proxies
`/api` to `127.0.0.1:7878`, override with `IA_SERVER`). Use `npm run electron:dev` to load the
dev server in Electron.

Faster Rust builds: install [sccache](https://github.com/mozilla/sccache) (`cargo install sccache
--locked`, or your package manager's) and `server/` builds through it (`server/.cargo/config.toml`),
so each task worktree reuses the dependencies another one already compiled rather than building
them again. Without sccache, or where it can't start its server (a sandbox with no network), cargo
runs rustc directly. `RUSTC_WRAPPER= cargo …` or `SCCACHE_DISABLE=1` turns it off; `sccache -s`
shows the hit rate. Debug builds also leave dependencies' debuginfo out, which keeps each
worktree's `target/` smaller.

The board shows every profile at once. The sidebar lists the profiles at the top, each with a bar
of how many of its tasks are in progress (blue), need attention (amber), in review (purple) and
merging or waiting to merge (pink), leaving out the columns with none. Clicking one opens the
**profile's board**: all of its tasks together, from every project and every host that has the
profile, with its group and scratch tasks. Its *New task* form picks the project, or makes a
scratch task.

The sidebar's project list is one profile's: the one whose board you opened last, which is marked
with a bar beside its name (its initial in colour, the others' grey) and named on the *Projects*
heading. It stays while you're on other pages, and opening a project it doesn't list (from a
link, or a starred task) moves it to that project's profile. Pin a project to keep it listed
whichever profile is active by right-clicking it and picking *Pin to every profile* (a group's
menu pins the projects it lists); pinned projects show a pin, and the initial of their own
profile when it's another one. The active profile and pinned projects are saved in this browser,
and the board opens on the active profile's board.

Add a project with the **+** by the *Projects* heading. Its *Folder* tab picks a folder on the
host (a repository, or a new folder that's created for it). Its *GitHub* tab (API 55) clones a
repository instead: it lists the ones gh can reach on the host as the profile's GitHub account (see
*GitHub accounts*), or gh's active account when it has none: those the account owns, collaborates
on or has contributed to, most recently pushed first. Typing filters them and also searches its
organizations' repositories by name (they aren't listed, as an organization can have thousands);
`OWNER/REPO` or a pasted github.com URL picks any other. The repository is cloned with
`gh repo clone` as that account, over the protocol gh is set up to use for the host (so SSH uses
the host's SSH keys, and any git config for the folder it goes in), into the profile's **clone
folder**, in a folder named after it (the path can be changed before cloning). Each profile sets
its clone folder per host in Settings → Profiles → Edit (`clone_dir`); it's `~/<profile name>`
(`~/work`, `~/personal`) until it's set. A folder that's already a clone of the repository is added as it
is, unless it's one of the profile's projects already. A clone that fails (its checkout too) is
taken away again, and a request for a folder that's being cloned into waits for that clone to be
added first. The dialog remembers which tab was used last. `GET /github-repos?account=&q=` lists or
searches the repositories and `POST /profiles/{id}/projects/clone` (`repo`, `repo_path`, `name`,
`key`) clones one and adds it.

Reorder projects in the sidebar by dragging their grip handles. With a handle focused,
Alt + Up/Down moves the project using the keyboard. Projects stay within their host group;
the order is saved in this browser.

Rename a project, change its key or point it at a moved repository folder in its settings (or
with the `update_project` tool, API 45). After a key change the old task keys (e.g. `OS-2`) still
find their tasks, and no other project can take them. A new repository path must be the same
repository (told by its worktrees, the commits its history started from, or its tasks' branches);
*Move the folder there* (`move_repo`) moves the folder itself, with the project's agents stopped.
Either way paths inside the folder (worktrees kept there, the worktrees folder) move with it, the
task worktrees are reconnected (`git worktree repair`), and conversations that ran in the old
folders can still be resumed.

Group projects by right-clicking one in the sidebar (or with *Group* in its settings). A group
shows as a collapsible folder with its projects underneath, and clicking it opens one board
(or list) with all of their tasks. Right-click a group to rename or ungroup it. Groups are
saved on the host, per project, so projects on different hosts are in separate groups; which
groups are collapsed is saved in this browser. Drag a group by its grip to move it with all
its projects; projects inside a group reorder within it.

Hide a project from the sidebar by right-clicking it and picking *Hide from sidebar* (a group's
menu hides all of its projects). Each host's hidden projects sit under a *N hidden* row at the
end of its list, which carries their counts and opens to show them; right-click one there to
show it again. A hidden project is only left out of the sidebar: its tasks are still on its
profile's and its group's boards. Hidden projects are saved in this browser.

Archive a project you're done with by right-clicking it and picking *Archive…*, or with *Archive
project* in its settings (API 46). It goes off the board for every browser: out of the sidebar, its
profile's and group's boards, and out of agents' `list_projects` (and `list_tasks` with `project_id='all'`).
It takes no new tasks and its agents don't start (messages, other agents' `send_to_task`, reviews
and idle compaction are refused; tasks waiting for their dependencies or a merge slot keep
waiting until it's unarchived), but its tasks, worktrees and branches are kept. It can't be
archived while one of its agents is running. Unarchive it in Settings → *Archived projects*, the only place it's
listed (its old board link says it's archived and points there).

Star a task (the star by its title, or *Star* in its card's right-click menu) to list it under
*Starred* at the top of the sidebar. Set a reminder to come back to a task with the bell beside its
tabs (or the card's menu): in an hour, tomorrow morning, next Monday or at a time you pick, with a
note on what for. Tasks with reminders are listed under *Reminders*, soonest first; once one comes
round it shows as due, counted on the section's heading, until you clear it or set a new time
(right-click it in the sidebar). Agents can do both too, with `starred`, `remind_at` (a delay
like `2h`, or a time) and `reminder` on `create_task` and `update_task` (API 48). Stars and
reminders are saved on the task's host; which of the two sections are collapsed is saved in this
browser.

A group's *New task* form can also start a **group task** (pick *Group task* in its project
picker). It isn't in any project: it sits on the group's board (keyed `G-<n>`, numbered across
the profile's groups; no project can use the key `G`, and one that had it moves to `GP`) and its agent
plans the work across the group's projects, creating and starting their tasks rather than
changing the repositories itself. Its card shows how many of the tasks it created are done,
and its details list them. It works in the profile's scratch folder with the group's
repositories readable, and follows its group when the group is renamed. A group whose
projects are all ungrouped or deleted stays in the sidebar (in italics) while it has group
tasks, so they can still be opened, resumed and deleted.

A task can also make a document instead of code: pick **Plan**, **Artifact** or **Diagram** at
the top of the *New task* form (a group task can be one too), or pass `type` to the
`create_task` tool. Its agent reads the project's repository (or the group's) but works in the
task's own folder (`<data dir>/documents/<task id>`) and writes one file there: `plan.html`, an
HTML plan to iterate on; `artifact.html`, a designed HTML page like a claude.ai artifact (the
agent uses the `artifact-design` skill when it has it, but the page stays on the board); or
`diagram.mmd`, a Mermaid diagram. It can write in its folder without asking. The task opens
on its document as the agent writes it: HTML in a sandboxed frame (its scripts run, but it
can't reach the board), a diagram drawn in the board with zoom, an SVG download and a button
that sends a parse error back to the agent. Reply under the document to ask for changes. The
board keeps a version from each turn that changed the file (`GET /tasks/{id}/document`, with
`?version=N` for an earlier one). There's no worktree, review or merge: moving one to *Ready
for merge* marks it done. Once you approve a plan, its agent can break it into tasks, and its
card shows how many of them are done.

A plan's agent asks what it needs to know as questions in the plan (`<ia-question>`: a choice of
one or several, a dropdown, or text, with an optional free-text *Other*, and any named form field
in the plan counts too). Answer them in the plan; the bar above the composer counts the answered
ones. Your answers are kept in this browser until you send them, so they last when the agent
changes the plan, or the board is reloaded (*Reset* puts back the plan's own). **Send answers**
sends them to the agent as a message, each question with its answer, and it updates the plan
with them. An earlier version's questions are shown but can't be answered.

A **scratch task** (pick **Scratch** in the *New task* form, or pass `type: "scratch"` to
`create_task`) is for whatever you ask its agent: questions, trying things out, or planning and
running work with the board tools. Its agent works in the task's own folder
(`<data dir>/documents/<task id>`). On a profile's board it starts out in no project (API 47): it
sits on that board, keyed `S-<n>` (numbered across the profile; no project can use the key `S`, and
one that had it moves to `SP`), with no repository. The form's project picker (*No project*, or a
project) moves it, and on a project's or subproject's board it's in that project (API 51, or with
`project_id` or `subproject` on `create_task`): numbered with the project's tasks, its agent reads
the repository (and the subproject's worktree) without changing it, and the tasks it creates go in
the subproject. A scratch task in a subproject isn't part of the subproject's work, so the
subproject's column and progress leave it out, and the subproject is merged without waiting for
it. Like a document task it has no worktree, review or merge: moving it to *Ready for merge*
marks it done. Scratch tasks replace the scratch chats of earlier versions:
those became done scratch tasks (in no project, whichever project they were in) that keep
working in their old folder, so their conversations carry on.

Run the UI regression tests with `cd app && npm test` (Node.js 22.6+).

### Server options

| Flag / env | Default | |
|---|---|---|
| `--host` / `IA_HOST` | `0.0.0.0` | Use `127.0.0.1` to disable network access |
| `--port` / `IA_PORT` | `7878` | `0` picks a free port (printed in the `IA_READY {"port": …}` line on stdout) |
| `--data-dir` / `IA_DATA_DIR` | `~/.local/share/huntaway` (`…/issue-agent` if only that exists) | DB, auth token, scratch folders, worktrees |
| `--ui-dir` / `IA_UI_DIR` | auto | Built UI (`app/dist`) |
| `IA_CLAUDE_BIN` | `claude` | Claude Code binary |
| `IA_CODEX_BIN` | `codex` | Codex binary |
| `--name` / `IA_NAME` | hostname | Name this host shows on boards |
| `--hub` / `IA_HUB` | | Hub(s) to dial out to (comma-separated or repeated) |
| `--hub-token` / `IA_HUB_TOKEN` | | Token for `--hub`, from that hub's Settings → Hosts |
| `--source-dir` / `IA_SOURCE_DIR` | checkout the binary was built in | Repository to rebuild from on restart |
| `--demo` / `IA_DEMO` | off | On a fresh data dir, create a "Default" profile with a sample "Demo" project and tasks (used by PR previews) |
| `--open-token` / `IA_OPEN_TOKEN` | off | Give the access token to any browser that opens the board, so it signs in without `?token=`. Anyone who can reach the server gets full control (used by LAN-only PR previews) |

### Agents survive restarts

Each agent run is started under `ia-shim`, which detaches it from the server and records its
output, pid and exit status in `<data-dir>/runs/<run_id>/`. The server only follows those files,
saving how far it has read. When it starts again it picks every unfinished run back up from
that point, so stopping, crashing or rebuilding the server doesn't interrupt agents.

A run's folder keeps everything the agent printed (every streamed delta, tool result and image),
which the thread no longer needs once the run is over, so the server removes it 14 days after
the run ends (`runs::KEEP_DAYS`), or as soon as its task is deleted. It checks every hour, and
also removes the recorded MCP calls of runs that ended over an hour ago.

The pieces that cross a restart are durable too:
- The agent's MCP helper retries each tool call under the same id until the server answers.
  The server records each call's result, so a call is never executed twice.
- Permission prompts are stored with the call that raised them. A prompt pending across a
  restart reappears, and the decision reaches the agent once it's made.

The shim is deliberately small and rarely changes. Shims that are already running never pick
up new code.

One caveat under `systemd`: by default a service restart kills its whole process group,
shims (and the tmux server behind terminals) included. Use `KillMode=process` (or run the shims in their own scope) to keep agents
alive across service restarts.

### Restarting after a merge

When the source checkout has commits the running server doesn't (for example, a task branch
merged to `master`), the sidebar shows **N new commits · Restart**. The same action is under
Settings → Server. It runs `npm install`, `npm run build` and `cargo build --release` in the
checkout, streaming the log, then re-execs the new binary with the same arguments, so the PID
stays the same and Electron or a supervisor keeps tracking it. Running agents keep going and
the new process picks them up. If a build fails, the old server keeps running.

### Network access

Every API call needs the token in `<data-dir>/auth_token` (sent as a bearer token; the
UI picks it up from `?token=` once and remembers it). Settings → Network access shows a
ready-made link. The token lets anyone holding it run agents on your machine, and traffic is
plain HTTP, so expose the server only on a trusted network (Tailscale, VPN) or behind a TLS
reverse proxy.

### Desktop config

`~/.config/huntaway/desktop.json` (all optional):

```json
{ "port": 7878, "dataDir": "~/.local/share/huntaway", "host": "127.0.0.1",
  "serverBin": "/path/to/huntaway",
  "serverUrl": "http://other-machine:7878", "token": "…" }
```

Setting `serverUrl` makes the desktop app a client of a remote server instead of starting one.
An `http:` one counts as a secure page in the app, so it can show notifications.
Packaging an AppImage: `npm run dist` (needs `electron-builder`; not exercised yet).

## Hosts

Every `huntaway serve` is a **host**: it keeps its own SQLite database with its profiles,
projects, tasks, agent threads and runs, and runs agents on its own machine. It is also a
**hub**: it serves the UI and can show other hosts on the same board. Nothing about another
host is stored on a hub beyond how to reach it, so any number of boards (your desktop, a
laptop somewhere else) can connect to the same host and see the same data.

Settings → Hosts offers two ways to link a host:

- **Add host** (the hub connects to the host): enter the host's URL and its token
  (`huntaway token` on that machine). This works whenever the hub can reach the host,
  e.g. over Tailscale.
- **Connect from elsewhere** (the host dials out to the hub): run
  `huntaway serve --hub http://<hub>:7878 --hub-token <token>` on the host (`https://` for a
  hub behind TLS; the host doesn't follow redirects). No inbound port
  is needed, which suits cloud VMs or machines behind NAT. The hub's requests are tunnelled
  back over that connection.

The UI reaches each host via `/api/h/<host_id>/…` on the hub, and events from every host
arrive on one websocket tagged with `host_id`. Agents' board tools act on their own host. A
project or task that isn't found there is looked up on linked hosts, and `list_projects` covers
every host, so an orchestrating agent can work across machines. On each host they reach their
own profile's board and those that let them in (see *Agents across profiles*).

A hub that can't run agents itself (no `claude` or `ia-shim`, e.g. a board-only deployment)
sends new scratch tasks to a linked host. Pick which one under Settings → Hosts →
**Scratch task host**; by default it's the first host that can run agents.

**Agent configs** and **profiles** (work, personal…) are configured on each host, and the
board merges them by name. Settings → Agent configs and Settings → Profiles show which hosts
have each. **Copy login** copies a Claude config's credentials, `.claude.json`, settings,
`CLAUDE.md`, skills, agents, commands, plugins and hooks (for a Codex config: `auth.json`,
`config.toml`, `AGENTS.md`, skills, rules and prompts) to another host, creating the config
there if needed. Session history and caches are not copied. (On macOS, Claude may keep
credentials in the keychain rather than `.credentials.json`; in that case log in on the target
host instead.)

**Versions.** Each host reports `api_version` (bumped with every API change) and
`api_compat` (the oldest UI it still serves). A board's UI is built against one API version,
and Settings → Hosts marks each host as current, **outdated** (older, so newer features are
hidden for it), **too old**, or **board too old** (the host needs a newer UI; update the hub).
API changes should be additive (new endpoints, optional fields); raise `api_compat` only
for a breaking change, after keeping the old behaviour for a while. The run directory files
and the MCP call shape are stable formats too: shims and helpers started by an older build
keep running after an upgrade.

**Updating hosts.** For a linked host that runs different code, Settings → Hosts offers
**Update to <commit>**. The hub packs its checkout's current branch into a git bundle and sends
it over the link, so no git remote or inbound access is needed. The host fast-forwards its own
checkout (it refuses if the checkout is dirty, on another branch, or has diverged), then
rebuilds and restarts like Rebuild & restart; agents keep running. Hosts from before
versioning need one manual update (`git pull`, then Rebuild & restart).

**Agent defaults** (Settings): each host has a default model, effort (`--effort`) and
permission mode for its agents. A model set on a thread, project or profile, or a permission
mode set on a thread or project, takes precedence.

### Codex agents

A thread whose config is a Codex one runs `huntaway codex-run` under ia-shim instead of
`claude -p`. That adapter starts `codex app-server`, starts (or resumes) the thread's Codex
thread, sends the prompt, steers messages sent meanwhile into the turn (`turn/steer`), and exits
when its input ends with no turn going. Codex's events are kept in the run's
output as they are, and the server shows them like Claude's: commands as Bash calls, file
changes as diffs, the plan as a todo list, MCP calls under their server's name. The board's MCP
tools, the project's MCP servers and skills, `/compact`, steering, stopping (`turn/interrupt`), queued messages and
reviews work the same.

Codex's native subagents appear in the thread and **Agents** list with their own transcripts,
permissions and lifecycle status, including nested agents and follow-up work on the same child.
Ask explicitly, for example: "Use two subagents to inspect the server and app, then combine their
findings." [Current Codex releases enable subagents by default](https://learn.chatgpt.com/docs/agent-configuration/subagents); Huntaway respects the Codex
config's `agents.enabled` setting and concurrency limit. Subagents share the task's worktree
and inherit its permissions and MCP servers.

Codex asks for approval through the board, like Claude's permission prompts. Permission modes
map onto Codex's approval policy and sandbox (writes stay in the working directory, the
repository's git directory and package caches such as `~/.npm`, `~/.cargo/registry` and
`~/.local/share/pnpm` (or where `CARGO_HOME`, `XDG_CACHE_HOME` and `XDG_DATA_HOME` put them),
which are made before the run if they don't exist yet, with network access):

| Mode | Codex |
|---|---|
| Ask | asks before anything but known-safe commands (`untrusted`) |
| Accept edits | edits in the sandbox go ahead, asks to leave it (`on-request`) |
| Auto | Codex's own reviewer decides (`on-request`, `auto_review`) |
| Plan | read-only sandbox, Codex's plan mode |
| Don't ask | never asks; what the sandbox blocks fails (`never`) |
| Bypass | no sandbox, never asks (`danger-full-access`) |

Reviewers run in a read-only sandbox that can still write the temp directories, the package caches
and the worktree's git-ignored directories (such as `target` or `node_modules`, but not `.claude`
or `.codex`), so they can build the work and run its tests without being able to change it. This
uses a Codex permission profile (`huntaway-review`, a beta feature); a Codex that doesn't take it
gets a plain read-only sandbox. A thread's model and effort are Codex's own (the new task
dialog lists the config's models); Claude models set on its project, profile or host are
skipped. Auto-compacting idle sessions is Claude-only.

## Concepts

- **Agent configs** are Claude Code config directories on a host, passed to agents as
  `CLAUDE_CONFIG_DIR`, or Codex homes, passed as `CODEX_HOME` (API 25), so logins, settings and
  history stay separate. A thread's config decides which agent runs it (see *Codex agents*).
- **Profiles** (work / personal) scope projects and tasks, and pick which Claude
  configs their agents can use (the first is the default). A project can pick its own instead.
  When more than one is available, the new task dialog asks which to use. A thread keeps the
  config it was created with (it can be changed under Details until its agent first starts),
  and its review thread uses the same one unless the project's reviewers pick another.
- **One prompt, several agents** (API 61), as t3code sends a prompt to several models: each
  `!model` in the new task dialog's description makes a task with that model, so `!opus
  !gpt-5.5` makes two tasks from one prompt, one on Claude Code and one on Codex. `!` takes any
  model of the configs the task can use (the picked config's first), `!<config>` a config's
  default model, and `!<model>.<config>` a model that more than one config has (`!opus.work`).
  Code tasks made this way each get their own worktree and branch. They share a `fanout_id`, so
  their cards show which model each ran with, and each one's Details list the others with their
  state and cost, to compare them.
- **Agents across profiles** (API 23): each profile has its own board, and agents' board tools
  see their own profile's. A profile can let other profiles' agents use its board too: edit it
  under Settings → Profiles and tick them under *Agents from other profiles* (or *Every
  profile*). It's off by default, so work and personal stay apart until you open one up, and it's
  one way: letting personal agents into work doesn't let work agents into personal. Those agents
  can then list, read, create and change the board's projects and tasks, and message its tasks'
  agents. `list_projects` labels each project with its profile. Projects and tasks are named by
  id or key. A key means the agent's own board if it's there, else the one other board that has
  it. A key that's on several other boards must be qualified, as `work:SD-3` or with the tools'
  `profile` argument. A task created on another profile's board belongs to that profile and runs
  with its Claude config and login. Agents are told which profiles' boards they can't use, so they
  ask rather than create a project that may already be there. The setting is per host, and is
  checked by name, so on a linked host it applies to agents from the profile of that name
  anywhere on the board.
- **Usage:** the sidebar shows how much of each config's plan limits (session,
  weekly, per-model weekly) is left, for the configs the sidebar's profile and its projects use. It's off until
  *Show usage* is ticked on a config in Settings → Agent configs (API 52): the endpoint's rate
  limit is per account, and every copy of a login (PR previews, test servers) would otherwise
  ask too. Each host reads the config's login (`<config dir>/.credentials.json`) and asks
  Anthropic's usage endpoint every few minutes (for Codex configs it asks `codex app-server`),
  and agent runs update it live. The login is never refreshed by the board. An expired login
  shows its last numbers until the config's next agent run renews it. Hosts before API 52
  don't show usage.
- **Context** (API 40): a thread's *Context* pill shows how full its agent's context window is,
  following each reply as it works. Clicking it opens the breakdown Claude Code's `/context`
  shows (system prompt, tools, MCP servers, memory files, skills, messages, free space and the
  autocompact buffer). The board asks the agent for it at the end of each turn (a
  `get_context_usage` control request), so it's as of the last turn. It asks for the summary: the
  total is the last reply's usage and the parts are Claude Code's local estimates, rather than
  `/context`'s recount with the token-counting API. Codex agents only report the total.
- **Projects** are local repositories. Each has a key (`ABC-12`), a scratch folder, a worktrees
  folder, setup/teardown and status change scripts, a permission mode and an optional model.
- **Skills and MCP servers** (API 21, 22): skills (a `SKILL.md` each) and MCP servers for
  agents, kept on the host rather than in a repository. **Global** ones (Settings → Skills and MCP
  servers) are switched on or off by default per profile. A project can override that in its
  settings (*Profile default*, *On* or *Off*), and it can have its own skills and servers, which
  win over a global one with the same name. Before each run, the skills that are on are written to
  `<data-dir>/projects/<id>/agent/.claude/skills/`, which the agent gets with `--add-dir`. The
  servers are added to the run's `--mcp-config` next to `huntaway`. A server can allow all of
  its tools, so they never ask for approval. Skills and servers that come from elsewhere (the
  Claude config, its plugins, claude.ai connectors, the repository) can be turned off per project.
  They're denied with `--disallowedTools` (`Skill(<name>)`, `mcp__<server>`). The settings list
  what the project's runs reported in their `init` message over the last two weeks, and anything
  else can be turned off by name. Changes apply from each thread's next message.
- **Tasks** start their agent when you press Start, drag the card into *In progress*, or tick
  "Start agent now". The first prompt is the task title and description. Replies resume the
  same Claude session (`--resume`). While the agent works, the card shows how long it has been
  working instead of when it was last active (API 15).
- **Titles** follow the work. A task created from a description alone gets a title using its
  agent and login: Haiku for Claude (`claude -p --model haiku`), or the Codex config's model for
  Codex. Each message you send it after that (not the board's own, nor
  other agents') asks again, with the title, the description and all of your messages (each
  with the end of what the agent said before it), for a title for what the task is about now. It
  answers `KEEP` unless the user has given the task a different goal: details, questions, feedback
  and routine steps (continue, review, rebase, merge) leave the title alone, and a message that's
  only links or attached files isn't asked about. A title renamed by hand (double-click it in the task
  panel, or `update_task`) is pinned and stays as it is; the pin next to it lets it follow the
  messages again (`title_pinned`, API 49). The branch keeps the name it was given.
- **Steering:** a message sent while the agent is running goes to it straight away, as in Claude
  Code (API 28). The agent reads it once it finishes its current step (the tool call it's in) and
  carries on in the same turn; until then it's shown above the composer, and then in the thread
  where the agent read it. One that arrives as the turn ends starts the next turn of the same run.
  Runs read stream-json input for this (`--input-format stream-json`; `turn/steer` for Codex):
  the shim passes the run directory's `input.jsonl` on to the agent after the prompt, and the
  server ends that input when a turn ends with no message waiting, so the run ends as before.
  **Stop** asks the agent to end its turn (an `interrupt`) rather than killing it, so the session
  stays resumable; a message it hadn't read yet then starts its next turn. If it hasn't ended the
  turn within 10 seconds, its process is stopped. Messages from other agents (`send_to_task`) are
  steered the same way.
- **Queued messages:** where a message can't go to the running agent (a `/compact` run, a run
  started before steering, a task waiting on its dependencies) it's queued (shown above the
  composer; more messages are added to it) and sent as the next prompt when the run ends, so the
  card stays in *In progress*. Press **Stop** to stop the run and send the queued message straight
  away, or the ✕ on it to take it back for editing. Messages the agent never read (its run ended
  first) are sent the same way. The card's working timer keeps counting through queued messages.
- **Attachments:** paste, drop or pick (📎) images and other files in the new task dialog or a
  thread's composer (API 18). Each file is uploaded to the host that runs the agent, saved under
  `<data-dir>/attachments/<id>/<name>` (10 MB at most), and listed by path at the end of the
  description or message, so the agent reads it with its Read tool. Agents get `--add-dir` on
  that folder, so reading attachments needs no approval. The board shows the files as thumbnails
  and chips rather than paths. A task's files are deleted with it, and files that no task or
  message refers to (abandoned drafts, removed chips) are deleted after a week.
- **Compacting:** reply `/compact` (optionally followed by instructions for the summary) to have
  Claude Code summarise the conversation so far, so later prompts start from a smaller context.
  It doesn't move the card. A session is also compacted on its own after 50 minutes with no new
  prompts, while its prompt cache (1 hour) is still warm. Sessions idle longer than an hour (for
  example while the host was down) and tasks in *Done* are left alone. The thread shows where it
  was compacted; click the line to read the summary.
- **Skills** (API 54): type `/` at the start of a message to pick one of the skills the task's
  agent has, with what each does (also `/compact`). Arrow keys move, Enter or Tab picks, Escape
  closes the menu. A Claude agent gets `/name arguments`, which Claude Code runs as at its own
  prompt; as a task's first message it goes before the task, which becomes part of its
  arguments. A Codex agent gets `$name` (also typed to open the menu), which tells it to use that
  skill. For Claude, the list (`GET /api/tasks/{id}/skills`) is the skills the project's last run
  with the task's config reported (the ones a user can call), and those in the config's and the
  repository's skills folders by folder name, less any changed since to `user-invocable: false`;
  descriptions also come from installed plugins and synced skills. Codex's host lists its own
  (with the repository's `.agents/skills`). Both add the project's own and global skills, less the
  ones it turns off. The menu reloads when the task moves to another config.
- **Status transitions:** running → *In progress*; the agent asks a question
  (`request_user_input`), a tool needs approval, a run fails, or you stop it → *Needs
  attention*; a run finishes cleanly → *In review*. You move cards to *Done* yourself, or to
  *Ready for merge*.
- **Archived** (API 53): a task that's been in *Done* for two days is archived. It leaves the
  kanban board's *Done* column, which links to it ("N archived"), for the list view's *Archived*
  section, the last one, which starts collapsed. It's still done (a task that depends on it
  still counts it as merged). Drag it back into *Done* to bring it back for another two days, or
  to another column to reopen it. Tasks keep when they were done in `done_at`; hosts from before
  that go by when the task last changed.
- **Search, filter and sort:** each board's header (a project's, a subproject's, a group's or a
  profile's; on a narrow board, a row below it), in both views, has a search field (`/` goes to it, Escape clears it) that matches
  every word typed in a task's key, title, description, branch or project. *Filter* picks
  statuses (which leaves the other columns or sections out), types of task, projects (on a
  group's or profile's board) and tasks with a running agent, a star, a pull request or a
  reminder; filters of one kind match any of their values. A bar under the header then shows how
  many tasks are left and each filter, to take off. Each board keeps its search and filters for
  the browser tab; *Sort* (the board's own order, latest activity, newest, oldest, title or cost)
  is kept for every board. A task dropped below a filtered column's last card goes after that
  card; sorted other than by hand, a drop only moves a task to another column, at its end.
- **Waiting** (API 36): an agent with nothing to do until something happens (the tasks it
  created, CI, a deploy) calls the `wait` tool (`reason`, `seconds`, `tasks`) instead of sleeping,
  polling or ending its turn. The call blocks until the first of: the wait period is over (10
  minutes unless given, an hour at most; for a wait with neither `tasks` nor a `command`, 30
  seconds by default and at most, since little else can end it early: a longer one is turned
  down with a note to give a command or wait 30 seconds at a time), one of the tasks in `tasks` changes status (or is
  deleted), one of its subagents completes, fails or stops, the shell command in `command`
  exits (API 41, see below), a message is sent to the agent (yours or `send_to_task`), the run is stopped, the
  task is moved to another column from the board or with `update_task` (*Needs attention* too;
  the board's own moves there and back for a subagent's permission prompt don't count), or the run carries on with other work: another board tool
  call (from the agent or its subagents) or a tool call of the agent's own thread (Claude or
  Codex). Its subagents' other tool calls and permission prompts don't count, so an agent can
  wait for its subagents. It then tells the agent which, with the watched tasks' state,
  and the agent can wait again. For a subagent it returns `ended: "subagent_finished"` with
  its `tool_use_id`, status and summary in `subagent`. Meanwhile the task stays in its column (it isn't waiting on you,
  so it's not *Needs attention*), and the card, list and thread show *waiting* with the agent's
  reason instead of *working*. The waiting state lasts exactly as long as the call, however it returns
  (failing that, until the turn or run ends), and is kept as the task's `agent_wait`, apart from `waiting`
  (queued for dependencies). A server restart doesn't start a wait over: the agent's MCP helper
  retries the call, which carries on until the same deadline, watching the same tasks (one
  deleted meanwhile ends it). Planning agents (subprojects and
  group tasks) are told to wait for the tasks they started this way rather than end their turn.
  - `command` lets the agent wait for what the board can't see (CI, a deploy, a file): the server
    runs it with bash in the agent's working directory, and the wait ends when it exits, telling
    the agent its exit code and the last 4000 bytes of its output. A command can block until
    it's ready (`gh pr checks 12 --watch`) or loop until it is (`until curl -sf …; do sleep 15;
    done`). It's approved like one of the agent's Bash calls (a permission prompt in the thread,
    unless the thread's mode or *Always allow* for Bash decides). In *Auto* mode the agent's
    own reviewer checks it instead: Claude runs there don't pre-approve `wait` as they do the
    other board tools, and Codex runs set its `approval_mode` to `prompt`, so each wait call,
    command included, goes through Claude's classifier or Codex's `auto_review` reviewer and
    the board doesn't ask again. (If Codex leaves the call to the user, the adapter asks the
    board about the command.) It runs in a process group of its
    own that's killed when it exits or the wait ends first, and starts again from the beginning
    when a server restart retries the call. A watchdog in its group kills it once the server
    that started it is gone, however it went (restarting, exiting or crashing), so a restart
    doesn't leave the old copy running. It's kept in `agent_wait.command` and shown with the
    wait.
- **Ready for merge:** moving a task there (once its agent has stopped) asks its agent to merge
  the work: its pull request if there is one, otherwise the branch, following the project's own
  instructions. The card stays in *Ready for merge* while the agent works. If the agent needs
  approval or asks a question, the card goes to *Needs attention* and comes back afterwards. When
  the merge is done, the agent moves the task to *Done*. If the agent stops without doing that,
  the task goes to *Needs attention*. A project merges one task at a time (and each subproject
  one of its tasks at a time): tasks moved there while another is merging show *queued to merge*
  and start in column order (top first) once it ends.
  A task with nothing to merge (no commits on its branch beyond its base and no uncommitted
  changes, or no worktree at all) skips the merge and goes straight to *Done*.
  A merge waiting on you in *Needs attention* still holds the queue; move it to another column to
  let the next one go. You can't message a queued task's agent until it's its turn.
- **Dependencies:** a task can depend on other tasks in its project (*Depends on* in its
  sidebar, the new task dialog, or `depends_on` in the agents' `create_task`/`update_task`).
  Moved to *In progress* (or started) before they're all merged, it shows *queued* and its agent
  doesn't start. Messages sent to it meanwhile are queued for it. Once every task it depends on
  is *Done* with resolution *Done* (closing one as *Won't fix* or *Not done* doesn't count),
  its agent starts. Deleting a task it depends on, or taking it off the list, also lets it go.
  Moving a queued task out of *In progress* takes it out of the queue.
- **Reviews:** when a task moves to *In review* (its agent finished, or you moved it), a reviewer
  agent reviews its branch's pull request (or the branch's diff if there's no PR) in a review
  thread of its own, working read-only in the task's worktree. The card shows *reviewing* while
  it runs, then the outcome; click it, or *Review thread* in the task's sidebar, to read the
  reviewer's thread or ask it about its findings. Only code changes are reviewed: if the branch
  has no commits of its own, the task is only reviewed if, since the last review, its agent
  edited files (and that succeeded), committed, pushed, opened a pull request or wrote files with
  a shell command such as `sed -i` or a redirect (outside scratch places such as `/tmp`), or the
  worktree has uncommitted changes (or, before the first review, the task has a pull request).
  Files a script writes from its own code (such as `python3 -c '...'`) aren't noticed. The task's
  activity says why it wasn't reviewed otherwise, and *Review now* reviews it anyway. Then the agent worked somewhere else, such as in another repository, so the
  reviewer is given the agent's last message and the task's pull request, if any, to find and
  review the changes, and passes the task if there were none. The review prompt also quotes what
  you told the task's agent in its thread (each message after what the agent said before it), so
  reviewers don't raise again a limitation you accepted or an option you turned down. The
  reviewer reports with `submit_review`.
  Serious issues go back to the task's agent to fix, which it may push back on by asking you
  (`request_user_input`, so the task goes to *Needs attention*). When it finishes, the new commit
  is reviewed again. After the project's *Fix rounds* (default 2) in a row, a review that still
  finds serious issues moves the task to *Needs attention* instead. A commit that was already
  reviewed isn't reviewed again (unless its review found issues and the branch has no commits, as
  the fixes are then elsewhere), and a review in progress is stopped when the task's agent
  starts working again. The card stays in *In review* while it's reviewed, and only goes back to
  *In progress* when the agent works on it again (to fix the issues found, or because you sent
  it a message). *Review now* in the task's sidebar reviews on demand, once the agent has
  stopped; a task in *In progress* or *Needs attention* moves to *In review* for it. Turn reviews off,
  or set the rounds, in the project's settings (API 12).
- **Several reviewers** (API 29): a project's settings can list more than one reviewer under
  *Reviewers*, each an agent config with an optional model and effort (for example one Codex and
  one Claude, or Fable and Opus). By default there's one, with the task's own config. Each reviews
  in a review thread of its own, all at once; the card shows how many have finished, and the
  task's sidebar shows each one's findings and links its thread. Once they've all finished, the
  serious issues they found go to the task's agent together, as one round of fixes. The review
  passes when they all pass; if none found issues but one failed or was stopped, the review
  failed. A reviewer keeps its thread from one review to the next, and changing its config, model
  or effort starts a new one. `update_project` takes `reviewers` too.
- **Prompts:** the project's settings show the instructions in the prompts the board sends as a
  task moves across it, and each can be replaced: *In progress* is sent to the task's agent when
  it starts, after the task's title and description (and before any message it was started
  with); *In review* tells the reviewer what to look for; *Ready for merge* tells the agent how to
  merge. The board keeps the parts it relies on around them (which branch, how to report a
  verdict, setting the task to done). A prompt left as the default (or cleared) follows the
  default, which `GET /default-prompts` returns. Agents can read and change them with
  `get_project` and `update_project` (API 27).
- **Project changes by agents** (API 44): `update_project` changes any project setting but its
  agent configs, which only the user changes; agents can't delete projects. Its name, key, base
  branch, model, prompts, reviews and group change straight away. A change to its permission
  mode, a script (setup, teardown or status), its repository path or its worktree settings first
  asks the user: a dialog over the whole app (and a card in the agent's thread) shows each
  setting's old and new value and the agent's reason, and the call waits for the answer. Nothing
  changes unless they approve, whatever the thread's permission mode, and an approval is never
  "always". What counts as a change is what the project would be after it (the update is made
  and rolled back), and only those settings are written. Agents on other hosts can't ask for
  these. `GET /project-approvals` lists the ones waiting. From API 45 a new repository path is checked before asking
  (it must be the same repository, or with `move_repo` a free path to move the folder to), and
  approving `move_repo` moves the folder.
- **Task deletions by agents** (API 58): `delete_task` deletes a task (and a subproject's tasks)
  as the task panel's *Delete* does, but only once the user confirms it. Like a project change, it
  asks in a dialog over the whole app and a card in the agent's thread, showing the task, the
  tasks deleted with it, whether its branch goes too (`delete_branch`) and the agent's reason. The
  call waits for the answer whatever the thread's permission mode, and deletes nothing unless they
  confirm. Agents can't delete their own task or the subproject they're in, reviewers don't get
  the tool, and agents on other hosts can't ask for it. Only the tasks the user was shown are
  deleted: if a subproject gains tasks while the user is asked (or a task becomes one), the call
  deletes none of them and the agent has to ask again. No task can be added to a subproject while
  it's being deleted (by an agent or from the board), since it would go with it. A task deleted
  some other way while the user is asked settles the question. `GET /project-approvals?all=true` lists these with the
  project changes waiting.
- **Worktrees:** by default each task gets `ia/<key>-<n>-<slug>` in its own worktree, created on
  first run (or from the task panel). A new branch starts from the latest base branch: its
  upstream (or, without one, the branch of the same name on `origin`) is fetched first, and the
  branch starts from it whenever the local base branch is behind, even if that can't be
  fast-forwarded (it's checked out with changes in the way) or has diverged. The local branch is
  fast-forwarded when it can be, and is used as it is when it's ahead (with unpushed commits)
  or has no upstream. The task's log says which it started from. The setup script then runs there with `IA_REPO_PATH`,
  `IA_WORKTREE_PATH`, `IA_BRANCH`, `IA_TASK_ID`, `IA_TASK_NUMBER` and `IA_PROJECT_KEY` set.
  Teardown runs the teardown script and removes the worktree. It refuses while there are
  uncommitted changes unless you choose to discard them, and keeps the branch unless asked.
  Agents are told to commit to their branch.
  **Remove merged worktrees** in a project's settings (API 39,
  `POST /projects/{id}/remove-merged-worktrees`) removes the worktrees of its done tasks when
  nothing in them would be lost: no uncommitted or untracked files, including changes to tracked
  files marked assume-unchanged or skip-worktree (ignored files, such as build output, don't
  count and go with the worktree), and HEAD is in the base branch, locally or
  upstream (fetched first), or is the head of the branch's merged pull request (squash and rebase
  merges, asked of `gh`). Worktrees an agent or reviewer is working in are left alone. It lists
  each done task's worktree as removed or kept, and why. The tasks and their branches are kept;
  if a task's agent runs again, its worktree is set up again in the same folder (named from its
  branch), so its conversation carries on.
- **Notifications**: Settings → Notifications picks how the browser tells you about tasks on
  every board it shows (other profiles' and other hosts' too): *Off* (the default),
  *Notifications* (the system's), *Sound* (a chime) or *Both*, and for which events: a task that
  needs attention (a question, a permission prompt or a failed run), one that's ready to review
  (in review once its automatic review passes, or with none to wait for; it has to stay so for
  5 seconds, as a review or a run can start straight after), and optionally Ready for merge and
  Done. A notification shows the task's key, title and reason, and clicking it opens the task.
  *Enable* asks the browser for permission. Browsers only show notifications for secure pages
  (HTTPS or localhost), so a board opened over plain HTTP on a LAN address can't have them, and
  the section says so; the sound needs a click or key press on the page since it loaded. One of
  the browser's tabs or windows notifies, and none do for the task open in a focused window,
  for tasks that were waiting already when the page loaded or reconnected, for a move you made
  yourself or a run you stopped. The tab title (`(2) Huntaway`) and icon count the tasks that
  need attention, and the desktop app shows the count on its dock or taskbar badge. The settings
  are kept in the browser.
- **Status scripts** (API 37, 38): a project's status scripts run with bash when one of its
  tasks moves to another column, whoever moved it (you, its agent, a review or a merge), e.g. to
  send a notification, update another tracker or clean up a finished build. Each column has its
  own script, run when a task moves into it, and the *Any column* script runs on every move,
  before the column's. They run in the background in the task's worktree (the repository when it
  has none), one at a time per task in the order the changes happened, and each is stopped after
  5 minutes. Its output, or why it failed, goes in the task's thread. They get the setup script's
  variables (`IA_WORKTREE_PATH` is empty without a worktree) and `IA_OLD_STATUS`, `IA_NEW_STATUS`
  (`backlog`, `todo`, `in_progress`, `needs_attention`, `in_review`, `ready_for_merge` or
  `done`), `IA_TASK_KEY`, `IA_TASK_TITLE`, `IA_RESOLUTION` (when done) and `IA_PR_URL`. The API
  has the column scripts in `status_scripts` (`{"done": "…"}`) and the any-column one in
  `status_script`.
  This repository's own project frees a done task's worktree build output (`server/target`,
  `app/dist`, about 2 GB each) with this *Done* script:

  ```bash
  "$IA_REPO_PATH/scripts/clean-worktree.sh" "$IA_WORKTREE_PATH"
  ```

  `scripts/clean-worktree.sh` only cleans linked worktrees, never the main checkout the daemon
  runs from, and keeps `node_modules`. A task that's reopened builds again from scratch.
- **Subprojects:** a task can be a subproject (pick **Subproject** at the top of the new task
  dialog, pass `type: "subproject"` or `is_subproject` to `create_task`, or *Make it a subproject*
  in a task's sidebar). It's a task like any other, with its own worktree, thread, changes, review
  and pull request into the project's base branch, and clicking its card opens it beside the board.
  The card also shows how many of its tasks are done, and its **Board** button (or *Board* in the
  task's header) opens the subproject's own board of tasks, as a kanban board or a list. The
  subproject's branch collects its tasks' work: each task gets a worktree branched from
  it (the subproject's worktree is set up first if needed), its agent is told to open its pull
  request against that branch (pushing the branch if the remote doesn't have it yet), and
  *Ready for merge* merges it there instead of the project's main branch. The subproject's own
  agent plans and coordinates: tasks it creates with `create_task` go in the subproject, and
  `list_tasks` lists them. The subproject's column follows its tasks (and its own agent), by
  priority: *Needs attention* if any of them is waiting on you, else *In progress* if any is being
  worked on, else *In review* once they're all in review or merged (tasks still to do don't
  count). It stays in review after the last one is merged, and its card then says so. Moving it
  to *Ready for merge* or *Done* is up to you. When they're done, the subproject is merged as a
  whole like any other task (its agent asks first if some of its tasks aren't done). Deleting a
  subproject deletes its tasks. Subprojects don't nest (API 17).
- **Terminals:** a task's *Terminal* tab opens a shell (xterm.js) in its worktree, or where its
  agent runs if it has none. It is a tmux session on the task's host, on a tmux server of its
  own (`tmux -L ia-<host id>`, so your other tmux sessions aren't touched, though `~/.tmux.conf`
  still applies). The session outlives the browser and server restarts, ends when the shell
  exits or with **End**, and is killed when the worktree is torn down or the task deleted.
  `CLAUDE_CONFIG_DIR` is set to the task's Claude config. The host needs `tmux` installed. Terminals
  on linked hosts are relayed by the hub (API 7). Copying in tmux reaches the browser's
  clipboard (OSC 52); Shift+drag selects in the browser instead.
- **Terminal tools:** TUI programs or scripts (`lazygit`, `nvim`, `~/bin/review.sh`…) set up on
  a host's page (Settings → the host → *Terminal tools*) show as shortcuts next to a task's
  tabs. Each opens in its own tmux session in the task's directory, run through your login
  shell (so it gets your usual `PATH`). Unlike the shell, a tool session lasts only while a
  board has it open: the board renews it every 30 seconds while the app is open, and the host
  ends tool sessions that nobody is attached to and nobody has renewed for 90 seconds.
  Reloading the page keeps them. **Close** ends one straight away. If a tool exits with an
  error, the message stays on screen until you press Enter (API 13).
- **Permissions:** in *Ask* mode, Claude's permission prompts are routed
  (`--permission-prompt-tool`) to an approval card in the thread: Allow, Always allow (for
  that thread), or Deny.
- **Permission modes:** each host has a default mode (its agent defaults), each project can
  set its own (Settings, or *Host default*), and every thread can override it from the selector under the message box (Shift+Tab cycles Ask → Accept edits →
  Auto → Plan). Modes map to Claude's `--permission-mode`: *Ask* (`default`), *Accept edits*,
  *Auto* (Claude's classifier), *Plan*, *Don't ask* (deny anything not already allowed) and
  *Bypass*. A change applies from the next message, except that switching to Bypass or Don't ask
  also settles prompts in the current run. Approving a plan (`ExitPlanMode`) moves a thread
  in Plan mode back to its default mode (Ask if that's Plan too).
- **Analytics** (sidebar) tracks when you prompted which project and task, for timesheets. It's
  built from the threads' own history (your messages, starting a task, moving it to *Ready for
  merge*, and agent runs), so it covers work from before it existed, across every host with the
  profile. Messages from other agents (`send_to_task`) and the board's own prompts (review fixes)
  don't count. Active time credits each prompt with the time since your previous one on any task,
  up to a break (30 minutes by default), and the first prompt after a break a few minutes (5 by
  default); both are adjustable. The *Report* tab filters by time range and project, with a chart
  per day, totals per project and task, a prompt log and a CSV export (one row per day and task).
  The *Calendar* tab shows months or weeks, and each day's timeline of your prompting and the
  agents' runs (API 16). The *Disk* tab shows how much space each project takes up on its host:
  its repository (and how much of that is `.git`), each task's worktree, its agent runs' folders
  (output and logs, kept 14 days after a run ends) and its scratch folders, as `du` counts them,
  and each host's database (API 59). Worktrees of done tasks, and worktrees of a project's repository in its
  worktrees folder that no task on the host has, count as reclaimable; click a worktree to open its task and remove it there. The
  folders are measured when the tab first opens and again on refresh (API 35).
- **Subagents:** each subagent Claude or Codex starts is a row in the thread
  showing whether it is running (in the foreground or background), done, failed or stopped. Expand
  the row to read its prompt and transcript. They are read-only: you reply to the parent thread,
  and stopping the parent stops its subagents. The **Agents** pill in the header counts running
  and finished subagents and jumps to each. A permission prompt raised inside a subagent shows
  on the parent thread and names the subagent that asked.

### Agent tools (MCP)

Each run gets the `huntaway` MCP server (`huntaway mcp`, configured per run):
`list_projects`, `list_tasks`, `get_task`, `get_task_field`, `create_task`, `update_task`, `send_to_task`,
`delete_task` (once the user confirms), `get_project`, `update_project` (a project's settings), `create_project`,
`request_user_input`, `wait` (block until something happens, showing the task as waiting; see
*Waiting*), plus the internal `permission_prompt`. Review threads
also get `submit_review`. `create_task` takes `subproject` (add the task to one; agents in a
subproject add to theirs by default) and `is_subproject` (or `type: "subproject"`, API 51), and
`list_tasks` takes `subproject`.

From API 59, helpers that advertise `get_task_field` receive a bounded overview from `get_task`:
small fields stay inline, `field_lengths` lists every available field's length, and
`omitted_fields` names those left out. Values over
1,000 serialized bytes are omitted, with a 6,000-byte budget for inline values in total. Read
any field with `get_task_field`, for example
`{"task_id":"IA-132","field":"last_message","offset":0,"limit":2000}`. Follow its
`next_offset` until it is null. Offsets and lengths count Unicode characters, starting at zero;
the default limit is 2,000 and the maximum is 4,000. String fields return plain text in
`content`; other fields (such as `review` and `created_tasks`) return pretty JSON, including
`null` for a null value, with `format` saying `text` or `json`. Pages reflect the current field
value, so a task changing between calls may change them. Both tools use the same profile access
and task-key resolution as other board tools. The helper opts in with `task_fields: true` in
the internal MCP request, which is carried through forwarded requests outside the tool arguments.
Older helpers and linked hosts omit it and keep receiving full details, so upgrading only the
serving host does not hide content from callers that cannot use `get_task_field`. For newer
helpers reading linked hosts before API 59, the calling host summarizes or slices the legacy
`get_task` response before returning it to the agent.

Each run also gets the `gh` MCP server (`huntaway gh-mcp`), which runs the GitHub CLI for the
agent. MCP servers run outside Claude Code's Bash sandbox, where `gh` and `git push` often can't
reach GitHub or the user's login, so these work either way. They run in the agent's working
directory (or `dir`, or against `repo`): `pr_create`, `pr_view`, `pr_list`, `pr_checks`,
`pr_diff`, `pr_comment`, `pr_edit`, `pr_merge`, `issue_view`, `issue_list`, `issue_create`,
`issue_comment`, `run_list`, `run_view`, `api` (`gh api`), `gh` (any gh command) and `git_push`.
The read-only ones run without asking; the rest go through permission prompts like any tool, and
review threads don't get them. The exception is `pr_merge` while a Claude task is merging (moved
to *Ready for merge*, including while that merge waits in *Needs attention*): it runs without
asking then, so a merge doesn't stall when auto mode's check fails to answer. Reviewers find the
pull request with these tools rather than `gh` in the shell, and Codex agents are told to use them
for GitHub: `gh` in Codex's sandbox may not reach GitHub or the user's login, and Codex's own
GitHub app (the `codex_apps` server's `github_*` tools) only reaches repositories the ChatGPT
GitHub app was installed on. A project can turn the server off like any other (it's listed
under its MCP servers once a run has had it), or replace it with a server of its own named `gh`.
It needs `gh` installed and signed in (`gh auth login`) on the host.

While a run has this server, agents are told to use it rather than the gh CLI. Claude runs also
get a PreToolUse hook (`huntaway gh-hook`, passed with `--settings`) that denies Bash commands
running `gh` (`cd x && gh pr view`, `$(gh …)`, `bash -c 'gh …'` and the like) and says to use the
tools instead. Codex has no such hook, so Codex agents are only told. A project that turns the
server off, or has its own `gh`, gets neither.

**GitHub accounts.** gh can be signed in to several accounts on a host (`gh auth login` once for
each), and each profile can pick which one its agents act as there (*GitHub account* in Settings →
Profiles → Edit, per host); a project can pick its own in its settings, overriding the profile's.
The default is gh's active account. The run passes the account to the `gh` server
(`IA_GH_ACCOUNT`), which runs each call with that account's token (`gh auth token --user`) and no
other credentials, so switching gh's active account doesn't matter. gh gets a config folder of its
own for the call (`GH_CONFIG_DIR`, private to the user and removed afterwards) with a login for the
account's host only, so it has no token for any other host, whatever the call names; no tokens in
the environment; `GH_HOST` set to the account's host; and on Linux no session bus, so it can't
fall back on the system keyring's logins. A call that goes to another host is refused before it
runs: `--hostname`, a repository given as `HOST/OWNER/REPO` or a URL with `--repo` (or `--source`,
`--branch-repo`), and the arguments that say where the command goes, which gh's own help for the
command tells apart (a pull request's or issue's URL, an API endpoint's, a repository as
`HOST/OWNER/REPO`, `[USER@]HOST:PATH` or a URL). What the call only says (a body, fields, a search
query, a repository's homepage) doesn't count. One about a repository whose remotes are on another
host fails.
`git_push` takes a remote's name, all of whose push URLs (as git rewrites them) must be on the
account's host; it uses the account's token over HTTPS, and pushes over SSH use the host's SSH
keys (or the SSH alias the remote names). The host's own gh calls for a task (finding its pull
request, checking a merged one before removing its worktree) and the commands of the agent's
`wait` calls use the same account. A wait's command doesn't get the token: `gh` on its `PATH` is a
script that runs `huntaway gh-run`, which checks each call's targets as the tools do and runs gh
with the token. An account that isn't signed in to gh fails the tool call
(and a `wait` with a command, without running it) with a message saying so, and the host skips its
own lookups. `GET /github-accounts` lists the accounts gh is signed in to on a host
(API 50), and profiles and projects take `github_account` (a login, or `HOST/LOGIN` for a GitHub
Enterprise host; null for the default). Agents can't change it with `update_project`.

### Pull requests

The board doesn't prompt the agent when its task goes to *In review*: that happens when its run
ends. Instead, an agent working on its own branch in a repository on GitHub is told up front
to open a pull request before it finishes, unless the project's own instructions (such as its
CLAUDE.md) say otherwise: commit, push the branch and open the PR into the task's base branch
(the subproject's branch for a subproject's task), or push to the PR the branch already has. A
task with no changes on its branch doesn't need one. The repository counts as on GitHub when the
remote it pushes to is on github.com: the base branch's upstream remote, or else `origin` (or the
only remote), by its push URL. The PR goes in the repository the branch is pushed to, which the
agent names with `gh pr create --repo … --head …`, since gh would otherwise pick one from the
remotes' fetch URLs (so a fork's PR goes into the fork, not its upstream). Agents in a worktree in other repositories are told not to push unless asked, and
tasks without a worktree (working in the repository's own checkout) don't open pull requests.

A task can carry its pull request's URL, shown on its card as a pull request icon next to the
branch icon that links to it. Its agent can set it (`pr_url` via `update_task`), or set it under
Pull request in the task's sidebar. Otherwise, whenever a run of a task with a branch ends and
the task has none yet, the host looks it up with `gh pr view <branch>` (if `gh` is installed and
signed in; with `--repo` for the GitHub repository the branch is pushed to, as above), so a PR the
agent opened shows up without it saying so.

### Preview URLs

A task can carry a preview URL (Preview in the task's sidebar, or `preview_url` via
`update_task`), for example its PR's preview deployment. While the task is *In review*, its card
shows a dot linking to it: yellow until the URL answers `200`, then green. The server the board
is served from checks it every 2 seconds while the board is visible.

### Asana tasks

A task can be linked to the Asana tasks it's for (API 57): **Link Asana task…** under Asana in
the task's sidebar, or **Link Asana task** in the New task form, opens a dialog that searches the
user's Asana workspaces as you type (with nothing typed, the tasks Asana ranks first for them)
or finds the task whose link is pasted. Picking one in the New task form with nothing written
yet fills the description in from the Asana task's name and notes. Linked tasks show as Asana's
mark on the task's card, and its agent's first prompt lists them after the description.

Asana is reached with a personal access token per profile, kept on the host (Settings → Profiles
→ Edit, or the dialog asks for one the first time). Saving it checks it with Asana; the board only
ever sees who it belongs to (`asana_user`). `PATCH /profiles/{id}` takes `asana_token` (null
disconnects), `GET /profiles/{id}/asana/tasks?q=` searches, and tasks take `external_links`
(`[{provider: "asana", id, url, title}]`) when they're created and in `PATCH /tasks/{id}`.
`IA_ASANA_URL` points the host at another Asana API, such as a fake one for testing.

A profile that doesn't use Asana can turn it off (API 60): **Link tasks to Asana tasks** under
Asana in Settings → Profiles → Edit, or `asana_enabled: false` in `POST /profiles` and
`PATCH /profiles/{id}`. Profiles have it on until it's turned off. Off, the New task form and the
task sidebar leave Asana out (a task linked before still lists its links in the sidebar, so they
can be removed), and the host won't search Asana for it. Its token is kept for when it's on again.

## License

MIT; see [LICENSE](LICENSE).
