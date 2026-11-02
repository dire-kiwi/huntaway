# Huntaway server: CLI, API, data model, and what the README leaves out

Detail behind [huntaway-features.md](huntaway-features.md), the Huntaway inventory.

Source: `master` at `90bb99b`.
Paths are relative to `server/` unless they say otherwise. Items marked **(README)** are already described
in `README.md` and are kept to a line here.

Version numbers at this commit:

| What | Value | Source |
|---|---|---|
| Host API version (`API_VERSION`) | **61** | `src/proto.rs` |
| Oldest UI a host still serves (`API_COMPAT`) | 1 | `src/proto.rs` |
| Hub tunnel protocol (`PROTOCOL`) | 1 | `src/proto.rs` |
| SQLite schema (`PRAGMA user_version`) | 53 | `src/db.rs` (`open`) |
| Run directory format (`RUN_FORMAT`) | 2 | `src/runs.rs` |

---

## 1. CLI

One binary, `huntaway` (clap, `src/main.rs`), plus `ia-shim` (`shim/src/main.rs`) and a compatibility
`issue-agent` binary (`src/bin/issue-agent.rs`). No subcommand means `serve` with defaults.

| Subcommand | Flags / args | What it does |
|---|---|---|
| `serve` | `--host`/`IA_HOST` (`0.0.0.0`), `--port`/`IA_PORT` (7878; 0 = free port), `--data-dir`/`IA_DATA_DIR`, `--ui-dir`/`IA_UI_DIR`, `--source-dir`/`IA_SOURCE_DIR`, `--name`/`IA_NAME`, `--hub`/`IA_HUB` (repeatable or comma-separated), `--hub-token`/`IA_HUB_TOKEN`, **`--token`/`IA_TOKEN`** (fixed access token, e.g. a deployment secret; not in the README's table), `--demo`/`IA_DEMO`, `--open-token`/`IA_OPEN_TOKEN` | Runs the server and serves the UI. Prints a machine-readable `IA_READY {"port","token"}` line for Electron (`token` is null when it came from `IA_TOKEN`, which is also kept out of the logs). `src/main.rs` |
| `mcp` | none | Stdio MCP server spawned by each agent run: lists the board tools and relays each call to `POST /api/internal/mcp`, retrying under the same call id while the server restarts. Reads `IA_URL`, `IA_TOKEN`, `IA_RUN_ID`, `IA_REVIEW`. `src/mcp.rs` |
| `gh-mcp` | none | Stdio MCP server that runs `gh` for agents outside their sandbox (reads `IA_CWD`, `IA_GH_ACCOUNT`). `src/gh_mcp.rs` (README) |
| `gh-hook` (hidden) | none | Claude Code PreToolUse hook that denies `gh` in Bash. `src/gh_mcp.rs` (README) |
| `gh-run` (hidden) | trailing gh args | `gh` shim on a `wait` command's PATH: checks targets, runs gh as the task's account. `src/gh_mcp.rs` (README) |
| `codex-run <spec>` (hidden) | path to `codex.json` | The Codex adapter: drives `codex app-server` over JSON-RPC for one run (started under ia-shim). `src/codex.rs` |
| `ssh-host` | `--port` (7878), `--data-dir`/`IA_DATA_DIR`, `--name` | Forced command for a hub's SSH key: starts `huntaway serve --host 127.0.0.1` through the login shell if no host answers on the port, then prints `{port, token, started, info}` as JSON. `src/ssh.rs` (not in README) |
| `title-check` (hidden) | `--db <copy of a db>`, `--steps`, `--input`, task ids | Debug tool: prints the titles tasks would get now (each step after each user message with `--steps`; the model input with `--input`) without changing them. `src/title.rs` |
| `token` | `--data-dir`, `--hub` | Prints the host's access token, or with `--hub` the token other hosts use to dial in (`hub_token`). `src/main.rs` |

Other binaries and environment:

- `ia-shim <run-dir> -- <program> [args…]`: detaches (own session/process group), feeds `prompt` (then
  `input.jsonl` lines until `input.closed`) to stdin, appends stdout to `out.jsonl`, stderr to `err.log`,
  writes `pid` and, at exit, `exit` (JSON). Deliberately dependency-free apart from libc. `shim/src/main.rs`
- `issue-agent`: execs the `huntaway` next to it with the same arguments. `src/bin/issue-agent.rs` (README)
- Environment variables read besides the flags: `IA_CLAUDE_BIN`, `IA_CODEX_BIN` (README), **`IA_GH_BIN`**
  (gh binary), **`IA_COMMIT`** (commit a deployment without a checkout reports), `IA_ASANA_URL` (README),
  `SHELL` (terminal tools, SSH-started hosts), `RUST_LOG`-style filter via `tracing_subscriber`
  (default `huntaway=info`). `src/main.rs`, `src/codex.rs`, `src/gh_mcp.rs`, `src/admin.rs`.

---

## 2. API surface

All routes are under `/api` (`router` in `src/api.rs`). 61 `.route` entries on the host API plus 13 on the
hub/top level; most carry several methods.

**Auth** (`auth` in `src/api.rs`): one bearer token per host (`Authorization: Bearer <token>`, or
`?token=` on any request, which the websockets use). No users, roles or scopes. CORS is fully permissive
(`CorsLayer::permissive`, `src/main.rs`). Unauthenticated: `GET /api/health`; `GET /api/hub/connect` takes
the separate `hub_token`; `GET /api/open-token` exists only with `--open-token`. Unknown `/api` paths get a
JSON 404 `no such API route: …` instead of the UI (`no_route`).

| Group | Routes | What they enable |
|---|---|---|
| Host info & settings | `GET /info`; `GET,PATCH /settings`; `GET /default-prompts` | Host id/name, build id, `api_version`/`api_compat`, commit, whether it can run agents and which CLIs (`agent_clis`), data dir, home. Settings: `default_model`, `default_effort`, `default_permission_mode`, `scratch_host`, `terminal_tools`. Default start/review/merge prompt text. `src/api.rs`, `src/prompts.rs` |
| Profiles | `GET,POST /profiles`; `PATCH,DELETE /profiles/{id}` | Profiles with their agent configs, default model, `agent_access`, `github_account`, `clone_dir`, `asana_token`/`asana_enabled`. `src/api.rs` |
| Agent configs | `GET,POST /claude-configs`; `PATCH,DELETE /claude-configs/{id}`; `GET /claude-configs/{id}/models`; `GET,POST /claude-configs/{id}/archive`; legacy `GET,POST /profiles/{id}/claude-config` | Claude/Codex config dirs (`agent`, `show_usage`); Codex model list with efforts (Claude configs list none); export/import a config as a base64 tar.gz (256 MB body limit) for **Copy login**. `src/api.rs` |
| Projects | `GET,POST /profiles/{id}/projects` (`?archived=true` lists archived); `POST /profiles/{id}/projects/clone`; `GET,PATCH,DELETE /projects/{id}`; `POST /projects/{id}/remove-merged-worktrees` | Create from a folder or a GitHub clone, change every setting (key, repo path + `move_repo`, scripts, reviewers, prompts, group, archive…), delete with tasks and worktrees (branches kept), clean merged worktrees. `src/api.rs`, `src/relocate.rs`, `src/worktree.rs` |
| Boards / task lists | `GET,POST /projects/{id}/tasks` (`?kind=task` default, `review` for review threads); `GET,POST /profiles/{id}/tasks` (POST = scratch task); `GET,POST /profiles/{id}/group-tasks`; legacy `GET /profiles/{id}/scratch` (always empty now) | Project board, profile board, group tasks; create a task with title, description, status, model, effort, config, `start`, `depends_on`, `task_type`, `parent_id`/`subproject`, `external_links`, `fanout_id`, star/reminder. `src/api.rs` |
| Tasks | `GET,PATCH,DELETE /tasks/{id}` (`?delete_branch=true`) | `GET` returns `{task, last_message, pending_permissions}`. `PATCH` takes title (pins it), description, status/resolution (moves trigger runs, reviews, merges, status scripts), position, worktree use, model, effort, base branch, permission mode, preview/PR URLs, external links, subproject, config, dependencies, star, reminder. `src/api.rs` |
| Threads / messages | `GET,POST /tasks/{id}/messages` (`?before=&after=&limit=` pages, API 56); `POST /tasks/{id}/stop`; `DELETE /tasks/{id}/queue` | Read the thread (whole or paged, with the subagent rows that precede a page); send a message (starts, steers or queues); stop (interrupt, then kill after 10 s, and stop a review); take back a queued message. `src/api.rs`, `src/runner.rs` |
| Review, worktree, diff | `POST /tasks/{id}/review`; `POST /tasks/{id}/worktree/setup`; `POST /tasks/{id}/worktree/teardown` (`force`, `delete_branch`); `GET /tasks/{id}/diff` | Review now; create/remove a task's worktree; the task's diff (see 4.7). `src/review.rs`, `src/worktree.rs` |
| Agent introspection | `GET /tasks/{id}/context`; `GET /tasks/{id}/skills`; `GET /usage` (`?refresh=true`) | Context-window summary and `/context`-style breakdown; slash-command/skill menu; plan-limit usage per config. `src/context.rs`, `src/agent_tools.rs`, `src/usage.rs` |
| Documents | `GET /tasks/{id}/document` (`?version=N`) | A plan/artifact/diagram task's document and its version list. `src/documents.rs` |
| Skills & MCP servers | `GET /agent-tools`; `POST /agent-tools/switches`; `POST /agent-tools/skills`, `PATCH,DELETE /agent-tools/skills/{skill}`; `POST /agent-tools/mcp-servers`, `PATCH,DELETE /agent-tools/mcp-servers/{server}`; `GET,PATCH /projects/{id}/agent-tools` and the same skill/server CRUD under `/projects/{id}/agent-tools/…` | Global and per-project skills and MCP servers, profile/project on-off switches, turning off outside skills/servers. `src/agent_tools.rs` |
| Permissions & approvals | `GET /permissions` (`?task_id=`); `POST /permissions/{id}` (`decision`: `allow`, `allow_always`, `deny`; optional `message`); `GET /project-approvals` (`?all=true` adds task deletions) | Answer tool prompts, project-setting changes and task deletions agents asked for. A deny can carry a note back to the agent. `src/api.rs`, `src/permissions.rs` |
| Agent tool plumbing | `POST /internal/mcp`; `POST /tools/{tool}` | The MCP helper's calls (may block on a prompt); board tools forwarded from an agent on another host. `src/tools.rs` |
| Terminals | `GET,DELETE /tasks/{id}/terminal` (`?tool=`); `GET /tasks/{id}/terminal/ws` (`?cols=&rows=&tool=`); `POST /tasks/{id}/terminal/keepalive` | tmux-backed shell or terminal tool per task over a websocket; tool-session lease renewal. `src/terminal.rs` |
| Attachments | `POST /attachments` (JSON `{name, data: base64}`, 16 MB body, 10 MB file); `GET /attachments/{id}/{name}` | Upload/download prompt attachments (JSON so they travel through a hub). `src/attachments.rs` |
| Analytics & disk | `GET /profiles/{id}/analytics?from=&to=`; `GET /profiles/{id}/disk-usage` | Prompt/run events for time tracking; per-project disk usage and the DB size. `src/analytics.rs`, `src/disk.rs` |
| GitHub | `GET /github-accounts`; `GET /github-repos?account=&q=` | gh logins on the host; repositories to clone. `src/gh_mcp.rs`, `src/github.rs` |
| Asana | `GET /profiles/{id}/asana/tasks?q=` | Search or resolve a pasted Asana task URL. `src/asana.rs` |
| Filesystem | `GET /fs/dirs?path=` | Folder browser for picking a repository on a remote host (lists hidden folders, flags git repos, reports missing paths as creatable). `src/api.rs` |
| Admin / restart / update | `GET /admin/server`; `POST /admin/restart` (`rebuild`, default true); `POST /admin/update` (`commit` + `bundle` + `branch`, or `commit` alone) | Running commit, source checkout state, new commits, running agent count, restart job log; rebuild & re-exec (or plain re-exec with `rebuild: false`); fast-forward to a hub's bundle or fetch a commit from the host's own `origin`. `src/admin.rs` |
| Hosts (hub side) | `GET,POST /hosts`; `PATCH,DELETE /hosts/{id}`; `GET /hosts/join`; `GET /hosts/ssh-key`; `POST /hosts/ssh`; `POST /hosts/copy-claude-config`; `POST /hosts/{id}/update`; `ANY /h/{host_id}/{*rest}` | List/link/rename/unlink hosts (HTTP, inbound tunnel, SSH), the dial-in command line, the hub's SSH public key, copy a config between hosts, push an update, and proxy any host route. `src/hub.rs`, `src/ssh.rs` |
| Hub misc | `GET /preview-status?url=` | Server-side check of a preview URL (the browser can't read cross-origin status). `src/api.rs` |
| Event websockets | `GET /host/ws` (this host's events); `GET /ws` (merged events from every host, tagged `host_id`); `GET /hub/connect` (host dial-in tunnel) | Live UI updates and the hub link (see 4.5, 4.10). `src/api.rs`, `src/hub.rs` |
| Health | `GET /health` | `{ok: true}`, unauthenticated (used by `ssh-host`). `src/api.rs` |

---

## 3. Data model

SQLite in WAL mode with `synchronous=NORMAL`, `foreign_keys=ON` and a 5 s busy timeout, one connection
behind a mutex (`AppState::db()`, `src/state.rs`; schema and migrations in `src/db.rs`). The file is
`<data dir>/huntaway.db` (or `issue-agent.db` from before the rename). JSON-valued columns are stored as
TEXT.

| Table | Holds |
|---|---|
| `profiles` | name, `claude_config_ids` (JSON list, default first), `default_model`, `agent_access` (JSON names or `*`), `github_account`, `clone_dir`, `asana_token`/`asana_user`/`asana_enabled`. |
| `claude_configs` | name, `config_dir`, `agent` (`claude` or `codex`), `show_usage`. |
| `projects` | profile, name, `key`, `former_keys`, `repo_path`, `repo_root` (fingerprint), `scratch_path`, `worktrees_root`, `base_branch`, setup/teardown scripts, `status_script` + `status_scripts` (per column), `use_worktrees`, `permission_mode`, `model`, `claude_config_ids`, `auto_review`, `review_rounds`, `reviewers` (JSON), start/review/merge prompts, `group_name`, `archived_at`, `github_account`, `next_number`. |
| `tasks` | Every thread: board tasks, review threads (`kind='review'`, `parent_id` = reviewed task) and scratch/group/document tasks. Columns: number, title (+`title_pinned`), description, `status`, `resolution`, `done_at`, `position`, worktree fields (`use_worktree`, `worktree_path`, `branch`, `base_branch`, `worktree_state`, `worktree_error`), `session_id` (Claude session or Codex thread), `running`, `run_started_at`, `merging`, `attention_reason`, `depends_on`, `waiting`, `agent_wait` (JSON), `queued_message`, `queued_user_text`, `steering` (JSON), `steerable`, `model`, `effort`, `permission_mode`, `claude_config_id`, `auto_allow` (Always-allowed tools), `preview_url`, `pr_url`, `external_links`, `fanout_id`, `starred`, `remind_at`, `reminder`, `review` (JSON), `context`/`context_detail` (JSON), `parent_id`, `subproject`, `group_name`, `created_by`, `task_type`, `document_at`, `work_dir`, `cost_usd`, timestamps. |
| `messages` | Thread entries: `kind` = `user`, `claude` (an agent event, Claude stream-json or Codex translated to that shape), `event` (board info lines), `permission` (approval cards); `data` JSON. |
| `permission_requests` | Pending/answered prompts: `kind` = `tool`, `project` (agent-requested project change), `delete_task`; `status` = `pending`, `allowed`, `denied`, `expired`; tied to the MCP `call_id` and the thread message. |
| `runs` | One agent process: `kind` (`prompt` or `compact`), `status` (`preparing`, `running`, `exited`), `out_offset` (how far its output was read), `stop_requested`, `stop_id`, `between_turns`, `attention`, `result_error`, `saw_result`, `cost_usd`, timestamps. |
| `mcp_calls` | Board tool calls by call id with their result, so a retried call isn't executed twice. |
| `documents` | Versions of a plan/artifact/diagram (`version`, `content`, `open` while the turn writing it is going). |
| `links` | Linked hosts: `mode` (`outbound` = hub dials the host, `inbound` = host dialled in, `ssh`), `url`, `token`, `ssh` (JSON target), `last_seen`. |
| `settings` | Host key/value settings (agent defaults, scratch host, terminal tools). |
| `agent_skills`, `agent_mcp_servers` | Global (`project_id` NULL) and per-project skills (`SKILL.md` content) and MCP server configs (`stdio`/`http`/`sse`, `auto_allow`). |
| `agent_tool_switches` | Per-profile and per-project on/off switches for global skills/servers. |
| `project_agent_tools` | Per-project turned-off outside skills/servers and what runs reported having (`seen`). |

Enumerations (`src/db.rs`):

- **Statuses** (`STATUSES`): `backlog`, `todo`, `in_progress`, `needs_attention`, `in_review`,
  `ready_for_merge`, `done`. Backlog is a real column (first, starts collapsed per the demo text in
  `src/demo.rs`; `app/src/api.ts` labels it), which the README only names in the status-script list.
- **Resolutions** (`RESOLUTIONS`, only while done): `done`, `not_done`, `wont_fix`.
- **Task types** (`TASK_TYPES`): `plan`, `artifact`, `diagram`, `scratch`; `subproject` is accepted on
  creation but stored as the `subproject` flag. Thread `kind`: `task` or `review`.
- **Worktree states**: `none`, `setting_up`, `ready`, `tearing_down`, `error`.
- **Permission modes** (`PERMISSION_MODES`): `default` (Ask), `acceptEdits`, `auto`, `plan`, `dontAsk`,
  `bypassPermissions`.
- **Efforts**: host default `low|medium|high|xhigh|max`; a thread can also take Codex-only `minimal`
  and `ultra` (`THREAD_EFFORTS`).
- **Agents** (`AGENTS`): `claude`, `codex`. **Link providers** (`LINK_PROVIDERS`): `asana` only, at most
  20 links per task.
- **Review state** (`Review`, `ReviewerRun`): `running`, `passed`, `issues`, `failed`, `stopped`, with
  `fixes` (rounds in a row), `head` (reviewed commit) and per-reviewer parts.
- Task keys: `<PROJECT>-<n>`, group tasks `G-<n>`, scratch tasks `S-<n>`; projects can't take `G` or `S`
  (`src/runner.rs`, `src/db.rs`).

---

## 4. Features the README doesn't describe or only hints at

### 4.1 How a Claude run is launched (`launch` in `src/runner.rs`, `start` in `src/runs.rs`)

Command: `ia-shim <run dir> -- claude <args> --mcp-config <run dir>/mcp.json`, in the task's working
directory, with `CLAUDE_CONFIG_DIR` set to the thread's config and `MCP_TOOL_TIMEOUT=86400000` (24 h, so
permission prompts can wait on the user). Arguments, in order:

- `-p --output-format stream-json --verbose --include-partial-messages`
- with steering: `--input-format stream-json --replay-user-messages` (the echo shows where in the turn
  the agent took a message in)
- `--append-system-prompt <board instructions>` (4.3)
- `--permission-mode <mode>`; unless Bypass, `--permission-prompt-tool mcp__huntaway__permission_prompt`
- `--settings <json>` with the `huntaway gh-hook` PreToolUse hook, when the run has the board's `gh` server
- `--allowedTools`: `mcp__huntaway` (in Auto mode every board tool except `wait`, so Claude's classifier
  vets waits), the gh server's read-only tools (plus `pr_merge` while the task is merging), servers the
  project marks auto-allowed, and for reviewers a read-only list (`Read`, `Grep`, `Glob`, `Skill`,
  `Agent`, `Task`, `git diff/log/show/status/merge-base/rev-parse`, `gh pr view/diff/list/checks`;
  `src/review.rs`)
- `--disallowedTools`: skills/servers turned off for the project (`Skill(<name>)`, `mcp__<server>`); for
  reviewers also `Edit`, `Write`, `NotebookEdit` and the gh write tools
- `--resume <session_id>` once the thread has a session
- `--model <m>`: first set of task → project → profile → host default
- `--effort <e>`: task → host default; Codex-only values map (`ultra`→`max`, `minimal`→`low`)
- `--add-dir` for: the project's repository (scratch/document tasks, read only by instruction), a
  subproject's worktree, the group's repositories (group tasks), the generated skills folder, and the
  attachments folder.

`mcp.json` always has `huntaway` (stdio, `huntaway mcp`, with `IA_URL`, `IA_TOKEN`, `IA_RUN_ID`, `IA_REVIEW`)
and `gh` (stdio, `huntaway gh-mcp`, with `IA_CWD`, `IA_GH_ACCOUNT`), then the project's servers. The launch
is recorded in `spec.json` (cwd, args, config dir). Output is followed by polling `out.jsonl` every 200 ms
(`follow_inner` in `src/runs.rs`), not by a pipe.

The first prompt is built by `start_prompt` (`src/runner.rs`): an optional leading slash command, then
`# KEY-n: title`, the description, the linked Asana tasks, `---`, the project's start instructions
(default "Start working on this task.") and any extra text the task was started with.

### 4.2 How a Codex run is launched (`src/codex.rs`)

`ia-shim … -- huntaway codex-run <run dir>/codex.json` with `CODEX_HOME` set. The adapter speaks
`codex app-server` JSON-RPC: `thread/start`/`thread/resume`, `turn/start`, `turn/steer`,
`turn/interrupt`, `thread/compact/start`, `model/list`, `skills/list`, `skills/extraRoots/set`,
`config/read`, `account/rateLimits/read`, and answers `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `item/permissions/requestApproval` and `mcpServer/elicitation/request`
by asking the board. Permission mode → (approval policy, reviewer, sandbox) is in `codex::policy`:
Bypass `never`/`danger-full-access`; reviewers `never`/`read-only` (or the `huntaway-review` permission
profile); Don't ask `never`/`workspace-write`; Accept edits `on-request`; Auto `on-request` + `auto_review`;
Plan `untrusted`/`read-only` + Codex plan mode; Ask `untrusted`/`workspace-write`. The board's
instructions go in as `developer_instructions`; the same `mcp.json` is converted to Codex's
`mcp_servers` config. (Mode table and sandbox paths: README.)

### 4.3 What agents are told (`system_prompt`, `profiles_note`, `gh_note` in `src/runner.rs`; `src/documents.rs`; `src/prompts.rs`)

Appended to Claude's system prompt (Codex: developer instructions), varying by thread kind:

- **Every non-review thread**: the board tools exist and reach other profiles' boards that allow it; use
  `wait` (with a `command` such as `gh pr checks <N> --watch` for CI) rather than sleeping or polling;
  use `request_user_input` then end the turn when blocked; end with a concise summary (the task then
  goes to In review). Plus which profile it is on, which boards it can reach, and which it can't (so it
  asks rather than creating a duplicate project).
- **Code task**: its key, title, project and repo; "you are in a dedicated git worktree at … on branch …
  (branched from …). Make all changes here", commit units of work, don't merge/switch branches (or push,
  unless the repo is on GitHub). On github.com: open a PR before finishing (`pr_create` with explicit
  repo/head/base, or `gh pr create --repo … --head …`), unless the project's instructions say otherwise.
- **Subproject / task in a subproject**: plan and coordinate with `create_task`/`list_tasks`/`get_task`/
  `send_to_task`/`wait`; tasks branch from and merge into the subproject branch; pull before working.
- **Group task**: planning-only role across the group's listed projects (with ids and paths).
- **Scratch task**: no repository (or read-only access to the project's and subproject's), don't commit,
  create tasks for changes.
- **Plan/artifact/diagram task**: write one file in its own folder; plans use the board's HTML
  components (4.8).
- **Review thread**: review only, call `submit_review` exactly once; a read-only-sandbox note for Codex.
- **gh**: Claude runs are told to use `mcp__gh__*` because gh in Bash is blocked; Codex is told not to use
  shell `gh` or the `codex_apps` GitHub tools. **Plan mode** (Codex): "investigate and propose a plan, but
  don't change any files".

### 4.4 Runs, restarts and steering internals (`src/runs.rs`, `src/runner.rs`, `shim/src/main.rs`)

- Run directory files: `run.json` (format), `prompt`, `out.jsonl`, `err.log`, `pid`, `shim.pid`, `exit`,
  `input.jsonl` + `input.closed` (steering), `mcp.json`, `spec.json`, `codex.json`, `reap`. (README covers
  the idea.)
- On start, `load_active` re-follows unfinished runs from their saved `out_offset`, refuses to follow runs
  written by a newer format (downgrade), re-steers or requeues messages, expires prompts of runs that no
  longer exist, and marks threads that were "running" without a live run as *Needs attention* with
  "Interrupted by server restart".
- A failed or stopped launch is "reaped": input closed, and an agent the shim starts late is stopped,
  even across a restart (`reap`, `resume_reaping`).
- Timings: Stop sends an `interrupt` and kills after 10 s (`STOP_GRACE`); an agent that ended a turn
  with unread messages has 30 s to start the next turn before they go to a new run (`STEER_GRACE`); a
  killed process group gets SIGTERM then SIGKILL after 10 s.
- `slim` (`src/runner.rs`) trims what's stored per event: thinking signatures and empty thinking blocks
  are dropped, tool results over 30,000 chars are truncated, images inside tool results become `[image]`,
  per-message `usage` is dropped, and subagent results keep only status/model/duration/token counts.
  The raw output stays in the run folder for 14 days (README).

### 4.5 Event streaming to the UI (`src/state.rs`, `src/api.rs`, `src/hub.rs`)

- Each host has a broadcast channel; `/api/host/ws` sends `{"type":"hello"}` then every event as JSON
  text. Event types: `task` (whole task), `task_deleted`, `message` (new thread entry), `message_updated`
  (approval card status), `delta` (streamed text of the current reply) and `delta_reset`, `project`,
  `project_deleted`, `profiles_changed`, `settings_changed`, `usage`, `restart`, `restart_log`.
- If a client lags behind the channel it gets `{"type":"resync"}` and refetches everything; there's no
  per-event sequence number or replay.
- The hub's `/api/ws` merges its own and every linked host's events, each tagged with `host_id`, plus
  `hosts_changed` and a `resync` per host on (re)connect.
- Text deltas are ephemeral (only for the live reply, Claude `text_delta` or Codex
  `item/agentMessage/delta`); only completed messages are stored. Message history is fetched over REST,
  whole or in pages of up to ~1 MB (`PAGE_BYTES`, API 56).

### 4.6 Hosts: three link modes, the tunnel and updates (`src/hub.rs`, `src/proto.rs`, `src/relay.rs`, `src/ssh.rs`, `src/admin.rs`)

- **Outbound** (Add host): the hub calls the host's URL with its token, follows `/api/host/ws`, and
  reconnects with backoff 1→30 s. (README)
- **Inbound** (`serve --hub … --hub-token …`): the host dials `/api/hub/connect`; the hub sends `Req`
  messages (method, path, JSON body) over the websocket and gets `Res`; events go up as `Event`; terminal
  websockets are relayed as `WsOpen`/`WsMsg`/`WsClose` with binary frames base64-encoded. `Hello` carries
  host id, name, version, protocol and API versions. (README describes the idea, not the protocol.)
- **SSH hosts (not in the README)**: `POST /hosts/ssh` with `target` (`user@host`), `ssh_port` (22) and
  `remote_port` (7878). The hub generates its own ed25519 key in `<data dir>/ssh/` (`GET /hosts/ssh-key`);
  the user installs it on the target restricted to the forced command `huntaway ssh-host` and
  `permitopen="127.0.0.1:7878"`. The hub runs that command (which starts a host on 127.0.0.1 through the
  login shell if needed, logging to `serve.log`), then keeps an SSH tunnel to it (`BatchMode`,
  keep-alives, trust-on-first-use known_hosts, tunnels die with the hub via `PR_SET_PDEATHSIG`). So the
  host needs no open port and never reaches the hub. The UI has this (`app/src/api.ts`: `sshKey`,
  `addSshHost`).
- The hub's proxy (`/api/h/{host}/…`) is JSON in, JSON out (bodies up to 64 MB); an offline host gives a
  503 "host … is offline". Board tools fall back to linked hosts via `POST /api/tools/{tool}`, with
  version gates (e.g. project-settings changes need API 44, deletions API 58, `get_task_field` API 59)
  (`src/tools.rs`).
- **Updating a host** (README) has a second path: a hub without a checkout (a container) sends only its
  commit (`IA_COMMIT`), and the host fetches it from its own `origin` and fast-forwards if it's on the
  upstream of its branch (`update_from_origin`).
- **Restart without rebuild**: `POST /admin/restart {"rebuild": false}` re-execs the binary as is.
  Rebuild runs `npm install --no-audit --no-fund`, `npm run build`, `cargo build --release`, streaming
  `restart_log` events, then `exec`s the new binary with the original arguments (same PID). The new
  process reaps zombie children it inherited (`reap_inherited`).
- **Copy login** (README) also copies `settings.local.json`, `keybindings.json` and `output-styles` for
  Claude configs (`CLAUDE_CONFIG_ENTRIES` in `src/api.rs`), as a tar.gz through the hub.

### 4.7 Diffs and "did it change code" (`diff` in `src/worktree.rs`; `src/changes.rs`)

- `GET /tasks/{id}/diff` diffs the worktree (or the repository's own checkout if the task has none)
  against the merge base of HEAD and the base branch (or its upstream, if the task started from that),
  so it includes commits, staged and unstaged changes. It returns `commits` (`git log --oneline`),
  `stat`, one unified `patch` (truncated at 2,000,000 bytes) and `untracked` files, whose contents are
  added as new-file diffs for the first 50 only. It's one cumulative diff: there are no per-turn diffs,
  checkpoints or revert endpoints (none found in `src/`).
- `changes.rs` isn't the diff: it decides whether a tool call changed code, to decide whether a task with
  no branch commits needs a review. `Edit`/`MultiEdit`/`Write`/`NotebookEdit`/`ApplyPatch` count if they
  succeeded; `Bash` is parsed with a small shell tokenizer (quotes, here-docs, `$(…)`, wrappers such as
  `sudo`/`env`/`timeout`/`xargs`, nested `bash -c`) and counts for git `commit/push/apply/am/
  cherry-pick/merge/rebase/revert/mv/rm`, in-place edits, redirects and copies outside scratch paths
  such as `/tmp`. Denied calls don't count. (README gives the outcome.)

### 4.8 Documents (`src/documents.rs`)

- Plans are written as HTML fragments using board components that the README doesn't list:
  classes `sub`, `callout` (with tones `ok|warn|bad|info`), `pill`, `grid2`/`grid3` of `card`s, `ol.steps`,
  `meta` and `td.n`, plus `<ia-diagram>` (Mermaid source inside a `<pre>`, rendered by the board) and
  `<ia-question>` (README). The older `<ia-lede>`, `<ia-callout>`, `<ia-steps>`, `<ia-cards>`, `<ia-columns>`
  and `<ia-badge>` elements are retired but still styled. The plan theme (`app/src/planTheme.css`) styles
  plain HTML; a whole page (with `<html>`) is shown as is.
- A document file is capped at 5 MB (`MAX_SIZE`); a version stays `open` while the turn that writes it
  goes on, so the UI shows it as it's written. (Versions: README.)

### 4.9 Cost, context, compaction, usage

- **Cost** (`handle_line` in `src/runner.rs`): from Claude's `result` event `total_cost_usd`, a running
  total per process; the increase is added to the run's and the task's `cost_usd`. Codex runs report no
  cost (`src/codex.rs` has none), so Codex tasks stay at $0. The README mentions sorting by cost and
  comparing fan-out costs but not where cost comes from.
- **Idle compaction** (README): a loop every 60 s finds sessions idle 50–60 min (`AUTO_COMPACT_AFTER`,
  `AUTO_COMPACT_UNTIL`) and starts a `compact` run (`/compact`); skipped for Codex threads and when the
  host can't run agents. Compaction boundaries (manual, idle or Claude's own) are stored as
  `compact_boundary` messages, and the context figure drops to the post-compaction token count
  (`context::on_compacted`).
- **Context** (README): per-reply token totals; Claude's `get_context_usage` control request at turn end.
- **Usage** (README): Anthropic's `https://api.anthropic.com/api/oauth/usage` with the config's own
  login, cached 4 min, at most every 30 s, plus `rate_limit_event`s from runs; Codex via
  `account/rateLimits/read` and `account/rateLimits/updated` (`src/usage.rs`, `src/codex.rs`).

### 4.10 Other server behaviour worth listing

- **Permission answers** carry an optional `message` sent to the agent with a deny; `allow_always` adds
  the tool to the thread's `auto_allow`. Approving `ExitPlanMode` drops the thread out of Plan mode
  (`src/permissions.rs`). Switching to Bypass/Don't ask settles pending prompts (README).
- **Codex limits in the adapter**: MCP elicitations are only accepted when the form has no fields (tool
  approvals); Codex's own `item/tool/requestUserInput` is answered with no answers (agents use the board's
  `request_user_input`); any other server request is refused "Method not supported by Huntaway"
  (`src/codex.rs`).
- **MCP servers** a project or host adds may be `stdio`, `http` or `sse` (`check_server_config` in
  `src/agent_tools.rs`); SSE ones are dropped for Codex runs (`mcp_server_config` in `src/codex.rs`).
  Skill descriptions are capped at 1,024 chars; "seen" outside tools are remembered 14 days.
- **Terminal websocket protocol** (`src/terminal.rs`): binary frames for output/input, JSON control
  frames `ready`, `resize {cols, rows}` and `ack {bytes}`; the server stops reading the pty past 384 KB
  unacknowledged (flow control), pings every 15 s; tool sessions are reaped every 30 s after a 90 s lease.
  Requires `tmux` (503 otherwise).
- **Project fingerprints** (`src/relocate.rs`): every hour the host records what each project's folder is
  (its root commits), so a moved repository can be recognised; on a move, Claude's conversation folders
  (`<config>/projects/<folder>`) are copied so sessions resume.
- **Folder picker** for remote hosts: `GET /fs/dirs` (README mentions picking a folder, not that any
  path on the host can be listed).
- **`--demo` data** (`src/demo.rs`): on a fresh data dir, a "Default" profile, a "Demo" project (a
  scratch folder, not a git repo, key `DEMO`), seven tasks across every column including Backlog, and
  three document tasks (a Mermaid diagram, a dark-mode plan using the components above, and a release-notes
  artifact) with one version each.
- **Titles**: Claude title calls run `claude -p --model haiku --output-format text --tools ""
  --strict-mcp-config --no-session-persistence --disable-slash-commands --system-prompt …` with the
  task's config; a placeholder (first line of the description, or attached file names) shows meanwhile;
  a reply over 10 words isn't taken as a title (8 are asked for); the refresh looks at up to 30 user messages (`src/title.rs`). (README)
- **Analytics** recognise the board's own prompts ("Start working on this task.", "The user moved this
  task to "Ready for merge"…") and cut prompt previews to 280 chars (`src/analytics.rs`). (README)
- **Status scripts** are killed after 5 minutes (`LIMIT`); attachments unused for 7 days are pruned every
  6 hours; run folders are pruned hourly after 14 days, recorded MCP calls after 1 hour (`src/status_script.rs`,
  `src/attachments.rs`, `src/runs.rs`). (README)

### 4.11 README-covered features (one line each)

- Kanban flow, statuses and automatic transitions (README; `src/runner.rs`, `src/api.rs`).
- Per-task git worktrees, branch naming, setup/teardown scripts, remove merged worktrees (README; `src/worktree.rs`).
- Agents survive restarts under ia-shim; durable MCP calls and permission prompts (README; `src/runs.rs`, `src/tools.rs`).
- Steering, queued messages, Stop as interrupt (README; `src/runner.rs`).
- Codex agents, sandbox mapping, native subagents (README; `src/codex.rs`).
- Board MCP tools incl. `wait`, `get_task_field`, `delete_task`, `create_project` (README; `src/mcp.rs`, `src/tools.rs`, `src/wait.rs`).
- gh MCP server, gh-hook, per-profile GitHub accounts, GHE `HOST/LOGIN` (README; `src/gh_mcp.rs`).
- PR discovery with `gh pr view`, preview URLs (README; `src/worktree.rs`, `src/api.rs`).
- Automatic reviews, up to 6 reviewers (`MAX_REVIEWERS`), fix rounds (README; `src/review.rs`).
- Ready-for-merge agent merges, one per project/subproject at a time (README; `src/runner.rs`).
- Dependencies, subprojects, group tasks, scratch tasks, document tasks (README; `src/runner.rs`, `src/documents.rs`).
- One prompt → several agents (`fanout_id`, API 61) (README; `src/api.rs`).
- Profiles, cross-profile agent access, archived projects/tasks, stars, reminders (README; `src/tools.rs`, `src/db.rs`).
- Skills and MCP servers per host/project, slash-command menu (README; `src/agent_tools.rs`).
- Attachments, terminals, terminal tools, analytics, disk usage, usage limits, context pill (README).
- Asana links (README; `src/asana.rs`). Clone from GitHub (README; `src/github.rs`).
- Hosts/hub, Copy login, Update host, Rebuild & restart, versions (README; `src/hub.rs`, `src/admin.rs`).

---

## 5. Limits and gaps evident in the code

- **Agent runtimes**: only Claude Code (`claude -p`) and Codex (`codex app-server`); `AGENTS = ["claude",
  "codex"]` in `src/db.rs`. No API-key/direct-model provider, no other CLIs (no Gemini, OpenCode, Cursor…).
- **Platform**: Unix only. The pty (`openpty`, `setsid`), ia-shim (process groups, libc), SSH hosts and
  terminals use `std::os::unix`/libc without Windows fallbacks (`src/pty.rs`, `src/ssh.rs`,
  `shim/src/main.rs`); only `disk.rs`, `admin.rs` and `main.rs` have `cfg(not(unix))` branches.
  Terminals need `tmux`; SSH hosts need `ssh`/`ssh-keygen`.
- **Auth and security**: one shared bearer token per host (plus a hub-dial-in token); no user accounts,
  roles, per-user audit, OAuth or token rotation endpoint; plain HTTP with permissive CORS; `--open-token`
  hands the token to any browser (`src/api.rs`, `src/main.rs`).
- **Clients**: the server serves one web UI (`app/dist`), wrapped by Electron (`app/electron/main.cjs`); there
  is no native mobile app in the repository and no PWA manifest in `app/public` (only `icon.svg`).
- **Forges**: GitHub only, through the `gh` CLI. The "open a PR before finishing" instruction is only given
  when the push remote is on `github.com` (`is_github_com` in `src/worktree.rs`); GitHub Enterprise works
  for gh tools via `HOST/LOGIN` accounts but doesn't get that instruction. No GitLab, Bitbucket or Gitea.
- **Trackers**: Asana only (`LINK_PROVIDERS = ["asana"]`); no Linear, Jira or GitHub Issues linking
  (agents can still use `issue_*` gh tools).
- **Diff/review UI data**: one cumulative diff per task (2 MB patch cap, 50 untracked files); no per-turn
  diffs, checkpoints, rewind/undo or conversation forking (`src/worktree.rs`; nothing in `src/` handles
  them).
- **Codex parity gaps**: no cost tracking; no idle auto-compaction; context reports only a total; no
  gh-in-shell hook; SSE MCP servers not passed; MCP elicitation forms with fields declined; Codex's own
  user-input requests get empty answers (`src/codex.rs`, `src/runner.rs`, `src/context.rs`).
- **Claude models aren't listed** by the server (`GET /claude-configs/{id}/models` only lists Codex
  models; the UI suggests aliases) (`src/api.rs`).
- **Thread fidelity**: images in tool results are stored as `[image]`, tool results over 30,000 chars are
  truncated, and streamed deltas are text only (no live thinking stream) (`slim`, `handle_line` in
  `src/runner.rs`).
- **Events**: no replay or sequence numbers; a lagging client is told to `resync` and refetch
  (`src/api.rs`, `src/hub.rs`).
- **Scale**: one SQLite connection behind a mutex per host; the hub stores nothing about other hosts, so
  each host must be online for its board to show (`src/state.rs`, `src/hub.rs`).
- **Self-update** assumes a source checkout with `npm` and `cargo` on the host (or a hub that sends a
  git bundle); packaged installs can't update from the UI (`src/admin.rs`).
- **Agent-requested project changes and deletions** can't be approved for agents on other hosts
  (README; `src/tools.rs`).
