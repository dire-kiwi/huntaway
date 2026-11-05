// Port of server/src/db/schema.rs: the database schema. `open` creates it, or migrates an older database to the latest
// version (`PRAGMA user_version`, `VERSION`).
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { all, run, value, type Conn } from "../db.ts";
import * as stats from "../review/stats.ts";
import { path_str } from "../util.ts";
import { config_for_dir } from "./profiles.ts";
import { ASSISTANT_TASK_KEY, SCRATCH_TASK_KEY, clear_projectless_dependencies, free_group_task_key, free_task_key } from "./tasks.ts";

/** Whether `table` has a column `column`. */
const has_column = (c: Conn, table: string, column: string): boolean =>
  !!value(c, "SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name=?2", table, column);

export function open(path: string): Conn {
  const conn = new DatabaseSync(path);
  // With WAL, synchronous=NORMAL syncs at checkpoints rather than on every commit, and the database stays consistent. A
  // power cut (not a crash) can lose the last few commits; runs' output after the saved out_offset is read again on the
  // next start. FULL syncs every commit with the one connection locked: about 1 ms each on an NVMe disk, more on slower
  // ones.
  conn.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const version = Number(value(conn, "PRAGMA user_version"));
  const batch = (sql: string) => conn.exec(sql);
  if (version < 1) batch(`BEGIN; ${SCHEMA_V1} PRAGMA user_version=1; COMMIT;`);
  if (version < 2) batch(`BEGIN; ${SCHEMA_V2} PRAGMA user_version=2; COMMIT;`);
  if (version < 3) batch(`BEGIN; ${SCHEMA_V3} PRAGMA user_version=3; COMMIT;`);
  if (version < 4) batch("BEGIN; CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=4; COMMIT;");
  if (version < 5) {
    // How to reach hosts linked over SSH (JSON, see ssh::Target).
    batch("BEGIN; ALTER TABLE links ADD COLUMN ssh TEXT; PRAGMA user_version=5; COMMIT;");
  }
  if (version < 6) {
    // Foreign keys off so dropping the old table doesn't cascade to tasks (it can't be changed inside a transaction).
    batch(`PRAGMA foreign_keys=OFF; BEGIN; ${SCHEMA_V6} PRAGMA user_version=6; COMMIT; PRAGMA foreign_keys=ON;`);
  }
  if (version < 7) {
    // Set while a task's agent is merging it (see runner::request_merge).
    batch("BEGIN; ALTER TABLE tasks ADD COLUMN merging INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=7; COMMIT;");
  }
  if (version < 8) {
    // Where the task's work can be tried (e.g. a PR preview deployment).
    batch("BEGIN; ALTER TABLE tasks ADD COLUMN preview_url TEXT; PRAGMA user_version=8; COMMIT;");
  }
  if (version < 9) {
    // What a run is for: 'prompt' (a turn of the conversation) or 'compact' (`/compact`).
    batch("BEGIN; ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'prompt'; PRAGMA user_version=9; COMMIT;");
  }
  if (version < 10) {
    // A message sent while the agent was running, waiting for the run to end.
    batch("BEGIN; ALTER TABLE tasks ADD COLUMN queued_message TEXT; PRAGMA user_version=10; COMMIT;");
  }
  if (version < 11) {
    // Automatic reviews (see review.rs): review threads point at the task they review, the task keeps the latest
    // review's outcome, and projects can turn them off.
    batch(
      `BEGIN;
             ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
             ALTER TABLE tasks ADD COLUMN review TEXT;
             ALTER TABLE projects ADD COLUMN auto_review INTEGER NOT NULL DEFAULT 1;
             ALTER TABLE projects ADD COLUMN review_rounds INTEGER NOT NULL DEFAULT 2;
             CREATE INDEX tasks_parent ON tasks(parent_id);
             PRAGMA user_version=11; COMMIT;`,
    );
  }
  if (version < 12) {
    // A thread's own effort level; falls back to the host's default when unset.
    batch("BEGIN; ALTER TABLE tasks ADD COLUMN effort TEXT; PRAGMA user_version=12; COMMIT;");
  }
  if (version < 13) {
    // When the task's agent started working, for the board's elapsed timer.
    batch("BEGIN; ALTER TABLE tasks ADD COLUMN run_started_at TEXT; PRAGMA user_version=13; COMMIT;");
  }
  if (version < 14) {
    // Prompt analytics (see analytics.rs) look up user messages by time.
    batch("BEGIN; CREATE INDEX messages_kind_time ON messages(kind, created_at); PRAGMA user_version=14; COMMIT;");
  }
  if (version < 15) {
    // Whether the queued message came only from other agents (see queue_message).
    batch("BEGIN; ALTER TABLE tasks ADD COLUMN queued_from_agent INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=15; COMMIT;");
  }
  if (version < 16) {
    // Subprojects: a task whose own tasks (`parent_id` = the subproject) branch from, and merge back into, its branch.
    batch("BEGIN; ALTER TABLE tasks ADD COLUMN subproject INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=16; COMMIT;");
  }
  if (version < 17) {
    // How a done task ended (see RESOLUTIONS); tasks already done were done.
    batch("BEGIN; ALTER TABLE tasks ADD COLUMN resolution TEXT; UPDATE tasks SET resolution='done' WHERE status='done'; PRAGMA user_version=17; COMMIT;");
  }
  if (version < 18) migrate_claude_configs(conn);
  if (version < 19) batch(`BEGIN; ${SCHEMA_V19} PRAGMA user_version=19; COMMIT;`);
  if (version < 20) batch(`PRAGMA foreign_keys=OFF; BEGIN; ${SCHEMA_V20} PRAGMA user_version=20; COMMIT; PRAGMA foreign_keys=ON;`);
  if (version < 21) {
    // Which other profiles' agents may use a profile's board (see Profile.agent_access).
    batch("BEGIN; ALTER TABLE profiles ADD COLUMN agent_access TEXT NOT NULL DEFAULT '[]'; PRAGMA user_version=21; COMMIT;");
  }
  if (version < 22) {
    // Task dependencies: tasks that have to be merged before a task's agent starts, and whether it's waiting for them
    // (see runner::wait_for_dependencies).
    batch(
      `BEGIN;
             ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';
             ALTER TABLE tasks ADD COLUMN waiting INTEGER NOT NULL DEFAULT 0;
             PRAGMA user_version=22; COMMIT;`,
    );
  }
  if (version < 23) {
    // Which agent CLI a config is for (see AGENTS): Claude Code or Codex. Tables created by migrate_claude_configs since
    // have it already.
    const add = has_column(conn, "claude_configs", "agent") ? "" : "ALTER TABLE claude_configs ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude';";
    batch(`BEGIN; ${add} PRAGMA user_version=23; COMMIT;`);
  }
  if (version < 24) {
    // The task's pull request, set by its agent or found with `gh` (see worktree::find_pr).
    batch("BEGIN; ALTER TABLE tasks ADD COLUMN pr_url TEXT; PRAGMA user_version=24; COMMIT;");
  }
  if (version < 25) {
    // A project's own instructions for the prompts the board sends when a task's agent starts, when it's reviewed and
    // when it's merged (see agent/prompts.rs); NULL for the default.
    batch(
      `BEGIN;
             ALTER TABLE projects ADD COLUMN start_prompt TEXT;
             ALTER TABLE projects ADD COLUMN review_prompt TEXT;
             ALTER TABLE projects ADD COLUMN merge_prompt TEXT;
             PRAGMA user_version=25; COMMIT;`,
    );
  }
  if (version < 26) {
    // Messages sent to a running agent that it hasn't taken in yet (see runner::steer), and what a run's agent has cost
    // so far (it reports a running total at the end of each turn).
    batch(
      `BEGIN;
             ALTER TABLE tasks ADD COLUMN steering TEXT NOT NULL DEFAULT '[]';
             ALTER TABLE runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
             PRAGMA user_version=26; COMMIT;`,
    );
  }
  if (version < 27) {
    // The project's reviewers (see review.rs): a JSON list of Reviewer, NULL for one reviewer with the task's own config.
    batch("BEGIN; ALTER TABLE projects ADD COLUMN reviewers TEXT; PRAGMA user_version=27; COMMIT;");
  }
  if (version < 28) {
    // Whether a task's running run takes messages while it works (see runner::can_steer); the id of a run's latest stop,
    // so an earlier stop's timer leaves a later one alone; and whether its agent is between turns.
    batch(
      `BEGIN;
             ALTER TABLE tasks ADD COLUMN steerable INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE runs ADD COLUMN stop_id TEXT;
             ALTER TABLE runs ADD COLUMN between_turns INTEGER NOT NULL DEFAULT 0;
             PRAGMA user_version=28; COMMIT;`,
    );
  }
  if (version < 29) {
    // Projects created in a folder that wasn't a git repository yet had worktrees turned off for good, even once it
    // became one. They're the ones without a base branch; turn worktrees back on, which applies once the folder is a git
    // repository (Project.is_git).
    batch(
      `BEGIN;
             UPDATE projects SET use_worktrees=1 WHERE use_worktrees=0 AND (base_branch IS NULL OR base_branch='');
             PRAGMA user_version=29; COMMIT;`,
    );
  }
  if (version < 30) {
    // The sidebar group a project is in (see Project.group_name); NULL for none.
    batch("BEGIN; ALTER TABLE projects ADD COLUMN group_name TEXT; PRAGMA user_version=30; COMMIT;");
  }
  if (version < 31) {
    // Group tasks (see Task.group_name) and the task whose agent created each task.
    batch(
      `BEGIN;
             ALTER TABLE tasks ADD COLUMN group_name TEXT;
             ALTER TABLE tasks ADD COLUMN created_by TEXT;
             PRAGMA user_version=31; COMMIT;`,
    );
  }
  if (version < 32) {
    // Group tasks' keys are G-<n>, so a project with the key G moves to a free one.
    batch("BEGIN;");
    free_group_task_key(conn);
    batch("PRAGMA user_version=32; COMMIT;");
  }
  if (version < 33) {
    batch("BEGIN;");
    clear_projectless_dependencies(conn);
    batch("PRAGMA user_version=33; COMMIT;");
  }
  if (version < 34) {
    // An agent blocked in the `wait` tool (see Task.agent_wait).
    batch("BEGIN; ALTER TABLE tasks ADD COLUMN agent_wait TEXT; PRAGMA user_version=34; COMMIT;");
  }
  if (version < 35) {
    // Runs whenever one of the project's tasks changes status (see integrations/status_script.rs).
    batch("BEGIN; ALTER TABLE projects ADD COLUMN status_script TEXT NOT NULL DEFAULT ''; PRAGMA user_version=35; COMMIT;");
  }
  if (version < 36) {
    // A script per column, run when a task moves into it (see integrations/status_script.rs).
    batch("BEGIN; ALTER TABLE projects ADD COLUMN status_scripts TEXT NOT NULL DEFAULT '{}'; PRAGMA user_version=36; COMMIT;");
  }
  if (version < 37) {
    // How full the agent's context window is (see agent/context.rs).
    batch(
      `BEGIN;
             ALTER TABLE tasks ADD COLUMN context TEXT;
             ALTER TABLE tasks ADD COLUMN context_detail TEXT;
             PRAGMA user_version=37; COMMIT;`,
    );
  }
  if (version < 38) {
    // Plan, artifact and diagram tasks, and the versions of the document each one makes (see agent/documents.rs).
    batch(
      `BEGIN;
             ALTER TABLE tasks ADD COLUMN task_type TEXT;
             ALTER TABLE tasks ADD COLUMN document_at TEXT;
             CREATE TABLE documents (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
               version INTEGER NOT NULL,
               content TEXT NOT NULL,
               open INTEGER NOT NULL DEFAULT 0,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE UNIQUE INDEX documents_task ON documents(task_id, version);
             PRAGMA user_version=38; COMMIT;`,
    );
  }
  if (version < 39) {
    // 'tool' for a tool-permission prompt, 'project' for a project change an agent asked the user to approve (see
    // permissions::approve), and since API 58 'delete_task' for a task an agent asked to delete.
    batch("BEGIN; ALTER TABLE permission_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'tool'; PRAGMA user_version=39; COMMIT;");
  }
  if (version < 40) {
    // The keys a project had before (see Project.former_keys).
    batch("BEGIN; ALTER TABLE projects ADD COLUMN former_keys TEXT NOT NULL DEFAULT '[]'; PRAGMA user_version=40; COMMIT;");
  }
  if (version < 41) {
    // What the repository folder was, to recognise it after it moves (see Project.repo_root).
    batch("BEGIN; ALTER TABLE projects ADD COLUMN repo_root TEXT; PRAGMA user_version=41; COMMIT;");
  }
  if (version < 42) {
    // When a project was archived (see Project.archived_at); NULL while it isn't.
    batch("BEGIN; ALTER TABLE projects ADD COLUMN archived_at TEXT; PRAGMA user_version=42; COMMIT;");
  }
  if (version < 43) {
    // Scratch chats become scratch tasks (see is_scratch), keyed S-<n>, so a project with the key S moves to a free one.
    // A database from a build that had this as version 42 (PR previews of it) has work_dir and its scratch tasks
    // already, but not archived_at.
    batch("BEGIN;");
    if (!has_column(conn, "projects", "archived_at")) batch("ALTER TABLE projects ADD COLUMN archived_at TEXT;");
    if (!has_column(conn, "tasks", "work_dir")) batch("ALTER TABLE tasks ADD COLUMN work_dir TEXT;");
    free_task_key(conn, SCRATCH_TASK_KEY, "SP");
    migrate_scratch_chats(conn, parent_dir(path));
    batch("PRAGMA user_version=43; COMMIT;");
  }
  if (version < 44) {
    // Starred tasks, and reminders to come back to a task (see Task.starred, Task.remind_at). A database from a build
    // that had this as version 42 (PR previews of it) has the columns already.
    batch("BEGIN;");
    for (const [column, kind] of [["starred", "INTEGER NOT NULL DEFAULT 0"], ["remind_at", "TEXT"], ["reminder", "TEXT"]]) {
      if (!has_column(conn, "tasks", column)) batch(`ALTER TABLE tasks ADD COLUMN ${column} ${kind};`);
    }
    batch("PRAGMA user_version=44; COMMIT;");
  }
  if (version < 45) {
    // A title renamed by hand, which then doesn't follow the user's prompts (see Task.title_pinned).
    batch("BEGIN; ALTER TABLE tasks ADD COLUMN title_pinned INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=45; COMMIT;");
  }
  if (version < 46) {
    // The user's own parts of a queued message (see Task.queued_user_text). One queued before is the user's unless other
    // agents sent all of it.
    batch(
      `BEGIN; ALTER TABLE tasks ADD COLUMN queued_user_text TEXT;
             UPDATE tasks SET queued_user_text=queued_message WHERE NOT queued_from_agent;
             PRAGMA user_version=46; COMMIT;`,
    );
  }
  if (version < 47) {
    // The GitHub account a profile's agents use, and a project's own (see Profile.github_account). A database from a PR
    // preview of this, where it was version 42, 44 or 45, has them already, at 44 it doesn't have starred tasks and
    // reminders (version 44 here), and at 45 pinned titles (version 45 here).
    batch("BEGIN;");
    const columns = [
      ["profiles", "github_account", "TEXT"],
      ["projects", "github_account", "TEXT"],
      ["tasks", "starred", "INTEGER NOT NULL DEFAULT 0"],
      ["tasks", "remind_at", "TEXT"],
      ["tasks", "reminder", "TEXT"],
      ["tasks", "title_pinned", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [table, column, kind] of columns) {
      if (!has_column(conn, table, column)) batch(`ALTER TABLE ${table} ADD COLUMN ${column} ${kind};`);
    }
    batch("PRAGMA user_version=47; COMMIT;");
  }
  if (version < 48) {
    // Whether the board fetches and shows a config's subscription usage (see agent/usage.rs); off until the user turns it
    // on, so every copy of a login (previews, test servers) doesn't. Tables created by migrate_claude_configs since have
    // it already.
    const add = has_column(conn, "claude_configs", "show_usage") ? "" : "ALTER TABLE claude_configs ADD COLUMN show_usage INTEGER NOT NULL DEFAULT 0;";
    batch(`BEGIN; ${add} PRAGMA user_version=48; COMMIT;`);
  }
  if (version < 49) {
    // When a task moved into Done (see Task.done_at). Those done already get the time they last changed, which is about
    // when they were done.
    batch("BEGIN; ALTER TABLE tasks ADD COLUMN done_at TEXT; UPDATE tasks SET done_at=updated_at WHERE status='done'; PRAGMA user_version=49; COMMIT;");
  }
  if (version < 50) {
    // The folder a profile's repositories are cloned into (see Profile.clone_dir). Added only if it isn't there, in case
    // another migration takes this version first.
    const add = has_column(conn, "profiles", "clone_dir") ? "" : "ALTER TABLE profiles ADD COLUMN clone_dir TEXT;";
    batch(`BEGIN; ${add} PRAGMA user_version=50; COMMIT;`);
  }
  if (version < 51) {
    // Tasks' links to the tasks they're for elsewhere (see Task.external_links), and a profile's Asana token and who it's
    // for (see Profile.asana_token).
    batch("BEGIN;");
    for (const [table, column] of [["tasks", "external_links"], ["profiles", "asana_token"], ["profiles", "asana_user"]]) {
      if (!has_column(conn, table, column)) batch(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT;`);
    }
    batch("PRAGMA user_version=51; COMMIT;");
  }
  if (version < 52) {
    // Whether a profile uses Asana (see Profile.asana_enabled), on until it's turned off.
    const add = has_column(conn, "profiles", "asana_enabled") ? "" : "ALTER TABLE profiles ADD COLUMN asana_enabled INTEGER NOT NULL DEFAULT 1;";
    batch(`BEGIN; ${add} PRAGMA user_version=52; COMMIT;`);
  }
  if (version < 53) {
    // What ties the tasks made together from one prompt (see Task.fanout_id).
    const add = has_column(conn, "tasks", "fanout_id") ? "" : "ALTER TABLE tasks ADD COLUMN fanout_id TEXT;";
    batch(`BEGIN; ${add} PRAGMA user_version=53; COMMIT;`);
  }
  if (version < 54) {
    // What a task's agent has been told about each pull request it waited on (see mcp/pr_watch.rs).
    batch(
      `BEGIN;
             CREATE TABLE IF NOT EXISTS pr_watches (
               task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
               pr TEXT NOT NULL,
               state TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               PRIMARY KEY (task_id, pr)
             );
             PRAGMA user_version=54; COMMIT;`,
    );
  }
  if (version < 55) {
    // Projects' automations and their runs (see integrations/automations.rs).
    batch(`BEGIN; ${SCHEMA_V55} PRAGMA user_version=55; COMMIT;`);
  }
  if (version < 56) {
    // Whether a task whose pull request was merged on GitHub moves to Done (see review/merged.rs), on until it's turned
    // off, and what its last read found.
    const add = has_column(conn, "projects", "done_when_merged") ? "" : "ALTER TABLE projects ADD COLUMN done_when_merged INTEGER NOT NULL DEFAULT 1;";
    batch(
      `BEGIN; ${add}
             CREATE TABLE IF NOT EXISTS pr_states (
               task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
               pr_url TEXT NOT NULL,
               state TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               PRIMARY KEY (task_id, pr_url)
             );
             PRAGMA user_version=56; COMMIT;`,
    );
  }
  if (version < 57) {
    // A merging task that stepped out of the merge queue to fix something (see Task.remerge).
    const add = has_column(conn, "tasks", "remerge") ? "" : "ALTER TABLE tasks ADD COLUMN remerge INTEGER NOT NULL DEFAULT 0;";
    batch(`BEGIN; ${add} PRAGMA user_version=57; COMMIT;`);
  }
  if (version < 58) {
    // Checkpoints of tasks' worktrees, a conversation rollback waiting for a task's next run, and where each run's turn
    // is (see git/checkpoints.rs). Columns added only if they aren't there, in case another migration takes this version
    // first.
    batch(`BEGIN; ${SCHEMA_V58}`);
    for (const [table, column] of [["tasks", "rewind TEXT"], ["runs", "turn_message_id INTEGER"], ["runs", "agent_at TEXT"]]) {
      if (!has_column(conn, table, column.split(" ")[0])) batch(`ALTER TABLE ${table} ADD COLUMN ${column};`);
    }
    batch("PRAGMA user_version=58; COMMIT;");
  }
  if (version < 59) {
    // Plans, artifacts and diagrams are labels any task can have, with a document each (see agent/documents.rs), rather
    // than types of task. A task that was one of those types gets its type as its label, and keeps working in its own
    // folder (as a `work_dir` in the data dir), where its agent's conversation is.
    const has = (table: string, column: string) => !!value(conn, `SELECT COUNT(*) > 0 FROM pragma_table_info('${table}') WHERE name='${column}'`);
    const tasks = has("tasks", "labels") ? "" : "ALTER TABLE tasks ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';";
    const documents = has("documents", "label") ? "" : "ALTER TABLE documents ADD COLUMN label TEXT NOT NULL DEFAULT 'plan';";
    batch(
      `BEGIN; ${tasks} ${documents}
             UPDATE documents SET label=(SELECT t.task_type FROM tasks t WHERE t.id=documents.task_id)
               WHERE (SELECT t.task_type FROM tasks t WHERE t.id=documents.task_id) IN ('plan','artifact','diagram');
             DROP INDEX IF EXISTS documents_task;
             CREATE UNIQUE INDEX documents_task ON documents(task_id, label, version);
             UPDATE tasks SET labels=json_array(task_type), work_dir=COALESCE(work_dir, 'documents/' || id), task_type=NULL
               WHERE task_type IN ('plan','artifact','diagram');
             PRAGMA user_version=59; COMMIT;`,
    );
  }
  if (version < 60) {
    // Whether a project's tasks' pull requests are watched while they're in review (see Project.watch_pull_requests),
    // off until it's turned on.
    const add = has_column(conn, "projects", "watch_pull_requests") ? "" : "ALTER TABLE projects ADD COLUMN watch_pull_requests TEXT NOT NULL DEFAULT 'off';";
    batch(`BEGIN; ${add} PRAGMA user_version=60; COMMIT;`);
  }
  if (version < 61) {
    // The thread that helps get a project's folder ready for worktrees (see Project.setup_task_id).
    const add = has_column(conn, "projects", "setup_task_id") ? "" : "ALTER TABLE projects ADD COLUMN setup_task_id TEXT;";
    batch(`BEGIN; ${add} PRAGMA user_version=61; COMMIT;`);
  }
  if (version < 62) {
    // The devices that get this board's notifications by Web Push (see integrations/push.rs).
    batch(
      `BEGIN;
             CREATE TABLE IF NOT EXISTS push_subscriptions (
               id TEXT PRIMARY KEY,
               endpoint TEXT NOT NULL UNIQUE,
               p256dh TEXT NOT NULL,
               auth TEXT NOT NULL,
               name TEXT NOT NULL DEFAULT '',
               events TEXT NOT NULL,
               created_at TEXT NOT NULL,
               last_sent_at TEXT,
               last_error TEXT
             );
             PRAGMA user_version=62; COMMIT;`,
    );
  }
  if (version < 63) {
    // Where a project's tasks' pull requests are previewed (see Project.pr_preview_url).
    const add = has_column(conn, "projects", "pr_preview_url") ? "" : "ALTER TABLE projects ADD COLUMN pr_preview_url TEXT;";
    batch(`BEGIN; ${add} PRAGMA user_version=63; COMMIT;`);
  }
  if (version < 64) {
    // Runs are looked up by task (the latest one, every minute for idle sessions; whether one is active) and prompts
    // counted by task on every task read; both tables only grow.
    batch(
      `BEGIN;
             CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, created_at);
             CREATE INDEX IF NOT EXISTS permission_requests_task ON permission_requests(task_id, status);
             PRAGMA user_version=64; COMMIT;`,
    );
  }
  if (version < 65) {
    // When the usage limit a task's agent ran out of resets (see Task.limit_reset_at), and what a profile's tasks do when
    // their config runs out (see Profile.limit_wait). Added only if they aren't there, in case another migration takes
    // this version first.
    batch("BEGIN;");
    const cols = [["tasks", "limit_reset_at", "TEXT"], ["profiles", "limit_wait", "INTEGER NOT NULL DEFAULT 0"], ["profiles", "limit_switch", "INTEGER NOT NULL DEFAULT 0"]];
    for (const [table, column, kind] of cols) {
      if (!has_column(conn, table, column)) batch(`ALTER TABLE ${table} ADD COLUMN ${column} ${kind};`);
    }
    batch("PRAGMA user_version=65; COMMIT;");
  }
  if (version < 66) {
    // Ignored files copied, and folders linked, into each new task worktree (see git/worktree_files.rs).
    let add = "";
    for (const col of ["copy_files", "link_folders"]) {
      if (!has_column(conn, "projects", col)) add += `ALTER TABLE projects ADD COLUMN ${col} TEXT NOT NULL DEFAULT '';`;
    }
    batch(`BEGIN; ${add} PRAGMA user_version=66; COMMIT;`);
  }
  if (version < 67) {
    // A summary of each task's changes once its review passes (see review/summary.rs): whether a project makes them and
    // who writes them, and the task's latest. Added only if they aren't there, in case another migration takes this
    // version first.
    batch("BEGIN;");
    const cols = [["projects", "auto_summary", "INTEGER NOT NULL DEFAULT 1"], ["projects", "summarizer", "TEXT"], ["tasks", "summary", "TEXT"]];
    for (const [table, column, kind] of cols) {
      if (!has_column(conn, table, column)) batch(`ALTER TABLE ${table} ADD COLUMN ${column} ${kind};`);
    }
    batch("PRAGMA user_version=67; COMMIT;");
  }
  if (version < 68) {
    // Whether a project's agents open pull requests for their tasks, and for its subprojects' tasks (see
    // Project.pull_requests), on until they're turned off. Added only if they aren't there, in case another migration
    // takes this version first.
    batch("BEGIN;");
    for (const col of ["pull_requests", "subproject_pull_requests"]) {
      if (!has_column(conn, "projects", col)) batch(`ALTER TABLE projects ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 1;`);
    }
    batch("PRAGMA user_version=68; COMMIT;");
  }
  if (version < 69) {
    // How big threads' contexts get and when they're compacted (see context::record_turn), with the compactions threads
    // already show.
    batch(`BEGIN; ${SCHEMA_V69} ${BACKFILL_V69}`);
    for (const column of ["turn_start_tokens", "turn_tokens"]) {
      if (!has_column(conn, "runs", column)) batch(`ALTER TABLE runs ADD COLUMN ${column} INTEGER;`);
    }
    batch("PRAGMA user_version=69; COMMIT;");
  }
  if (version < 70) {
    // Who reviews and summarises the tasks of a profile's projects that don't choose their own (see Profile.reviewers).
    // Added only if they aren't there, in case another migration takes this version first.
    batch("BEGIN;");
    for (const col of ["reviewers", "summarizer"]) {
      if (!has_column(conn, "profiles", col)) batch(`ALTER TABLE profiles ADD COLUMN ${col} TEXT;`);
    }
    batch("PRAGMA user_version=70; COMMIT;");
  }
  if (version < 71) {
    // Whether the board starts a config's next 5-hour window as soon as one ends (see agent/window.rs); off until the
    // user turns it on. Added only if it isn't there, in case another migration takes this version first (tables
    // created by migrate_claude_configs since have it already).
    const add = has_column(conn, "claude_configs", "restart_window") ? "" : "ALTER TABLE claude_configs ADD COLUMN restart_window INTEGER NOT NULL DEFAULT 0;";
    batch(`BEGIN; ${add} PRAGMA user_version=71; COMMIT;`);
  }
  if (version < 72) {
    // Whether a profile's and a project's merges wait for the user's approval, and where a task's merge is with it (see
    // review/merge_gate.rs). Added only if they aren't there, in case another migration takes this version first.
    batch("BEGIN;");
    const cols = [["profiles", "merge_approval", "INTEGER NOT NULL DEFAULT 0"], ["projects", "merge_approval", "INTEGER"], ["tasks", "merge_approval", "TEXT"]];
    for (const [table, column, kind] of cols) {
      if (!has_column(conn, table, column)) batch(`ALTER TABLE ${table} ADD COLUMN ${column} ${kind};`);
    }
    batch("PRAGMA user_version=72; COMMIT;");
  }
  if (version < 73) {
    // The Claude Code session a run is in and its total cost as it last said, which a run that resumes the session goes
    // on from (see add_cost), and the costs counted twice before. Added only if they aren't there, in case another
    // migration takes this version first.
    batch("BEGIN;");
    for (const column of ["session_id TEXT", "session_cost REAL"]) {
      if (!has_column(conn, "runs", column.split(" ")[0])) batch(`ALTER TABLE runs ADD COLUMN ${column};`);
    }
    recount_run_costs(conn);
    batch("PRAGMA user_version=73; COMMIT;");
  }
  if (version < 74) {
    // How a task's pull request's checks stood at the latest read (see Task.pr_checks).
    const add = has_column(conn, "tasks", "pr_checks") ? "" : "ALTER TABLE tasks ADD COLUMN pr_checks TEXT;";
    batch(`BEGIN; ${add} PRAGMA user_version=74; COMMIT;`);
  }
  if (version < 75) {
    // Whether a task needs an approving review on its pull request to go to "Ready for merge".
    batch("BEGIN;");
    for (const [table, kind] of [["profiles", "INTEGER NOT NULL DEFAULT 0"], ["projects", "INTEGER"]]) {
      if (!has_column(conn, table, "require_pr_approval")) batch(`ALTER TABLE ${table} ADD COLUMN require_pr_approval ${kind};`);
    }
    batch("PRAGMA user_version=75; COMMIT;");
  }
  if (version < 76) {
    // What a task's worktree starts from, when not the project's base branch (see Task.start_from). Builds of this before
    // it was version 76 had it as version 65, 71, 73, 74 or 75, and skipped what those versions add, so their columns are
    // added here too if they aren't there (and 73's recount).
    batch("BEGIN;");
    const cols = [
      ["tasks", "start_from", "TEXT"],
      ["tasks", "limit_reset_at", "TEXT"],
      ["profiles", "limit_wait", "INTEGER NOT NULL DEFAULT 0"],
      ["profiles", "limit_switch", "INTEGER NOT NULL DEFAULT 0"],
      ["claude_configs", "restart_window", "INTEGER NOT NULL DEFAULT 0"],
      ["tasks", "pr_checks", "TEXT"],
      ["profiles", "require_pr_approval", "INTEGER NOT NULL DEFAULT 0"],
      ["projects", "require_pr_approval", "INTEGER"],
    ];
    for (const [table, column, kind] of cols) {
      if (!has_column(conn, table, column)) batch(`ALTER TABLE ${table} ADD COLUMN ${column} ${kind};`);
    }
    if (!has_column(conn, "runs", "session_id")) {
      batch("ALTER TABLE runs ADD COLUMN session_id TEXT; ALTER TABLE runs ADD COLUMN session_cost REAL;");
      recount_run_costs(conn);
    }
    batch("PRAGMA user_version=76; COMMIT;");
  }
  if (version < 77) {
    // When a task went into "now" (see Task.now_at); the others are in "later". Added only if it isn't there, in case
    // another migration takes this version first.
    batch("BEGIN;");
    if (!has_column(conn, "tasks", "now_at")) batch("ALTER TABLE tasks ADD COLUMN now_at TEXT;");
    batch("PRAGMA user_version=77; COMMIT;");
  }
  if (version < 79) {
    // The tokens each run used, per model (see agent/tokens.rs), counted from runs' output as they end (and from older
    // runs' that are still kept), and what reviewers reported (see review/stats.rs), with the reviews threads already
    // show. Added only if they aren't there, in case another migration takes this version first. Builds of this before
    // it was version 79 had it as version 74, 75, 76 or 78, and skipped what the versions below theirs add (a database
    // can have taken it as 75, then 76, then 78, skipping them all), or added less than this does: 74's, 75's and 76's
    // columns are added here if they aren't there, as are the runs' usage columns, and a `review_stats` from before its
    // rounds were kept is made again.
    batch("BEGIN;");
    const cols = [
      ["tasks", "pr_checks", "TEXT"],
      ["profiles", "require_pr_approval", "INTEGER NOT NULL DEFAULT 0"],
      ["projects", "require_pr_approval", "INTEGER"],
      ["tasks", "start_from", "TEXT"],
    ];
    for (const [table, column, kind] of cols) {
      if (!has_column(conn, table, column)) batch(`ALTER TABLE ${table} ADD COLUMN ${column} ${kind};`);
    }
    const stale = !!value(
      conn,
      "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='review_stats') AND NOT EXISTS(SELECT 1 FROM pragma_table_info('review_stats') WHERE name='round')",
    );
    if (stale) batch("DROP TABLE review_stats;");
    batch(SCHEMA_V79);
    for (const column of ["usage_at TEXT", "usage_session TEXT", "usage_snapshot TEXT", "usage_tail TEXT"]) {
      if (!has_column(conn, "runs", column.split(" ")[0])) batch(`ALTER TABLE runs ADD COLUMN ${column};`);
    }
    stats.backfill(conn);
    batch("PRAGMA user_version=79; COMMIT;");
  }
  if (version < 80) {
    // The tokens of model calls that aren't runs: task titles and 5-hour window restarts (see agent/tokens/calls.rs).
    batch(`BEGIN; ${SCHEMA_V80} PRAGMA user_version=80; COMMIT;`);
  }
  if (version < 81) {
    // Which call each `call_usage` row is from (a call has a row for each model it used). The rows written before were
    // one call's if they agree on all but the model.
    const add = has_column(conn, "call_usage", "call_id") ? "" : "ALTER TABLE call_usage ADD COLUMN call_id TEXT;";
    batch(
      `BEGIN; ${add}
             UPDATE call_usage SET call_id=lower(hex(randomblob(16))) WHERE call_id IS NULL AND id IN (SELECT MIN(id) FROM call_usage WHERE call_id IS NULL GROUP BY at, purpose, task_id, config_id);
             UPDATE call_usage SET call_id=(SELECT c.call_id FROM call_usage c WHERE c.id=(SELECT MIN(d.id) FROM call_usage d WHERE d.at=call_usage.at
               AND d.purpose=call_usage.purpose AND d.task_id IS call_usage.task_id AND d.config_id IS call_usage.config_id)) WHERE call_id IS NULL;
             PRAGMA user_version=81; COMMIT;`,
    );
  }
  if (version < 82) {
    // The effort the reviewed task's agent worked at when its review was submitted (see review/stats.rs). The rows from
    // before are given the task's effort now, which is what it was unless the user changed it since. Added only if it
    // isn't there: a `review_stats` made at version 79 or later by this build has it already.
    batch("BEGIN;");
    if (!has_column(conn, "review_stats", "effort")) {
      batch("ALTER TABLE review_stats ADD COLUMN effort TEXT;");
      stats.backfill_efforts(conn);
    }
    batch("PRAGMA user_version=82; COMMIT;");
  }
  if (version < 83) {
    // The effort each run was started with, as its agent was given it (see runner/launch.rs): an empty one is the agent's
    // own default, and null a run from before this, whose reviews' efforts are their tasks' (see review/stats.rs).
    batch("BEGIN;");
    if (!has_column(conn, "runs", "effort")) batch("ALTER TABLE runs ADD COLUMN effort TEXT;");
    batch("PRAGMA user_version=83; COMMIT;");
  }
  if (version < 84) {
    // Several summarizers for a project or profile (see Project.summarizers). The `summarizer` saved before is read as the
    // only one until they're saved again. Added only if they aren't there, in case another migration takes this version
    // first.
    batch("BEGIN;");
    for (const table of ["projects", "profiles"]) {
      if (!has_column(conn, table, "summarizers")) batch(`ALTER TABLE ${table} ADD COLUMN summarizers TEXT;`);
    }
    batch("PRAGMA user_version=84; COMMIT;");
  }
  if (version < 85) {
    // Git repositories that global skills come from (see agent/agent_tools/sources.rs). A guard for a database that got
    // `agent_skills.source_id` and then lost its version.
    const add = has_column(conn, "agent_skills", "source_id") ? "" : SCHEMA_V85_COLUMNS;
    batch(`BEGIN; ${SCHEMA_V85} ${add} PRAGMA user_version=85; COMMIT;`);
  }
  if (version < 86) {
    // The board skills a review or summary thread was given on top of its project's (see review::start).
    batch(`BEGIN; ${SCHEMA_V86} PRAGMA user_version=86; COMMIT;`);
  }
  if (version < 87) {
    // An Anthropic-compatible proxy a Claude config's agents go through, such as CLIProxyAPI, with the key they use and
    // the key its accounts' usage is read with (see ClaudeConfig.api_url). Added only if they aren't there, in case
    // another migration takes this version first.
    batch("BEGIN;");
    for (const col of ["api_url", "api_key", "management_key"]) {
      if (!has_column(conn, "claude_configs", col)) batch(`ALTER TABLE claude_configs ADD COLUMN ${col} TEXT;`);
    }
    batch("PRAGMA user_version=87; COMMIT;");
  }
  if (version < 88) {
    // Projects' workflows and their runs on tasks (see integrations/workflows.ts).
    batch(`BEGIN; ${SCHEMA_V88} PRAGMA user_version=88; COMMIT;`);
  }
  if (version < 89) {
    // Tasks' threads as items, requests and a short log of numbered events (see threads/store.ts and docs/threads.md).
    // Nothing writes them yet.
    batch(`BEGIN; ${SCHEMA_V89} PRAGMA user_version=89; COMMIT;`);
  }
  if (version < 90) {
    // Each profile's assistant (see is_assistant): one at most, keyed A-<n>, so a project with the key A moves to a free
    // one.
    batch("BEGIN;");
    free_task_key(conn, ASSISTANT_TASK_KEY, "AP");
    batch("CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_assistant ON tasks(profile_id) WHERE task_type='assistant'; PRAGMA user_version=90; COMMIT;");
  }
  if (version < 91) {
    // Routines: automations that belong to a profile rather than a project (see integrations/automations.ts). SQLite
    // can't drop NOT NULL, so the table is rebuilt, with foreign keys off so dropping the old one doesn't take the runs
    // with it; ids, runs and every column are kept, and each automation's profile is its project's. Also how a
    // routine's run ended and what it cost, and the routines' runs whose messages are in the one queued on a thread
    // (see db.Queued). Each part only if it isn't there, in case another migration takes this version first.
    const rebuild = has_column(conn, "automations", "profile_id") ? "" : SCHEMA_V91;
    let add = "";
    for (const col of ["outcome TEXT", "cost_usd REAL", "agent_run_id TEXT"]) {
      if (!has_column(conn, "automation_runs", col.split(" ")[0])) add += `ALTER TABLE automation_runs ADD COLUMN ${col};`;
    }
    for (const col of ["queued_routine_runs TEXT", "queued_routine INTEGER NOT NULL DEFAULT 0"]) {
      if (!has_column(conn, "tasks", col.split(" ")[0])) add += `ALTER TABLE tasks ADD COLUMN ${col};`;
    }
    batch(
      `PRAGMA foreign_keys=OFF; BEGIN; ${rebuild} ${add}
             CREATE INDEX IF NOT EXISTS automation_runs_task ON automation_runs(task_id);
             CREATE INDEX IF NOT EXISTS automation_runs_agent_run ON automation_runs(agent_run_id);
             PRAGMA user_version=91; COMMIT; PRAGMA foreign_keys=ON;`,
    );
  }
  if (version < 92) {
    // The folder each run's agent was started with (CLAUDE_CONFIG_DIR or CODEX_HOME, '' for the agent's default), so a
    // thread goes on in the folder its conversation is in after its config's folder changes (see db.task_config_dir).
    // Only if it isn't there, in case another migration takes this version first.
    const add = has_column(conn, "runs", "config_dir") ? "" : "ALTER TABLE runs ADD COLUMN config_dir TEXT;";
    batch(`BEGIN; ${add} PRAGMA user_version=92; COMMIT;`);
  }
  return conn;
}

/** The folder a database file is in, as Rust's `path.parent().unwrap_or("")` (`""` for a bare file name). */
function parent_dir(path: string): string {
  const d = dirname(path);
  return d === "." && !path.startsWith("./") ? "" : d;
}

/** The latest database version (`PRAGMA user_version`). */
export const VERSION = 92;

/**
 * Until version 73 a run's `cost_usd` was its session's total as Claude Code last said it, and the task was charged what
 * that went up by in the run, from nothing: so a run that resumed a session charged the task for all of the session's
 * earlier runs again (see add_cost). Each run's cost becomes what the session's total went up by in it, and its task's
 * cost and its first turn's (in `context_stats`) lose what they were charged twice.
 *
 * Runs don't say which session they were in, but a thread's session is only replaced by a review round or a summary (a
 * review run, see review.rs) or a rewind that starts a new conversation (its event says so, see
 * checkpoints::handlers): any other run resumes the session its thread's previous run was in. Checkpoints say the
 * session of the runs they were taken in, which starts a new one where it changes; and a total lower than the session's
 * last means Claude Code started counting again. A run with no total (it ended before its first result) is left out.
 * The runs of the thread's current session are put in it, so the next one's goes on from them.
 */
function recount_run_costs(c: Conn): void {
  interface R {
    id: string;
    task_id: string;
    kind: string;
    cost: number;
    created_at: string;
    session: string | null;
  }
  const runs: R[] = all(
    c,
    `SELECT r.id, r.task_id, r.kind, r.cost_usd AS cost, r.created_at,
           (SELECT k.session FROM checkpoints k WHERE k.task_id=r.task_id AND k.run_id=r.id AND k.session IS NOT NULL ORDER BY k.n DESC LIMIT 1) AS session
         FROM runs r ORDER BY r.task_id, r.rowid`,
  );
  const rewinds = c.prepare(
    `SELECT created_at FROM messages WHERE task_id=?1 AND kind='event'
           AND json_extract(data, '$.text') LIKE 'Rewound to before turn %the next message starts a new conversation%'`,
  );
  // Rust's `chunk_by`: the runs of each task, in a row.
  const chunks: R[][] = [];
  for (const r of runs) {
    const last = chunks[chunks.length - 1];
    if (last && last[0].task_id === r.task_id) last.push(r);
    else chunks.push([r]);
  }
  for (const task of chunks) {
    const task_id = task[0].task_id;
    const session: string | null = value<string | null>(c, "SELECT session_id FROM tasks WHERE id=?1", task_id) ?? null;
    const fresh: string[] = (rewinds.all(task_id) as any[]).map((r) => r.created_at);
    // The session's total before each run, where the latest session started and what it's known to be.
    let total = 0;
    let start = 0;
    let known: string | null = null;
    let twice = 0;
    for (let i = 0; i < task.length; i++) {
      const r = task[i];
      const rewound = i > 0 && fresh.some((at) => at > task[i - 1].created_at && at < r.created_at);
      const other = known != null && r.session != null && known !== r.session;
      if (r.kind === "review" || rewound || other || (r.cost > 0 && r.cost < total)) {
        total = 0;
        start = i;
        known = null;
      }
      known = r.session ?? known;
      if (r.cost <= 0) continue;
      const before = total;
      total = r.cost;
      if (before > 0) {
        twice += before;
        run(c, "UPDATE runs SET cost_usd=?1 WHERE id=?2", r.cost - before, r.id);
        run(
          c,
          "UPDATE context_stats SET cost_usd=MAX(cost_usd-?1, 0) WHERE id=(SELECT MIN(id) FROM context_stats WHERE run_id=?2 AND kind='turn') AND cost_usd >= ?1",
          before, r.id,
        );
      }
    }
    if (twice > 0) run(c, "UPDATE tasks SET cost_usd=MAX(cost_usd-?1, 0) WHERE id=?2", twice, task_id);
    // Unless the latest runs are known to have been in another session.
    if (session != null && (known == null || known === session)) {
      for (const r of task.slice(start)) {
        // Its old cost was the session's total.
        run(c, "UPDATE runs SET session_id=?1, session_cost=?2 WHERE id=?3", session, r.cost > 0 ? r.cost : null, r.id);
      }
    }
  }
}

/**
 * Scratch chats, a project's and the profile's own, become scratch tasks. They're in no project, and done (they can
 * still be opened and carried on), numbered in the order they were made. Each keeps working in the folder its
 * conversation is in: the project's scratch folder, or its profile's (under `data_dir`).
 */
function migrate_scratch_chats(c: Conn, data_dir: string): void {
  const chats = all<{ id: string; profile_id: string; scratch_path: string | null }>(
    c,
    `SELECT t.id, t.profile_id, p.scratch_path FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
         WHERE t.kind='scratch' ORDER BY t.created_at, t.id`,
  );
  for (const { id, profile_id, scratch_path } of chats) {
    const dir = scratch_path ?? path_str(join(data_dir, "profiles", profile_id, "scratch"));
    run(
      c,
      `UPDATE tasks SET kind='task', task_type='scratch', project_id=NULL, work_dir=?2, status='done', resolution='done',
               number=(SELECT COALESCE(MAX(number),0)+1 FROM tasks WHERE profile_id=?3 AND project_id IS NULL AND kind='task' AND task_type='scratch'),
               position=(SELECT COALESCE(MAX(position),0)+1 FROM tasks WHERE project_id IS NULL AND status='done' AND kind='task')
             WHERE id=?1`,
      id, dir, profile_id,
    );
  }
}

/**
 * Claude configs become their own list, which profiles (and projects, to override) pick from. Each config directory
 * profiles used becomes a config named after the first profile that had it, and the profiles pick it. Their threads
 * keep it too, so changing a profile's or project's configs later doesn't move a conversation away from the config it's
 * in. (`pub(super)` in Rust, for the tests.)
 */
export function migrate_claude_configs(conn: Conn): void {
  conn.exec(
    `BEGIN;
         CREATE TABLE claude_configs (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           config_dir TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL,
           agent TEXT NOT NULL DEFAULT 'claude',
           show_usage INTEGER NOT NULL DEFAULT 0,
           restart_window INTEGER NOT NULL DEFAULT 0,
           api_url TEXT,
           api_key TEXT,
           management_key TEXT
         );
         ALTER TABLE profiles ADD COLUMN claude_config_ids TEXT NOT NULL DEFAULT '[]';
         ALTER TABLE projects ADD COLUMN claude_config_ids TEXT;
         ALTER TABLE tasks ADD COLUMN claude_config_id TEXT;`,
  );
  try {
    const profiles = all<{ id: string; name: string; claude_config_dir: string }>(conn, "SELECT id, name, claude_config_dir FROM profiles ORDER BY created_at");
    for (const { id, name, claude_config_dir } of profiles) {
      const config = config_for_dir(conn, name, claude_config_dir);
      run(conn, "UPDATE profiles SET claude_config_ids=?1 WHERE id=?2", JSON.stringify([config]), id);
      run(conn, "UPDATE tasks SET claude_config_id=?1 WHERE profile_id=?2", config, id);
    }
    conn.exec("PRAGMA user_version=18;");
  } catch (e) {
    try {
      conn.exec("ROLLBACK;");
    } catch {}
    throw e;
  }
  conn.exec("COMMIT;");
}

const SCHEMA_V1 = `
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  claude_config_dir TEXT NOT NULL DEFAULT '',
  default_model TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  scratch_path TEXT NOT NULL,
  worktrees_root TEXT NOT NULL,
  base_branch TEXT,
  setup_script TEXT NOT NULL DEFAULT '',
  teardown_script TEXT NOT NULL DEFAULT '',
  use_worktrees INTEGER NOT NULL DEFAULT 1,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  model TEXT,
  next_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'task',
  number INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  position REAL NOT NULL DEFAULT 0,
  use_worktree INTEGER NOT NULL DEFAULT 0,
  worktree_path TEXT,
  branch TEXT,
  base_branch TEXT,
  worktree_state TEXT NOT NULL DEFAULT 'none',
  worktree_error TEXT,
  session_id TEXT,
  running INTEGER NOT NULL DEFAULT 0,
  attention_reason TEXT,
  model TEXT,
  auto_allow TEXT NOT NULL DEFAULT '[]',
  cost_usd REAL NOT NULL DEFAULT 0,
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_project ON tasks(project_id, kind);
CREATE INDEX tasks_profile ON tasks(profile_id, kind);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_task ON messages(task_id, id);
CREATE TABLE permission_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
`;

const SCHEMA_V2 = `
ALTER TABLE tasks ADD COLUMN permission_mode TEXT;
`;

/**
 * Durable runs and MCP calls (agents outlive server restarts), and the hub's links to
 * other hosts.
 */
const SCHEMA_V3 = `
CREATE TABLE links (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  url TEXT,
  token TEXT,
  last_seen TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  out_offset INTEGER NOT NULL DEFAULT 0,
  stop_requested INTEGER NOT NULL DEFAULT 0,
  attention TEXT,
  result_error TEXT,
  saw_result INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX runs_status ON runs(status);
CREATE TABLE mcp_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
ALTER TABLE permission_requests ADD COLUMN call_id TEXT;
ALTER TABLE permission_requests ADD COLUMN note TEXT;
CREATE INDEX permission_requests_call ON permission_requests(call_id);
`;

/**
 * A project's permission mode may be left to the host default (NULL). SQLite can't drop a
 * NOT NULL constraint, so the table is rebuilt. Until now 'default' was also what a project
 * started with, so it becomes NULL: with no host default set that still means Ask.
 */
const SCHEMA_V6 = `
CREATE TABLE projects_v6 (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  scratch_path TEXT NOT NULL,
  worktrees_root TEXT NOT NULL,
  base_branch TEXT,
  setup_script TEXT NOT NULL DEFAULT '',
  teardown_script TEXT NOT NULL DEFAULT '',
  use_worktrees INTEGER NOT NULL DEFAULT 1,
  permission_mode TEXT,
  model TEXT,
  next_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
INSERT INTO projects_v6 (id, profile_id, name, key, repo_path, scratch_path, worktrees_root, base_branch,
  setup_script, teardown_script, use_worktrees, permission_mode, model, next_number, created_at)
SELECT id, profile_id, name, key, repo_path, scratch_path, worktrees_root, base_branch,
  setup_script, teardown_script, use_worktrees, NULLIF(permission_mode, 'default'), model, next_number, created_at
FROM projects;
DROP TABLE projects;
ALTER TABLE projects_v6 RENAME TO projects;
`;

/**
 * The board skills (by name) a review or summary thread has on top of its project's, from its
 * reviewer's `skills` when the review started (see agent/agent_tools.rs, `for_run`).
 */
const SCHEMA_V86 = `
CREATE TABLE IF NOT EXISTS review_thread_skills (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  skills TEXT NOT NULL DEFAULT '[]'
);
`;

/**
 * Workflows, graphs of steps that act on a project's tasks, and their runs: each run keeps the graph it started with,
 * what each node did (`nodes`) and the rounds its sends have used (see integrations/workflows.ts).
 */
const SCHEMA_V88 = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  graph TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflows_project ON workflows(project_id);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  state TEXT NOT NULL,
  head TEXT,
  task_run TEXT,
  graph TEXT NOT NULL,
  nodes TEXT NOT NULL DEFAULT '{}',
  rounds TEXT NOT NULL DEFAULT '{}',
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS workflow_runs_task ON workflow_runs(task_id, workflow_id);
CREATE INDEX IF NOT EXISTS workflow_runs_state ON workflow_runs(state);
`;

/**
 * A task's thread as items (see threads/protocol.ts), kept beside its messages (see threads/store.ts):
 *
 * - `thread_items`: each item as it is now, as JSON, updated in place. `pos` orders them (an item's index is the number
 *   before it: removing items leaves gaps), and `live` marks a subagent's call whose subagent hasn't finished, which a
 *   window brings along. `meta` is what the board knows about an item that the item doesn't say (who sent a message).
 * - `thread_requests`: its permission prompts, questions and plans, open (`open`) or resolved, as JSON, in order.
 * - `thread_events`: the numbered events, as JSON, kept for a day or the last few per thread, for clients catching up.
 * - `thread_item_origins`: the messages each item came from.
 *
 * The thread's id is its task's, and its rows go with the task.
 */
const SCHEMA_V89 = `
CREATE TABLE IF NOT EXISTS thread_items (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  pos INTEGER NOT NULL,
  type TEXT NOT NULL,
  parent_id TEXT,
  turn_id TEXT,
  live INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS thread_items_pos ON thread_items(task_id, pos);
CREATE INDEX IF NOT EXISTS thread_items_live ON thread_items(task_id, pos) WHERE live=1;
CREATE TABLE IF NOT EXISTS thread_requests (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  pos INTEGER NOT NULL,
  type TEXT NOT NULL,
  tool_call_id TEXT,
  turn_id TEXT,
  open INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS thread_requests_pos ON thread_requests(task_id, pos);
CREATE TABLE IF NOT EXISTS thread_events (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);
CREATE TABLE IF NOT EXISTS thread_item_origins (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (task_id, item_id, message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS thread_item_origins_message ON thread_item_origins(task_id, message_id);
`;

/**
 * What each run used of each model (see agent/tokens.rs): `input_tokens` is what wasn't read
 * from or written to the cache, and `reasoning_tokens` is the part of `output_tokens` the model
 * thought in. `estimated` rows are guesses: a run whose output was gone has its cost and no
 * tokens. A run's `usage_at` says when it was counted, and `usage_session` and `usage_snapshot`
 * the totals its agent's session (or Codex's threads) had reached, which a later run that resumes
 * the session goes on from; `usage_tail` the part of them its requests after its last result add.
 *
 * `review_stats` has a row for each `submit_review` (see review/stats.rs), for the task reviewed,
 * with when its review round started (`round`).
 * `minor` is how many minor issues it listed, null for reviews from before they were listed;
 * `minor_noted` whether it found any or its summary mentions them. `effort` (version 82) is the effort
 * the reviewed task's agent was set to work at, null for the agent's own default.
 */
const SCHEMA_V79 = `
CREATE TABLE IF NOT EXISTS token_usage (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  runtime TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  estimated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, model)
);
CREATE TABLE IF NOT EXISTS review_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  round TEXT NOT NULL,
  run_id TEXT,
  at TEXT NOT NULL,
  verdict TEXT NOT NULL,
  serious INTEGER NOT NULL DEFAULT 0,
  minor INTEGER,
  minor_noted INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  effort TEXT
);
CREATE INDEX IF NOT EXISTS review_stats_task ON review_stats(task_id, at);
CREATE INDEX IF NOT EXISTS review_stats_time ON review_stats(at);
`;

/**
 * What each model call that isn't a run used (see agent/tokens/calls.rs), counted as
 * `token_usage` is: `purpose` `title` for a task's title, written for task `task_id`, and `window`
 * for the prompt that restarts config `config_id`'s 5-hour window. `cost_usd` is null for Codex,
 * which doesn't say. From version 81, `call_id` says which call a row is from: a call has a row
 * for each model it used, and they share it.
 */
const SCHEMA_V80 = `
CREATE TABLE IF NOT EXISTS call_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  purpose TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  config_id TEXT,
  model TEXT NOT NULL,
  runtime TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL
);
CREATE INDEX IF NOT EXISTS call_usage_time ON call_usage(at);
CREATE INDEX IF NOT EXISTS call_usage_task ON call_usage(task_id);
`;

/**
 * A row for the end of each agent turn (`kind` `turn`: `tokens` is the context it left and
 * `start_tokens` what its first request to the model held) and for
 * each compaction (`compact`: `tokens` before it and `post_tokens` after, and its `source`:
 * `auto` when the agent compacted by itself as its context filled up, `user` for a `/compact`,
 * `idle` for the board's after a session sat idle). See agent/context.rs. A run's `turn_start_tokens`
 * and `turn_tokens` follow its current turn's requests to the model, until the turn's row is written.
 */
const SCHEMA_V69 = `
CREATE TABLE IF NOT EXISTS context_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  tokens INTEGER,
  start_tokens INTEGER,
  post_tokens INTEGER,
  max_tokens INTEGER,
  model TEXT,
  source TEXT,
  cost_usd REAL,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS context_stats_time ON context_stats(at);
CREATE INDEX IF NOT EXISTS context_stats_task ON context_stats(task_id, at);
`;

/**
 * The compactions in threads from before `context_stats`, each with the run it was in (the
 * task's latest to start before it). Its source is worked out as context::compaction_source does.
 */
const BACKFILL_V69 = `
INSERT INTO context_stats (task_id, run_id, kind, at, tokens, post_tokens, source, duration_ms)
SELECT b.task_id, b.run_id, 'compact', b.at,
  json_extract(b.meta, '$.pre_tokens'), json_extract(b.meta, '$.post_tokens'),
  CASE
    WHEN json_extract(b.meta, '$.trigger') = 'auto' THEN 'auto'
    WHEN r.kind = 'compact' AND NOT EXISTS (
      SELECT 1 FROM messages u WHERE u.task_id = b.task_id AND u.kind = 'user' AND u.created_at >= r.created_at AND u.created_at <= b.at
    ) THEN 'idle'
    ELSE 'user'
  END,
  json_extract(b.meta, '$.duration_ms')
FROM (
  SELECT m.task_id, m.created_at AS at, json_extract(m.data, '$.compact_metadata') AS meta,
    (SELECT id FROM runs WHERE task_id = m.task_id AND created_at <= m.created_at ORDER BY created_at DESC LIMIT 1) AS run_id
  FROM messages m
  WHERE m.kind = 'claude' AND m.data LIKE '%"compact_boundary"%' AND json_extract(m.data, '$.subtype') = 'compact_boundary'
    AND json_extract(m.data, '$.parent_tool_use_id') IS NULL
) b LEFT JOIN runs r ON r.id = b.run_id;
`;

/**
 * Checkpoints of a task's worktree (see git/checkpoints.rs), each kept as a commit under
 * `refs/huntaway/checkpoints/<task>/<n>` in its repository.
 */
const SCHEMA_V58 = `
CREATE TABLE IF NOT EXISTS checkpoints (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  kind TEXT NOT NULL,
  sha TEXT NOT NULL,
  tree TEXT NOT NULL,
  head TEXT,
  before_n INTEGER,
  run_id TEXT,
  turn INTEGER,
  message_id INTEGER,
  status TEXT,
  session TEXT,
  agent_at TEXT,
  stats TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, n)
);
`;

/**
 * Automations, which create a task or message one on a schedule or when a webhook is
 * delivered, and their runs (including webhook deliveries that didn't run). See integrations/automations.rs.
 */
const SCHEMA_V55 = `
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger TEXT NOT NULL,
  action TEXT NOT NULL,
  token TEXT NOT NULL,
  secret TEXT,
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS automations_project ON automations(project_id);
CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  task_id TEXT,
  delivery_id TEXT,
  event TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  batch_key TEXT,
  batch_id TEXT,
  payload TEXT,
  due_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS automation_runs_automation ON automation_runs(automation_id, created_at);
CREATE INDEX IF NOT EXISTS automation_runs_status ON automation_runs(status, due_at);
CREATE INDEX IF NOT EXISTS automation_runs_delivery ON automation_runs(automation_id, delivery_id);
`;

/**
 * Skill sources: git repositories whose skills the host offers as global skills. `git_ref` is the
 * branch or tag cloned (null: the default branch), `notes` a JSON list of what a refresh skipped, and
 * `error` why the last refresh failed. A skill from one has `source_id` and its folder in the clone.
 */
const SCHEMA_V85 = `
CREATE TABLE IF NOT EXISTS skill_sources (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  git_ref TEXT,
  name TEXT NOT NULL,
  commit_sha TEXT,
  synced_at TEXT,
  error TEXT,
  notes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
`;

/**
 * Per-project skills and MCP servers (see agent/agent_tools.rs).
 */
const SCHEMA_V19 = `
CREATE TABLE project_skills (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
CREATE TABLE project_mcp_servers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_allow INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
CREATE TABLE project_agent_tools (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  disabled_skills TEXT NOT NULL DEFAULT '[]',
  disabled_mcp_servers TEXT NOT NULL DEFAULT '[]',
  seen TEXT NOT NULL DEFAULT '{}'
);
`;

/**
 * Global skills and MCP servers (no project) join the projects' own, and each profile can
 * switch a global one on by default, which its projects can override (see agent/agent_tools.rs).
 */
const SCHEMA_V20 = `
CREATE TABLE agent_skills (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX agent_skills_name ON agent_skills(ifnull(project_id, ''), name);
INSERT INTO agent_skills (id, project_id, name, content, enabled, created_at, updated_at)
  SELECT id, project_id, name, content, enabled, created_at, updated_at FROM project_skills;
DROP TABLE project_skills;
CREATE TABLE agent_mcp_servers (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_allow INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX agent_mcp_servers_name ON agent_mcp_servers(ifnull(project_id, ''), name);
INSERT INTO agent_mcp_servers (id, project_id, name, config, enabled, auto_allow, created_at, updated_at)
  SELECT id, project_id, name, config, enabled, auto_allow, created_at, updated_at FROM project_mcp_servers;
DROP TABLE project_mcp_servers;
CREATE TABLE agent_tool_switches (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (scope, scope_id, item_id)
);
CREATE TRIGGER agent_tool_switches_profile AFTER DELETE ON profiles BEGIN
  DELETE FROM agent_tool_switches WHERE scope='profile' AND scope_id=OLD.id; END;
CREATE TRIGGER agent_tool_switches_project AFTER DELETE ON projects BEGIN
  DELETE FROM agent_tool_switches WHERE scope='project' AND scope_id=OLD.id; END;
CREATE TRIGGER agent_tool_switches_skill AFTER DELETE ON agent_skills BEGIN
  DELETE FROM agent_tool_switches WHERE item_id=OLD.id; END;
CREATE TRIGGER agent_tool_switches_server AFTER DELETE ON agent_mcp_servers BEGIN
  DELETE FROM agent_tool_switches WHERE item_id=OLD.id; END;
`;

/**
 * Automations get a profile, and a project only if they're a project's (none for a profile's routine), and the
 * conditions a run is checked against first: the hours it may run in, a command to run first, and a budget a day.
 */
const SCHEMA_V91 = `
CREATE TABLE automations_v91 (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger TEXT NOT NULL,
  action TEXT NOT NULL,
  token TEXT NOT NULL,
  secret TEXT,
  next_run_at TEXT,
  last_run_at TEXT,
  active_hours TEXT,
  precheck TEXT,
  budget_usd REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO automations_v91 (id, profile_id, project_id, name, enabled, trigger, action, token, secret, next_run_at, last_run_at, created_at, updated_at)
  SELECT a.id, p.profile_id, a.project_id, a.name, a.enabled, a.trigger, a.action, a.token, a.secret, a.next_run_at, a.last_run_at, a.created_at, a.updated_at
  FROM automations a JOIN projects p ON p.id = a.project_id;
DROP TABLE automations;
ALTER TABLE automations_v91 RENAME TO automations;
CREATE INDEX IF NOT EXISTS automations_project ON automations(project_id);
CREATE INDEX IF NOT EXISTS automations_profile ON automations(profile_id);
DELETE FROM automation_runs WHERE automation_id NOT IN (SELECT id FROM automations);
`;

const SCHEMA_V85_COLUMNS = `ALTER TABLE agent_skills ADD COLUMN source_id TEXT REFERENCES skill_sources(id) ON DELETE CASCADE;
ALTER TABLE agent_skills ADD COLUMN source_path TEXT;`;
