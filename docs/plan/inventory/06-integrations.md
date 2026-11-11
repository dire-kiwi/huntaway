# 06 Integrations (`apps/server/src/integrations/`)

Source: `the huntaway repository/apps/server/src/integrations/**`, `wire/{workflows,automations,asana,github}.ts`, `db/docs_site.ts`,
`docs/guide/{workflows,integrations,github,mobile,concepts}.md`. Paths below are relative to `apps/server/src/` unless they start with `docs/`.

## 1. Purpose

Everything that makes the board act by itself or talk to the outside. **Workflows** are a project's graphs of nodes that take a task across the
board column by column (prompts for the task's agent, checks, reviewer/summary agent steps, opening the PR, sending fixes back, moving the task).
**Automations** create tasks or message tasks on a schedule or on a webhook delivery; a profile's automations (**routines**) wake its assistant.
**Push** sends the board's notifications to browsers (Web Push + VAPID) and the mobile app (Expo), and lets a permission prompt be answered from a
notification with a one-time token. Smaller parts: **Asana** task search for linking, **GitHub** repository listing/cloning/creating for new
projects, **hosted docs** publishing (OAuth device flow + MCP over HTTP), per-column **status scripts**, and **Telegram** (a bot per assistant; not in use).

## 2. Capabilities

### 2.1 Workflows: the model (`integrations/workflows.ts`, `workflows/model.ts`, `wire/workflows.ts`)

A workflow = `{id, project_id, name, enabled, graph, created_at, updated_at}`; `graph = {nodes: Node[], edges: Edge[]}`.
A node = `{id, kind, ...kind fields, join?: "any"|"all" (omitted when any), x, y, label? (data nodes only)}`.
An edge = `{from, port, to, input?}`. Without `input` it is a **flow edge** (the way a run goes: out of `from`'s outcome `port` into `to`).
With `input` it is a **data wire**: `from`'s value `port` replaces `to`'s text input `input`.

Statuses (columns): `backlog, todo, in_progress, needs_attention, in_review, ready_for_merge, done` (labels Backlog, To do, In progress, Needs
attention, In review, Ready for merge, Done).

| kind | fields (defaults) | flow ports (outcomes) | data inputs | data outputs (values) |
|---|---|---|---|---|
| `trigger` | `on: "manual"` | `out` | - | - |
| `column` | `status`, `prompt` (""), `done_when?: "run_end"\|"finish"` (stored only when `finish`), `max_rounds?` (in_progress only; default `COLUMN_ROUNDS`=3) | `done` | `prompt` (not for needs_attention/done) | `next` |
| `condition` | `check: changed\|has_commits\|has_pr\|task_type\|label`, `value?` | `yes`, `no` | - | - |
| `agent` | `name`, `prompt` (""), `output: "text"\|"verdict"` (text), `claude_config_id?`, `model?`, `effort?`, `skills?`, `disabled_mcp_servers?`, `tab?`, `input_only?`, `keep_conversation?` | text: `done`, `failed`; verdict: `pass`, `issues`, `failed` | `prompt` | `text`, `issues`, `verdict` |
| `split` (A/B test) | `weights: number[]` ([50,50]), `each_run?` | `a`..`h`, one per weight | - | `path` |
| `send_to_task` | `message` (""), `max_rounds` (2) | `sent`, `exhausted` | `message` | - |
| `open_pr` | `title` (""), `body` (""), `draft?` | `opened`, `exists`, `failed` | `title`, `body` | `url` |
| `text` (data) | `text` | none | - | `text` |
| `task` (data) | - | none | - | `title, description, key, branch, commit, pr, labels` |
| `project_prompt` (data) | `which: start\|review\|merge` (start) | none | - | `text` |
| `compose` (data) | `template` | none | one per `{{name}}` without a dot (regex `\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}`) | `text` |
| `join` (data) | `separator` ("\n\n"), `count` (2, 1..8) | none | `in1`..`in<count>` | `text` |
| `switch` (data) | `check: has_pr\|task_type\|label`, `value?` | none | `yes`, `no` | `text` |
| `set_status` (legacy) | `status` | read as a column node | | |

Legacy reads (`Graph_from_json`): `trigger on:"status"` + `status` -> column node of that status; `trigger on:"finished"` -> column `in_progress`;
`set_status` -> column node; their `out` edges become `done`. Edge `port` defaults to `"out"`.

**Checks.** `changed`: true for a manual run; else true unless the workflow's last *done* run on this task that reached this node (state not
pending/skipped, looked up in the latest 20 runs) has the same `head` and the same `task_run`. `has_commits`: false without branch/ready worktree;
else `git merge-base <base> HEAD != HEAD` (base from `worktree.work_scope`). `has_pr`: `task.pr_url` non-blank. `task_type`: `(task.task_type ??
"code") === (value ?? "code")`. `label`: `task.labels` includes `value`.

**Where the agent works** (`agent_works`): a column node whose status is `in_progress` or `ready_for_merge`, or any column with a non-blank prompt
or a wire into `prompt`. There the column's `done` waits for the agent's work; elsewhere `done` follows at once.

**Limits** (`workflows.ts`, `check.ts`, `model.ts`): `MAX_NODES`=80, `MAX_AGENTS`=8, `MAX_ROUNDS`=20, `COLUMN_ROUNDS`=3, `MAX_TEXT`=20 000 bytes (prompts,
messages, PR body, text, template), PR title 1000 bytes, `MAX_SKILLS`=10, `MAX_JOIN`=8, `MAX_PATHS`=8, `MAX_WEIGHT`=1000, compose inputs <= 20,
join separator <= 100 chars, node id 1..40 of `[A-Za-z0-9_-]`, name 1..100 chars, agent name 1..60, tab <= 30, data label <= 60, model <= 100 chars
no whitespace/control and not starting with `-` (it goes on the agent's command line), disabled MCP servers <= 50 each <= 100 chars,
`MAX_CHAIN`=10 runs in a row started by workflow moves, 20 finished runs kept per (workflow, task).

**Validation** (`check_graph`, `check.ts`): at most one trigger; needs a trigger or a column node; one node per column; Done and Needs attention
can't have a prompt; `done_when` dropped where the agent doesn't work and refused on Ready for merge; `max_rounds` only on in_progress (1..20);
`task_type` value is `code` or one of `db.TASK_TYPES`, `label` value one of `db.LABELS`; agent `claude_config_id` must be one of the project's/profile's
available configs; effort in `db.THREAD_EFFORTS`; skills trimmed with leading `/` or `$` stripped; split 2..8 weights each 0..1000 with one > 0;
edges must name existing nodes and existing ports/values/inputs; one wire per input; no duplicate flow edge; no edge into the trigger or into a data
node; an edge into Done only from `after_merge(g)` (Ready for merge's `done` and steps after it that no other column/trigger also reaches); no flow
cycle except through a column (edges into columns are removed before the cycle check); no cycle among data nodes through wires. Blank optional
settings are deleted; non-finite x/y become 0. `check_columns` (`change.ts`): a column where the agent works may belong to only one *enabled*
workflow of the project (409 on create/enable/graph change).

### 2.2 Workflows: a run and how the engine advances (`workflows/engine.ts`, `engine/*.ts`)

- **What starts a run** (`TriggerOn`): `status` (task entered a column: `on_status`), `finished` (agent's work in a column done: `on_finished`),
  `merged` (`on_merged`, `on_merge_finished`), `manual` (`POST /workflows/{id}/run`, `run_workflow`).
- `on_status(task)` is called after every status change (api/tasks.ts, runner/output.ts, review/merged.ts, review/merge_gate.ts). It: stops runs
  waiting at a column the task left (`left_columns`, not when the new status is in_progress/needs_attention); returns for in_progress and
  ready_for_merge (they start on work done / merge); if the task is done-as-merged calls `on_merged`; then starts every enabled workflow's node for
  that column (only if `project.use_workflows`), skipping ones in `QUIET`, in the background. If the move came from a workflow step and the chain
  would reach `MAX_CHAIN` it adds a warn event and starts nothing.
- `start(workflow, task, manual, chain, on, at)` under the global `STARTING` mutex (`start_locked`): task must be `kind==="task"` in the workflow's
  project; archived project -> nothing (409 if manual); non-manual needs `enabled && use_workflows`. Start node: manual -> trigger, else the column
  node for the task's status; otherwise node `at` (or the column node for in_progress / ready_for_merge / task status). Non-manual guards: `status`
  needs node.status === task.status; `finished` not when task done or merging; `merged` needs task done, or in ready_for_merge and not merging.
  `waits = !manual && on==="status" && agent_works(node)`. A column with nothing after it and not waiting starts no run (a run would hide the
  last one's output). `task_run` (task's latest agent run id) is read *before* checking `is_running`; a running agent refuses the start (except
  `merged`). Refused when the same workflow already has a running run that started at the same node. Deduplicated once per agent finish / per
  merge: previous run has the same `source` and `task_run`. `head` = `git rev-parse --verify HEAD` in the ready worktree. After the git read it
  rechecks `later_run || is_running`. Run row inserted with the graph snapshot, every non-data node `pending` except the start node (`running` with
  `start:true` when waiting, else `done` with port `out`/`done`), `rounds` = previous run's rounds (fresh `{}` for manual). Event "Running the
  workflow "X"". After the lock: if waiting, the column's prompt is sent to the task's agent (`runner.send_as(…, auto=true)`), then `advance`.
- `advance(run_id)` loop: reload run; `plan` marks each pending node whose incoming flow edges' sources are all settled as `running` (if at least
  one incoming edge was taken, i.e. source not skipped and `source.port === edge.port`; with `join: all`, every one) or `skipped`, repeating until
  something is ready or nothing changes (a node with no incoming edges is skipped; a column node counts as settled for its successors unless it is
  `running`); `settle` ends the run (`done`) when no non-data node is pending/running; save; run each ready node in order and `record` what it did
  (only if the run and node are still `running`). Agent steps only *start* here; their end calls `advance` again. So parallel branches run at once.
- Node execution: `trigger` -> `out`. `condition` -> `yes`/`no` (an error: state failed, no port). `split` -> kept path from the latest earlier run
  that reached the same split node (unless `each_run`, or that path now weighs 0), else weighted random (`engine_testing.random`), event
  "took path A … (N% likely)", text = `A`. `open_pr` (`engine/steps.ts`): has PR and no worktree -> `exists`; no own commits -> `exists` if it has a
  PR else failed; `git_push` via the gh MCP tool runner as the task's GitHub account to the GitHub remote of the task's remote base; then `pr_create
  {repo, head, title, body, base?, draft?}` (title default `<key>: <task title>`; body default the task agent's last assistant text, else the
  description, else the title); "already exists" -> `exists`; sets `task.pr_url` if unset; text = URL.
- `agent` step (`engine/agent_step.ts`): needs a host that can run agents and a ready worktree/branch (`elsewhere`). Thread = the node's thread from
  the latest earlier run that had one, if it still exists, is a workflow thread of this task and has the same config/model/effort; else a new task
  row `kind:"review"`, `task_type:"workflow"`, `parent_id` = task, `status:"todo"`, `use_worktree:false`, title `<name> (<workflow>) of <key>`.
  Deleted config -> the task's config. Sets the thread's skills and disabled MCP servers; clears `session_id` and context unless
  `keep_conversation` and the thread has a session. Records `thread_id`, `label` (e.g. "Claude · haiku"), `after_run` (thread's latest run before
  this) on the node, then `runner.send_review(thread, prompt)`. The prompt (`prompt.ts agent()`): who it is, description, where the work is (three
  variants: branch with PR tools; `own_start` -> `git diff <base>...HEAD`; `elsewhere` -> the agent's last message quoted, max 6000 chars), the user's
  replies (verdict steps), the output of upstream agent steps (any agent node with a flow path to it, quoted, 6000 chars), its instructions
  (blank: project review prompt for verdict, or `Read the work, and report on it as "<name>".`), skills (`/skill` for Claude, `$skill` for Codex),
  how to report, and for a verdict step with rounds used the issues it found last time to recheck. `input_only` omits where the work is.
- Step end (`finished` -> `step_ended`, called by runner/output.ts for a `review` run of a workflow thread): matches the running node by
  `thread_id`, ignores a run not after `after_run`. Cancelled -> `stopped`; failed -> `failed` "The step failed: …"; asked the user -> `failed` "The
  step's agent asked: …"; verdict without `submit_review` -> `failed`; verdict -> `done` port `pass`/`issues`, text = summary or what it wrote; text
  step -> `done` port `done` with what it said since asked, or `failed` if nothing.
- `submit_review` from a workflow thread (`submit`): `serious_issues` (array or string) -> verdict `issues` with the list; `verdict:"needs_fixes"`
  without issues uses the summary as the issue; else `pass`. Stored on the node while it runs.
- `send_to_task` (`send`): message = wired/own text rendered, else `fixes(workflow, issues)` (numbered issues of the run's verdict steps, prefixed
  `(step name)` when several); appends the finish note when In progress waits for `finish_work`. If `rounds[node] >= max_rounds`: warn event with the
  issues, port `exhausted`, and with no edge out of `exhausted` the task goes to `needs_attention` with the reason (unless running/done/merging). If
  the task's agent is running or the task is done/merging: failed, findings left in a warn event. Otherwise: `rounds[node]++`, node `done` port
  `sent`, all other pending nodes skipped and running ones stopped (their threads stopped), run `done`, then `runner.send_fixes(task, text, round)`.
- Edge into a `column` node (`enter_column`): into in_progress with rounds used up -> `out_of_rounds` (task to Needs attention with the issues, node
  failed). Into Done only for a `merged` run with the task in ready_for_merge and not merging. Moves the task (`api.update_task_inner`, with a
  `MOVING` entry so the runs it starts continue the chain; a move to needs_attention sets `attention_reason` "failed at …" or "moved it here").
  The node ends with **no port**: what follows the column is the next run's. Into in_progress with an idle started task it ends the run as a send
  does and sends the agent the issues (if any and the prompt isn't wired) or the column's prompt (fallback the start text); a never-started task is
  started with empty text.
- Run end (`ended_run`): event "finished" or "finished with steps that failed" (list). Then `release`: for a `finished`-source run whose task is
  still idle in in_progress with no later agent run and no other `finished` run going: no failure -> move to `in_review` (event "ended without
  moving the task, so it goes to In review"; `QUIET` entry so In review's node doesn't start again if the run started there); a failed step or a
  stopped run -> `needs_attention` with the reason. For a `merged` run that left the task in ready_for_merge -> needs_attention (`merge_left`).
- Stopping: `supersede` when the task's agent starts again (all runs but those waiting at a column; no release); `stop` when the user stops the
  task (event "Workflow stopped"); `left_columns`; `stop_waiting` when the workflow is turned off; delete stops all its runs; `POST
  /workflow-runs/{id}/stop`. `stop_run` marks pending nodes skipped, running ones `stopped` with the reason as text, stops their threads.
- **The agent's work in a column** (`engine/columns.ts`, called from `agent/runner/output.ts` when a task agent's run ends and would go to In
  review): `on_finish_due(task)` -> a running run waiting at a column whose agent ran since, else the enabled In progress node that has edges after it
  or `done_when: finish`. If due, the task **stays in its column** (status not set). If the node asks for `finish_work` (`asks_finish`: `done_when
  finish`, and for in_progress only code tasks) and `runs.finished` isn't set -> Needs attention "The agent ended its turn without saying its work in
  X is done (with finish_work)". Otherwise `on_finished`: starts a `finished` run at the node, or marks the waiting node `done` and turns that run
  into a `finished` one (`source`, `task_run` rewritten) and advances. A run that doesn't start -> `unheld` -> In review.
- **Prompts taken over by workflows**: `start_instructions` (In progress node's prompt or the project start prompt + done note, code tasks only),
  `merge_instructions` (Ready for merge node's prompt), `merge_finish` (when a path from Ready for merge's done reaches Done: tell the merging agent
  to call `finish_work`, "Don't set the task's status yourself"), `board_opens_pr` (an `open_pr` follows In progress's done: the system prompt stops
  telling the agent to push/open a PR; not while merging/remerge), `with_finish`/`with_due_finish` (append the finish note to fix messages and the
  todo-list nudge). `done_note`: "When you're done, end your turn with a summary of what you did. The board then <after_done list>." or the
  `finish_work` variant; `after_done` lists steps after `done` up to the next columns, skipping `failed`/`exhausted` edges.
- **Merge**: `on_merged` (task Done as merged -> `merged` run at Ready for merge's node); `on_merge_finished` (agent called `finish_work` while
  merging and a workflow moves to Done: runner clears `merging`, the run moves the task to Done); otherwise Needs attention with why.
- **Values** (`engine/values.ts`): an input reads its wire (`output_value`, depth limit 40) or its own text rendered. A step's value comes from the
  run, else from the workflow's latest of 20 earlier runs on the task where that node is `done`. Templates (`prompt.ts render`): `{{task.key}}`,
  `{{task.title}}`, `{{task.description}}`, `{{branch}}`, `{{commit}}` (run head), `{{workflow}}`, `{{issues}}`, `{{<id>.text|issues|verdict}}`,
  `{{<id>.path}}`; unknown names are left as written. Join's separator turns literal `\n` into newlines.
- **Review settings as a workflow** (`store.ts`): `review_settings_graph(project)` (null when `auto_review` is off): column In review `start` ->
  condition `changed` -yes-> one verdict agent per reviewer (`db.reviewers_for`, max 8; ids `reviewer`/`reviewerN`, tab "Review") -issues-> `fix`
  (`send_to_task`, `max_rounds = project.review_rounds` clamped 0..20); with `auto_summary`, text agents per summarizer (`summary`/`summaryN`, tab
  "Summary", `SUMMARY_PROMPT` default, `join: all` when several reviewers) from every reviewer's `pass`. `move_review_settings` creates it enabled
  as "Review and summarise" / "Review" when `use_workflows` is turned on (api/projects.ts) unless an enabled workflow already has an In review node
  that does something. `move_all_review_settings` does this once at startup for all `use_workflows` projects (setting `workflows_reviews_moved`).
  With `use_workflows` on, the board's own auto review and summary do not run (`review.ts`, `review/summary.ts`).
- **Presets** live in the web app (`apps/web/src/components/settings/workflows/presets.ts`): Board's default (In progress -> In review -> Has
  commits? -> review-settings graph; Ready for merge -> Done), Work, PR and review, Open a PR when done, Summarise then a skill, From the Review
  tab, Review and summarise, Blank (only a trigger).
- CRUD (`change.ts`, `handlers.ts`), run listing for a task (`latest_runs`: latest run per workflow plus the latest earlier run in which each
  agent step ran, so tabs keep each step's last output).

### 2.3 Automations and routines (`automations.ts`, `automations/*.ts`)

- CRUD for a project's automations and a profile's routines; checking and tidying trigger, action, active hours, precheck, budget, secret (`check.ts`, `handlers.ts`).
- Triggers: `interval` (5 min .. 31 days, from when turned on/changed), `daily` (`HH:MM` + weekdays; all seven = none), `cron` (5 fields, own parser
  `cron.ts`: ranges, steps, lists, month/day names, `@hourly|@daily|@midnight|@weekly|@monthly|@yearly|@annually`, Vixie day rule, Sunday 0 or 7),
  `at` (once, RFC 3339 or local `YYYY-MM-DD HH:MM[:SS]`; stored as UTC; turns itself off), `webhook` (filters <= 16, `coalesce_seconds` <= 3600, `coalesce_key` <= 500 bytes).
- Schedule arithmetic in the host's time zone with DST rules (`next_daily`, `Cron_next_after`, `align` to active hours; `time_zone()` for display).
- Scheduler (`running.ts start/start_due/claim_due/claim_batches`): claim-then-run, missed-run policy, coalesced batches, interrupted runs, pruning.
- Guards before a run (`guards`): routine's assistant is on this host; active hours; daily budget; previous fresh-thread run still going; precheck command.
- Actions (`act`): `create_task` (templated title/description, type, labels, config, model, effort, status todo|backlog, optional start),
  `send_to_task` (templated message to a task of the same project), `message_assistant` (`routines.message`: `fresh` thread or the assistant's `thread`).
- Webhook receive (`webhook`, `receive`, `delivery.ts`): token check, rate limit, HMAC signature, ping ignore, filters, dedupe, coalescing, template values, untrusted-data wrapping.
- Run now / test delivery (`run_now`); run history with task info and live costs (`run_json`, `runs_handler`).
- Routine thread end -> report message in the assistant's thread, outcome and cost recorded (`routines.finished`); unread reports prefaced to the
  assistant's next prompt and marked read (`unread_reports`, `mark_read`); cost attribution of agent runs (`taken_in`, `agent_run_ended`); pruning routine threads.
- Morning brief = a routine template created by `agent/assistant/brief.ts` (other area) through `create_routine`.

### 2.4 Push (`push.ts`, `push/*.ts`, `push_answers.ts`)

- VAPID key creation/storage, RFC 8291 `aes128gcm` encryption, RFC 8292 `Authorization: vapid` header (`push/webpush.ts`).
- Subscriptions: subscribe/update/unsubscribe/test, per-device event choices, per-paired-device ownership, Expo token rotation (`push/handlers.ts`, `push/subscriptions.ts`).
- Sending: Web Push one by one, Expo in batches of 100, ticket and receipt handling, deleting gone subscriptions, `last_error` (`push/subscriptions.ts`, `push/expo.ts`).
- Watching every host's events on the hub and deciding what notifies: task column changes, permission prompts, routine reports, assistant replies (`push/events.ts`).
- One-time tokens that answer a permission prompt from a notification, forwarded to the prompt's host (`push_answers.ts`).

### 2.5 Asana, GitHub, hosted docs, status scripts, Telegram

- Asana (`asana.ts`): validate a personal access token (`me`), label "Name (email)", search tasks (typeahead per workspace, 25 each, open first) or
  resolve a pasted URL/gid (`task_gid`), fetch one task. Linking itself is `external_links` on the task (tasks area).
- GitHub (`github.ts`): list repositories an account can clone (own + collaborator up to 3 pages of 100, plus contributed-to via GraphQL, newest
  push first, de-duplicated), search by name among the account's login and orgs (50 results), validate `OWNER/REPO` and repo names, clone with `gh
  repo clone` into a reserved folder, create a repository from a folder with `gh repo create --source --remote origin [--push]` (with `git init` and rollback).
  Signed-in accounts (`GET /github-accounts`) come from `mcp/gh_mcp/env.ts accounts()`.
- Hosted docs (`docs_site.ts`, `db/docs_site.ts`): connect a profile by OAuth device flow or pasted token, refresh rotating tokens, publish a
  local document version (pages, folder, labels, images) through the site's MCP `publish_document`, ask-before-overwrite, remember where it went.
- Status scripts (`status_script.ts`): on every task status change run the project's any-column script then the new column's script, serially per task.
- Telegram (`telegram.ts`, `telegram/*`): see 12.1 (not in use).

## 3. Data

### 3.1 Workflow tables (migration 88, 112, 113)

- `workflows(id PK, project_id FK cascade, name, enabled INT default 1, graph TEXT JSON Graph, created_at, updated_at)`; index on `project_id`.
- `workflow_runs(id PK, workflow_id FK cascade, task_id FK cascade, source, state, head, task_run, graph TEXT JSON (snapshot), nodes TEXT JSON
  {nodeId: NodeRun}, rounds TEXT JSON {nodeId: n}, detail, created_at, updated_at, finished_at)`; indexes `(task_id, workflow_id)`, `(state)`.
  On insert, non-running runs beyond the newest 20 per (workflow, task) are deleted. JSON maps are written with sorted keys.
- `Run`: `source` = `status|finished|merged|manual`; `state` = `running|done|stopped`; `head` = task HEAD commit at start; `task_run` = task's latest
  agent run id at start (not sent on the wire); `detail` = why stopped. The API adds `workflow_name` (null once deleted).
- `NodeRun`: `state` (`pending|running|done|skipped|failed|stopped`), `port?`, `thread_id?`, `label?`, `text?` (agent output / PR URL / split path /
  sent message / failure reason), `verdict?` (`pass|issues`), `issues?: string[]`, `after_run?`, `start?`, `started_at?`, `finished_at?`. Data nodes have no entry.
- `thread_mcp_servers(task_id PK, disabled TEXT JSON string[])`: the project's MCP servers an agent step's thread doesn't get. Thread skills via `db.set_thread_skills`.
- `projects.use_workflows INT default 0` (migration 113 set it for projects that had an enabled workflow with a column start). Also read:
  `auto_review`, `auto_summary`, `review_rounds`, reviewers/summarizers, `archived_at`.
- `runs.finished INT`: set by the MCP tool `finish_work`, cleared when a user message starts another turn (`runner/queue.ts`).
- Setting `workflows_reviews_moved` = "1" once the one-time move ran.
- Agent step threads are ordinary task rows (`kind='review'`, `task_type='workflow'`, `parent_id`); they survive workflow deletion.

### 3.2 Automation tables (migrations 55, 91)

- `automations(id PK, profile_id FK cascade NOT NULL, project_id FK cascade NULL (null = routine), name, enabled, trigger TEXT JSON, action TEXT
  JSON, token TEXT (webhook URL secret, never sent), secret TEXT NULL (HMAC secret, never sent), next_run_at, last_run_at, active_hours TEXT JSON
  NULL, precheck TEXT NULL, budget_usd REAL NULL, created_at, updated_at)`. Trigger/action JSON stored with sorted keys.
- `automation_runs(id PK, automation_id FK cascade, source, status, detail, task_id, delivery_id, event, count INT default 1, batch_key,
  batch_id, payload TEXT JSON Delivery, due_at, created_at, finished_at, outcome, cost_usd REAL, agent_run_id)`; indexes `(automation_id,
  created_at)`, `(status, due_at)`, `(automation_id, delivery_id)`, `(task_id)`, `(agent_run_id)`. `batch_key` and `payload` are never sent.
- `Trigger`: `{kind:"interval", every_minutes}` | `{kind:"daily", time:"HH:MM", weekdays}` | `{kind:"cron", expr}` | `{kind:"at", at}` |
  `{kind:"webhook", filters:[{path, op, value}], coalesce_seconds, coalesce_key}`. Filter ops: `equals, not_equals, starts_with, contains, in, not_in, exists, not_exists`.
- `Action`: `{kind:"create_task", title, description, task_type: "scratch"|null, labels?, claude_config_id, model, effort, status:"todo"|"backlog",
  start}` | `{kind:"send_to_task", task_id, message}` | `{kind:"message_assistant", message, mode:"fresh"|"thread"}`.
- `ActiveHours`: `{start:"HH:MM", end:"HH:MM" (may be past midnight; hours past midnight belong to the day they started), weekdays}`.
- Run `source`: `schedule|webhook|manual`. `status`: `pending` (waiting to coalesce), `coalesced` (into `batch_id`), `running`, `ok`, `failed`,
  `skipped`, `filtered`, `duplicate` (`batch_id` = the earlier run), `rejected`. `outcome` (fresh routine thread): `quiet|reported|asked|failed|stopped`.
- API-only fields on an automation: `cost_usd`, `cost_today_usd`, `hook_path` (`/api/hooks/<id>/<token>`), `has_secret`, `last_run`; on a run:
  `task {key, title, status, running}` and a live `cost_usd`. MCP adds `webhook_url` (host setting `public_url` + hook path) or `webhook_note`.
- `Delivery` = `{body (JSON, or form `payload` JSON, or text, or null), headers (lower-case names, each cut to 1000 chars, without `authorization,
  proxy-authorization, cookie, x-hub-signature, x-hub-signature-256`), query}`.
- Template paths (`lookup`): from a delivery `body.<path>` (dots, list indexes, `*`), `headers.<name>`, `query.<name>`, `event`
  (`x-github-event` or `x-event-key`), `action` (`body.action`), `labels` (`body.label.name` + issue/pull_request/discussion label names),
  `delivery`; from the board `automation`, `source`, `count`, `date`, `time`, `now`; `precheck` (untrusted); `google` (routines). Paths are
  `[A-Za-z0-9_.*-]`, <= 200 bytes. Cuts: value 20 000 chars, whole text 100 000, title one line of 200. Untrusted values in text are wrapped in
  `<untrusted-data>` with `<`/`>` escaped, and a note is prepended (`untrusted_note`).
- Retention (`prune`): per automation keep the newest 1000 runs, and of runs older than 7 days only the newest 50; never delete `pending`/`running`,
  nor runs of the last 2 days that cost something or made/messaged a task; payloads kept only for the newest 5.
- Routine reports: a thread message `kind:"report"`, data `{automation_id, automation, task_id, key:"A-<n>", outcome, text (<= 20 000), read?}`.
- Tasks columns used: `task_type='routine'`, `parent_id`, `cost_usd`, `queued_routine_runs`, `queued_routine`.

### 3.3 Push tables and settings (migrations 62, 94, 97)

- `push_subscriptions(id PK, endpoint UNIQUE, p256dh, auth, name default '', events TEXT JSON, created_at, last_sent_at, last_error, kind default
  'web', device_id)`. `events` = `{attention, review, merge, done: bool; prompts: "off"|"assistant"|"all"; replies, reports: bool}`. New
  subscription default: attention, review true; merge, done false; prompts assistant; replies false; **reports true**. A stored value missing a
  field reads the same except **reports false**. For `kind:"expo"` the endpoint is the Expo token and `p256dh`/`auth` are empty.
- `push_answer_tokens(token_hash PK (sha256 hex), request_id, host_id, task_id, status default 'pending', created_at, claimed_at, expires_at)`;
  index `(request_id, host_id)`. Status: `pending|answering|allowed|denied|expired|timed_out|closed`. Rows older than 30 days deleted on mint.
- Setting `vapid_private_key`: base64url of the 32-byte P-256 scalar, created on first use.
- Push payload (`Message`): `{title, body, url:"/t/<task>", tag, task_id?, event?, request_id?, answer?: {url, token}}`; `host_id` and `summary` only go to Expo.

### 3.4 Other data

- Asana: `profiles.asana_token`, `asana_user` (label), `asana_enabled` (default 1). `AsanaTask {gid, name, url, completed, notes, assignee, projects[], workspace}`.
- GitHub: `GithubRepo {full_name, name, description, private, fork, archived, pushed_at, url}`, `GithubRepoList {account, repos, error}`,
  `GithubAccount {account, host, login, active, ok}`; `profiles.github_account`, `profiles.clone_dir`.
- Hosted docs (migrations 104, 105): `docs_site_clients(site_url PK, client_id, created_at)`; `docs_site_connections(profile_id PK FK cascade,
  site_url, kind 'oauth'|'token', access_token, refresh_token, expires_at INT ms, login, connected_at)`; `docs_site_published(doc_id FK cascade,
  site_url, remote_slug, remote_version, local_version, url, version_url, published_at, login; PK (doc_id, site_url))`. Tokens are never returned or logged.
- Status scripts: `projects.status_script TEXT` (any column), `projects.status_scripts TEXT JSON {status: script}`.
- Telegram: settings keys `telegram_token:<profile>`, `telegram:<profile>` (config), `telegram_state:<profile>` (offset, sent prompts), `telegram_outbox:<profile>`.

## 4. In-memory state

| State | Where | For | Across a restart |
|---|---|---|---|
| `STARTING` AsyncMutex | workflows/engine.ts | one run start checked and recorded at a time (not held while advancing) | n/a |
| `MOVING` list `{task, workflow, chain}` | engine.ts | marks a status change as made by a workflow step, to count the chain | lost; fine |
| `CHAIN` Map runId -> n | engine.ts | runs in a row started by moves; stop at 10 | lost; chain restarts at 0 |
| `QUIET` Set `task\|workflow\|node` | engine.ts | don't restart In review's node when `release` moves the task there | only held during the move |
| run/node state | DB `workflow_runs` | everything else | `resume` (see 6) |
| `IN_FLIGHT` Set automationId | automations/running.ts | one scheduled/coalesced run per automation at a time | lost; `running` rows are marked failed "Interrupted" |
| `STARTING` Set automationId | automations/running.ts | a fresh-thread routine between its guard check and making its thread | lost |
| `RECENT` Map id -> times | automations/delivery.ts | 60 deliveries/min per automation (`<id>:unsigned` bucket apart) | lost |
| `PushState.tasks` Map `<host>:<id>` -> task JSON | push.ts | previous state to diff against | rebuilt as a baseline without notifying |
| `PushState.pending` Set | push.ts | "ready to review" waiting out 5 s | lost |
| `PushState.moves` Map key -> [status, at] | push.ts | moves the user made in the last 15 s don't notify | lost |
| `PushState.prompts` Map key -> Set requestId | push.ts | pending prompts already pushed (suppress the attention push) | lost; cleared per host on reload |
| `PushState.ready` / `watching` | push.ts | a link counts as connected only after its initial snapshot was taken as baseline | rebuilt |
| `PushState.tickets` | push.ts | Expo tickets awaiting receipts | **lost** (receipts never read) |
| `answering` claims | DB | one answer at a time | `push_answers.recover` resets `answering` -> `pending` |
| `KNOWN` Map account -> [time, owners] | github.ts | login + orgs cache, 5 min | lost |
| `FOLDERS` Map path -> AsyncMutex | github.ts | one clone/create per destination folder (never freed) | lost |
| docs-site `pending`, `refreshing`, `publishing`, `last_site` (WeakMap per state) | docs_site.ts | device sign-in in progress, shared refresh promise, per-document publish chain, last site after disconnect | **lost**: a sign-in under way must be restarted |
| `QUEUES` Map taskId -> Change[] | status_script.ts | serial script runs per task, in order | lost: queued scripts don't run |
| Asana `TEST_URL` | asana.ts | test seam | n/a |

## 5. Outside the process

- **Binaries**: `git` (`rev-parse --verify HEAD`, `merge-base <base> HEAD`, `rev-parse --show-toplevel`, `init -q`, `remote get-url origin`, `remote
  set-url`, `status --porcelain --untracked-files=no`, `config --get-regexp ^remote\..*\.url$`); `gh` (`api user`, `api user/repos?affiliation=owner,collaborator&sort=pushed&per_page=100&page=N`,
  `api graphql -f query=…repositoriesContributedTo…`, `api user/orgs?per_page=100`, `api -X GET search/repositories -f q=… -f per_page=50`, `repo clone
  <target> <dest>`, `repo create <target> --private|--public --source <dir> --remote origin [--push]`, `config get git_protocol --host <h>`), run
  with `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `GIT_TERMINAL_PROMPT=0` and a per-account `GH_CONFIG_DIR` (`gh_mcp.account_env`), clone
  and create in their own process group killed with SIGKILL on timeout; `bash` for prechecks (`worktree.run_limited`, env `runs.agent_env()`) and
  status scripts (`worktree.run_script`); the gh MCP tool runner (`gh_mcp.run("git_push" | "pr_create")`) for `open_pr`.
- **HTTP services**: push services at each subscription's endpoint (POST, headers `Authorization: vapid t=<jwt>, k=<pub>`, `Content-Encoding:
  aes128gcm`, `TTL: 86400`, `Urgency: high|normal`, `Topic: <32 hex of sha256(tag)>`, 30 s timeout; 404/410 = gone); Expo
  `https://exp.host/--/api/v2/push/send` and `…/getReceipts` (30 s timeout, optional bearer); Asana `https://app.asana.com/api/1.0` (`/users/me`,
  `/tasks/{gid}`, `/workspaces/{gid}/typeahead`; bearer token; 15 s timeout); the docs site (`/.well-known/oauth-authorization-server`,
  registration, device authorization, token endpoint, `/mcp` JSON-RPC with `mcp-protocol-version: 2025-06-18`, answers as JSON or SSE; 20 s
  timeout; `redirect: "error"`); Telegram Bot API `https://api.telegram.org`. Linked hosts through `hub.host_request`.
- **Inbound without the board's token**: `POST /api/hooks/{id}/{token}` and `POST /api/permissions/{id}/push-answer`.
- **Environment**: `IA_PUSH_SUBJECT` (VAPID `sub`, default `https://github.com/dire-kiwi/huntaway`), `IA_EXPO_PUSH_URL` (fake Expo),
  `IA_EXPO_ACCESS_TOKEN` (Expo enhanced security), `IA_ASANA_URL`, `IA_TELEGRAM_API`, `IA_GH_BIN` (which gh), `TZ` and `/etc/localtime` (time zone
  name shown). Status scripts receive `IA_TASK_KEY`, `IA_TASK_TITLE`, `IA_OLD_STATUS`, `IA_NEW_STATUS`, `IA_RESOLUTION`, `IA_PR_URL`,
  `IA_WORKTREE_PATH` (empty without a worktree) plus the setup script's variables (`worktree.script_env`).
- Host setting `public_url` (owned by api/host.ts) builds full webhook URLs. No file watchers, sockets or ports of its own.

## 6. Background work

- **Workflows**: no timers. Work is driven by status changes, agent run ends and API calls, each in a detached task. At startup
  (`serve.ts`, after `runner.load_active`): `move_all_review_settings`, then `resume`: every running node of every running run becomes `failed`
  ("Interrupted: the server stopped while this ran." / "…before this step's agent started.") except agent steps whose thread's agent is still
  running and column nodes a run waits at; all running runs are advanced; tasks in the merge-handoff state (ready_for_merge, not merging, not
  running, latest agent run `finished`) with no `merged` run get `on_merge_finished`.
- **Automations scheduler**: `TICK` 5 s (`setTimeout` after each pass; passes don't wait for the runs). Each pass `claim_due` + `claim_batches`.
  At start `mark_interrupted` (all `running` rows -> `failed`, not rerun). `prune` and `routines.prune_threads` at start and every hour.
  Missed runs: interval runs once late then continues from now; daily/cron later than `LATE_GRACE` 10 min are recorded `skipped` "Missed: …"; `at`
  runs however late then disables itself. Precheck limit 120 s (output cut to 20 000 chars, stderr tail 2000). Dedupe window 7 days. Coalesce
  window <= 3600 s; at most 20 pending per automation. Routine threads deleted 14 days after finishing.
- **Push**: Expo receipts every 5 min for tickets at least 15 min old (dropped after 23 h; batches of 300; a failed fetch re-queues). Review grace
  5 s; move grace 15 s. Events are handled strictly one at a time through a queue. VAPID JWT valid 12 h, made per push.
- **push_answers**: claim lease 6 min; tokens kept 30 days; `recover` at push start.
- **GitHub**: gh JSON calls 60 s; `gh config get` 10 s; clone 60 min; create 15 min; owners cache 5 min.
- **Hosted docs**: device poll every `interval` s (default 5), +5 s on `slow_down`, retried on network error or 5xx until `expires_in` (default 600 s);
  access token refreshed 60 s before expiry and on a 401.
- **Status scripts**: 300 s limit each; output cut to 20 000 chars.
- **Telegram**: long poll 50 s; send retry backoff up to 300 s; outbox <= 300 items; link code 10 min.

## 7. Surface

HTTP (all under `/api`, board token unless noted; registered in `api.ts`):

| Method, path | Meaning |
|---|---|
| GET/POST `/projects/{id}/workflows` | list `{workflows}`; create `{name, graph, enabled?}` |
| GET/PATCH/DELETE `/workflows/{id}` | read; change any of `{name, graph, enabled}`; delete -> `{deleted:true}` |
| POST `/workflows/{id}/run` | `{task_id}`: run by hand (on or off); 409 "Can't run the workflow: <why>" |
| GET `/tasks/{id}/workflow-runs` | `{runs: Run[] (+workflow_name), workflows: [{id, name, enabled}]}` |
| POST `/workflow-runs/{id}/stop` | `{stopped: bool}` |
| GET/POST `/projects/{id}/automations` | `{automations, time_zone: {name, offset}}`; create `{name, trigger, action, enabled?, secret?, active_hours?, precheck?, budget_usd?}` |
| GET/POST `/profiles/{id}/automations` | routines (409 if the profile's assistant is on another host) |
| GET/PATCH/DELETE `/automations/{id}` | PATCH also `rotate_token: true`, blank `secret` clears, null clears guards; DELETE -> `{ok:true}` |
| POST `/automations/{id}/run` | Run now; for a webhook a test delivery `{payload?, event?}` (filters only) |
| GET `/automations/{id}/runs` | `{runs (50), latest_delivery: {body, event}|null}` |
| POST `/hooks/{id}/{token}` (no auth, 1 MiB) | delivery -> `{run, status, detail}`; 202 running/pending/coalesced/filtered, 200 duplicate, 401 rejected, 409 off, 429 rate or 20 pending, 413 too big, 404 unknown id/token/not a webhook |
| GET `/push` | `{public_key, subscriptions}` (a paired device sees only its own) |
| POST `/push/subscriptions` | `{endpoint, keys?: {p256dh, auth}, kind?: "web"|"expo", name?, events?}` upsert by endpoint |
| PATCH/DELETE `/push/subscriptions/{id}`, POST `…/test` | change name/events (merged), remove, send a test (502 with why) |
| POST `/permissions/{id}/push-answer` (no auth, 64 KiB) | `{token, decision: "allow"|"deny"}` -> `{result, message, error}`; result `allowed|denied|answered|expired|closed|invalid|offline|failed`; 200/400/403/409/502/503 |
| GET `/profiles/{id}/asana/tasks?q=` | AsanaTask[]; 409 if off or not connected; 502 on Asana errors |
| GET `/github-accounts`, GET `/github-repos?account=&q=` | accounts gh is signed in to; repositories to clone |
| POST `/profiles/{id}/projects/clone` | `{repo: "OWNER/REPO", repo_path?, name?, key?}`: clone as the profile's GitHub account into `repo_path` or `<clone_dir>/<repo name>`, then add the project (handlers in api/projects.ts) |
| POST `/profiles/{id}/projects/github` | create a repo from a folder `{repo_path, name?, key?, repo_name?, owner?, visibility: "public"\|"private"}` -> project + `github {full_name, pushed, push_error}` |
| GET/DELETE `/profiles/{id}/hosted_docs`, POST/DELETE `…/device`, POST `…/token` | status; disconnect; start/cancel device sign-in `{site_url?}`; connect with `{site_url?, token}` |
| POST `/profiles/{id}/docs/{slug}/publish` | `{version?, slug?, ask?}` -> `{published, warnings}` or `{exists: {slug, title, latest_version, url, owner}}` |
| GET/PATCH `/profiles/{id}/telegram`, POST `…/link`, DELETE `…/owner` | Telegram settings |

MCP tools (schemas in `mcp/schemas/{workflows,automations,waiting}.ts`, logic in `mcp/tools/{workflows,automations,local,dispatch}.ts`):
`list_workflows`, `create_workflow`, `update_workflow`, `delete_workflow`, `run_workflow`; `list_automations`, `create_automation`,
`update_automation`, `delete_automation`, `run_automation` (with `routines: true` for the caller's own profile's routines; `generate_secret`,
`remove_secret`, `rotate_url`); `finish_work` (sets `runs.finished=1`); `submit_review` (routed to `workflows.submit` for a workflow thread).
Create/update/delete ask the user first (a permission request of `kind='automation'` whose input carries `apply`, the view, `before`, `changes`,
`reason`); only turning off or renaming applies without asking; what is applied is exactly what was approved. `get_task` includes `workflows`
(latest runs' agent steps). No CLI subcommands; `huntaway gh-run` belongs to gh_mcp.

## 8. Events

Emitted (board event bus -> websocket): `workflows_changed {project_id, workflow_id}`; `workflow_runs_changed {task_id}` (every run save);
`automations_changed {project_id, profile_id, automation_id}` (CRUD, every run/delivery recorded, cost update); `docs_site {profile_id}`; `docs
{profile_id, slug}` after a publish; `task`/`task_deleted` for routine threads; `hosts_changed` (push, when a link becomes ready); thread events via
`add_event(task, info|warn|error, title, detail)` for workflow progress, status script output, automation notes; `report` messages; telemetry
`automation_run`. Telegram emits `assistant_reply {task_id, profile_id, message_id, telegram}`.

Consumed: push subscribes to `hub_events` (all hosts): `task`, `task_deleted`, `message` (kind `permission` pending -> prompt push; kind `report`
-> report push), `message_updated` (prompt settled), `assistant_reply`, `resync`, `hosts_changed`. Workflows are called directly by the runner and
API rather than through events (see 11).

**Which events notify** (`push/events.ts`, mirrors `apps/web/src/notifications.ts`), only for `kind === "task"` and never for a task first seen:
- `attention`: status became `needs_attention` and `attention_reason !== "Stopped by user"`. Body "Needs attention: <reason>" (Expo gets only "Needs attention"). Urgent.
  Not sent to a device that already got this task's pending prompt.
- `review`: became "ready to check" = `in_review`, not running, and `review` null or `review.state === "passed"`; must still hold 5 s later.
- `merge`: status became `ready_for_merge`. `done`: became `done` ("Done" / "Closed: not done" / "Closed: won't fix" from `resolution`).
- `prompt`: a pending permission message; body from `prompt_text` (never the tool input); tag `<host>:<task>:<request>`; urgent; with an `answer`
  token only when `answerable` (plain tool permission: not a question, not ExitPlanMode, not `kind` project/delete_task/automation/workflow).
  Device choice `prompts`: `assistant` (task_type assistant or routine) or `all`.
- `report`: outcome `reported` (first line) or `failed`; Expo summary "Posted a report" / "A routine failed". `reply`: "Replied", only for the
  assistant, not when it went back to Telegram.
- Nothing for a move the user made through this board in the last 15 s (`note_move` from hosts/hub/endpoints.ts). Title `<KEY>-<n> <title>`; key
  prefix = project key, `G` group, `S` scratch, `A` assistant/routine, else `T`. Body cut to 200 chars. Tag `<host>:<task>` (later push replaces earlier).

## 9. Invariants and hard-won rules

Workflows
- A run keeps the graph it started with; edits never affect runs in progress (`workflow_runs.graph`).
- An edge into a column ends that path; the column's own outcome belongs to the next run. This is the only allowed loop, and why the cycle check
  drops edges into columns (`check.ts cycle`).
- "Read before the check that it isn't running, so a run that starts in between counts as later" (`engine.ts`: `task_run` read before
  `is_running`), and the recheck after the git read: "The agent may have started again while git was read: `supersede` found no run to stop then."
- Sections that change a run have no `await` inside (Rust held an `UPDATING` mutex). `start_agent`: "From here on there's no await … a step of a
  run it has stopped doesn't start, and one that starts first is stopped with it." `record` only writes if run and node are still `running`.
- `STARTING` is not held while advancing: "steps can take minutes (a push) and would hold up every other task's workflows."
- An earlier thread run ending late must not end the current step: `after_run` + `db.run_after`.
- Once per agent finish and once per merge (`previous.source`/`task_run` dedupe): "a restart settles a plan task's column again".
- A run started by the agent finishing holds the task in its column; it must always be released (`release`, `unheld`, `flag_unfinished`,
  `merge_left`), each re-reading the task and doing nothing if it moved, is running, waiting, merging, or has a later agent run.
- Rounds carry from run to run, reset on a manual run, and are given back only when a run *could have reached* the send/In-progress node and
  skipped it; a send past another column is the next run's (`settle`).
- Sending to the task's agent (or giving it work via In progress) ends the run and stops its other steps: the work is about to change.
- Done is only for merged work: only a `merged` run may move a task there, and only Ready for merge's `done` path may point at Done.
- A column with nothing after it starts no run ("a run would hide the last one's output in the task's tabs").
- `finish_work` belongs to the run that called it; a follow-up message (fixes, todo nudge) must repeat the finish note (`with_finish`).
- Two workflows moving a task into each other's columns would loop forever: `MAX_CHAIN`.
- `review_settings_graph` emits only what `check_graph` accepts, "one it refused would leave the project without its reviews".

Automations
- Claim before acting: `next_run_at` moved on (and `enabled=0` for `at`) and the run row inserted in one transaction, conditional on the old
  `next_run_at` and `enabled=1`, so neither a restart nor a concurrent pass can run it twice. No backfill.
- An automation's scheduled/coalesced runs never overlap (`IN_FLIGHT`); others are not held up by a slow precheck. A claim is always dropped on error.
- Webhook: unknown id, wrong token and non-webhook all give the same 404; token compared in constant time (`same_secret`). The rate limit is
  counted *after* the signature check, with a separate bucket for unsigned deliveries, "so that anyone with the URL can't use up the minute's deliveries".
- With a secret, the delivery id is `body-sha256:<hex>`: "one that's been captured … can't be sent again with a new id". Duplicates only count
  earlier runs in `pending|coalesced|running|ok`, so a failed/rejected/off delivery can be resent.
- "No await from the checks to the record, so two deliveries at once can't both pass them" (`receive`).
- Answer the sender as soon as the run is recorded (GitHub's timeout is 10 s); the sender never sees internal failures or the task made.
- The payload can only fill templates; a message only goes to a task of the automation's own project (`target_task`); a routine can only message its
  own profile's assistant. The secret can't have leading/trailing whitespace ("GitHub signs with the secret as it's given").
- GitHub `ping` is ignored unless a filter asks for event `ping`.
- A run is linked to its routine thread before the agent starts, "so a run that ends at once still finds it". An empty thread that never started is deleted.
- Budget counts running work too (thread cost so far, share of the agent run that took the message). Manual runs skip active hours, budget and the still-running check, but not the precheck.
- A routine's precheck runs only in the assistant's own workspace, "not one that's become a symlink".

Push
- A host's tasks are loaded as a baseline before any change from it can notify; a link is shown connected only after that ("Publishing connected
  before that snapshot completed let a first change be swallowed into the baseline", `sync_host`). `push.start` runs before `hub.start`.
- `noted` updates/deletes a subscription only if it still has the endpoint the push went to (Expo token rotation).
- `merged_events`: a client that sends only some events must not turn the others off.
- Web Push carries the full body (encrypted); Expo gets `summary` because Expo/Apple/Google can read it. No push ever carries a tool's input.
- A paired device can only subscribe `kind:"expo"`, sees only its own subscriptions, and they are deleted when it is revoked (devices.ts). One Expo subscription per device.
- Answer tokens: stored as hashes; one prompt may have many; the first answer settles all; a single claimer at a time (`answering`, lease 6 min); a
  host that is offline releases the claim back to `pending`; `expires_at` is honoured even if the hub hasn't heard; a new token for a settled prompt is born settled.

Others
- GitHub: `check_repo` forbids an owner starting with `-`, `_` or `.` so nothing can be read as a gh option; search words are reduced to
  login/repo characters; a failed clone/create leaves the folder as it was (only what this call made is removed; parent folders only while empty); a
  `.git` git can't open is never initialised over; a clone whose checkout failed is removed; the folder is reserved so a repeated request waits and finds the project.
- Docs site: refresh tokens rotate, so concurrent refreshes share one promise and the DB update is conditional on the old refresh token; a
  connection is forgotten only if it still holds the token that failed; URLs from the site are used only if `http(s)`; publishes of one document are serialised.
- Status scripts: must be queued right after the status change on the same connection so they run in the order changes happened; scripts are re-read at run time.

## 10. How it is tested

- Workflows: `workflows/testing.ts` (project + task with a real git worktree, sample graphs, `step_ended` to fake an agent step's end),
  `engine_testing.GITHUB` (stand-in GitHub remote for `open_pr`) and `engine_testing.random`; `process.env.IA_SHIM_BIN=/nonexistent` so no agents
  run unless `runs.TEST_CAN_RUN`. Test files per part: `check`, `values`, `advance`, `columns`, `merge`, `splits`, `triggers`, `agent_steps`,
  `pull_requests`, `review_settings`.
- Automations: `tick_in(s, now, tz)` and `start_due` with an explicit clock and `Tz` (`fixed(offset)`); `receive` with `raw=null`; tests in
  `automations/tests.test.ts`, `tests/routines.test.ts`; runner helpers `assistant_running_with_a_routine`, `project_task_running_with_an_automation`.
- Push: `push/testing.ts` (a local push service, a browser's keys and `decrypt`, raising prompts), `timing.review_grace`, `PushState.expo_url`,
  `check_receipts(s, after)`, plain HTTP endpoints allowed for localhost, `push_answers.status_of`.
- Asana `set_test_url` / `IA_ASANA_URL` with `asana/tests.ts` fake; GitHub `github/tests.ts` writes a fake `gh` shell script, passed in as the `gh`
  argument of `clone`/`create` and via `gh_mcp.gh_program()`; docs site `timing` (request, slow-down, interval) against a fake site; Telegram
  `TelegramState.use_api`, `second`; `status_script.QUEUES` exported.

## 11. Dependencies

Calls out to: `db` (tasks, projects, profiles, runs, settings, docs), `api.update_task_inner` / `create_task_inner` / `delete_one` / `pick_config`,
`agent/runner` (`send_as`, `send_fixes`, `send_review`, `send_from_automation`, `send_from_routine`, `stop`, `task_github_account`, `key_prefix`),
`agent/runs` (`can_run_agents`, `agent_env`), `agent/prompts` (start/review/merge prompts), `agent/context.clear`, `agent/assistant`
(`get_or_create`, `routines_elsewhere`, memory `checked`, google `status_line`), `agent/documents`, `git/worktree` (`git`, `work_scope`,
`remote_base`, `github`, `remote_repo`, `run_script`, `run_limited`, `script_env`), `mcp/gh_mcp` (`run`, `Account`, `account_env`, `gh_program`),
`mcp/permissions` (`expire_for_*`, `is_question`, `EXIT_PLAN`, `EXPIRED_UNANSWERED`), `review` (`label`, `user_said`, `REPLIES`),
`threads/history` (`last_assistant_text`, `said_since_asked`, `user_replies`, `unread_reports`), `hosts/hub` (`host_request`, `find_link`), `telemetry`.

Called by: `serve.ts` (startup order: `automations.start`, `telegram.start`, `workflows.move_all_review_settings`, `workflows.resume`, …,
`push.start` before `hub.start`); `agent/runner/output.ts` (run end: `workflows.finished`, `on_finish_due`, `asks_finish`, `unfinished`,
`on_finished`, `on_status`, `merges_to_done`, `on_merge_finished`, `flag_unfinished`; `routines.agent_run_ended`, `routines.finished`);
`runner/send.ts` (`start_instructions`, `supersede`), `runner/launch.ts` and `prompt.ts` (`board_opens_pr`, `is_workflow`, `unread_reports`,
`mark_read`), `runner/merge.ts` (`merge_finish`, `merge_instructions`), `runner/todos.ts` (`with_due_finish`), `runner.ts`/`queue.ts`
(`routines.taken_in`); `api/tasks.ts`, `review/merged.ts`, `review/merge_gate.ts` (`on_status`); `api/thread.ts` (`workflows.stop`);
`api/projects.ts` (`move_review_settings`, GitHub clone/create); `api/profiles.ts` (Asana, GitHub lists); `api/docs.ts` (docs site);
`state.ts` (`status_script.status_changed` on every status update); `hosts/hub/endpoints.ts` (`push.note_move`, `link_ready`);
`mcp/pr_watch/*` and assistant memory reuse `UNTRUSTED_TAG`/`defang`; `devices.ts` deletes a device's subscriptions.

## 12. Rewrite notes

Accidental (Rust-port shape or compatibility):
- Hand-written "serde" readers and error texts (`Node_from_json`, `Trigger_from_json`, `field`, 422 "Failed to deserialize the JSON body…"),
  `sorted_json`/`sorted` to match serde's key order, `db.hidden` for fields kept off the wire, `InFlight` mimicking Rust `Drop`, `Notify`, string
  errors thrown in place of `Result<T, String>`.
- Legacy graph kinds (`trigger on: status|finished`, `set_status`), migration 113's backfill, `workflows_reviews_moved`, `task_type` holding a
  label from before API 71, push `MISSING` vs default events, "(API n)" version notes: compatibility with old hosts and databases.
- `MOVING` records the workflow "so the move doesn't start the same workflow again", but nothing reads it: only the chain count is used.
- Workflow approvals reuse permission `kind='automation'` (`expire_for_workflow` filters on `$.workflow.id`).
- Presets and the "Board's default" graph live only in the web client; the server has a second copy of the review-settings graph and of
  `SUMMARY_PROMPT` that must match it.
- The `IA_` prefix on environment variables (former name "issue-agent"); default VAPID subject is the project's GitHub page.
- Notification rules duplicate the web client's (`taskEvent`, `readyToCheck`, `notificationText`, grace constants).

Essential: the graph semantics in 2.2 (ports, joins, column-ends-path, rounds, per-run snapshot, values from earlier runs), the hold-and-release
of a task while its `finished` run goes, `finish_work`, the merge handoff, the claim-before-run scheduler, the webhook check order, untrusted-data
wrapping, per-device push ownership and one-time answer tokens.

Awkward today:
- The engine is entangled with the runner: `runner/output.ts` decides the task's next column and calls five workflow entry points in a set order;
  the engine in turn calls `api.update_task_inner`, which calls `on_status` back (hence `MOVING`, `CHAIN`, `QUIET`).
- Run state is one JSON blob rewritten on every change, guarded only by "no await in the critical section"; concurrent `advance` calls on a run are normal.
- `open_pr` is awaited inside `advance`, so sibling steps of that pass start after it; agent steps are the only truly asynchronous nodes.
- Cost attribution for automations joins three sources (run row, routine thread, share of an agent run) in SQL.
- Expo tickets, device sign-ins, status-script queues and the webhook rate limiter live only in memory.
- Time zone handling is hand-rolled offset arithmetic on the host's zone (`to_local`/`from_local`), including DST gaps and repeats.
- A hub does not forward webhooks; a delivery must reach the project's own host.

### 12.1 Telegram (not in use; summary only)

A bot per profile's assistant, running on the assistant's host. Token in setting `telegram_token:<profile>` (never returned); config in
`telegram:<profile>` = `{bot {id, username}, owner {chat_id, user_id, name, username, linked_at}, events {replies:false, reports:true, prompts:true,
attention:true}, link {code_hash, expires_at}, last_error, dropped {count, last_from, last_at}}`; `telegram_state:<profile>` = `{offset, awaiting,
replied, prompts {requestId: {message_id, html}}}` (max 200); `telegram_outbox:<profile>` = `{next, items [{id, item, sent}]}` (max 300). It
long-polls `getUpdates` (50 s; `message`, `callback_query`), links the owner chat with a one-time code (`/start <code>`, 10 min), forwards the
owner's messages and files to the assistant thread, and sends replies, routine reports, questions and permission prompts (Allow/Deny buttons,
answered through `permissions.answer_by` and using `push_answers.answerable`), editing a prompt's message when it settles. Sending is a persisted
per-profile queue with backoff up to 300 s. Markdown is converted to Telegram HTML and split at 3800 chars (`telegram/format.ts`). Routes: `GET/PATCH
/profiles/{id}/telegram`, `POST …/link`, `DELETE …/owner`. Its one coupling worth keeping in mind: its event watcher (`telegram/outgoing.ts
watch` -> `on_turn_end` -> `announce_reply`) is the only emitter of `assistant_reply {…, telegram: true|false}`, also for profiles with no bot, and
push's `reply` notifications depend on it. If Telegram is dropped, something else must emit that event at the end of an assistant turn (not for a compaction).
