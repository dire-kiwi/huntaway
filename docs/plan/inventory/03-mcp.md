# 03 — The board's MCP servers and what agents can do through them

Sources read: `apps/server/src/mcp.ts`, all of `apps/server/src/mcp/` (non-test), `hosts/uplink.ts`, `wire/permissions.ts`,
`wire/approvals.ts`, plus what they hang on: `agent/runner/requests.ts`, `agent/codex/requests.ts`, `agent/approval_rules.ts`
(+ `approval_rules/{rules,hook,hook_main}.ts`), `agent/runner/access.ts`, `agent/runner/launch.ts` (arguments), `agent/runs.ts`
(`start`), `agent/assistant/tracked.ts`, `agent/runner/background.ts`, `hosts/hub.ts` (`run_up_call`), `main.ts`, `bin/huntaway`,
`docs/guide/{agents,github,concepts}.md`. Paths below are relative to `apps/server/src/`.

## 1. Purpose

The board is itself the MCP server for every agent run it starts: there is no helper process per run. It exposes four servers
(`huntaway` = the board's own tools, `gh` = GitHub through the `gh` CLI outside the agent's sandbox, `docs` = the profile's
documents, `desktop` = the host's GUI through Cua Driver). The same area owns everything an agent *asks* the board: permission
prompts (Claude's `can_use_tool`, Codex's approvals), approvals of dangerous board changes, questions (`request_user_input`,
`AskUserQuestion`, Codex's `requestUserInput`), plans (`ExitPlanMode`), the blocking `wait` tool, and polling GitHub for pull
request news. Every board tool call runs **at most once per call id** and survives a server restart (it is recorded in
`mcp_calls` and either resumed, answered from its record, or answered "interrupted").

## 2. Capabilities

### 2.1 Transports (how a run reaches the servers)
- **Claude, in process (default for every Claude run that takes input, i.e. all but `/compact`)**: the `huntaway` server is a
  Claude Code "SDK" MCP server. The run's input starts with a `control_request` `{subtype:"initialize", sdkMcpServers:["huntaway"],
  sdkMcpServerConfigs:{huntaway:{timeout:86400000, disableAutoBackground:true}}, sdkMcpServerManifests:{huntaway:{initializeResult,
  toolsListResult}}}` (request id `huntaway-init-<run id>`, MCP protocol `2025-11-25`), so the handshake is skipped. Each MCP
  message then arrives on the run's output (`out.jsonl`) as `control_request {subtype:"mcp_message", server_name, message}` and is
  answered on its input (`input.jsonl`) with `{"type":"control_response","response":{"subtype":"success","request_id",
  "response":{"mcp_response":<JSON-RPC>}}}`. Notifications still get a control response (`{jsonrpc,id:0,result:{}}`).
  (`agent/runner/requests.ts`)
- **Codex, dynamic tools (new sessions that take input)**: the board's tools are one Codex dynamic tool of `type:"namespace"`,
  `name:"huntaway"`, given at `thread/start`. The adapter (`huntaway codex-run`) writes every app-server request to `out.jsonl`
  as-is; the board answers on the input with `{"type":"codex_response","id","result"|"error"}`. `item/tool/call` with a board
  namespace = a board tool call; answer `{contentItems:[{type:"inputText",text}], success}`. (`agent/codex/requests.ts`)
- **HTTP (MCP streamable HTTP)**: `POST|GET /api/mcp/<run id>/<server>` on the host's internal URL (`127.0.0.1:<port>`), bearer
  token per run. Used by every run for `gh`, `docs`, `desktop`; for `huntaway` only by compactions, Codex sessions that started
  before dynamic tools (a resumed Codex session can't be given new dynamic tools; `db.session_board_tools`), and Codex builds that
  refuse dynamic tools (adapter falls back, `agent/codex/adapter.ts` `start_thread`). (`mcp/http.ts`)
- **Run config**: `agent/runs.ts start()` writes `<run dir>/mcp-run.json` (`RunSettings`) and `<run dir>/mcp.json`
  `{mcpServers:{…}}` (keys sorted) and passes `--mcp-config <path>` to Claude (Codex's adapter converts the same file to
  `mcp_servers`: `url`, `http_headers`, `tool_timeout_sec` = 3900 for board / 600 gh / 300 desktop). Entries:
  `{type:"http", url, headers:{Authorization:"Bearer <secret>"}, timeout}` with `timeout` 86 400 000 ms (board), 900 000 (gh),
  300 000 (desktop), none (docs). The `huntaway` entry is removed when in process; `docs` removed if the project turned it off;
  `desktop` only when computer use is on; the project's own MCP servers are merged in (never one named `huntaway`; one named
  `gh`/`docs`/`desktop` replaces ours). Claude runs also get env `MCP_TOOL_TIMEOUT=86400000`.
- No stdio helpers any more (`huntaway mcp`, `huntaway gh-mcp`, `/api/internal/mcp` were removed in HA-225).

### 2.2 HTTP server behaviour (`mcp/http.ts`)
- Path regex `^/api/mcp/([^/]+)/([^/]+)$`; unknown server → 404; bad/missing bearer → 401; no `mcp-run.json` → 404 `unknown run`;
  `huntaway` for an in-process run → 404; `desktop` for a run not launched with it → 404.
- `POST` body is one JSON-RPC message (batches → 400 `-32600`; parse error → 400 `-32700`); limit 32 MiB, 64 MiB for `docs`.
  Notifications/responses → `202` empty. Non-`tools/call` requests are answered as plain JSON 200.
- `tools/call` is answered as SSE when `Accept` includes `text/event-stream` (both CLIs do), else as JSON once done. Stream: first
  a priming event `id: <event id>\nretry: 5000\ndata: \n\n`; then every 20 s either a `notifications/progress` message
  (`progress` = unix seconds, must only grow) if the request had `_meta.progressToken`, or a `: keepalive` comment; finally the
  JSON-RPC answer as `event: message`.
- Event id = `<server>.<call id>.<b64url(JSON rpc id)>[.<b64url(JSON progress token)>]`. `GET` with `Last-Event-ID` resumes:
  board calls are re-dispatched from `mcp_calls` (same call id, so at-most-once applies); gh/docs/desktop answers are kept in
  memory for 10 min after they finish, and after a restart the client is told the output is lost ("may or may not have taken
  effect"). `GET` without `Last-Event-ID` → 405. A resume whose `mcp_calls` row belongs to another run → 404.
- For gh/docs/desktop, a `tools/call` from a run whose row is `status='exited'` is answered with a tool error ("This run has ended
  on the board…"); the board dispatcher does the same check itself.

### 2.3 Caller identity and authorisation
- **Per-run secret**: `HMAC-SHA256(key = host token, msg = "mcp:" + run_id)` hex; compared in constant time. Derived, never
  stored; a run never holds the host token. In-process and Codex-on-output calls need no token: the run is the one whose output
  the request was read from.
- **Who the caller is**: run → task (`runs.task_id`) → profile (`tasks.profile_id`). `Ctx = {profile_id, profile_name, task,
  call_id, task_fields, from_host}` (`mcp/tools.ts`).
- **Gates in `execute_mcp`** (`mcp/tools/dispatch.ts`), in order: schema check (`check_args`: unknown argument or missing/blank
  required one is an error naming the tool's arguments and telling the agent to load the schema; `host` is always allowed) →
  run exists → run not `exited` → task exists → **reviewer gate** (`task.kind === "review"` may only call `FOR_REVIEWERS`) →
  **plan-mode gate** (effective permission mode `plan` may only call `FOR_PLANNING`; checked per call because the run's tool
  list was fixed at launch) → any call other than `wait`/`permission_prompt` ends the run's current wait (`wait.resumed`) →
  **approval rules** (`check_rules`, assistant threads only, skipped for `permission_prompt` and `request_user_input`) → the tool.
- **Cross-profile access** (`mcp/tools/resolve.ts`): usable boards = the caller's own profile first, then every profile `p` on
  this host with `db.grants(p, caller name)` (`p.name === name` or `p.agent_access` contains `"*"` or the name). `profile`
  argument or `<profile>:<ref>` prefix picks one (`"all"` = all usable). A prefix only counts as a profile if a profile by that
  name/id exists on this host (project names may contain colons: a name match on the usable boards wins first). Unqualified
  key: own board wins; else the single other board that has it; else error "is on more than one profile's board: name one of …".
  Naming a board that exists but doesn't grant access gives a NotFound whose text tells the agent what the user must change
  (Settings → Profiles → "Agents from other profiles").
- **Task refs**: id, or `KEY-n` where KEY is a project key, a former key, or the reserved keys for group / scratch (`S`) /
  assistant (`A`) tasks; only `kind === "task"`; another profile's assistant and its routine threads are never reachable. Two
  projects sharing a former key → "could be more than one task … name it by its id".
- **Project refs**: id, key, name (case-insensitive), former key.
- **Other hosts** (`dispatch`): a call that is NotFound here is tried on each connected linked host (`POST /api/tools/<tool>`
  there with `{profile, args, task_fields}`; `host` stripped) and then on each uplink hub; `list_projects`, `list_pens`, and
  `list_tasks` with `project_id:"all"` or `profile:"all"` fan out to all and concatenate (hub results de-duplicated by `id`).
  `args.host` (name or id) pins one host. A host that refused for a reason other than "not found…" has its reason reported
  rather than "not found". Linked hosts on an older API version are skipped per feature (`too_old`, see §12).
- **Inbound from another host** (`handle_remote`, route `POST /api/tools/{tool}`): runs `local` only (no further forwarding),
  with the access of this host's profile of the caller's *name* (or just the profiles that grant that name); `task=null`,
  `call_id=null`, so anything needing an approval fails ("only an agent on the project's own host can ask for").
- **Up-calls** (`hosts/uplink.ts`, `hub.run_up_call`, `handle_up_call`): a linked host's agent can use the hub's board only if
  the hub's link row has `uplink` on (off by default), the connection came the way that host is linked (dialled vs tunnel), and
  the named profile's `assistant_host` is that host. Recorded as `mcp_calls` id `up:<host id>:<call id>`, run id `up:<host id>`;
  `THREAD_TOOLS` refused ("only works on the host the agent runs on"); never passed further up nor back down to the caller.
  Outcome on the calling side: `Ok` / `Err` / `Off{why}`; timeout 300 s; lost link or timeout says "may or may not have taken
  effect".

### 2.4 At-most-once execution (`at_most_once`, `mcp/tools/dispatch.ts`)
- Row written `status='executing'` before the tool runs, `status='done'` with `result` (JSON) or `error` after. Nothing runs if
  the row can't be written ("The board couldn't record this … call, so it wasn't run (call it again)").
- Duplicate delivery while running: HTTP duplicates wait for the first's result; control-request duplicates are ignored.
- Delivery after `done`: recorded result/error returned (control path: not answered again).
- Found `executing` (server stopped mid-call): re-run only if `rerunnable`: tool in `RERUNNABLE` = `permission_prompt,
  request_user_input, finish_work, submit_review, wait, background_wait, list_projects, list_tasks, get_task, get_project,
  list_automations, list_workflows, list_pens, untrack_work, list_tracked_work`; or the call has a pending/denied rule prompt
  (`permission_requests` with `kind='tool'` and `rule` set, not `allowed`); or it is `create_project/update_project/delete_task/
  *_automation/*_workflow` whose approval request exists and isn't `allowed` (nothing changed yet). Otherwise answer "This … call
  was interrupted (the board's server restarted while it ran), so it isn't run again: it may or may not have taken effect…"
  and record that as done.
- Control path (`handle_control`): the answer is written to the run's input **before** the row is marked done, so "done" implies
  "answered"; `saved` args (request id + JSON-RPC id + arguments) are what `resume_requests` needs after a restart.
- Cancellation: Claude sends `notifications/cancelled {requestId}` to the in-process server (found by `rpc_id` among the run's
  executing `stdio:` calls) or `control_cancel_request` for a prompt; Codex's adapter reports `resolved`. Effect
  (`cancel_call`): mark cancelled, expire the call's pending permission request, clear its wait, and never answer it.

### 2.5 Server `huntaway`: every tool
Callers: **N** normal task thread (also scratch, pen, group threads), **R** review-kind thread, **P** any thread while in plan
mode, **A** the profile's assistant and routine threads under it. "ask" = the user must approve in the thread whatever the
permission mode. All tools except the thread tools take optional `profile` and accept `host`. Listed in `tools/list` order.

| Tool | Meaning | Arguments (required in bold) | N | R | P | A |
|---|---|---|---|---|---|---|
| `request_user_input` | Put a question card in the thread, flag run attention; agent then ends its turn | **question**, options[{**label**, description}] ≤9, multi_select=false, allow_other=true | y | y | y | y |
| `finish_work` | Sets `runs.finished=1` ("this column's work is done"), read at run end by workflows | none | y | n | n | y |
| `track_work` | Add/change an item of the assistant's tracked-work list | id, title, note, status, task, url | err¹ | n | n | y |
| `untrack_work` | Remove items by id, or all done ones | ids[], done | err¹ | n | n | y |
| `list_tracked_work` | The list, with each linked task's live state | none | err¹ | n | y | y |
| `wait` | Block until something happens (§2.8) | **reason**, seconds (1..3600), tasks[], last_seen{}, pull_request, pull_request_events[], command | y | y | y | y |
| `background_wait` | Mark a Claude background shell as something the agent waits on (task shows working) | **task_id**, waiting=true | y | y | y | y |
| `list_projects` | Non-archived projects on all usable boards and all hosts: `{id,key,name,repo_path,profile,host}` | profile | y | y | y | y |
| `list_tasks` | Task summaries; default own project (or own subproject / own pen for a pen thread) | project_id (\|`all`), status, subproject (id\|`none`\|`all`), include_assistant, pen (name\|id\|`none`) | y | y | y | y |
| `get_task` | Bounded overview of a task (§3) | **task_id** | y | y | y | y |
| `get_task_field` | One field, paged by Unicode characters | **task_id**, **field**, offset=0, limit=2000 (1..4000) | y | y | y | y |
| `create_task` | Create a task; starts its agent by default | **title**, description, project_id, status, resolution, use_worktree, model, effort, start, subproject, labels[], type=`scratch`, depends_on[], start_from, merges_into, starred, remind_at, reminder, pen | y | n | n | y |
| `update_task` | Change fields; moving an un-run todo/backlog task to in_progress starts it | **task_id**, title, description, status, resolution, pr_url, preview_url, labels, model, effort, remerge, depends_on, start_from, merges_into, starred, remind_at, reminder, pen | y | n | n | y |
| `delete_task` | Delete a task (and a subproject's tasks) — **ask** | **task_id**, delete_branch, reason | y | n | n | y |
| `list_pens` / `create_pen` / `update_pen` / `delete_pen` | Pens (named task sets shown as tabs) | create: **name**, active, color; update: **pen**, name, active, color, index; delete: **pen** | y | n | list only | y |
| `send_to_task` | Send a message to another task's agent, starting/resuming it | **task_id**, **message** | y | n | n | y |
| `get_project` | Project settings + effective prompts | project_id | y | y | y | y |
| `update_project` | Change settings; some fields **ask** (§2.6) | project_id, name, key, base_branch, model, start_prompt, review_prompt, merge_prompt, auto_review, review_rounds (0..20), group_name, reviewers[≤6], permission_mode, setup_script, teardown_script, copy_files, link_folders, status_script, status_scripts{}, repo_path, move_repo, use_worktrees, worktrees_root, use_workflows, auto_summary, summarizer, summarizers[], reason | y | n | n | y |
| `create_project` | Add a folder as a project — **ask** | **repo_path**, name, reason | y | n | n | y |
| `list_automations` | A project's automations or (routines) the profile's routines | project_id, routines | y | n | y | y |
| `create_automation` / `update_automation` / `delete_automation` | **ask** (update: turning off / renaming applies at once) | create: **name**, **trigger**, **action**, enabled, generate_secret, active_hours, precheck, budget_usd, routines, reason; update: **automation_id** + same + remove_secret, rotate_url; delete: **automation_id**, reason | y | n | n | y |
| `run_automation` | Run once now (webhook: a test delivery) | **automation_id**, payload, event, routines | y | n | n | y |
| `list_workflows` | A project's workflows with graphs | project_id | y | n | y | y |
| `create_workflow` / `update_workflow` / `delete_workflow` | **ask** (same exception as automations) | create: **name**, **graph**{nodes,edges}, enabled, reason; update/delete: **workflow_id**, … | y | n | n | y |
| `run_workflow` | Run a workflow on one of its project's tasks now | **workflow_id**, **task_id** | y | n | n | y |
| `submit_review` | A reviewer's verdict (only *listed* for review threads) | **verdict** (`pass`\|`needs_fixes`), **summary**, **serious_issues**[], minor_issues[] | err² | y | y | – |
| `permission_prompt` | Not listed. The internal name every prompt is recorded under; called by name it just asks the user | tool_name, input, tool_use_id | – | – | – | – |

¹ Listed for everyone, but `tracked.owner()` throws unless the caller is the assistant or a thread whose parent is the assistant.
² `review.submit` rejects non-review threads; a workflow agent step's `submit_review` goes to `workflows.submit`.
`FOR_REVIEWERS` = list_projects, list_tasks, get_task, get_task_field, get_project, wait, background_wait, request_user_input,
submit_review. `FOR_PLANNING` = those + list_automations, list_workflows, list_pens, list_tracked_work. `tools(review=true)` lists
only the reviewers' set; all other runs are listed the full set (minus `submit_review`) and the gates are applied per call.

Pre-approval at launch (`agent/runner/access.ts`): Claude gets `--allowedTools mcp__huntaway` (every board tool, no CLI
prompt); in Auto mode each board tool is listed by name **except `wait`**, so Claude's classifier reviews waits. Also allowed:
`mcp__docs`, the desktop read tools, the gh read-only tools (+ `pr_merge` while merging). Codex: board server/dynamic tools
need no approval (`default_tools_approval_mode="approve"`; old-session MCP `wait` set to `prompt` under `auto_review`).

Tool behaviour details (all `mcp/tools/local.ts` unless noted):
- `create_task`: `start` defaults to true unless status is other than todo/in_progress (set explicitly by the dispatcher so old
  linked hosts behave the same). On a host that can't run agents the task is still made, with a `note` saying it wasn't started.
  Project defaults to the caller's; a task created from inside a subproject goes into it if same project; `type:"scratch"`
  without project → a scratch task on the caller's own board. `created_by` = caller's task id. Star/reminder and pen name are
  validated *before* the task is created (a failing call must leave nothing behind to duplicate). `pen` omitted in a pen's own
  thread → that pen. `merges_into`, `depends_on` take ids or keys. `is_subproject` is refused by the API.
- `update_task`: only fields given (non-null); `model:""` → null; `api.check_todos` blocks leaving In progress with an unfinished
  todo list; starts the agent when moved todo/backlog → in_progress and it has never run (`session_id == null`), isn't queued,
  isn't running, isn't the caller itself. If the task was closed unmerged while others merge into it, the result carries a `note`
  telling the agent to ask the user where those go.
- `send_to_task`: not to yourself; `runner.send_from_agent`.
- `remind_at` parsing (`tools/tasks.ts reminder_time`): delay (`30m`, `2h`, `1d 12h`, `in 3 days`, `1w`; each number ≤ 10 000),
  RFC 3339, local `YYYY-MM-DD[ HH:MM[:SS]]` (date alone = 09:00 host time), `""` clears.
- `list_tasks` leaves out archived projects' tasks and (unless `include_assistant` and own board) the assistant.
- `delete_pen` refused from the pen's own thread.
- Automations: "routines" = the caller's own profile's (argument `routines`, or action kind `message_assistant`, or the caller is
  an assistant thread naming no project). `generate_secret` creates the secret only after approval and returns it once
  (`secret`, `secret_note`); webhook results carry `webhook_url` if setting `public_url` is set, else `webhook_note`.
- Tracked work (`dispatch.ts tracked_tool`, `agent/assistant/tracked.ts`): list on the assistant task's `tracked` JSON; ≤100
  items, title ≤200, note ≤2000 chars, url http(s); item id = first 8 chars of a new id; `task` is resolved through `get_task`
  on any reachable board/host and stored as `{task_id, task_key}` (key qualified `profile:KEY-n` if on another profile);
  returned items carry effective `status` (done once the task is done; `waiting_user` when the task needs attention or is in
  review), `own_status` if different, and `task` = `{key,title,status,resolution,merged?,pr_url}` or null if unreadable now.
- `finish_work` result `{ok:true, note}`; `request_user_input` sets `runs.attention = question` and returns `{ok:true, note}`.

### 2.6 Approvals of board changes (`mcp/tools/approvals.ts`, `projects.ts`, `automations.ts`, `workflows.ts`, `mcp/permissions.ts approve`)
- Always asked of the user, whatever the mode, never "always": `create_project`; `update_project` when any changed field is in
  `APPROVAL_FIELDS` = permission_mode, setup_script, teardown_script, copy_files, link_folders, status_script, status_scripts,
  repo_path, move_repo, use_worktrees, worktrees_root; `delete_task`; create/delete of an automation or workflow and any update
  other than only {rename, turn off}. `AGENT_FIELDS` (name, key, base_branch, model, three prompts, auto_review, review_rounds,
  reviewers, auto_summary, summarizer(s), use_workflows, group_name) apply at once. `claude_config_ids` can never be changed by an
  agent.
- `update_project` computes what *would* change by applying and rolling back (`db.preview_project_update`), validates a new
  `repo_path` (`relocate.check`) before asking, and applies only the differing fields (`apply`), exactly as shown.
- `create_project`: path must be absolute or `~/…`; symlinks resolved for the existing prefix; `..` in the missing part refused;
  missing directory is created on approval; key derived; shows `exists`, `git`, host default permission mode.
- `delete_task`: can't delete own task, the subproject one is in, or the assistant. After approval, an `api.Deleting` guard stops
  tasks being added; if the subproject gained tasks the user wasn't shown, nothing is deleted and the agent must ask again; if
  the task vanished meanwhile → `{deleted:false, note}`.
- Request kinds in `permission_requests.kind`: `project`, `delete_task`, `automation` (workflows too; their thread message says
  `kind:"workflow"`, with `input.workflow` instead of `input.automation`). Question text: "Add a project?", "Approve a project
  change?", "Delete a task?", "Approve an automation?", "Delete an automation?", "Approve a workflow?", "Delete a workflow?".
- A retried call finds its request by `call_id` (`permissions.asked`) and carries on with the *saved* input, whatever changed.
- The user may edit an automation approval's `create_task` model/effort (`Reply.automation`); the result then has
  `approval_note` telling the agent to keep them.
- Calls with no thread to ask in (from another host) fail with "needs the user's approval, which only an agent on the …'s own
  host can ask for; ask the user to …".

### 2.7 Permission prompts, questions, plans (`mcp/permissions.ts`, `mcp/questions.ts`)
- **Claude**: launched with `--permission-prompt-tool stdio` (unless Bypass with no ask-rule, or a compaction). Each prompt is
  `control_request {request_id, request:{subtype:"can_use_tool", tool_name, input, tool_use_id}}` on the output → board call
  `permission_prompt`, id `stdio:<run id>:<request id>` → answered on the input with the decision as `response`. Other subtypes
  → `{subtype:"error", error:"the board doesn't handle … requests"}`.
- **Codex**: app-server requests mapped to prompts: `item/commandExecution/requestApproval` → tool `Bash` `{command, cwd,
  description}`; `item/fileChange/requestApproval` → `ApplyPatch` `{changes, reason, grant_root}`;
  `item/permissions/requestApproval` → `Permissions`; `mcpServer/elicitation/request` → `mcp__<server>__<tool>` (declined
  outright if it wants a URL or any form field; auto-accepted for the board's own server except a `wait` with a command, asked
  as `Bash`); `item/tool/requestUserInput` → `request_user_input` questions. Ids `stdio:<run id>:codex:<id>`. Answers:
  `{decision:"accept"|"decline"}`, `{permissions, scope:"turn"}`, `{action:"accept"|"decline", content}`, `{answers}`.
  Unknown method → JSON-RPC error `-32601`.
- **Decision** (`permissions.prompt`), in order: (1) approval rule for the tool in the *current* mode: `never` → deny + log;
  `allow` → allow; `ask` → deny if mode is Don't ask, else ask the user (skipping 2–3). (2) no rule: allow if not a question and
  (`task.auto_allow` has the tool, or the call writes the task's own documents folder). (3) current mode: Bypass → allow (not
  questions); Don't ask → deny everything. (4) otherwise raise a request and wait.
- **Raising** (`request_ruled`): one request per (call id, tool name); refused if the call's run is no longer the one this host
  holds for the task ("this call's run has ended on the board"); adds a thread message `kind:"permission"` with data `{tool_name,
  input, tool_use_id, request_id, status:"pending", expires_at?, rule?:{tool,decision}, agent?:"codex"}`; inserts the row; sets
  the task's `attention_reason` (`"Approve <tool>?"`, the first question's text "(and N more questions)", or "Plan ready for
  approval[: title]") and, for a task-kind thread, `status = needs_attention`.
- **Answer to the agent**: allow → `{behavior:"allow", updatedInput:<stored input>}` (+ `updatedPermissions:[{type:"setMode",
  mode, destination:"session"}]` for an approved plan when the thread's mode is now acceptEdits/auto); deny →
  `{behavior:"deny", message}` (default "The user denied this action."). A thrown error becomes a deny with its message.
- **User's answer** (`answer_by`, `POST /permissions/{id}`): first answer wins (single `UPDATE … WHERE status=<current>`);
  `allow_always` adds the tool to `tasks.auto_allow` (only `kind='tool'`, not questions, not ruled). Questions: `answers` is one
  list per question, checked (single-answer unless `multiSelect`), written into the stored input as Claude wants
  (`answers[question text] = "a, b"`) or Codex wants (`answers[question id] = {answers:[…]}`); secret answers shown as
  "(hidden)". Plans: approve may carry `mode` (not `plan`); deny may carry `feedback` (note: "The user wants you to keep
  planning…"). Approving a plan changes the thread's `permission_mode` (`mode_after_plan`: picked mode, or back to the inherited
  one, or `default` if that is plan too) and re-applies the mode to other pending prompts.
- **Late answers**: an *expired* question or plan (its run ended) can still be answered unless the conversation moved on
  (`history.moved_on`); the answer is sent as a user message (`runner.send`) — "My answer(s) to the question(s) you asked: …",
  "Your plan is approved: go ahead and implement it.", "Keep planning: don't start on the plan yet." — and rolled back to
  `expired` if sending fails.
- After a prompt settles while the agent runs and none is pending: `attention_reason=null`, status back to
  `db.working_status(task)`.
- Mode change mid-run (`apply_mode_to_pending`): Bypass allows, Don't ask denies, the pending `kind='tool'` prompts (Bypass
  leaves questions and rule-asked prompts).
- Expiry: `expire_for_task` (run ended, task deleted), `expire_for_run`, `expire_for_call` (agent cancelled), `expire_for_project`,
  `expire_deletions_of`, `expire_for_automation`, `expire_for_workflow`; note "Request expired". Prompts from **routine runs**
  (assistant threads whose turn was started by an automation) get `expires_at = now + rules.expiry_minutes` (default 30, 0 =
  never, max 10 080) and are denied by the sweeper with "Nobody answered this in time, so it was denied. Carry on without…".
- **`request_user_input`** (`mcp/questions.ts`): not waited on. Adds a thread message `kind:"question"` `{question, options,
  multi_select, allow_other, call_id, status:"pending"}` once per call id. Answered later by `POST
  /tasks/{id}/questions/{message_id}` `{choices[], text}`: validated against the options, first answer wins, then sent as the
  user's message `> question\n\n<answer or "- a\n- b">`; statuses `pending → answered | replied` (any user reply in the thread
  settles all open questions). Refused once the conversation moved on. A card with `merge_approval:true` is the board's own
  merge question: the answer goes to `merge_gate.decide` instead of the agent.

### 2.8 `wait` (`mcp/wait.ts`, `dispatch.ts wait_tool`)
- Stores `tasks.agent_wait` for exactly the call's duration; the board shows "waiting" with the reason.
- Period: default 600 s, max 3600 s; with `command` max 600 s; with nothing watched default *and* max 30 s (a longer request
  is an error explaining the alternatives); min 1 s.
- Ends on the first of → `ended` value: deadline `timeout`; a watched task's status differs from the stored one, it was deleted,
  or its review finished after the wait began `tasks_changed`; first subagent to complete/fail/stop `subagent_finished`; command
  exit `command_exited`; PR news `pull_request`; a queued or steering message for this run `message`; run stop requested/exited
  or task gone `stopped`; `agent_wait` cleared under it (another tool call) `resumed`; explicit column move (`moved_to` written
  by the API with the move) `task_moved`.
- Result: `{ended, waited_seconds, note, tasks:[summary with review reduced to {state}] | {id,key,deleted:true}, command?:
  {exit_code, output} | {stopped:true, output}, subagent?, pull_request?}`.
- `tasks` must be on this host. `last_seen` = `{ref: status | {status, review}}` overrides the baseline so a change between the
  agent's read and the wait ends it at once (HA-389/390).
- `command`: needs approval as a `Bash` prompt (`{command, cwd, description:"Run while waiting: <reason>"}`) unless the agent's
  own reviewer already reviewed the call (Claude auto mode, which doesn't pre-approve `wait`; Codex `auto_review` on the MCP
  server) *and* no approval rule asks/refuses Bash. Runs `bash -c LAUNCH issue-agent-wait <command>` detached in its own process
  group, in the task's work dir, env = agent env + `TMPDIR` = the task's temp dir + gh shim env; stdout+stderr to an unlinked
  temp file (`issue-agent-wait-<id>.log`); returns the last 4000 bytes ("… [N bytes before this]"). Killed (group SIGKILL) on
  exit or when the wait ends; a watchdog subshell kills the group when the server's end of its stdin pipe closes.
- Restart: the same call resumes the stored wait (same deadline, tasks, PR); the command is started again from scratch; the PR is
  read again immediately.
- "Activity" that ends a wait: any other board call of the run; a Claude `assistant` event of the main thread
  (`parent_tool_use_id == null`) with a `tool_use` that isn't `mcp__<board>__wait`; Codex's own-thread tool items. Subagents'
  tool calls and all permission prompts don't count.
- `background_wait` (`agent/runner/background.ts`): records the Claude background task id in the run's "waited" list so the task
  keeps showing as working; error lists the ids that are going.

### 2.9 Pull request watching (`mcp/pr_watch.ts`, `pr_watch/*`)
- Target forms: `12`, `#12`, `7.0`, `OWNER/REPO#12`, `https://HOST/OWNER/REPO/pull/12[/files][#…]`. Default repo = where the
  task's branch is pushed. The task's GitHub account must be on the PR's host, else the wait doesn't start.
- One GraphQL query per read via `gh api graphql -f query=… -f owner= -f name= -F number= [--hostname H]`: viewer login; PR `url
  number title state isDraft baseRefName headRefOid mergeable mergeStateStatus reviewDecision`; last commit's
  `statusCheckRollup.contexts(first:100)` (CheckRun: `databaseId name status conclusion detailsUrl isRequired checkSuite{…
  workflowRun{workflow{name}}}`; StatusContext: `context state targetUrl createdAt isRequired`); `comments(last:50)`,
  `reviews(last:50)`, `reviewThreads(first:100){comments(last:20)}` + up to 9 more thread pages. Timeout 60 s per gh call.
- Check state: CheckRun not completed = Pending; conclusions failure/cancelled/timed_out/action_required/startup_failure =
  Failed; else Passed. StatusContext success/failure|error/else. A workflow run still in progress with no pending job adds a
  synthetic pending check "`<workflow> / jobs still to start`". "Passed" = all required checks passed (all checks if none
  required, and at least one).
- News (`compare`): `checks_failed` (new failed check keys on this head), `checks_passed` (once per head), `comments` (remarks not
  seen; never the viewer's own, bare "commented" reviews, PENDING reviews, or anything present at the first read), `conflicts`
  (mergeable=conflicting and not told; `unknown` changes nothing), `merged`/`closed` (always), `unreadable` (5 failed reads in a
  row). A wait always includes checks_failed, checks_passed, conflicts; `pull_request_events` can only add `comments` (default:
  all four). Special case: conflicting + no check pending + nothing else found → report `conflicts` every time (GitHub runs no PR
  workflows on a conflicting PR, HA-287).
- News payload: `{base_branch, checks:{failed:[{conclusion,name,required,url}], outcome, passed, pending:[names],
  required_checks}, draft, head, merge_state, mergeable, number, review_decision, state, title, url, events:[…], comments?:[≤20
  × {at, author, body (HTML comments stripped, ≤800 chars), kind, url, author_association?, review_state?, path?, line?}],
  more_comments?}`.
- "Told" bookkeeping per (task, PR): `seen` only advances to `pending.told` when the call that found the news actually returns
  it to the agent (`delivered`); a wait ended by Stopped/Resumed leaves the news for the next wait. Seen remark ids capped at
  2000 (never dropping ones the current read still sees).
- Each read of an open PR also updates `tasks.pr_checks` (only when changed, and only if the task's PR is still this one).
- **In-review watcher** (`in_review.ts`): tasks `kind='task'`, `status='in_review'`, non-empty `pr_url`, project
  `watch_pull_requests` ∈ {`failures`,`all`}, project not archived, agent idle (has a session, not running/queued/merging/
  waiting, no steering or queued message, no review running). Wakes the agent with one message (`runner.send_as`) containing
  failed checks with log tails, a conflict instruction, and/or comments (mode `all`) — only from non-bot authors with
  association owner/member/collaborator, wrapped in `<untrusted-data>` tags and defanged. Comments alone wake at most 10 times
  in a row (then a thread event says so; reset when the user writes). Merged/closed PRs are not read again.
- **Failed-check logs** (`failed.ts`): `gh run view --job <id> --log-failed -R <repo>` for ≤5 jobs; tail = last 80 lines, ≤6000
  bytes, each line ≤400 chars, timestamps/ANSI/`##[group]` stripped, grouped under `--- <step> ---`.
- **Fix broken checks** (`fix_checks`, `POST /tasks/{id}/fix_checks`): read now, send failed checks + logs as the user's message,
  mark them told (and mark a pending in-review wake `superseded`). 409 if PR not open or nothing failed.
- `preview_for(project, pr_url)`: `pr_preview_url` template with `{pr}` → number.

### 2.10 Server `gh` (`mcp/gh_mcp.ts`, `gh_mcp/*`) — serverInfo name `huntaway-gh`
All tools also take `repo` (`OWNER/REPO` → env `GH_REPO`) and `dir`. `readOnlyHint` annotation set for the read-only ones
(Codex runs those without asking). Claude: read-only ones in `--allowedTools`; `pr_merge` too while `task.merging`. Review
threads: writes are in `--disallowedTools` / Codex `disabled_tools` (the server itself does **not** check reviewer-ness).
| Tool | Runs | Arguments |
|---|---|---|
| `pr_create` (w) | `gh pr create --title= --body=` or `--fill`; `--base --head --draft` | title, body, base, head, draft |
| `pr_view` | `gh pr view [pr] --json=number,title,state,isDraft,url,author,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,body[,comments,reviews]` | pr, comments |
| `pr_list` | `gh pr list … --json=number,title,state,isDraft,url,author,headRefName,baseRefName,updatedAt` | state, head, base, author, search, limit |
| `pr_checks` | `gh pr checks [pr] --json=name,state,bucket,workflow,link,startedAt,completedAt` (exit 8 = pending, ok) | pr |
| `pr_diff` | `gh pr diff [pr] [--name-only]` | pr, name_only |
| `pr_comment` (w) / `issue_comment` (w) | `gh pr|issue comment <n> --body=` | pr/**issue**, **body** |
| `pr_edit` (w) | `gh pr edit [pr] --title= --body= --base=` (at least one) | pr, title, body, base |
| `pr_merge` (w) | resolves pr to number+repo via `gh pr view --json=url`, then `gh pr merge <n> --repo= --merge|--squash|--rebase [--auto] [--delete-branch]` (`--repo` stops gh's local cleanup); stacked PRs use `PUT repos/…/pulls/n/merge-async`, polled every 2 s up to 10 min, refused while PRs below are unmerged or with `auto` | pr, method, auto, delete_branch |
| `issue_view` / `issue_list` / `issue_create` (w) | `gh issue …` with fixed `--json` field lists | **issue**, comments / state, label, assignee, search, limit / **title**, body, labels[] |
| `run_list` / `run_view` | `gh run list --json=databaseId,workflowName,displayTitle,headBranch,event,status,conclusion,url,createdAt` / `gh run view <id> [--log-failed]` | branch, workflow, limit / **run_id**, log_failed |
| `api` (w) | `gh api <endpoint> [--method=] --raw-field k=v (strings) / --field k=json (scalars) [--jq=] [--paginate]` | **endpoint**, method, fields{}, jq, paginate |
| `gh` (w) | any gh args after `refuse()` | **args**[] |
| `git_push` (w) | `git push [--force-with-lease] -u <remote=origin> <branch=HEAD>`; branch must be a plain branch name (no refspec) | remote, branch, force_with_lease |
- Flags are always `--flag=value`; positional targets starting with `-` are rejected.
- `refuse()` (also in `gh-run`): gh's command must come first (only `--help/-h/--version` before it); refuses `gh auth`,
  `gh extension|extensions|ext`, `alias set|import|delete`, `config set|clear-cache`, any `config` naming `oauth_token` or a host
  (`-h`/`--host`), and `--recurse-submodules`.
- **Merge gate**: for `pr_merge`, `gh` args containing both `pr` and `merge`, `gh api` args mentioning "merge" or reading a body
  from a file (`--input`, `@file`, `=@`), or `api` whose JSON mentions "merge": ask `merge_gate.blocked(task)`; if it returns a
  reason the call fails with it.
- **Account isolation** (`GhEnv`, `Account`): account = project's `github_account` else profile's, stored in `mcp-run.json`;
  form `login` or `HOST/login`. Token from `gh auth token --hostname= --user=` (30 s timeout, token env vars removed). Each call
  gets a private `GH_CONFIG_DIR` (`$XDG_CACHE_HOME|~/.cache/huntaway/gh-account/<id>/hosts.yml`, mode 0700/0600, removed after;
  leftovers older than 24 h swept), `GH_HOST`, no `GH_TOKEN/GITHUB_TOKEN/GH_ENTERPRISE_TOKEN/GITHUB_ENTERPRISE_TOKEN`, and on
  Linux `DBUS_SESSION_BUS_ADDRESS=disabled:` (no keyring). Targets on other hosts are refused before running, using gh's own
  `--help` for the command (cached per `command sub`) to tell target arguments from content; fallback heuristics when no help.
- **Unsandboxed-git hardening**: env `GIT_CONFIG_COUNT/KEY_n/VALUE_n` sets `core.hooksPath=/dev/null, core.fsmonitor=false,
  protocol.file.allow=never, submodule.recurse=false, push.recurseSubmodules=no, fetch.recurseSubmodules=false`; a repo whose
  local/worktree config sets anything matching `REPO_COMMANDS` (sshCommand, gitProxy, askPass, credential helper, remote
  receivepack/uploadpack/proxy/vcs, http proxy/ssl, protocol allow, filter/diff drivers, submodule update, gpg programs…) is
  refused. `git_push` with an account: remote must be a name, all its push URLs on the account's host with no login in them;
  `-c http.*extraheader=` resets + a `credential.https://<host>.helper` that echoes `$IA_GH_GIT_TOKEN` (HTTPS only).
- Env always set: `GH_PROMPT_DISABLED=1 GH_PAGER=cat GH_NO_UPDATE_NOTIFIER=1 NO_COLOR=1 GIT_TERMINAL_PROMPT=0`. Timeout 600 s.
  Output = stdout + stderr, "(gh exited with exit status: N)" on failure, "Done." if empty, clipped from the middle over 60 000
  bytes.

### 2.11 Server `docs` (`mcp/docs_mcp.ts`, `doc_images.ts`) — `huntaway-docs`
- Tools come from the `@dire-kiwi/docs-render` WASM package's `toolDefinitions()` minus `share_document`, patched with
  `labels`/`images` arguments and the tools `set_document_labels`, `list_labels` if the package lacks them:
  `publish_document` (slug, title, message, mode `replace|merge`, folder, delete_paths[], labels[], pages[{path, content,
  format…}], images[{name,data}]), `list_documents` (label), `get_document` (**slug**, version), `read_page` (**slug**, **path**,
  version), `move_document` (**slug**, **folder**), `get_feedback` (**slug**, version, since), `list_components`,
  `set_document_labels` (**document**|slug, **labels**), `list_labels`. All callers; in `--allowedTools` / Codex approved.
- Documents belong to the run's task's profile; `task_id`/`run_id` stored on each version. Default folder = the task's project
  name (normalised), top level if none; a later publish never moves a document (result `note` says so).
- URLs: `<public_url setting or internal_url>/docs/<profile id>/d/<slug>/[-/v/<n>/]<page suffix>`.
- Images: PNG/JPEG/WebP/GIF(first frame)/AVIF by signature (SVG refused); inline `data:image/…;base64,` URIs outside code are
  lifted out and named `images/inline-<sha256[:16]>.avif`; converted with `sharp` to AVIF quality 60, effort 2, EXIF-rotated,
  ≤100 MP input, ≤512 000 bytes output (not resized), ≤200 images per version, names ≤200 chars `[A-Za-z0-9._-]` segments.
  Conversion only after the pages validate. Merge mode keeps previous images the pages still reference. Warnings for relative
  `<img src>` with no matching image.
- `get_feedback`: user comments as `selections` (`id, version, page, quote, comment, context_before, context_after,
  user:"user", created_at` unix s), `responses: []`, `cursor` = now (unix s).
- Protocol versions accepted: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05. Answers `resources/list` and `prompts/list` empty.
  Results carry both text and `structuredContent`.

### 2.12 Server `desktop` (`mcp/desktop_mcp.ts`) — `huntaway-desktop`
- Read tools (no approval): `health`, `apps`, `windows`, `read`, `screen`, `zoom`, `verify`, `op_status`. Write tools (ask;
  refused per call for reviewers and plan mode): `act` (≤64 steps → Cua `run_steps`), `launch`, `clipboard`.
- Session per task `huntaway-<task key>`; locked screen refuses all but `health`/`op_status`; one task holds the desktop at a
  time (`desktop.claim`); writes journaled in `desktop_ops` and run at most once per `op_id`; computer use turned off → error
  text. Structured content is folded into text (Claude would otherwise hide the text).

### 2.13 Approval rules and the hook commands
- Rules (`agent/approval_rules/rules.ts`): `{tool, decision: allow|ask|never}`; `tool` = exact name, `mcp__server` prefix, or
  `*` glob; case-insensitive; strongest matching decision wins (never > ask > allow); questions and `ExitPlanMode` are never
  ruled; plan mode drops allow rules. Only for the profile's assistant and threads whose parent is the assistant. Stored in
  setting `approval_rules:<profile id>` as `{rules, expiry_minutes}`; defaults target `mcp__google__*` (read/search/draft allow;
  send/share/modify ask; delete/trash never). ≤200 rules, pattern ≤200 bytes, no whitespace, no duplicates.
- Board tools: decided by the dispatcher (`check_rules`) under any of the names `mcp__huntaway__X`, `mcp__issue_agent__X`,
  `mcp__issue-agent__X`. `ASKS_ITSELF` (delete_task, create_project, *_automation) aren't asked twice.
- **`huntaway approval-hook '<rules json>'`** — Claude Code PreToolUse hook (in `--settings {"hooks":{"PreToolUse":[…]}}`,
  timeout 30 s), spawned by Claude Code for every tool call its matcher matches. Reads the call JSON on stdin, prints
  `{hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"allow"|"ask"|"deny", permissionDecisionReason}}`.
  Fails **closed**: exit 2 with a message when rules ask/refuse and anything goes wrong (the shell command also appends
  `|| { [ $? -eq 2 ] || echo '<HOOK_FAILED>' >&2; exit 2; }`). Must start fast because it runs per tool call: `bin/huntaway`
  execs `hook_main.ts` directly, which loads only `hook.ts` + `rules.ts` (no server modules, not even `util.ts`); the matcher is
  a hand-built case-insensitive regex limited to the MCP servers the rules name so other tools don't pay the start-up cost
  (`*` only if a rule isn't for an MCP tool). An `ask` from the hook reaches the permission prompt tool in every mode, so Bypass
  runs with ask-rules still get `--permission-prompt-tool`. Exact `never` rules also go into `--disallowedTools`. Blocked calls
  are found in the output by the text "Blocked by the user's approval rules" and logged.
- **`huntaway gh-hook`** — Claude Code PreToolUse hook with matcher `Bash`, timeout 10 s, on every run that has our gh server.
  Denies any Bash command that runs `gh` (shell-aware check `git/changes.ts runs_program`; an unparsable command is denied)
  telling the agent to use the `gh` tools. Runs on every Bash call, so `mcp/gh_mcp.ts` and its parts import only light modules.
- **`huntaway gh-run <args>`** — what `gh` resolves to inside a `wait` command when the task has a GitHub account: a shim script
  `<data dir>/gh-shim/gh` (`exec '<exe>' gh-run "$@"`, written atomically) is put first on `PATH`, with `IA_GH_ACCOUNT` and
  `IA_GH_BIN` (the real gh). It applies `refuse()`, checks targets, fetches the token, runs gh with the isolated env, and exits
  with gh's code. The shell itself never sees the token.
- Codex: no hooks; rules become per-server config (`default_tools_approval_mode="prompt"`, per-tool `approval_mode`,
  `disabled_tools`), the reviewer is forced to `user`, and a `never` rule on Codex's own tools refuses to start the run.
- Action log (`approval_log`): every ask/never hit; outcome pending/allowed/denied/expired/blocked; `answered_by` user, push,
  telegram, mode, rule, ended, expiry; 5000 rows kept per profile.

## 3. Data

- **`mcp_calls`**: `id` PK (HTTP: random id; control: `stdio:<run>:<request id>` or `stdio:<run>:codex:<id>`; up-call:
  `up:<host>:<call id>`), `run_id`, `task_id` ('' for up-calls), `tool`, `args` JSON (HTTP: the arguments; control tool call:
  `{request_id, rpc_id, arguments, codex?}`; control prompt: `{tool_name, input, tool_use_id, request_id, codex?}`), `status`
  (`executing`|`done`; column default `pending` unused), `result` JSON, `error`, `created_at`. Pruned by `agent/runs.ts`: rows
  older than 1 h whose run is gone or exited over 1 h ago, 1000 per batch.
- **`permission_requests`**: `id`, `task_id` (FK cascade), `message_id`, `tool_name`, `input` JSON (rewritten on answer: with
  `answers`, or the edited automation), `status` (`pending|allowed|denied|expired`), `created_at`, `call_id`, `note`, `kind`
  (`tool|project|delete_task|automation`), `expires_at`, `rule` (matching pattern). Indexes on call_id, (task_id,status),
  partial on expires_at.
- **`pr_watches`**: PK (`task_id`, `pr` = lowercased `host/owner/name#n`), `state` JSON `Row {seen:{head, failed[], passed,
  remarks[], conflicting}, pending?:{call_id, told:Seen, superseded?}, last:<summary>, polled_at, comment_wakes, woke_at?,
  comments_paused}`, `updated_at`.
- **`approval_log`**: `id, profile_id, task_id, request_id, tool_name, summary (≤300 chars), rule, decision, outcome,
  answered_by, created_at, decided_at`.
- **Task columns written here**: `agent_wait` JSON `AgentWait {reason, since, until, tasks:[WaitTask {id,key,status,review_at?}],
  command?, call_id, run_id, moved_to?, subagent_finished?:{status,summary,task_id,tool_use_id}, pull_request?:WaitPr {url, repo,
  number, events[], news?}}`; `pr_checks` JSON `PrChecks {url, head, outcome, failed:[{name,conclusion,url}] ≤20, more_failed,
  pending, passed, since}`; `tracked` JSON `TrackedItem[] {id,title,note,status,task_id,task_key,url,created_at,updated_at}`;
  `auto_allow` JSON string list; `attention_reason`, `status`, `permission_mode`, `created_by`, `pen_id`, `background_work`.
- **Run columns**: `attention` (question text), `finished` (0/1, cleared when another turn starts).
- **Settings keys**: `approval_rules:<profile id>`, `public_url`, `default_permission_mode`.
- **Thread messages**: `kind:"permission"` and `kind:"question"` (data above; statuses mirrored from the request).
- **Wire types**: `PendingPermission {id, task_id, tool_name, input, created_at, expires_at, rule}`; `Approval` union
  (`ProjectApproval`, `ProjectCreationApproval`, `DeletionApproval`, `AutomationApproval`, `WorkflowApproval`) each `{request_id,
  status, note?, task_id, created_at?, kind, tool_name, input}` with inputs `ProjectChange {project, task, changes:[{field, from,
  to, needs_approval}], reason}` (+ `apply`), `ProjectCreation {op:"create", project, task, board, repo_path, exists, git,
  permission_mode, reason}` (+ `changes`, `apply`), `TaskDeletion {project, task, delete:{id,key,title,status,branch,running,
  subproject}, tasks_with_it[], delete_branch, reason}`, `AutomationChange {op, project|profile, task, automation:
  AutomationView, before?, changes?, time_zone, reason}` (+ `apply`), `WorkflowChange {op, project, task, workflow:WorkflowView,
  before?, changes?, reason}` (+ `apply`).
- **Task JSON given to agents** (never the DB row): `summary` = `{id, key, title, status, resolution, running,
  attention_reason, branch, preview_url, pr_url, review:{state,summary,issues}|null, project_id, profile, host}` + optional
  `external_links, starred, model, effort, remind_at, reminder`; `summarize` adds `depends_on[], start_from, base_branch,
  merges_into, merge_held, stack, github_stack, stack_merge, carries, merging_into_it[], queued_for_dependencies, is_subproject,
  group_task, labels, documents{label:path}, type, thread_of_pen, pen, subproject`; `task_details` adds `description,
  worktree_path, last_message, stack_title, stack_description, created_tasks[], workflows[]`. `get_task` overview: fields in key
  order kept inline if pretty-JSON size ≤1000 bytes and within a 6000-byte total budget, plus `field_lengths` and
  `omitted_fields`. `get_task_field` → `{task_id, field, format:text|json, offset, limit, length, total_length, next_offset,
  content}`.
- **Files**: `<run dir>/mcp-run.json` `{cwd, github_account, review, in_process, desktop}`; `<run dir>/mcp.json`;
  `<data dir>/gh-shim/gh`; `~/.cache/huntaway/gh-account/<id>/hosts.yml`; `$TMPDIR/issue-agent-wait-<id>.log` (unlinked at once).

## 4. In-memory state

- `s.calls_inflight: Map<call id, resolvers[]>` — calls executing now + duplicate deliveries waiting. Lost on restart by design:
  the DB row says `executing`.
- `s.perm_waiters: Map<request id, wakers[]>` — calls blocked on a decision; rebuilt when the call is resumed.
- `kept_calls: Map<event id, Promise>` (http.ts) — gh/docs/desktop answers for reconnecting clients, 10 min; not persisted.
- `cancelled: Set<call id>` (requests.ts) — calls the agent gave up on, so they aren't answered.
- `s.uplinks: Map<hub id, Uplink>` with `pending: Map<number, resolver>`; dropped with the connection (pending calls fail).
- `HELP_CACHE` (gh help per command), cached WASM renderer and `sharp` module (lazy), `schemas` (lazy tool schema list).
- In-review watcher's `watched: Map<task id, {url, watcher, next, failures}>` — rebuilt on restart (first read after 2 min).
- `TaskEvents` subscription per wait (queue of task ids since subscribe).
- Running wait commands (child, log fd, keep-alive pipe) — die with the server (watchdog), restarted by the resumed call.
- Persisted instead: everything in §3; `agent_wait` (deadline, watched tasks, PR news, subagent result), `pr_watches`.

## 5. Outside the process

- Binaries: `gh` (`api graphql`, `auth token`, `auth status --json=hosts`, `<cmd> --help`, `run view --job N --log-failed -R`,
  tool commands), `git` (`push`, `config --show-scope --list`, `remote get-url --push --all`, `config --get-regexp`),
  `bash -c` (wait commands), `cua-driver mcp` (desktop, other area), Claude Code / Codex spawn the hook commands.
- HTTP: linked hosts `POST /api/tools/<tool>`; hub link frames `hub_hello`, `hub_call`, `hub_result` on `/api/host/ws` (or
  tunnel `Up::ToolCall` / `Down::ToolAnswer`).
- Env read: `IA_GH_BIN` (real gh for gh-run), `IA_GH_ACCOUNT`, `GH_REPO`, `IA_CWD` (tests' GhRun), `IA_DEBUG` (log fan-out
  failures), `XDG_CACHE_HOME`, `HOME`, `PATH`, `IA_TS_EXE` (the launcher path used in hook commands). Env set for children:
  `IA_GH_GIT_TOKEN`, `GH_CONFIG_DIR`, `GH_HOST`, `GH_REPO`, `GIT_CONFIG_*`, `TMPDIR`, `MCP_TOOL_TIMEOUT`.
- Ports: none of its own; served on the host's HTTP port under `/api/mcp/`.

## 6. Background work

| What | Interval / limit |
|---|---|
| Permission expiry sweeper (`start_sweeper`) | at start, then every 15 s |
| Wait loop tick (run-stopped check) | 5 s (200 ms in tests); otherwise woken by task events |
| PR poll during a wait | first read before the wait starts; then every 60 s; failure backoff `min(60 s·2^min(n,4), 600 s)`; give up after 5 in a row (`unreadable`) |
| In-review watcher | sweep every 15 s; each PR every 120 s (first read 120 s after first seen); failure backoff `min(120 s·2^min(n,4), 1200 s)`; warn event at exactly 5 failures, keeps trying |
| SSE keep-alive / progress | 20 s; `retry` 5 s |
| Kept gh/docs/desktop answers | 10 min |
| gh call timeout | 600 s tools; 60 s PR reads; 30 s token/status |
| Stacked merge poll | 2 s, up to 10 min |
| Uplink call timeout | 300 s |
| `mcp_calls` pruning | rows > 1 h old (with the runs prune) |
| Stale gh config dirs | removed if > 24 h old, whenever a new one is made |

## 7. Surface

- HTTP: `POST|GET /api/mcp/{run id}/{huntaway|gh|docs|desktop}` (run bearer); `POST /api/tools/{tool}` `{profile, args,
  task_fields}` → `{result}` or 400 `{error}`; `GET /permissions?task_id=&profile_id=` → `PendingPermission[]`;
  `POST /permissions/{id}` `{decision: allow|allow_always|deny, message?, answers?, mode?, feedback?, automation?, via?:"push"}`
  → `{ok, status}` (404 unknown, 409 not pending / conversation moved on, 400 bad mode/answers);
  `GET /project-approvals?all=&automations=&workflows=` → `Approval[]`; `POST /tasks/{id}/questions/{message_id}` `{choices,
  text}` → Task; `POST /tasks/{id}/fix_checks`; `POST /tasks/{id}/tracked/remove` `{ids}`; `GET|POST
  /profiles/{id}/approval-rules`; `GET /profiles/{id}/approval-log`. (`POST /permissions/{id}/push-answer` and Telegram answers
  call `answer_by` from other areas.)
- CLI: `approval-hook <rules>`, `gh-hook`, `gh-run <args…>` (and `codex-run <spec>` which carries Codex requests).
- MCP: §2.5, §2.10–2.12. JSON-RPC methods: `initialize` (echoes the client's protocol version; default `2025-06-18`), `ping`,
  `tools/list`, `tools/call`; else `-32601`. Board results: `{content:[{type:"text", text: pretty JSON}]}` or `{content:[{text:
  "Error: …"}], isError:true}`. `initialize` returns `instructions` text (added to the agent's system prompt).

## 8. Events

- Emits: `task` (every `update_task`: agent_wait, pr_checks, attention, status, tracked…), thread message added
  (`permission`, `question`), `message_updated {task_id, message}`, thread events for edited items, `docs {profile_id, slug}`,
  `approval_log {profile_id, task_id}`, task events `warn`/`info` from the in-review watcher; telemetry `board_tool {run_id,
  tool, status, duration_ms}` and `permission {tool, status, outcome, wait_ms, attrs}`.
- Consumes: `task` events (waits); run output lines (`control_request`, `control_cancel_request`, Codex requests,
  `task_notification`/`task_updated` for subagents, `assistant` tool_use for activity); run end (`wait.ended`, expiry).

## 9. Invariants and hard-won rules

- Nothing runs unless it's recorded first; a call found `executing` after a restart is only re-run if it is read-only, resumable
  by call id, or still waiting on an approval (dispatch.ts).
- Control answers are written before the row is marked done; duplicates are never answered twice (dispatch.ts `handle_control`).
- A wait subscribes to task events **before** reading any state; a permission waiter registers **before** reading the row
  ("so a decision can't slip in between").
- One read + one write with nothing in between when recording PR news, a subagent's completion, or tracked items (don't
  overwrite a newer wait or a board move).
- A permission request is only raised while the call's run is still the run the host holds for the task; otherwise the thread
  would be flagged for nothing (permissions.ts).
- Approval prompts are keyed by (call id, tool name) because one call can ask twice (a rule, then the tool itself).
- Only explicit column moves end a wait (`moved_to`), since the board itself moves the task to Needs attention and back for a
  subagent's prompt.
- PR news counts as told only once returned to the agent; first wait treats existing comments as seen but still reports check
  outcome and conflict (pr_watch.ts header).
- "An agent that waited on checks alone sat until its timeout when the pull request conflicted" → checks and conflicts always
  end a PR wait (HA-300). Unwatched waits capped at 30 s; command waits at 600 s after a loop on a misnamed file slept an hour
  (HA-301); the command gets the task's `$TMPDIR` for the same reason.
- A workflow run with unstarted jobs counts as pending, or "all checks passed" fires after the first job.
- In-review wakes: only maintainers' comments, never bots or the account's own; text in untrusted-data tags; max 10
  comment-only wakes; re-check idleness after the slow log fetch (`still_wakes`).
- Reviewer and plan limits are enforced server-side per call, not only by the tool list (a run's list is fixed at launch while
  its mode changes; Claude doesn't validate arguments of deferred tools, hence `check_args`).
- `create_task` validates marks/pen before creating, so a failed call leaves no task for a retry to duplicate.
- Only the changed fields of a project/automation/workflow are applied, exactly as the user saw them.
- Run secret is an HMAC of the host token so restarts keep URLs valid and no secret is stored.
- Claude Code drops an HTTP call 90 s after its connection broke unless it saw progress → progress notifications; it gives up on
  an HTTP call after 5 min without news unless `timeout` is set.
- Structured content must not be returned by desktop tools (Claude shows it instead of the text).
- Hook must fail closed with exit 2: "Node before 24.2 doesn't set import.meta.main: the hook then did nothing and exited 0 …
  so ask and never rules didn't hold (HA-245)"; an exit 1 lets the call through (HA-254).
- gh tools run git outside the sandbox with the account's token: hooks off, repo-config commands refused, no file transport, no
  submodule recursion, `--repo` on merge to stop gh's local cleanup, branch must not be a refspec.
- An up-call's profile name proves nothing: require the hub's switch, the right connection kind, and `assistant_host`.
- `get_task` output is bounded because review summaries ran to thousands of characters on every wait (HA-390).

## 10. How it is tested

- Fakes: `pr_watch.fake(f)` / `fake_pages(f)` replace GitHub reads; `pr_watch.response(...)` builds a GraphQL answer;
  `TEST_GH_PROGRAM` cell swaps the gh binary; `gh_mcp.merge_testing {poll_ms, wait_ms}`; `GhRun_from_env()`; `wait.timing.shortest`
  and shorter `TICK`/`POLL`/`REVIEW_POLL` under `IN_TEST`; `reached("mcp:executed")` checkpoint; `hook(rules, input)` takes an
  injected stdin reader.
- Helpers: `mcp/tools/testing.ts` (`state`, `task`, `started_run`, `grant`, approve/deny the next approval, `cut_short` =
  simulate a restart by forgetting `calls_inflight` and `perm_waiters`); `hosts/uplink/testing.ts` (two nodes with their own
  ids, served APIs, a hub linked by URL); `sweep(s, watched, now)` is exported so tests drive the in-review watcher by hand.
- Tests per part: `dispatch.test.ts`, `local.test.ts`, `tasks.test.ts`, `resolve.test.ts`, `approvals.test.ts`, `http.test.ts`,
  `wait/tests.test.ts`, `pr_watch/tests.test.ts`, `gh_mcp/tests.test.ts`, `permissions/tests.test.ts`, `questions.test.ts`,
  `docs_mcp.test.ts`, `doc_images.test.ts`.

## 11. Dependencies

- Calls: `db` (tasks, runs, projects, profiles, pens, docs, settings), `api` (`create_task_inner`, `update_task_inner`,
  `create_project_inner`, `update_project_inner`, `delete_one/last`, `Deleting`, `check_todos`, `project_fields`), `agent/runner`
  (`send`, `send_from_agent`, `send_as`, `send_for_user`, `work_dir`, `task_github_account`, `task_gh_env`,
  `agent_reviews_waits`), `agent/runs` (`write_input`, `run_dir`, `can_run_agents`, `agent_env`), `agent/task_tmp`,
  `agent/documents`, `agent/approval_rules`, `agent/assistant`, `integrations/automations` and `workflows`, `review`
  (`submit`, `merge_gate`), `hosts/hub` + `uplink`, `git/worktree`, `git/relocate`, `threads/history` + `messages`, `desktop`,
  `telemetry`.
- Called by: `serve.ts` (routes `/api/mcp/`, starts watcher + sweeper), run output followers (`runner/output.ts`,
  `codex/driver.ts`), `runner/launch.ts` + `runs.ts` (config), API handlers (`api/thread.ts`, `api/host.ts`, `api/tasks.ts`,
  `api/projects.ts`), push/Telegram answer integrations, `hosts/hub` (up-calls).

## 12. Rewrite notes

- **Accidental / legacy**: Rust-port shapes (`{ok}|{err}` unions, `canonical`/sorted-key JSON to mimic serde, `*_default()`
  constructors, `drop()`); the `McpCall.task_fields` flag and "helpers from older builds" comments (helpers are gone — every
  current caller passes `true`; only old linked hosts lack it); `mcp_calls.status` default `pending`; the hidden
  `permission_prompt` tool name; `LEGACY_MCP_SERVER_NAME = "issue_agent"` and `issue-agent` in rule matching, wait-tool
  detection and `approves_own_waits`; the `issue-agent-wait` argv0/log name; env prefix `IA_`; the whole `too_old` API-version
  table (44/45/48/58/59/67/107/127/129/131/151), `pen_active` (`hidden` → `active`), and `call_linked`'s legacy `get_task`
  slicing — only needed for mixed-version host fleets; `changes` on a project creation and `kind:"workflow"` vs `automation`
  "for UIs from before"; `summarizer` alongside `summarizers`; `is_subproject`/subproject arguments (new subprojects can't be
  made); docs-tool patching for old renderer versions (`LABEL_TOOLS`, `IMAGES_HELP`); three transports for the same board tools
  (in-process, Codex dynamic, HTTP) where HTTP for `huntaway` survives only for compactions and old Codex sessions.
- **Probably a bug / gap worth deciding on**: `get_task_field` and `track_work` are absent from `RERUNNABLE`; the gh server has
  no reviewer flag (restriction is only the CLI's disallow list); tracked-work tools are listed to every run but only work for
  the assistant; `GH_TIMEOUT_MS` (15 min client) vs gh's own 10 min.
- **Essential**: at-most-once with resume-by-call-id; answering before marking done; per-run derived secret; server-side
  reviewer/plan gates; approvals outside the permission mode with "apply exactly what was shown"; the wait end-condition set and
  its restart behaviour; PR "told" bookkeeping; account isolation and unsandboxed-git hardening; fail-closed fast hook.
- **Awkward today**: permission state is split across `permission_requests`, the thread message's data and the task's
  status/attention; prompts and tool calls share `mcp_calls` with different `args` shapes; `wait` state lives in a task JSON
  column mutated from several places (API move, PR watcher, subagent notifications); synchronous SQLite is relied on for
  "read+write with nothing in between".
