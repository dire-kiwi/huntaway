# 09 Data model (`apps/server/src/db.ts`, `db/`, `wire/`)

Sources read: every non-test file under `apps/server/src/db/` and `apps/server/src/wire/`, all numbered and named
migrations, `backup.ts` (header and helpers), `threads/protocol.ts` and `threads/source.ts` (headers and types),
`docs/development.md` (_Database migrations_), `docs/guide/server.md` (_The database file_), `docs/guide/concepts.md`
(skimmed). Live schema and row counts were read with `sqlite3 -readonly ... mode=ro` from
`~/.local/share/issue-agent/huntaway-2.db` (1.28 GB, server 0.5.8, `user_version` 130). Besides `.schema`, `count(*)`
and four `settings` key names, I also read the bookkeeping rows `named_migrations` (2 names) and `db_origin` (1 row:
file name, version, file stamps). No other row contents were read. Nothing was written.

The checkout (master) is two named migrations ahead of the live database: `2026-11-11-background-work`
(`tasks.background_work`, `servers`, `lost_background`) and `2026-11-11-desktop-ops` (table `desktop_ops`). They are
marked "(checkout only)" below; an importer must tolerate their absence.

## 1. Purpose

One SQLite file holds the whole board of one host: profiles, agent configs, projects, tasks (each task is also an agent
thread), the thread contents (items, requests, events), agent runs and their accounting, approvals, automations,
workflows, published documents, pens, links to other hosts, devices, and a key/value `settings` table. `db.ts` is a
thin synchronous layer over `node:sqlite` (`one/all/run/value/tx`), `db/*.ts` holds row parsers and queries per table,
and `wire/*.ts` declares the JSON the API and websocket send (shared by relative path with the web and mobile
clients). There is no ORM and no schema file: the schema is the result of 129 numbered migrations (1..130, no 78) plus
dated "named" migrations.

## 2. Capabilities

**Connection and query helpers** (`db.ts`)
- `open(path)` then `one`, `all`, `run`, `value` with positional `?N` params; booleans stored 0/1, `undefined`->NULL, objects/arrays->JSON text.
- Prepared-statement cache per connection, LRU of 500 statements (HA-183: a token report spent half its time preparing).
- `tx(c, f, immediate?)`: BEGIN/COMMIT, nested calls become savepoints `sp<depth>`; `immediate` = `BEGIN IMMEDIATE` for a second process writing beside the server.
- `update_generic(table, allowed, id, fields)`: whitelisted-column UPDATE from `[column, json value]` pairs; `json_to_sql`.
- `hidden(obj, key, value)`: non-enumerable property so secrets/server-only fields never serialise.
- `json_list`, `json_or_default`: lenient JSON column readers (bad JSON -> default, never throws).
- `get_setting` / `set_setting` (trimmed; null or blank deletes the row).
- Enumerations: `STATUSES`, `RESOLUTIONS`, `PERMISSION_MODES`, `EFFORTS`, `THREAD_EFFORTS`, `AGENTS`, `LABELS`, task types; `check_resolution`.

**Schema and migrations** (`db/schema.ts`, `db/migrations.ts`, `db/migrations/*`)
- `schema.open(path)`: sets pragmas, runs numbered migrations above `user_version`, re-runs the pens `active/hidden` repair on every start, then runs pending named migrations.
- `not_current(conn)`: read-only reason why a database is not at this build's schema (used by backup, thread rebuild/report tools).
- Named migrations: folder listed at runtime, name `YYYY-MM-DD-words`, `after` dependencies, `foreign_keys: false` for table rebuilds, each in `BEGIN IMMEDIATE` with its `named_migrations` row; `standing()` gives pending/unknown names.

**Database file handling** (`db/file.ts`, `db/room.ts`)
- Chooses `huntaway-2.db`; on first start copies the older file (`huntaway.db`, else `issue-agent.db`) with `VACUUM INTO`, migrates the copy, records `db_origin`.
- Detects that an older build wrote to the older file since the copy (size + mtime ns of db and wal); warns; recopies only on `--recopy-db` / `recopy-db` marker file; previous file kept as `huntaway-2.db.replaced`.
- `check_room`: refuses a copy/backup that would leave under 100 MB free (`HEADROOM = 100_000_000`).

**Profiles and agent configs** (`db/profiles.ts`)
- CRUD for `profiles` and `claude_configs`; `ensure_profile(name, dir)` (the `--profile NAME=DIR` flag), `config_for_dir`.
- Resolution rules: `available_configs` (project override else profile list, default first), `task_claude_config`, `task_config_dir` (a thread with a session stays in the folder its session started in), `thread_config` (assistant / pens threads), `task_is_codex`.
- `reviewers_for`, `summarizers_for` (project -> profile -> one default reviewer); `summarizers_column` reads list or legacy single.
- `api_env(cfg)`: proxy env for Claude (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, empty `ANTHROPIC_API_KEY`); `settings_base_url` reads `settings.json` of a config dir (cached by mtime+size).
- `grants(profile, name)`: cross-profile agent access; `clone_dir_or_default`.
- `delete_claude_config`: removes the id from every profile/project list and the assistant/threads picks.

**Projects** (`db/projects.ts`)
- CRUD, `preview_project_update` (savepoint rolled back), `pull_requests(p, in_subproject)`; `is_git` / `has_commits` computed from the folder at read time.

**Tasks** (`db/tasks/*`)
- `insert_task` (savepoint; allocates `projects.next_number`; end-of-column position; pins the default config), `update_task` (whitelist + derived-column rules, section 9), `replace_title` (compare-and-set unless pinned).
- Reads: by id, project+kind, pen, number, creator, profile, fan-out, subproject, open PRs, PR-watch list, `run_time`.
- Projectless tasks: group (`G-n`), scratch (`S-n`), pens thread and pen threads (`S-n`), assistant and routines (`A-n`); lookups by number; `old_routine_tasks` for pruning.
- Stacks/targets: `stacked_on`, `merging_into`, `first_target`, `target_state`, `reaching`, `stacked_below`, `stack_state`, `stack_waits`, `stacked_levels`, `stack_of`, `stack_line`, `stack_run_tasks`, `stack_runs`, `due_restacks`, `unlinked_stack_levels`, `in_github_stack`, `task_base`, `stacked_base`.
- Merge queue: `merge_lane`, `merge_held`, `active_merge`, `queued_merges`, `merge_lanes`, `projects_with_queued_merges`, `merge_handoffs`, `stack_run_lanes`.
- Dependencies: `check_dependencies` (same project, no self, no cycle), `unmet_dependencies`, `waiting_tasks`, `drop_dependency`, `clear_projectless_dependencies`.
- Thread extras: `review_threads`, `summary_threads`, `thread_skills`, `thread_disabled_mcp_servers`.
- Derived readers: `is_scratch/assistant/routine/pens_thread/pen_thread`, `working_status`, `effective_permission_mode`, `is_merged`, `subproject_status`.

**Queued messages and legacy messages** (`db/messages.ts`)
- `queue`, `take_queued`, `clear_queued`, `take_parked_runs`, `queued_then` (joins with blank line, tracks who sent it and which automation runs it carries).
- `list_messages`, `message_page` (page by main-conversation count or 1 MiB), `subagent_messages` (cut-down subagent listing). Only for threads still on `messages`.

**Runs** (`db/runs.ts`): `insert_run`, `latest_run`, `run_after`, `later_run`, `add_cost` (session-total delta), `set_run_session`, `set_run_board_tools`, `session_board_tools`, `set_run_config_dir`, `session_config_dir`, `has_active_run`, `active_runs`, `idle_sessions`.

**Pens** (`db/pens.ts`): CRUD, unique case-insensitive name per profile, colour allocation, reorder by index, `pen_counts`, `pen_of_thread`.

**Docs** (`db/docs.ts`, `db/docs_site.ts`): publish a version (merge/delete pages, images by sha256), slugs, folders, labels (tree, case-insensitive spelling), comments, move/rename folder, delete with image GC; hosted-site OAuth clients, connections, published records.

**Other** : `db/links.ts` (links to hosts), `db/desktop.ts` (desktop-op journal, checkout only), `db/review_stats.ts` (review submissions, effort backfill, `mentions_minor`, `Rounds`), `db/task_data.ts` (serde-like `_from_json` parsers for every JSON value on a task).

**Wire declarations** (`wire/*.ts`, 22 files): tasks, profiles, claude_configs, projects, pens, messages, automations, workflows, approvals, approval_rules, permissions, agent_tools, docs, events, server, settings_sync, telemetry, terminal, usage, asana, github, git.

## 3. Data

Conventions for every table:
- **Ids**: TEXT UUID v4 (`crypto.randomUUID()`, `util.new_id`) unless stated. Integer AUTOINCREMENT ids: `messages`, `documents`, `context_stats`, `review_stats`, `call_usage`, `telemetry_outbox`; plain INTEGER PK: `doc_comments`.
- **Timestamps**: TEXT, `new Date().toISOString()` = RFC 3339 UTC with milliseconds and `Z` (`2026-11-11T06:16:59.131Z`). Compared as strings and with `julianday()`. Exceptions: `docs_site_connections.expires_at` is INTEGER ms since epoch; `setting_versions.changed_at`/`since` use `''` for "unknown".
- **Booleans**: INTEGER 0/1. **JSON**: TEXT. Readers never throw on bad JSON; they return null / `[]` / default.
- **Money**: REAL US dollars. **Order**: `position` REAL; several queries order by `rowid` (see section 9).
- Foreign keys are enforced (`PRAGMA foreign_keys=ON` per connection); "CASCADE" below means `ON DELETE CASCADE`.

### 3a. Tables in their final state

Row counts are from the live board (2 profiles, 42 projects).

#### `profiles` (2)
PK `id`. No indexes. Trigger `agent_tool_switches_profile` deletes its switches.

| column | type | meaning |
|---|---|---|
| id | TEXT PK | uuid |
| name | TEXT NOT NULL | "work", "personal"; matched by name across hosts |
| claude_config_dir | TEXT NOT NULL DEFAULT '' | **legacy** (pre-v18 single config dir); the API value is recomputed from the first config |
| default_model | TEXT | profile default model |
| created_at | TEXT NOT NULL | |
| claude_config_ids | TEXT NOT NULL DEFAULT '[]' | JSON `string[]` of config ids, default first |
| agent_access | TEXT NOT NULL DEFAULT '[]' | JSON `string[]` of other profile **names** (or `*`) whose agents may use this board |
| github_account | TEXT | `LOGIN` or `HOST/LOGIN`; null = gh's active account |
| clone_dir | TEXT | where GitHub clones go; null = `~/<name>` |
| asana_token | TEXT | secret, never sent |
| asana_user | TEXT | who the token belongs to |
| asana_enabled | INTEGER NOT NULL DEFAULT 1 | |
| limit_wait | INTEGER NOT NULL DEFAULT 0 | tasks wait for a usage limit to reset |
| limit_switch | INTEGER NOT NULL DEFAULT 0 | unstarted tasks switch to another config when theirs is out |
| reviewers | TEXT | JSON `Reviewer[]` (`Reviewer_from_json`) |
| summarizer | TEXT | JSON `Reviewer`; **legacy single**, still written as mirror of `summarizers[0]` |
| summarizers | TEXT | JSON `Reviewer[]` |
| merge_approval | INTEGER NOT NULL DEFAULT 0 | merges wait for user approval |
| require_pr_approval | INTEGER NOT NULL DEFAULT 0 | |
| assistant_host | TEXT | link id of the host the assistant runs on; null = this host |
| assistant_config_id | TEXT | config new assistant/routine conversations start with |
| threads_config_id | TEXT | same for pens thread and pen threads |
| telemetry | INTEGER NOT NULL DEFAULT 0 | send this profile's task events |
| telemetry_titles | INTEGER NOT NULL DEFAULT 1 | with titles |
| tint | TEXT | `#rrggbb` theme tint or null (named migration `profile-tint`) |

#### `claude_configs` (3)
PK `id`. Columns: `name` TEXT NOT NULL; `config_dir` TEXT NOT NULL DEFAULT '' (may start with `~`; empty = `~/.claude`
or `~/.codex`); `created_at`; `agent` TEXT NOT NULL DEFAULT 'claude' (`claude` | `codex`); `show_usage` INTEGER NOT
NULL DEFAULT 0; `restart_window` INTEGER NOT NULL DEFAULT 0; `api_url` TEXT (Anthropic-compatible proxy); `api_key`
TEXT (secret); `management_key` TEXT (secret, CLIProxyAPI).

#### `projects` (42)
PK `id`; FK `profile_id` -> profiles CASCADE. No indexes (the v6 rebuild dropped none; none were ever made). Trigger
`agent_tool_switches_project`.

| column | type | meaning |
|---|---|---|
| id, profile_id, name | TEXT NOT NULL | |
| key | TEXT NOT NULL | 1-10 letters/digits, task key prefix |
| repo_path, scratch_path, worktrees_root | TEXT NOT NULL | folders on the host |
| base_branch | TEXT | null/'' while the folder is not a git repo |
| setup_script, teardown_script | TEXT NOT NULL DEFAULT '' | bash |
| use_worktrees | INTEGER NOT NULL DEFAULT 1 | |
| permission_mode | TEXT | null = host default |
| model | TEXT | |
| next_number | INTEGER NOT NULL DEFAULT 1 | next task number (never reused) |
| created_at | TEXT NOT NULL | |
| auto_review | INTEGER NOT NULL DEFAULT 1 | |
| review_rounds | INTEGER NOT NULL DEFAULT 2 | |
| claude_config_ids | TEXT | JSON `string[]` or NULL (= profile's) |
| start_prompt, review_prompt, merge_prompt | TEXT | null = host default |
| reviewers | TEXT | JSON `Reviewer[]`; NULL/empty = profile's |
| group_name | TEXT | sidebar group |
| status_script | TEXT NOT NULL DEFAULT '' | |
| status_scripts | TEXT NOT NULL DEFAULT '{}' | JSON `{[status]: script}` (string map, keys sorted) |
| former_keys | TEXT NOT NULL DEFAULT '[]' | JSON `string[]`, newest last |
| repo_root | TEXT | hidden: root commits / `git` / '' / null, to recognise a moved repo |
| archived_at | TEXT | project archive (soft) |
| github_account | TEXT | |
| done_when_merged | INTEGER NOT NULL DEFAULT 1 | |
| watch_pull_requests | TEXT NOT NULL DEFAULT 'off' | `off` \| `failures` \| `all` |
| setup_task_id | TEXT | task that helps make the folder a repo (no FK) |
| pr_preview_url | TEXT | template with `{pr}` |
| copy_files, link_folders | TEXT NOT NULL DEFAULT '' | one pattern/folder per line |
| auto_summary | INTEGER NOT NULL DEFAULT 1 | |
| summarizer | TEXT | JSON `Reviewer`, legacy single (mirror) |
| summarizers | TEXT | JSON `Reviewer[]` |
| pull_requests, subproject_pull_requests | INTEGER NOT NULL DEFAULT 1 | |
| merge_approval, require_pr_approval | INTEGER (nullable) | tri-state: null follows profile |
| use_workflows | INTEGER NOT NULL DEFAULT 0 | |

#### `tasks` (2,848)
PK `id`. FKs: `profile_id` -> profiles CASCADE, `project_id` -> projects CASCADE (nullable), `parent_id` -> tasks
CASCADE. Indexes: `tasks_project(project_id, kind)`, `tasks_profile(profile_id, kind)`, `tasks_parent(parent_id)`,
`tasks_one_assistant` UNIQUE `(profile_id) WHERE task_type='assistant'`, `tasks_one_pens_thread` UNIQUE `(profile_id)
WHERE task_type='pens'`, `tasks_pen(pen_id) WHERE pen_id IS NOT NULL`, `tasks_merges_into(merges_into) WHERE
merges_into IS NOT NULL`. 82 columns on the live board (85 with the checkout's named migration), all listed in 3b:
the column list and the wire `Task` are nearly the same thing.

#### `messages` (0)  legacy
`id` INTEGER PK AUTOINCREMENT, `task_id` TEXT NOT NULL FK CASCADE, `kind` TEXT NOT NULL (`user` | `claude` | `event` |
`permission` | `question` | `report`), `data` TEXT NOT NULL (JSON, shape per kind: Claude Code stream-json line for
`claude`), `created_at`. Indexes `messages_task(task_id, id)`, `messages_kind_time(kind, created_at)`. Empty on the
live board: every thread is on items (migration 102 deleted the rows). **Its `sqlite_sequence` row is still the
allocator of message ids** (section 9).

#### `thread_items` (244,068)
One row per item of a thread, updated in place. FK `task_id` CASCADE. `UNIQUE(task_id, id)`; indexes
`thread_items_pos` UNIQUE `(task_id, pos)`, `thread_items_live(task_id, pos) WHERE live=1`,
`thread_items_user_time(type, created_at) WHERE type='user_message'`.
Columns: `task_id`, `id` TEXT (item id; translated ones are `legacy:<message id>[:<block>]`), `pos` INTEGER (order,
gaps allowed), `type` TEXT (`user_message` | `assistant_message` | `reasoning` | `tool_call` | `compaction` | `notice`
| `turn_result`), `parent_id` TEXT (subagent tool_call id), `turn_id` TEXT, `live` INTEGER DEFAULT 0 (a subagent call
whose subagent has not finished), `data` TEXT NOT NULL (JSON `Item`, `threads/protocol.ts`), `meta` TEXT (JSON
`ItemMeta`: what the board knows that the item does not say, e.g. who sent a message), `created_at`, `updated_at`.

#### `thread_requests` (298)
Permission prompts, questions and plans of a thread. FK CASCADE; `UNIQUE(task_id, id)`; `thread_requests_pos` UNIQUE
`(task_id, pos)`. Columns: `task_id`, `id`, `pos`, `type` (`permission` | `question` | `plan`), `tool_call_id`,
`turn_id`, `open` INTEGER NOT NULL, `data` TEXT (JSON `ThreadRequest`; its `metadata` holds the board's record:
`status`, `note`, `rule`, `expires_at`, `kind`, `message_id`, a plan's `mode`/`feedback`), `created_at`, `updated_at`.

#### `thread_events` (15,222)
Numbered event log for clients catching up; pruned (a day or the last few per thread). PK `(task_id, seq)`; FK
CASCADE. `type` TEXT, `data` TEXT (JSON `SavedEvent` = every `ThreadEvent` but deltas), `created_at`.

#### `thread_item_origins` (425,122)
`(task_id, item_id, message_id)` PK, WITHOUT ROWID; index `thread_item_origins_message(task_id, message_id)`. Which
(legacy or virtual) message id each item came from.

#### `threads` (2,848: one per task)
PK `task_id` FK CASCADE. `seq` INTEGER DEFAULT 0 (last saved event number, kept when events are pruned), `converter`
INTEGER (translator `CONVERTER_VERSION` that wrote the items), `writes` INTEGER DEFAULT 0 (write counter the in-memory
translator checks), `error` TEXT (why live writes stopped, until a rebuild), `rebuilt_at`, `created_at`, `flipped_at`
TEXT (when the task moved onto items), `flipped_writes` INTEGER (nulled by migration 102; unused).

#### `runs` (7,018)
One row per agent process started for a thread. PK `id`; FK `task_id` CASCADE. Indexes `runs_status(status)`,
`runs_task(task_id, created_at)`.

| column | type | meaning |
|---|---|---|
| status | TEXT NOT NULL | `preparing` (worktree setup) -> `running` -> `exited` |
| out_offset | INTEGER DEFAULT 0 | how far the server has read `<data>/runs/<id>/` output |
| stop_requested | INTEGER DEFAULT 0 | |
| attention | TEXT | reason the run asks for attention |
| result_error | TEXT | |
| saw_result | INTEGER DEFAULT 0 | a `result` line was seen |
| created_at, ended_at | TEXT | |
| kind | TEXT DEFAULT 'prompt' | `prompt` \| `compact` (old rows may say `review`) |
| cost_usd | REAL DEFAULT 0 | what this run added (not the session total) |
| stop_id | TEXT | id of the latest stop request |
| between_turns | INTEGER DEFAULT 0 | |
| turn_message_id | INTEGER | user message id the turn started with |
| agent_at | TEXT | place in the agent conversation (Claude message uuid / Codex turn id) |
| turn_start_tokens, turn_tokens | INTEGER | context of the current turn until its `context_stats` row is written |
| session_id | TEXT | agent session the run is in (null on old runs) |
| session_cost | REAL | session's `total_cost_usd` as last reported |
| usage_at | TEXT | when its tokens were counted |
| usage_session | TEXT | session the snapshot is of |
| usage_snapshot | TEXT | JSON per-model totals of the session so far |
| usage_tail | TEXT | JSON per-model part added after its last result |
| effort | TEXT | effort given to the agent; `''` = agent default; NULL = run from before v83 |
| config_dir | TEXT | `CLAUDE_CONFIG_DIR`/`CODEX_HOME` it was started with; `''` = agent default; NULL = unknown |
| board_tools | INTEGER DEFAULT 0 | Codex session got the board tools as dynamic tools |
| finished | INTEGER DEFAULT 0 | agent called `finish_work` |

#### `token_usage` (7,013)
PK `(run_id, model)`; FK `run_id` -> runs CASCADE. `runtime` (`claude`|`codex`), `input_tokens`, `output_tokens`,
`cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens` (all INTEGER NOT NULL DEFAULT 0), `cost_usd` REAL,
`estimated` INTEGER DEFAULT 0, `cache_write_1h_tokens`, `cache_write_5m_tokens` INTEGER (null = unknown).

#### `call_usage` (710)
Model calls that are not runs (titles, window restarts). `id` AUTOINCREMENT, `at`, `purpose` (`title` | `window` | ...),
`task_id` FK CASCADE nullable, `config_id`, `model`, `runtime`, the same five token columns, `cost_usd` (null for
Codex), `call_id` TEXT (rows of one call share it), `cache_write_1h_tokens`, `cache_write_5m_tokens`. Indexes
`call_usage_time(at)`, `call_usage_task(task_id)`.

#### `context_stats` (4,427)
`id` AUTOINCREMENT, `task_id` FK CASCADE, `run_id`, `kind` (`turn` | `compact`), `at`, `tokens`, `start_tokens`,
`post_tokens`, `max_tokens`, `model`, `source` (`auto` | `user` | `idle` for compactions), `cost_usd`, `duration_ms`.
Indexes `context_stats_time(at)`, `context_stats_task(task_id, at)`.

#### `review_stats` (2,315)
One row per `submit_review`. `id` AUTOINCREMENT, `task_id` FK CASCADE (the reviewed task), `thread_id`, `round` TEXT
NOT NULL (when the round started), `run_id`, `at`, `verdict` (`pass` | `issues`), `serious` INTEGER DEFAULT 0, `minor`
INTEGER (null before minor issues were listed), `minor_noted` INTEGER DEFAULT 0, `label`, `effort`. Indexes
`review_stats_task(task_id, at)`, `review_stats_time(at)`.

#### `review_thread_skills` (213) / `thread_mcp_servers` (0)
PK `task_id` FK CASCADE. `skills` / `disabled` TEXT NOT NULL DEFAULT '[]' (JSON `string[]`): board skills a review or
summary thread has on top of its project's; project MCP servers a workflow agent step's thread does not get.

#### `checkpoints` (1,866)
PK `(task_id, n)`; FK CASCADE. `kind` (`start` | `turn` | `rewind`), `sha`, `tree`, `head`, `before_n`, `run_id`,
`turn`, `message_id`, `status` (`done` | `stopped` | `failed`), `session`, `agent_at`, `stats` TEXT (JSON `Stats`
`{files, additions, deletions, excluded: string[], excluded_count}`), `stale` INTEGER DEFAULT 0 (0, 1, 2),
`created_at`. The commits live under `refs/huntaway/checkpoints/<task>/<n>` in the repo.

#### `permission_requests` (78)
PK `id`; FK `task_id` CASCADE. `message_id` INTEGER NOT NULL, `tool_name`, `input` TEXT (JSON), `status` DEFAULT
'pending' (`pending` | `allowed` | `denied` | `expired`), `created_at`, `call_id`, `note`, `kind` DEFAULT 'tool'
(`tool` | `project` | `delete_task` | `automation` | `workflow`), `expires_at`, `rule` (the approval rule's tool
pattern). Indexes `permission_requests_call(call_id)`, `permission_requests_task(task_id, status)`,
`permission_requests_expiry(expires_at) WHERE status='pending' AND expires_at IS NOT NULL`.

#### `mcp_calls` (33)
Durable record of board-tool calls so a call is never executed twice. PK `id`; **no FKs** (pruned by time). `run_id`,
`task_id`, `tool`, `args` TEXT (JSON), `status` DEFAULT 'pending' (`pending` | `executing` | `done`), `result` TEXT
(JSON), `error`, `created_at`.

#### `approval_log` (0)
PK `id`; no FKs. `profile_id`, `task_id`, `request_id`, `tool_name`, `summary`, `rule`, `decision` (`ask` | `never`),
`outcome` (`pending` | `allowed` | `denied` | `expired` | `blocked`), `answered_by` (`user` | `push` | `telegram` |
`expiry` | `mode` | `rule` | `ended`), `created_at`, `decided_at`. Indexes `approval_log_profile(profile_id,
created_at)`, `approval_log_request(request_id)`. Wire type `ApprovalAction`.

#### `pr_watches` (351) / `pr_states` (402)
`pr_watches`: PK `(task_id, pr)`, FK CASCADE, `state` TEXT JSON (`{seen, pending?: {call_id, told, superseded?}, last,
polled_at, comment_wakes, woke_at?, comments_paused}`, `mcp/pr_watch/seen.ts`), `updated_at`.
`pr_states`: PK `(task_id, pr_url)`, FK CASCADE, `state` TEXT (plain lowercase GitHub state: `open` | `merged` |
`closed`), `updated_at`.

#### `documents` (108)  task documents (plan / artifact / diagram), not Docs
`id` AUTOINCREMENT, `task_id` FK CASCADE, `version` INTEGER, `content` TEXT (HTML or Mermaid), `open` INTEGER DEFAULT
0, `created_at`, `updated_at`, `label` TEXT NOT NULL DEFAULT 'plan'. UNIQUE index `documents_task(task_id, label,
version)`.

#### Agent tools: `agent_skills` (7), `agent_mcp_servers` (2), `agent_tool_switches` (8), `project_agent_tools` (40), `skill_sources` (2)
- `agent_skills`: PK `id`; `project_id` FK CASCADE nullable (NULL = global); `name`, `content` (SKILL.md), `enabled` DEFAULT 1, `created_at`, `updated_at`, `source_id` FK -> skill_sources CASCADE, `source_path`. UNIQUE index `(ifnull(project_id,''), name)`.
- `agent_mcp_servers`: same shape with `config` TEXT (JSON MCP server config) and `auto_allow` INTEGER DEFAULT 0. UNIQUE index `(ifnull(project_id,''), name)`.
- `agent_tool_switches`: PK `(scope, scope_id, item_id)`; `scope` `profile` | `project`; `enabled` INTEGER. No FKs: four AFTER DELETE triggers (on profiles, projects, agent_skills, agent_mcp_servers) clean it.
- `project_agent_tools`: PK `project_id` FK CASCADE; `disabled_skills`, `disabled_mcp_servers` (JSON `string[]`), `seen` (JSON object per Claude config: what a run's `init` reported).
- `skill_sources`: PK `id`; `url`, `git_ref`, `name`, `commit_sha`, `synced_at`, `error`, `notes` (JSON `string[]`), `created_at`, `subdir`. Wire `SkillSource` renames `git_ref`->`ref`, `commit_sha`->`commit`.

#### `automations` (2) / `automation_runs` (2)
`automations`: PK `id`; FKs `profile_id` -> profiles CASCADE (NOT NULL), `project_id` -> projects CASCADE (NULL = a
profile's routine). `name`, `enabled` DEFAULT 1, `trigger` TEXT (JSON `Trigger`), `action` TEXT (JSON `Action`),
`token` TEXT NOT NULL (webhook URL secret, never sent), `secret` TEXT (signature secret), `next_run_at`,
`last_run_at`, `active_hours` TEXT (JSON `ActiveHours`), `precheck` TEXT (bash), `budget_usd` REAL, `created_at`,
`updated_at`. Indexes on `project_id`, `profile_id`.
`automation_runs`: PK `id`; FK `automation_id` CASCADE. `source` (`schedule` | `webhook` | `manual`), `status`
(`pending` | `coalesced` | `running` | `ok` | `failed` | `skipped` | `filtered` | `duplicate` | `rejected`),
`detail`, `task_id` (no FK), `delivery_id`, `event`, `count` DEFAULT 1, `batch_key`, `batch_id`, `payload` TEXT (JSON
delivery, never sent), `due_at`, `created_at`, `finished_at`, `outcome` (`quiet` | `reported` | `asked` | `failed` |
`stopped`), `cost_usd`, `agent_run_id`. Indexes `(automation_id, created_at)`, `(status, due_at)`, `(automation_id,
delivery_id)`, `(task_id)`, `(agent_run_id)`.

#### `workflows` (0) / `workflow_runs` (0)
`workflows`: PK `id`; FK `project_id` CASCADE; `name`, `enabled` DEFAULT 1, `graph` TEXT (JSON `Graph`), timestamps.
Index `workflows_project`.
`workflow_runs`: PK `id`; FKs `workflow_id`, `task_id` CASCADE; `source`, `state` (`running` | `done` | `failed` ...),
`head` (commit), `task_run`, `graph` TEXT (the graph it started with), `nodes` TEXT DEFAULT '{}' (JSON `{[node id]:
{state: pending|running|done|failed|skipped, ...}}`), `rounds` TEXT DEFAULT '{}' (JSON rounds used per send node),
`detail`, timestamps, `finished_at`. Indexes `(task_id, workflow_id)`, `(state)`.

#### `pens` (2)
PK `id`; FK `profile_id` CASCADE; UNIQUE index `pens_name(profile_id, name COLLATE NOCASE)`. `name` (max 60 chars,
whitespace collapsed), `position` REAL (renumbered 1..n on reorder), `hidden` INTEGER DEFAULT 0 (**legacy mirror, always
`1 - active`**), `created_at`, `updated_at`, `thread_id` TEXT (the pen's own thread task; no FK), `color` TEXT DEFAULT
'' (one of 10 names; '' or unknown reads as `blue`), `active` INTEGER DEFAULT 1.

#### Docs: `docs` (28), `doc_versions` (56), `doc_pages` (95), `doc_labels` (10), `doc_images` (13), `doc_version_images` (33), `doc_comments` (7)
- `docs`: PK `id`; FK `profile_id` CASCADE; `slug` (lowercase `[a-z0-9-]`, about 60 max, `doc` if empty), `title`, `created_at`, `updated_at`, `folder` TEXT DEFAULT '' ('/'-separated, max 200 chars). `UNIQUE(profile_id, slug)`; index `docs_profile_folder`.
- `doc_versions`: PK `id`; FK `doc_id` CASCADE; `number` (1..n, `UNIQUE(doc_id, number)`), `message`, `task_id`, `run_id` (no FKs: the publisher may be gone), `created_at`. Versions are immutable.
- `doc_pages`: PK `(version_id, path)`; FK CASCADE; `title`, `format` (`md` | `mdx`), `source`, `position`.
- `doc_labels`: PK `(doc_id, label)`; label is a '/'-path, max 100 chars, 20 per doc, case-insensitive match.
- `doc_images`: PK `(profile_id, sha256)`; `data` BLOB (AVIF), `width`, `height`, `created_at`. Deduplicated per profile.
- `doc_version_images`: PK `(version_id, name)`; `sha256`; index on `sha256`.
- `doc_comments`: `id` INTEGER PK; FK `version_id` CASCADE; `page_path`, `quote`, `prefix`, `suffix`, `comment`, `created_at`, `updated_at`, `sent_at` (null = not yet sent to the agent; editing clears it). Index `(version_id, page_path)`.

#### Hosted docs: `docs_site_clients` (0), `docs_site_connections` (0), `docs_site_published` (0)
`docs_site_clients`: PK `site_url`; `client_id`, `created_at`. `docs_site_connections`: PK `profile_id` FK CASCADE;
`site_url`, `kind` (`oauth` | `token`), `access_token`, `refresh_token` (secrets), `expires_at` INTEGER ms, `login`,
`connected_at`. `docs_site_published`: PK `(doc_id, site_url)` FK CASCADE; `remote_slug`, `remote_version`,
`local_version`, `url`, `version_url`, `published_at`, `login`.

#### Hosts, devices, push: `links` (0), `device_tokens` (0), `push_subscriptions` (0), `push_answer_tokens` (0)
- `links`: PK `id` (the other host's id); `name`, `mode` (`outbound` | `inbound` | `ssh`), `url`, `token` (secret), `last_seen`, `created_at`, `ssh` TEXT (JSON `Target {target: "user@host", ssh_port=22, remote_port=7878}`), `uplink` INTEGER DEFAULT 0.
- `device_tokens`: PK `id`; `name`, `token_hash` UNIQUE, `created_at`, `last_used_at`.
- `push_subscriptions`: PK `id`; `endpoint` UNIQUE (for `expo`: the Expo push token), `p256dh`, `auth`, `name` DEFAULT '', `events` TEXT (JSON `Events {attention, review, merge, done, prompts, replies, reports}`), `created_at`, `last_sent_at`, `last_error`, `kind` DEFAULT 'web' (`web` | `expo`), `device_id`.
- `push_answer_tokens`: PK `token_hash`; `request_id`, `host_id`, `task_id`, `status` DEFAULT 'pending', `created_at`, `claimed_at`, `expires_at`. Index `(request_id, host_id)`.

#### Housekeeping: `settings` (4), `setting_versions` (0), `telemetry_outbox` (0), `named_migrations` (2), `db_origin` (1), `desktop_ops` (checkout only)
- `settings`: `key` TEXT PK, `value` TEXT NOT NULL. See 3d.
- `setting_versions` (named migration, settings sync between hosts): PK `name` (`global/<key>` or `profile/<uri-encoded name>/<field>`); `value` (JSON), `vv` DEFAULT '{}' (JSON version vector `{host id: counter}`), `changed_at` DEFAULT '', `changed_by` DEFAULT '', `lost` DEFAULT '[]' (JSON `SyncLost[]`, max 10), `seen` (JSON this host's own value at last compare), `since` DEFAULT ''.
- `telemetry_outbox`: `id` AUTOINCREMENT (never reused: ids are in the batch's dedup token), `target` (ClickHouse table), `row` (JSON), `at`. Index `(target, id)`.
- `named_migrations`: `name` PK, `applied_at`. Made by `open`, not by a migration.
- `db_origin`: `id` INTEGER PK CHECK (id = 1); `source` (older file name), `source_version`, `source_state` (JSON `FileState {db: {len, modified_ns}, wal: {...}|null}`), `copied_at`. Only in `huntaway-2.db`; not a migration.
- `desktop_ops`: PK `id`; FK `task_id` CASCADE; `run_id`, `op_id` (agent's idempotency name), `tool` (`act` | `launch` | `clipboard`), `summary`, `args` (JSON), `status` (`running` | `ok` | `failed`; read as `interrupted` when `running` with another process's `boot`), `result`, `boot`, `created_at`, `finished_at`. UNIQUE `(task_id, op_id) WHERE op_id IS NOT NULL`; index `(task_id, created_at)`.
- `sqlite_sequence` (5 rows): SQLite's own; the `messages` row matters (section 9).

### 3b. The `Task` row in full

`Task_from_row` (`db/tasks/row.ts`) builds the wire `Task` (`wire/tasks.ts`) plus three hidden fields. SQL type shown
as stored; "bool" = INTEGER NOT NULL DEFAULT 0.

**Identity and placement**

| field / column | type | meaning |
|---|---|---|
| id | TEXT PK | uuid; also the thread id |
| profile_id | TEXT NOT NULL | owner profile |
| project_id | TEXT null | null for projectless tasks (see 3f) |
| kind | TEXT NOT NULL DEFAULT 'task' | `task` or `review` (a thread under a task: reviewer, summarizer, workflow agent step). Legacy `scratch` |
| parent_id | TEXT null, FK CASCADE | review thread: the task it reviews. Task: the subproject it belongs to. Routine thread: the assistant |
| subproject | bool | legacy: a task with its own board; cannot be created any more |
| group_name | TEXT null | group task: the group whose projects it plans |
| created_by | TEXT null | task whose agent created it (no FK) |
| task_type | TEXT null | task: `scratch` \| `assistant` \| `routine` \| `pens` \| `pen` \| null (code task). review thread: `summary` \| `workflow` \| null (review) |
| labels | TEXT NOT NULL DEFAULT '[]' | JSON `("plan"\|"artifact"\|"diagram")[]`: documents its agent writes |
| work_dir | TEXT null | where the agent works when not the project/worktree: absolute (old scratch chat folder) or relative to the data dir (`documents/<id>`, assistant workspace) |
| document_at | TEXT null | when one of its documents last changed |
| number | INTEGER NOT NULL DEFAULT 0 | the `n` of its key; 0 for review threads |
| pen_id | TEXT null | pen it is in (no FK; nulled by `delete_pen`) |
| fanout_id | TEXT null | shared by tasks made together from one prompt |
| position | REAL NOT NULL DEFAULT 0 | order within (project, status, kind); new = max+1 |

**What the user sees**

| field | type | meaning |
|---|---|---|
| title | TEXT NOT NULL | |
| title_pinned | bool | renamed by hand; otherwise each user prompt re-titles |
| description | TEXT NOT NULL DEFAULT '' | |
| status | TEXT NOT NULL DEFAULT 'todo' | column (see 3e) |
| resolution | TEXT null | `done` \| `not_done` \| `wont_fix`; set iff status is `done` |
| done_at | TEXT null | when it entered Done; set iff done. Archived = done for 2 days (computed by clients) |
| attention_reason | TEXT null | free text shown in Needs attention |
| starred | bool | |
| remind_at, reminder | TEXT null | reminder time (UTC) and text |
| preview_url | TEXT null | |
| pr_url | TEXT null | |
| pr_checks | TEXT null | JSON `PrChecks` |
| external_links | TEXT null | JSON `ExternalLink[]` (max 20, provider `asana`) |
| todos | TEXT null | JSON `Todo[]`, the agent's latest todo list |
| tracked | TEXT null | JSON `TrackedItem[]` (assistant only) |
| context | TEXT null | JSON `Context` |
| (context_detail) | TEXT null | column only: JSON breakdown behind `context`, read on its own by `agent/context.ts` |
| cost_usd | REAL NOT NULL DEFAULT 0 | total agent cost |
| last_activity_at, created_at, updated_at | TEXT NOT NULL | `updated_at` is set by every `update_task` |

**Git and merging**

| field | type | meaning |
|---|---|---|
| use_worktree | bool | |
| worktree_path, branch, base_branch | TEXT null | branch is `ia/<key>-<n>-<slug>` |
| worktree_state | TEXT NOT NULL DEFAULT 'none' | `none` \| `setting_up` \| `ready` \| `tearing_down` \| `error` |
| worktree_error | TEXT null | |
| start_from | TEXT null | JSON `StartFrom` |
| merges_into | TEXT null | task (same project) whose branch this merges into; kept after done and after the target is deleted |
| carries | TEXT null | JSON `Carries {key, commit}`: commits it may still carry from a closed/deleted task it was built on |
| restack | TEXT null | `due` \| `conflict` (anything else reads null) |
| github_stack | INTEGER null | GitHub stack number its PR is in |
| stack_title, stack_description | TEXT null | on the stack's bottom task only |
| stack_pinned | bool | title/description edited by hand |
| stack_input (hidden) | TEXT null | what the title was written from |
| stack_run | TEXT null | id of the whole-stack merge run this level is in |
| merging | bool | moved to Ready for merge and not merged yet |
| remerge | bool | stepped out of the merge queue to fix something; rejoins when its run ends |
| merge_approval | TEXT null | `pending` \| `approved` |
| depends_on | TEXT NOT NULL DEFAULT '[]' | JSON `string[]` of task ids (same project) |
| waiting | bool | queued in In progress for dependencies or a usage-limit reset |

**Agent and run state**

| field | type | meaning |
|---|---|---|
| session_id | TEXT null | agent session to resume |
| running | bool | a run is going |
| run_started_at | TEXT null | |
| limit_reset_at | TEXT null | when the usage limit it ran out of resets |
| agent_wait | TEXT null | JSON `AgentWait`: agent is inside the `wait` tool |
| background_work | TEXT null | JSON `BackgroundWork` (checkout only) |
| servers | TEXT null | JSON `TaskServer[]` (checkout only) |
| lost_background (hidden) | TEXT null | JSON `{kind, label}[]` (checkout only) |
| queued_message | TEXT null | text queued for the next run |
| queued_user_text (hidden) | TEXT null | the user's own parts of it |
| (queued_from_agent) | bool, column only | everything queued came from other agents |
| (queued_routine) | bool, column only | everything queued came from an automation |
| (queued_routine_runs) | TEXT null, column only | JSON `string[]` of automation run ids the queued text carries (or parked with no text) |
| steering | TEXT NOT NULL DEFAULT '[]' | JSON `Steer[]` not yet taken in |
| steerable | bool | running run accepts messages mid-turn |
| model | TEXT null | free string (alias or full id) |
| effort | TEXT null | `ThreadEffort` |
| permission_mode | TEXT null | null inherits project then host |
| claude_config_id | TEXT null | config pinned at creation (no FK; deleted config falls back) |
| auto_allow | TEXT NOT NULL DEFAULT '[]' | JSON `string[]` of always-allowed tool rules |
| review | TEXT null | JSON `Review` |
| summary (column) -> `summaries`, `summary` | TEXT null | JSON `ChangeSummary[]`, or one object (legacy); `summary` = first |
| rewind | TEXT null | JSON `Rewind`; field omitted when null |
| thread_items | bool | thread is kept as items |
| thread_source | TEXT NOT NULL DEFAULT 'messages' | `items` \| `messages` (anything else reads `messages`) |
| (now_at) | TEXT null, column only | unused since HA-285 |

**Nested value types** (all in `wire/tasks.ts`, parsed in `db/task_data.ts`; `?` = omitted when unset)

- `StartFrom` (`StartFrom_from_json`): `{type:"branch", branch}` | `{type:"task", task_id}` | `{type:"pull_request", number, repo?}` | `{type:"commit", commit}`.
- `Carries`: `{key: string|null, commit: string|null}`.
- `ExternalLink`: `{provider:"asana", id, url, title}`.
- `PrChecks` (`PrChecks_from_json`): `{url, head, outcome: failed|passed|pending|none, failed: FailedCheck[], more_failed, pending, passed, since}`; `FailedCheck {name, conclusion, url|null}`.
- `Context`: `{tokens, max_tokens|null, compact_at|null, model|null, updated_at, detail_at|null}`.
- `Todo`: `{text, status: pending|in_progress|completed}` (lenient).
- `TrackedItem`: `{id, title, note, status: working|waiting_user|waiting_task|done|failed, task_id, task_key, url, created_at, updated_at}` (lenient).
- `AgentWait`: `{reason|null, since, until, tasks: WaitTask[], command?, call_id, run_id, moved_to?, subagent_finished?, pull_request?: WaitPr}`; `WaitTask {id, key, status, review_at?}`; `WaitPr {url, repo, number, events: (checks_failed|checks_passed|comments|conflicts)[], news?}`.
- `Steer`: `{id, text, from_agent, run_id, written, routine_runs?, routine?}`.
- `Review` (`Review_from_json`): `{thread_id, state: running|passed|issues|failed|stopped, head|null, summary|null, issues: string[], verdict?, fixes, extra_rounds, updated_at, started_at?, reviewers: ReviewerRun[]}`; `ReviewerRun {thread_id, label, state, summary|null, issues, verdict?, after_run?}`.
- `ChangeSummary`: `{thread_id, label, name?, skills?, custom_prompt?, state: running|done|failed|stopped, head|null, text|null, after_run?, updated_at}`.
- `Rewind`: `{turn, message_id, session, resume_at?, before_turn?}`.
- `BackgroundWork {run_id, idle, tasks: BackgroundItem[]}`; `BackgroundItem {id, kind: shell|subagent|other, description, command, since, waited}`; `TaskServer {port, address, pid, pgid, command, since, detached}`.
- `TaskDetail` (`GET /tasks/{id}`): `{task, last_message: string|null, pending_permissions: number}`.

### 3c. Other entities

- **Profile** (`wire/profiles.ts`): the columns above, with `claude_config_dir` recomputed, `summarizers` read from list-or-single, and hidden `asana_token`.
- **ClaudeConfig** (`wire/claude_configs.ts`): `{id, name, config_dir, agent, show_usage, restart_window, api_url, settings_api_url (computed from the dir's settings.json; null for codex), has_api_key, has_management_key, created_at}`; hidden `api_key`, `management_key`. `AgentModel {id, name, description?, is_default, efforts, default_effort}` is what a Codex config offers.
- **Project** (`wire/projects.ts`): the columns, plus computed `is_git`, `has_commits`; hidden `repo_root`. **Reviewer** (also summarizer): `{claude_config_id|null, model|null, effort|null, name?, skills?, prompt?}`. Also `Branch {name, remote}`, `CreatedRepo`, `MergedWorktreeResult`, `SystemPromptPreview`.
- **Pen** (`wire/pens.ts`): row + computed `hidden` (= `!active`) and `task_count`. `PenColor`: blue, orange, green, pink, violet, teal, amber, red, lime, indigo (allocation order).
- **Automation** (`wire/automations.ts`): row minus `token`/`secret`, plus computed `cost_usd`, `cost_today_usd`, `hook_path` (`/api/hooks/<id>/<token>`), `has_secret`, `last_run`. `Trigger`: `interval {every_minutes}` | `daily {time "HH:MM", weekdays}` | `cron {expr}` | `at {at}` | `webhook {filters: Filter[], coalesce_seconds, coalesce_key}`; `Filter {path, op: equals|not_equals|starts_with|contains|in|not_in|exists|not_exists, value}`. `Action`: `create_task {title, description, task_type, labels?, claude_config_id, model, effort, status: todo|backlog, start}` | `send_to_task {task_id, message}` | `message_assistant {message, mode: fresh|thread}`. `ActiveHours {start, end, weekdays}`. `Run`: the `automation_runs` row minus `batch_key`/`payload`, plus `task?`.
- **Workflow** (`wire/workflows.ts`): `{id, project_id, name, enabled, graph, created_at, updated_at}`; `Graph {nodes: Node[], edges: Edge[]}`; `Edge {from, port, to, input?}`; `Node = {id, x, y, join?: any|all, label?} & NodeKind`; node kinds: `trigger{on:"manual"}`, `column{status, prompt, done_when?, max_rounds?}`, `condition{check, value?}`, `agent{name, prompt, output: text|verdict, claude_config_id?, model?, effort?, skills?, disabled_mcp_servers?, tab?, input_only?, keep_conversation?}`, `split{weights, each_run?}`, `send_to_task{message, max_rounds}`, `set_status{status}` (legacy), data nodes `text`, `task`, `project_prompt{which}`, `compose{template}`, `join{separator, count}`, `switch{check, value?}`, and `open_pr{title, body, draft?}`. `Check`: changed | has_commits | has_pr | task_type | label.
- **Doc** (`db/docs.ts`, `wire/docs.ts`): `Doc {id, profile_id, slug, title, folder, created_at, updated_at, latest_version, page_count, labels}`; `DocVersion {number, message, task_id, run_id, created_at, task: DocPublisher|null}`; `DocPageSummary {path, title, format, position}`; `DocComment {id, version, page, quote, prefix, suffix, comment, created_at, updated_at, sent_at}`; `DocPublished`, `HostedDocsStatus`, `DocSummary`, `DocDetail`, `RenderedDocVersion/Page`, `DocLabelNode`.
- **Link / host** (`db/links.ts`): row with hidden `token`. `HostInfo`, `Health` (`wire/server.ts`) describe a host: `{host_id, host_name, build_id, api_version, api_compat, capabilities, commit, updates_from, agents, agent_clis, version, data_dir, hostname, home}`.
- **Run** (`db/runs.ts`): parsed fields `id, task_id, kind, status, out_offset, stop_requested, attention, finished, result_error, saw_result, cost_usd, between_turns, turn_message_id, agent_at, created_at, ended_at` (the other columns are read by their own queries).
- **Device**: `device_tokens` row (`devices.ts`); push subscriptions hang off `device_id`.
- **Message** (`wire/messages.ts`): `{id: number, task_id, kind, data: any|null, created_at}`; `MessagePage {messages, more, subagents}`.
- **Thread items** (`threads/protocol.ts`): `Item` = `UserMessage {text, attachments?, steered?, queued?, client_id?}` | `AssistantMessage {text}` | `Reasoning {text}` | `ToolCall {name, kind: shell|read|edit|search|web|mcp|app|subagent|todo|other, input, status: pending|running|completed|failed|denied|cancelled, result?, title?, command?, path?, changes?, query?, url?, server?, todos?, subagent?}` | `Compaction {trigger?, summary?, tokens_before?}` | `Notice {level, text, code?, detail?}` | `TurnResult {ok, interrupted?, error?, usage?, duration_ms?, session?}`; all share `{id, parent_id?, turn_id?, created_at?, metadata?}`. `ThreadRequest` = `PermissionRequest {name, kind, server?, input, title?, reason?}` | `QuestionRequest {questions}` | `PlanRequest {plan}` with `{id, tool_call_id?, parent_id?, resolution?, turn_id?, created_at?, metadata?}`; `Resolution {outcome: allow|deny|answer|cancel, always?, message?, permission_mode?, answers?}`. `Thread` snapshot header `{id, harness, status: idle|running|waiting|error, title?, model?, effort?, permission_mode?, cwd?, session_id?, usage?, error?, metadata?, created_at, updated_at?}`.
- **Approvals** (`wire/approvals.ts`): `ApprovalRequest {request_id, status, note?, task_id, created_at?}` specialised by `kind`/`tool_name` with `input` of `ProjectChange`, `ProjectCreation`, `TaskDeletion`, `AutomationChange`, `WorkflowChange`. `PendingPermission {id, task_id, tool_name, input, created_at, expires_at, rule}`. `ApprovalRules {rules: {tool, decision: allow|ask|never}[], expiry_minutes, is_default, defaults, board_server, google_server, create_task_tools}`.
- **Usage** (`wire/usage.ts`): `Usage {config_id, limits: UsageLimit[], plan, updated_at, error, out_until, accounts?}`; kept in memory, not in the database.
- **Host settings** (`wire/server.ts`): `HostSettings {default_model, default_effort, default_permission_mode, scratch_host, terminal_tools, public_url, release_prereleases, thread_items, settings_sync?}`; also `ServerStatus`, `DatabaseFile {file, copied_from, older_changed}`, `ReleaseStatus`, `ServiceStatus`, `ThreadsStatus/Batch`, `DirListing`, `RestartJob`, `UpdateResult`.
- Small wire types: `TerminalTool {id, name, command}`, `TerminalStatus`, `DiffResult`, `AsanaTask`, `GithubRepo/Account(s)`, `TelemetryStatus`, `SettingsSync {enabled, host_id, entries: SyncEntry[]}`, `SkillSource`, `TaskSkill(s)`.

### 3d. `settings` keys

Live board has 4: `default_model`, `default_effort`, `default_permission_mode`, `workflows_reviews_moved`. Every key
the code uses (values are trimmed strings; a blank or null write deletes the row, so "unset" always means "no row"):

| key | holds | owner |
|---|---|---|
| `default_model` | host default model; seeded `opus` by migration 123 | `api/host.ts`, `agent/runner/launch.ts` |
| `default_effort` | one of `EFFORTS`; seeded `high` | same; `db/review_stats.ts` |
| `default_permission_mode` | one of `PERMISSION_MODES`; unset = `default` (Ask) | `db/tasks/row.ts`, `mcp/tools/projects.ts` |
| `scratch_host` | link id scratch tasks go to on a board that cannot run agents | `api/host.ts` |
| `public_url` | where the host is reached from outside (webhook and doc URLs) | `api/host.ts`, `mcp/docs_mcp.ts`, `mcp/tools/automations.ts` |
| `terminal_tools` | JSON `TerminalTool[]` | `hosts/terminal.ts` |
| `release_prereleases` | `"true"` or unset | `update/release.ts` |
| `thread_items` | `"false"` turns "keep threads as items" off; unset = on | `threads/write.ts` |
| `thread_batch` | start time of an unfinished batch rebuild of threads (restart resumes) | `threads/batch.ts` |
| `settings_sync` | `"true"` when this host syncs settings | `settings_sync.ts` |
| `settings_sync_since` | when this host began to sync | `settings_sync.ts` |
| `desktop_tools` | `"true"` when computer use is on | `desktop.ts`, `api/desktop.ts` |
| `vapid_private_key` | base64 P-256 private key for Web Push, generated on first use (secret) | `integrations/push/webpush.ts` |
| `workflows_reviews_moved` | `"1"` once the one-off HA-277 move ran | `integrations/workflows/store.ts` |
| `approval_rules:<profile id>` | JSON approval rules; unset = defaults | `agent/approval_rules.ts` |
| `telegram_token:<profile id>` | bot token (secret) | `integrations/telegram*.ts` |
| `telegram:<profile id>` | JSON bot `Config` | same |
| `telegram_state:<profile id>` | JSON `Progress {offset, awaiting, replied, prompts}` | same |
| `telegram_outbox:<profile id>` | JSON `Outbox {next, items}` | same |
| `telemetry_url`, `telemetry_database`, `telemetry_user`, `telemetry_password` | ClickHouse target; the password is written untrimmed by a direct INSERT | `telemetry.ts` |
| `telemetry_logs` | `off` \| `info`; unset = `warn` | `telemetry.ts` |
| `telemetry_agents` | `"false"` or unset (= on) | `telemetry.ts` |
| `telemetry_inflight` | JSON batch being sent (crash-safe dedup) | `telemetry.ts` |
| `telemetry_dropped` | count of dropped rows not yet reported | `telemetry.ts` |
| `telemetry_since` | when telemetry was first on (backfill boundary) | `telemetry.ts`, `telemetry/backfill.ts` |
| `demo_todos_seeded` | `"1"` once the demo seeded todos | `demo.ts` |

Synced between hosts (`settings_sync.ts`): the global keys `default_model`, `default_effort`,
`default_permission_mode`, `release_prereleases`, `terminal_tools`; the profile fields `default_model`,
`github_account`, `limit_wait`, `limit_switch`, `merge_approval`, `require_pr_approval`, `agent_access` (its `PROFILE`
map), and each profile's approval rules (`profile/<name>/approval_rules`).

### 3e. Enumerations and where they are defined

| what | values | defined |
|---|---|---|
| task status | `todo`, `in_progress`, `needs_attention`, `in_review`, `ready_for_merge`, `done`, `backlog` | `db.ts` `STATUSES`; `wire/tasks.ts` `Status` |
| resolution | `done`, `not_done`, `wont_fix` | `db.ts` `RESOLUTIONS`; `Resolution` |
| task kind | `task`, `review` (legacy `scratch`) | `wire/tasks.ts` `Task.kind` |
| task type | `scratch`, `assistant`, `routine`, `pens`, `pen` (tasks); `summary`, `workflow` (review threads); legacy `subproject`, `plan`, `artifact`, `diagram` as a *requested* type | `db.ts` `SCRATCH`, `TASK_TYPES`, `ASSISTANT`, `ROUTINE`, `PENS`, `PEN_THREAD`, `SUBPROJECT` |
| labels | `plan`, `artifact`, `diagram` | `db.ts` `LABELS`; `DocumentType` |
| permission mode (task/project/host) | `default`, `acceptEdits`, `auto`, `plan`, `dontAsk`, `bypassPermissions` | `db.ts` `PERMISSION_MODES` (Claude Code's names) |
| permission mode (thread protocol) | `default`, `accept_edits`, `auto`, `plan`, `bypass`, `dont_ask` | `threads/protocol.ts` (a different spelling of the same set) |
| effort (host/profile/reviewer) | `low`, `medium`, `high`, `xhigh`, `max` | `db.ts` `EFFORTS` |
| effort (thread) | adds `minimal`, `ultra` (Codex only) | `db.ts` `THREAD_EFFORTS` |
| agent | `claude`, `codex` | `db.ts` `AGENTS` |
| model | **no server list**: free string. Claude aliases known to code: `fable`, `opus`, `sonnet`, `haiku`, `default`, `opusplan`, or anything starting `claude` (`agent/codex.ts:236`, `apps/web/src/agents.ts`); Codex models come from the CLI at runtime (`AgentModel`) | |
| worktree state | `none`, `setting_up`, `ready`, `tearing_down`, `error` | `wire/tasks.ts` |
| review state | `running`, `passed`, `issues`, `failed`, `stopped` | `ReviewState` |
| summary state | `running`, `done`, `failed`, `stopped` | `SummaryState` |
| merge approval | `pending`, `approved` | `Task.merge_approval` |
| restack | `due`, `conflict` | `Restack` |
| target/stack state (computed) | `none`, `open`, `merged`, `closed`, `deleted` (+ `restack`, `conflict` for stacks) | `db/tasks/stacks.ts` |
| run kind / status | `prompt`, `compact` / `preparing`, `running`, `exited` | `db/runs.ts` |
| message kind | `user`, `claude`, `event`, `permission`, `question`, `report` | `wire/messages.ts` |
| watch PRs | `off`, `failures`, `all` | `wire/projects.ts` |
| link mode | `outbound`, `inbound`, `ssh` | `db/links.ts` |
| pen colour | 10 names | `db/pens.ts` `PEN_COLORS` |
| reserved project keys | `G`, `S`, `A` | `runner.GROUP_TASK_KEY`, `db.SCRATCH_TASK_KEY`, `db.ASSISTANT_TASK_KEY` |

### 3f. Ids, keys, deletes, projectless tasks

- **Task key** is not stored: it is `<prefix>-<number>` (`api/incoming.ts key_of`, `runner key_prefix`). Prefix = the project's `key`; else `G` if `group_name` is set; else `S` for scratch, pens thread and pen threads; else `A` for assistant and routine threads; else `T`.
- **Project key**: suggested by `util.derive_key(name)` (initials of the first 3 words, or the first 3 letters of a single word, upper-cased, `T` if empty); validated by `api/projects.ts check_key`: 1-10 ASCII letters/digits, not `G`/`S`/`A`, not another project's current **or former** key in the profile (case-insensitive). Renaming appends the old key to `former_keys`, so `OS-2` still resolves after `OS` became `OMS`.
- **Task number in a project**: `UPDATE projects SET next_number=next_number+1 ... RETURNING next_number-1` inside a savepoint (a failed insert does not burn a number). Numbers are never reused. Only `kind='task'` rows get one.
- **Number of a projectless task**: `MAX(number)+1` over its family in the profile, set by a second UPDATE after the insert: group tasks over all group tasks of the profile (any group); scratch + `pens` + `pen` share one `S` sequence; assistant + routine share one `A` sequence. (Not a counter: deleting the highest lets its number be reused.)
- **Projectless tasks** all have `project_id IS NULL`, `kind='task'`:
  - group task: `group_name` set, `task_type` null. Follows a group rename (`rename_group_tasks`) only when no project is left in the old group.
  - scratch task: `task_type='scratch'`; works in its own folder (or `work_dir`).
  - assistant: `task_type='assistant'`, one per profile (unique index), `work_dir` relative to the data dir.
  - routine thread: `task_type='routine'`, `parent_id` = assistant, copies its `work_dir`, model, effort, permission mode; `title_pinned=1`. Pruned when old and idle.
  - pens thread: `task_type='pens'`, one per profile (unique index), `title_pinned=1`.
  - pen thread: `task_type='pen'`; `pens.thread_id` points at it; `title_pinned=1`.
  - They cannot have dependencies (`check_dependencies`), and are filtered out of board lists by `task_type` (`list_tasks_for_profile`, `list_group_tasks` flags).
- **Review, summary and workflow-step threads**: `kind='review'`, `parent_id` = the task, same `project_id`, `number` 0, `task_type` null / `summary` / `workflow`. They are never listed as tasks (every board query filters `kind='task'`), and die with the parent (FK cascade). The parent's `review.thread_id`, `review.reviewers[].thread_id` and `summaries[].thread_id` name them.
- **Deletes are hard.** `DELETE FROM tasks` cascades to messages, thread tables, runs (and through runs to `token_usage`), checkpoints, permission_requests, documents, pr tables, stats, workflow_runs, review threads. Not cascaded (handled in code or left dangling on purpose): `depends_on` entries (`drop_dependency`), `tasks.pen_id` (`delete_pen`), `merges_into` (left: reads as target `deleted`), `start_from.task_id` (reads as "a deleted task"), `created_by`, `claude_config_id`, `projects.setup_task_id`, `pens.thread_id`, `doc_versions.task_id/run_id`, `automation_runs.task_id`, `mcp_calls`, `approval_log`, `push_answer_tokens`.
- **Soft states**: `projects.archived_at` (project archive: off the board, agents do not start, merges and waits freeze); task "archived" is derived from `done_at` older than two days (no column); `pens.active`; `automations.enabled`, `workflows.enabled`; `agent_skills.enabled`.

### Files on disk (the part this area owns)

Data dir is `~/.local/share/issue-agent/` (the product's former name; `--data-dir` / `IA_DATA_DIR`). Database files:
`huntaway-2.db` (+ `-wal`, `-shm`), the older `huntaway.db` or `issue-agent.db` if the dir predates the switch,
transient `huntaway-2.db.partial`, `huntaway-2.db.replaced` (previous file after a recopy), marker file `recopy-db`
(content: a timestamp), `server_version` (text, last server version that opened the database), and
`backups/huntaway-<from>-to-<to>-<YYYY-MM-DDTHH-MM-SSZ>.db[.gz]`. Other folders seen beside them (owned elsewhere):
`app/`, `assistants/`, `attachments/`, `documents/`, `gh-shim/`, `profiles/`, `projects/`, `runs/`, `skill-sources/`,
files `auth_token`, `host_id`, `hub_token`, `serve.log`.

## 4. In-memory state

- `statements: WeakMap<Conn, Map<sql, StatementSync>>` (`db.ts`): per-connection prepared statements, LRU 500. Rebuilt lazily; nothing to persist.
- `depth` (`db.ts`): module-global transaction nesting counter for `tx`. It is not per connection, which is only correct because all access is synchronous on one thread.
- `settings_cache` (`db/profiles.ts`): `settings.json` path -> `{mtime:size stamp, ANTHROPIC_BASE_URL}`.
- `LOADED` (`db/migrations/named.ts`): the named migrations folder, read once per process.
- `BOOT` (`db/desktop.ts`): `ts-<hex start time>`; a `desktop_ops` row left `running` with another boot id reads as `interrupted`.
- `flipping: WeakMap<Conn, boolean>` (`threads/source.ts`): whether tasks on this connection move onto items (the server turns it on).
- Nothing in this area needs to survive a restart outside the database. Everything durable is a row: run output offsets, queued messages, steers, agent waits (with `news`/`subagent_finished` kept "across a server restart"), MCP calls, permission prompts, thread batch progress, telemetry in-flight batch.

## 5. Outside the process

- No binaries spawned and no network calls from `db/`. `Project_from_row` stats the repo folder (`is_git_root`, `has_commits`) on every read; `ClaudeConfig_from_row` reads `<config dir>/settings.json`.
- Environment: `IA_NEW_DB_FILE` (`0/false/no/off` keeps the board in `huntaway.db`; default on), `IA_RECOPY_DB` / `--recopy-db` (one start only; `serve.ts` deletes the variable so restarts do not inherit it), `IA_DATA_DIR` / `--data-dir`, `IA_SKIP_DB_BACKUP=1`, `IA_SKIP_DB_BACKUP_ONCE=1`, `VITEST` (test mode flag in `util.ts`).
- SQLite pragmas on every connection: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`. The copy source is opened `readOnly` with `busy_timeout=5000`.

## 6. Background work

None owned by `db/`. Queries that exist for other areas' loops: `idle_sessions` (idle compaction, polled every minute),
`old_routine_tasks` (routine pruning), `waiting_tasks`, `queued_merges`, `tasks_with_open_prs`, `tasks_to_watch`,
`due_restacks`, `merge_handoffs`, `active_runs` (restart recovery). Backups are gzipped after the server is up
(`backup.ts`, in a worker); `KEEP = 2` newest plus the newest from before a major version change.

## 7. Surface

`db/` has no routes of its own. Directly tied to it: `GET /admin/server` field `database` (`DatabaseFile`),
`POST /admin/database/recopy` (writes the `recopy-db` marker), `GET/PUT /settings` (`HostSettings`), CLI flags
`--recopy-db`, `--data-dir`, `--profile NAME=DIR`. `wire/` is the response vocabulary of the whole API; each file's
header names its endpoints (e.g. `GET /tasks/{id}` -> `TaskDetail`, `GET /profiles/{id}/pens` -> `Pen[]`,
`GET /projects/{id}/workflows`, `GET /automations/{id}/runs`, `GET /permissions`, `GET /project-approvals`,
`GET /usage`, `GET /telemetry`, `GET /settings-sync`, `GET /health`, `GET /info`).

## 8. Events

`db/` emits nothing. `wire/events.ts` is the complete list of websocket events.
`HostEvent` (a host about itself, on `/api/host/ws` and up its link): `task {task}`, `task_deleted {id, project_id}`,
`message {task_id, message}`, `message_updated`, `delta {task_id, text}`, `delta_reset {task_id}`,
`thread_event {task_id, event}`, `thread_resync {task_id}`, `project {project}`, `project_deleted {id}`,
`profiles_changed`, `settings_changed`, `pens {profile_id}`, `usage {usage}`, `approval_rules {profile_id}`,
`approval_log {profile_id, task_id}`, `checkpoints {task_id}`,
`automations_changed {project_id, profile_id, automation_id}`, `workflows_changed {project_id, workflow_id}`,
`workflow_runs_changed {task_id}`, `docs {profile_id, slug, deleted?}`, `doc_comments {profile_id, slug}`,
`docs_site {profile_id}`, `telegram {profile_id}`,
`assistant_reply {task_id, profile_id, message_id, telegram}` (for push only), `release_checked`,
`release_download {download}`, `restart {phase, error}`, `restart_log {line}`.
`HubEvent` (the hub's own on `/api/ws`): `hello {host_id}`, `tick` (every 25 s), `hosts_changed`, `resync {host_id?}`.
`BoardEvent` = `HostEvent & {host_id}` | `HubEvent`. Tasks and projects are always sent whole.

## 9. Invariants and hard-won rules

### Rules enforced in the write path

- **`update_task` side effects** (`db/tasks/write.ts`), run after every whitelisted update:
  1. `status` or `resolution` changed: a done task gets `resolution = COALESCE(resolution,'done')` and `done_at = COALESCE(done_at, now)`; any other task gets both set to NULL.
  2. `status` changed: `restack` cleared on a done task.
  3. `status`/`merging`/`resolution` changed: `stack_run` cleared unless the task is in `ready_for_merge`, or `needs_attention` while `merging`, or merged.
  4. `status` changed without `remerge` in the same update: `remerge` cleared unless status is `in_progress` or `needs_attention`.
  5. `status`/`merging`/`remerge` changed: `merge_approval` cleared when `merging=0 AND remerge=0`.
  `updated_at` is always bumped. Unknown columns throw. Columns not in the whitelist (`kind`, `number`, `profile_id`, `project_id`, `group_name`, `queued_*` flags, `thread_items`, `thread_source`, `now_at`) change only through their own statements.
- **A thread keeps the config it started with**: `insert_task` writes the resolved default config id into the row "so its session stays with the config it started in even if the profile's or project's configs change later". A task with a `session_id` but no config ran in the agent's default config. `task_config_dir` goes further: it uses the folder the session's **first run** recorded (`runs.config_dir`), unless that folder no longer exists, because "in another folder the agent can't find it (No conversation found)".
- **Run ordering is by `rowid`, not time**: `latest_run`, `run_after`, `later_run`, `add_cost`, `session_config_dir`, `session_board_tools`, `MERGE_HANDOFF` and `workflow_runs` all use `ORDER BY rowid`. "The latest run's start and end set the task's running state and column; an earlier run that ends after it must leave them." An importer must preserve insertion order of `runs` and `workflow_runs` (or carry an explicit sequence).
- **Cost accounting** (`add_cost`): Claude Code reports a session's running total; a run adds only the increase over the session's last total (its own, or the task's latest earlier run in that session). A lower total in a result that counted model usage means the counter restarted; a lower total in a result that did not (a failed turn reporting 0) charges nothing.
- **Merge lanes**: one merge at a time per branch merged into: per project top level (`lane = null`), per subproject (`parent_id`), per `merges_into` target; a stack level joins the lane of the level below once that is merged. A task holds the slot when `merging=1 AND (running=1 OR status='needs_attention')`, or when handed off (`ready_for_merge`, not merging, not running, latest run `finished=1`); never while `merge_approval='pending'`. Merges are held when the target is `closed` or `deleted` until the user says where they go. Walks are capped (16 steps for targets, 64 for stack lines, 256 stack levels) as a cycle guard.
- **Dependencies**: same project only, no self, no cycles (DFS over `depends_on`); "merged" means `status='done' AND resolution IN (NULL,'done')`; a deleted dependency no longer counts.
- **One assistant and one pens thread per profile**: partial unique indexes; the insert functions rely on them and the callers check first.
- **Pen names** unique per profile case-insensitively (index + check in a transaction).
- **Docs**: versions immutable; a publish with `merge` carries over the previous version's pages and referenced images; images deduplicated by sha256 per profile and garbage-collected when a document is deleted; label spelling is the first spelling used in the profile.
- **Secrets are never serialised**: `asana_token`, `api_key`, `management_key`, link `token`, automation `token`/`secret`, docs-site tokens, `vapid_private_key`, telegram tokens. The mechanism is non-enumerable properties, so object spread and `Object.keys` also drop them ("copy it by name if a copy needs it").
- **Query-plan traps** (`db/messages.ts`): the database is never ANALYZEd on purpose (statistics go stale and fresh test databases would not check the same plans). Queries for one task that also filter on `kind`/`type` write `+kind` to stop SQLite choosing the `(kind, created_at)` index and scanning the whole board (HA-188, HA-193: 80 ms per query on 280,000 messages). `thread_items_user_time` is partial for the same reason.
- **`set_setting` trims**; the telemetry password is written by a direct INSERT because it must not be trimmed.

### Database file handling

- **Pragmas**: WAL, `synchronous=NORMAL` ("a power cut, not a crash, can lose the last few commits; runs' output after the saved `out_offset` is read again on the next start"; FULL cost about 1 ms per commit with the single connection locked), `foreign_keys=ON`, `busy_timeout=5000`.
- **One connection, synchronous**: the server holds a single `DatabaseSync` (`AppState.db()`). Other processes open the file too: the thread rebuild command (`threads/write.ts rebuild(c, id, immediate=true)`, the one user of `BEGIN IMMEDIATE` besides the named-migration runner), the backup worker and schema checks (read-only connections), and CLI commands such as `huntaway title-check` and `threads/report.ts`, which are meant for a copy since opening migrates.
- **`huntaway.db` vs `huntaway-2.db`**: the build that moved threads onto items (HA-222) writes a file older builds cannot read correctly, so it took a new file name. First start: copy the older file with `VACUUM INTO huntaway-2.db.partial` (includes what is in the WAL), migrate the copy, record `db_origin`, switch the copy to `journal_mode=DELETE`, fsync, remove stale `-wal/-shm/-journal`, rename, fsync the directory. The older file is only ever read, so a rollback finds it exactly as it was. A start that stops part-way leaves the older file in use and copies again next time.
- **Coming forward after a rollback**: `file_state` (size + mtime in ns of the db and of a non-empty wal; `-shm` ignored because readers write it; an empty wal counts as none) is compared with `db_origin.source_state`. If changed: warn only. Recopy happens only when asked, once (the marker is removed before trying, "a copy that fails isn't tried again on every start"); the current file is first taken out of WAL mode and renamed to `.replaced`.
- "A build whose database older builds mustn't open takes the next number" (`huntaway-3.db`), with the current file first in `OLDER`.
- **Backups before migrations** (`backup.ts`): `VACUUM INTO backups/huntaway-<from>-to-<to>-<time>.db`, gzipped later. Made when a server starts on a data dir a different version last ran on (`server_version`) unless the schema is already exactly this build's (`user_version` equal **and** the set of named migrations equal); and before restarting onto a release that will not make its own (Rust 0.3.x, or TypeScript up to `LAST_BEFORE_NAMED = 0.5.5`, which looks only at `user_version`). No backup means no start / no rollback, unless `IA_SKIP_DB_BACKUP`. The first start on `huntaway-2.db` needs none: the older file is the backup. Live board's `backups/` has three such files plus hand-made ones.
- **Migration runner rules**: numbered migrations each own their transaction and set `user_version`; table rebuilds (6, 20, 91) switch `foreign_keys` off outside the transaction. Named migrations run in `BEGIN IMMEDIATE` ("another process opening this database waits here, then finds the migration recorded"), must not COMMIT, must import nothing but `named.ts`, are never edited after release, and two written at the same time must commute (a test runs both orders). `VERSION` is frozen at 130. Column position is never relied on.
- Migration 102 ran `VACUUM; PRAGMA wal_checkpoint(TRUNCATE)` after deleting 323k message rows (half of a 2 GB file).

### What the migrations reveal: shapes that changed and legacy forms still in rows

The importer reads a database at `user_version` 130 with some named migrations, so the numbered history only matters
where it left marks in data. Those marks:

1. **Message ids outlive the `messages` table.** Threads moved from `messages` rows to `thread_items` (migrations 89, 95, 98, 101, 102). A task on items writes no message rows, but each "message" still takes an id from the `messages` AUTOINCREMENT sequence (`sqlite_sequence`) "without writing a row, so ids stay unique across the board and in order within a task". Those ids are referenced by `permission_requests.message_id`, `checkpoints.message_id`, `runs.turn_message_id`, `tasks.rewind.message_id`, `thread_item_origins.message_id`, request `metadata.message_id`, and item ids of the form `legacy:<id>[:<block>]`. The importer must carry the sequence's high-water mark and keep the ids. A `messages` row may still exist for an items task ("a message whose items couldn't be written, kept so it isn't lost").
2. **`thread_source`** is `items` for every moved task; `messages` only for tasks that never ran since, or on a server kept on the old file. `threads.converter` may be an older translator version (such a thread is rebuilt before use); `threads.error` marks a thread whose live writes stopped. `threads.flipped_writes` is always NULL now. `tasks.thread_items` is implied by `thread_source='items'`.
3. **Scratch chats became scratch tasks** (migration 43): old rows were `kind='scratch'`; they are now `kind='task', task_type='scratch', project_id NULL, status='done', resolution='done'` with `work_dir` = an **absolute** path (the project's scratch folder, or `<data dir>/profiles/<profile id>/scratch`). `list_profile_scratch` still queries `kind='scratch'` for old clients and finds none.
4. **Plan/artifact/diagram task types became labels** (migration 59): `task_type` was set to NULL, `labels=[type]`, `work_dir='documents/<id>'` (**relative** to the data dir), `documents.label` filled. So `work_dir` has two forms (absolute, relative). An automation's stored `Action.task_type` may still hold `plan`/`artifact`/`diagram` ("in an action kept from before API 71"), and the API still accepts those as a new task's `task_type`.
5. **Subprojects are frozen legacy** (`tasks.subproject`, tagged `legacy-subproject` in code): existing ones keep working (own merge lane via `parent_id`, `subproject_status`, `projects.subproject_pull_requests`), new ones are refused (HA-295); `merges_into` replaces them. `parent_id` therefore has three meanings depending on `kind`/`task_type`.
6. **`tasks.summary` is one object or a list** (`summaries_column`); same for `profiles.summarizer`/`projects.summarizer` (single, pre-v84) versus `summarizers` (list). Today both are written, the single as a mirror of the first, for old clients. Read rule: list if non-empty, else the single as a one-element list.
7. **`profiles.claude_config_dir`** is a dead column since migration 18 (configs became rows; each old dir became a config named after the first profile that had it, and every task of the profile was pinned to it). `claude_configs.config_dir=''` means the agent's default folder.
8. **`pens.hidden`** is kept as `1 - active` only so a release from before migration 110 can be rolled back to; `open` repairs rows where the two agree on every start. `pens.color=''` (before 108) reads as `blue`.
9. **`tasks.now_at`** (Now/Later split, migration 77) is unused since HA-285. **`threads.flipped_writes`**, **`runs.kind='review'`** (referenced only by the v73 recount) are also dead.
10. **Nullable "unknown" markers on old rows**: `runs.session_id`/`session_cost` NULL where the v73 recount could not tell; `runs.effort` NULL before v83 (`''` = agent default); `runs.config_dir` NULL = unknown (`''` = default); `runs.usage_*` NULL when never counted; `token_usage`/`call_usage` `cache_write_1h/5m_tokens` NULL (unknown, and always for Codex); `token_usage.estimated=1` rows are guesses; `review_stats.minor` NULL; `review_stats.effort` was backfilled from the task's current effort; `call_usage.call_id` backfilled with `lower(hex(randomblob(16)))` (32 hex chars, not a dashed uuid); `docs_site_published.login` NULL; `tasks.done_at` backfilled from `updated_at`; `resolution` backfilled `done`.
11. **JSON values with optional newer fields** (readers default them): `Review.reviewers` empty and `ReviewerRun.label` blank before API 29; `Review.started_at`, `ReviewerRun.after_run`, `ChangeSummary.after_run` missing ("any run of the thread ends it"); `Review.extra_rounds`/`fixes` default 0; `WaitTask.review_at` missing on old waits; `Steer.routine_runs`/`routine` missing; `PrChecks` counters default 0; push `Events` missing keys default with `reports=false` (not the new-subscription default `true`); `ssh` target ports default 22 and 7878; `Reviewer` optional `name/skills/prompt`.
12. **Renamed values inside JSON**: workflow approvals stored with `kind:'automation'` were rewritten to `'workflow'` (migration 100) in both `messages.data` and `thread_requests.data.metadata.kind`; the wire type still allows both. Workflow graphs may contain `trigger` nodes with `on:'status'|'finished'` and `set_status` nodes, which `Graph_from_json` reads as `column` nodes. `projects.use_workflows` was derived from such graphs (migration 113).
13. **`projects.permission_mode`** `'default'` was turned into NULL at v6 (NULL = host default). `projects.reviewers` NULL or `[]` both mean "use the profile's".
14. **Project keys were moved off reserved letters**: a project keyed `G`, `S` or `A` became `GP`/`SP`/`AP` (or `GP2`...) when group, scratch and assistant keys arrived (migrations 32, 43, 90). `former_keys` exists since v40.
15. **Automations gained `profile_id`** by a table rebuild (91); routines have `project_id NULL`.
16. **Default model/effort were seeded** (`opus`, `high`, migration 123) only where unset; "cleared in the host settings, they stay clear" (no row).
17. **Migrations are written defensively** because PR-preview and branch builds reused version numbers: most use `has_column` / `IF NOT EXISTS`, several re-add earlier migrations' columns (76, 79, 107, 111, 113, 114, 130), there is no migration 78, and `desktop_ops` once existed as a branch's numbered 107. Consequence: column **order** differs between databases, and a database can hold tables or columns from a branch that never merged (`named_migrations` may list names this build does not know; they are left alone).
18. **Names from the Rust era and the old product name**: data dir `issue-agent`, `issue-agent.db`, env prefix `IA_`, branch prefix `ia/`, temp prefix `ia-ts-`, `ia-shim`; comments cite `.rs` files; `claude` as the message kind for Codex output too; `claude_config*` for configs of either agent.

## 10. How it is tested

- `db/testing.ts`: `temp_dir()`, `np()` / `nt()` builders for a project and a task, `deferred_fk()` (a database whose COMMIT fails, to test `tx` rollback), `thread()`.
- `open(":memory:")` gives a fully migrated in-memory database; tests run the whole migration chain on every open.
- `db/schema.test.ts` (1,465 lines) migrates from old versions and checks backfills; `tests/migration_numbers.test.ts` pins `VERSION`; `tests/named_migrations.test.ts` checks names and `after`; `tests/migration_order.test.ts` runs recent named migrations in both orders on a database with sample rows and diffs tables, indexes, triggers and rows.
- Seams: `room.disk.free` is replaceable; `named.load(dir)`, `run_pending(conn, path, list)` and `standing(conn, list)` take a list; `file.enabled(env)` takes an env; `threads/source.set_flips(c, on)` controls the items flip per connection; `wire/tests.test.ts` checks the wire files stay import-free.

## 11. Dependencies

- `db/` imports only `util.ts` (`now`, `new_id`, `expand_tilde`, `is_git_root`, `has_commits`, `byte_len`), `http.ts` (`ApiError` for validation errors) and `wire/` types. It is the bottom layer ("db/ imports nothing above it").
- Everything else imports it as `db.<name>`: the runner, API handlers, MCP tools, review, workflows, automations, threads, telemetry, settings sync, backup, hosts/hub.
- Tables written by other areas with their own SQL (not through `db/`): threads (`threads/store.ts`, `write.ts`, `source.ts`), permission requests and MCP calls (`mcp/`), checkpoints (`git/checkpoints.ts`), context and token accounting (`agent/context.ts`, `agent/tokens*.ts`), agent tools (`agent/agent_tools*`), automations and workflows (`integrations/`), push and devices (`integrations/push*`, `devices.ts`), task documents (`agent/documents.ts`), pr tables (`mcp/pr_watch/seen.ts`, `review/merged.ts`), approval log (`agent/approval_rules.ts`), telemetry outbox, setting versions.
- `wire/` is imported by the web and mobile clients through `packages/client` by relative path, so it must stay plain erasable TypeScript with no imports outside `wire/` and `threads/protocol.ts`.

## 12. Rewrite notes

**Accidental (port shape or compatibility)**
- The serde emulation: `_from_json` functions that reproduce Rust's error messages, `put(..., skip)` to mimic `skip_serializing_if`, `hidden()` for `#[serde(skip)]`, `Queued_new`/`queued_then` naming, `debug_list` (Rust `{:?}`). A schema library replaces all of it; what must survive is the leniency (a bad JSON column reads as null/empty, it never breaks a task read).
- Wide `tasks` table (82 columns on the live board, 85 in the checkout; 17 of them JSON, 20 in the checkout) grown one `ALTER TABLE` at a time; mirror columns (`pens.hidden`, `summarizer`, `claude_config_dir`); dead columns (`now_at`, `flipped_writes`); `summary` holding two shapes; `task.summary` and `Profile.summarizer`/`claude_config_dir` wire fields kept "for clients from before".
- "(API n)" version gating on wire fields, the `huntaway.db`/`huntaway-2.db` two-file scheme, `db_origin`, recopy, `LAST_BEFORE_NAMED`, the Rust-release backup rules and the defensive `has_column` migrations are all about rolling back to older builds on the same data dir. A new product with a one-off importer needs none of it, but does need its own backup-before-migrate rule.
- Subprojects, `kind='scratch'`, task-type documents, `set_status`/`trigger on` workflow nodes: legacy forms to convert at import and then drop.
- The name `claude_config` for a config of either agent; message kind `claude` for any agent; two spellings of permission modes (Claude Code's on tasks, snake_case in the thread protocol).

**Essential**
- The entity graph: profile -> (configs by id list) -> projects -> tasks -> threads under tasks (`kind='review'`), runs, items; projectless task families with their own key letters and number sequences; pens across projects.
- Never-reused per-project task numbers and `former_keys` so old keys keep resolving.
- The derived-column rules of `update_task` (resolution/done_at, restack, stack_run, remerge, merge_approval).
- Session continuity rules: config pinned at creation, config folder pinned per session, cost as a delta of a session total, board tools pinned per Codex session.
- Run order as a strict sequence independent of clocks.
- Message ids as a board-wide monotonic sequence even though messages are no longer rows.
- Lenient reads of agent-written JSON (`todos`, `tracked`), strict writes.
- Secrets never leaving the server.

**Awkward today**
- Board queries filter by `kind` and `task_type IS NOT ...` in many places; forgetting one leaks assistant/routine/pen threads onto a board. The "what kind of thread is this" notion is spread over `kind`, `task_type`, `group_name`, `subproject`, `parent_id`.
- Projectless numbers use `MAX(number)+1` in a second UPDATE after the insert (a number can be reused after a delete, unlike project numbers).
- Stack and merge-lane logic walks task-to-task links with one query per step (`merge_lane` is evaluated per candidate in `active_merge`/`queued_merges`), fine at 2,848 tasks, quadratic in principle. `stacked_on` uses `json_extract(start_from, ...)` with no index.
- `Project_from_row` touches the filesystem on every read (`is_git`, `has_commits`), and `ClaudeConfig_from_row` reads `settings.json`.
- `tx`'s global `depth` counter and the single synchronous connection are load-bearing assumptions (no awaits inside a transaction).
- Many references are soft (ids in JSON or plain TEXT without FKs), each with its own hand-written cleanup; `merges_into` and `start_from.task_id` deliberately dangle to express "the target was deleted".
- `settings` mixes host preferences, secrets, per-profile JSON blobs (`approval_rules:<id>`, `telegram*:<id>`), one-off migration flags and crash-recovery state (`telemetry_inflight`, `thread_batch`) in one key/value table.
