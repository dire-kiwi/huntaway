use std::collections::BTreeMap;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::util::{new_id, now, path_str};

const SCHEMA_V1: &str = r#"
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
"#;

const SCHEMA_V2: &str = r#"
ALTER TABLE tasks ADD COLUMN permission_mode TEXT;
"#;

/// Durable runs and MCP calls (agents outlive server restarts), and the hub's links to
/// other hosts.
const SCHEMA_V3: &str = r#"
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
"#;

/// A project's permission mode may be left to the host default (NULL). SQLite can't drop a
/// NOT NULL constraint, so the table is rebuilt. Until now 'default' was also what a project
/// started with, so it becomes NULL: with no host default set that still means Ask.
const SCHEMA_V6: &str = r#"
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
"#;

pub fn open(path: &std::path::Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    // With WAL, synchronous=NORMAL syncs at checkpoints rather than on every commit, and the
    // database stays consistent. A power cut (not a crash) can lose the last few commits; runs'
    // output after the saved out_offset is read again on the next start. FULL syncs every commit
    // with the one connection locked: about 1 ms each on an NVMe disk, more on slower ones.
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V1} PRAGMA user_version=1; COMMIT;"))?;
    }
    if version < 2 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V2} PRAGMA user_version=2; COMMIT;"))?;
    }
    if version < 3 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V3} PRAGMA user_version=3; COMMIT;"))?;
    }
    if version < 4 {
        conn.execute_batch("BEGIN; CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=4; COMMIT;")?;
    }
    if version < 5 {
        // How to reach hosts linked over SSH (JSON, see ssh::Target).
        conn.execute_batch("BEGIN; ALTER TABLE links ADD COLUMN ssh TEXT; PRAGMA user_version=5; COMMIT;")?;
    }
    if version < 6 {
        // Foreign keys off so dropping the old table doesn't cascade to tasks (it can't be
        // changed inside a transaction).
        conn.execute_batch(&format!("PRAGMA foreign_keys=OFF; BEGIN; {SCHEMA_V6} PRAGMA user_version=6; COMMIT; PRAGMA foreign_keys=ON;"))?;
    }
    if version < 7 {
        // Set while a task's agent is merging it (see runner::request_merge).
        conn.execute_batch("BEGIN; ALTER TABLE tasks ADD COLUMN merging INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=7; COMMIT;")?;
    }
    if version < 8 {
        // Where the task's work can be tried (e.g. a PR preview deployment).
        conn.execute_batch("BEGIN; ALTER TABLE tasks ADD COLUMN preview_url TEXT; PRAGMA user_version=8; COMMIT;")?;
    }
    if version < 9 {
        // What a run is for: 'prompt' (a turn of the conversation) or 'compact' (`/compact`).
        conn.execute_batch("BEGIN; ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'prompt'; PRAGMA user_version=9; COMMIT;")?;
    }
    if version < 10 {
        // A message sent while the agent was running, waiting for the run to end.
        conn.execute_batch("BEGIN; ALTER TABLE tasks ADD COLUMN queued_message TEXT; PRAGMA user_version=10; COMMIT;")?;
    }
    if version < 11 {
        // Automatic reviews (see review.rs): review threads point at the task they review, the
        // task keeps the latest review's outcome, and projects can turn them off.
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
             ALTER TABLE tasks ADD COLUMN review TEXT;
             ALTER TABLE projects ADD COLUMN auto_review INTEGER NOT NULL DEFAULT 1;
             ALTER TABLE projects ADD COLUMN review_rounds INTEGER NOT NULL DEFAULT 2;
             CREATE INDEX tasks_parent ON tasks(parent_id);
             PRAGMA user_version=11; COMMIT;",
        )?;
    }
    if version < 12 {
        // A thread's own effort level; falls back to the host's default when unset.
        conn.execute_batch("BEGIN; ALTER TABLE tasks ADD COLUMN effort TEXT; PRAGMA user_version=12; COMMIT;")?;
    }
    if version < 13 {
        // When the task's agent started working, for the board's elapsed timer.
        conn.execute_batch("BEGIN; ALTER TABLE tasks ADD COLUMN run_started_at TEXT; PRAGMA user_version=13; COMMIT;")?;
    }
    if version < 14 {
        // Prompt analytics (see analytics.rs) look up user messages by time.
        conn.execute_batch("BEGIN; CREATE INDEX messages_kind_time ON messages(kind, created_at); PRAGMA user_version=14; COMMIT;")?;
    }
    if version < 15 {
        // Whether the queued message came only from other agents (see queue_message).
        conn.execute_batch("BEGIN; ALTER TABLE tasks ADD COLUMN queued_from_agent INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=15; COMMIT;")?;
    }
    if version < 16 {
        // Subprojects: a task whose own tasks (`parent_id` = the subproject) branch from, and
        // merge back into, its branch.
        conn.execute_batch("BEGIN; ALTER TABLE tasks ADD COLUMN subproject INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=16; COMMIT;")?;
    }
    if version < 17 {
        // How a done task ended (see RESOLUTIONS); tasks already done were done.
        conn.execute_batch(
            "BEGIN; ALTER TABLE tasks ADD COLUMN resolution TEXT; UPDATE tasks SET resolution='done' WHERE status='done'; PRAGMA user_version=17; COMMIT;",
        )?;
    }
    if version < 18 {
        migrate_claude_configs(&conn)?;
    }
    if version < 19 {
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V19} PRAGMA user_version=19; COMMIT;"))?;
    }
    if version < 20 {
        conn.execute_batch(&format!("PRAGMA foreign_keys=OFF; BEGIN; {SCHEMA_V20} PRAGMA user_version=20; COMMIT; PRAGMA foreign_keys=ON;"))?;
    }
    if version < 21 {
        // Which other profiles' agents may use a profile's board (see Profile::agent_access).
        conn.execute_batch("BEGIN; ALTER TABLE profiles ADD COLUMN agent_access TEXT NOT NULL DEFAULT '[]'; PRAGMA user_version=21; COMMIT;")?;
    }
    if version < 22 {
        // Task dependencies: tasks that have to be merged before a task's agent starts, and
        // whether it's waiting for them (see runner::wait_for_dependencies).
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';
             ALTER TABLE tasks ADD COLUMN waiting INTEGER NOT NULL DEFAULT 0;
             PRAGMA user_version=22; COMMIT;",
        )?;
    }
    if version < 23 {
        // Which agent CLI a config is for (see AGENTS): Claude Code or Codex. Tables created
        // by migrate_claude_configs since have it already.
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('claude_configs') WHERE name='agent'", [], |r| r.get(0))?;
        let add = if has { "" } else { "ALTER TABLE claude_configs ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude';" };
        conn.execute_batch(&format!("BEGIN; {add} PRAGMA user_version=23; COMMIT;"))?;
    }
    if version < 24 {
        // The task's pull request, set by its agent or found with `gh` (see worktree::find_pr).
        conn.execute_batch("BEGIN; ALTER TABLE tasks ADD COLUMN pr_url TEXT; PRAGMA user_version=24; COMMIT;")?;
    }
    if version < 25 {
        // A project's own instructions for the prompts the board sends when a task's agent
        // starts, when it's reviewed and when it's merged (see prompts.rs); NULL for the default.
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE projects ADD COLUMN start_prompt TEXT;
             ALTER TABLE projects ADD COLUMN review_prompt TEXT;
             ALTER TABLE projects ADD COLUMN merge_prompt TEXT;
             PRAGMA user_version=25; COMMIT;",
        )?;
    }
    if version < 26 {
        // Messages sent to a running agent that it hasn't taken in yet (see runner::steer), and
        // what a run's agent has cost so far (it reports a running total at the end of each turn).
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE tasks ADD COLUMN steering TEXT NOT NULL DEFAULT '[]';
             ALTER TABLE runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
             PRAGMA user_version=26; COMMIT;",
        )?;
    }
    if version < 27 {
        // The project's reviewers (see review.rs): a JSON list of Reviewer, NULL for one reviewer
        // with the task's own config.
        conn.execute_batch("BEGIN; ALTER TABLE projects ADD COLUMN reviewers TEXT; PRAGMA user_version=27; COMMIT;")?;
    }
    if version < 28 {
        // Whether a task's running run takes messages while it works (see runner::can_steer);
        // the id of a run's latest stop, so an earlier stop's timer leaves a later one alone;
        // and whether its agent is between turns.
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE tasks ADD COLUMN steerable INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE runs ADD COLUMN stop_id TEXT;
             ALTER TABLE runs ADD COLUMN between_turns INTEGER NOT NULL DEFAULT 0;
             PRAGMA user_version=28; COMMIT;",
        )?;
    }
    if version < 29 {
        // Projects created in a folder that wasn't a git repository yet had worktrees turned
        // off for good, even once it became one. They're the ones without a base branch; turn
        // worktrees back on, which applies once the folder is a git repository (Project::is_git).
        conn.execute_batch(
            "BEGIN;
             UPDATE projects SET use_worktrees=1 WHERE use_worktrees=0 AND (base_branch IS NULL OR base_branch='');
             PRAGMA user_version=29; COMMIT;",
        )?;
    }
    if version < 30 {
        // The sidebar group a project is in (see Project::group_name); NULL for none.
        conn.execute_batch("BEGIN; ALTER TABLE projects ADD COLUMN group_name TEXT; PRAGMA user_version=30; COMMIT;")?;
    }
    if version < 31 {
        // Group tasks (see Task::group_name) and the task whose agent created each task.
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE tasks ADD COLUMN group_name TEXT;
             ALTER TABLE tasks ADD COLUMN created_by TEXT;
             PRAGMA user_version=31; COMMIT;",
        )?;
    }
    if version < 32 {
        // Group tasks' keys are G-<n>, so a project with the key G moves to a free one.
        conn.execute_batch("BEGIN;")?;
        free_group_task_key(&conn)?;
        conn.execute_batch("PRAGMA user_version=32; COMMIT;")?;
    }
    if version < 33 {
        conn.execute_batch("BEGIN;")?;
        clear_projectless_dependencies(&conn)?;
        conn.execute_batch("PRAGMA user_version=33; COMMIT;")?;
    }
    if version < 34 {
        // An agent blocked in the `wait` tool (see Task::agent_wait).
        conn.execute_batch("BEGIN; ALTER TABLE tasks ADD COLUMN agent_wait TEXT; PRAGMA user_version=34; COMMIT;")?;
    }
    if version < 35 {
        // Runs whenever one of the project's tasks changes status (see status_script.rs).
        conn.execute_batch("BEGIN; ALTER TABLE projects ADD COLUMN status_script TEXT NOT NULL DEFAULT ''; PRAGMA user_version=35; COMMIT;")?;
    }
    if version < 36 {
        // A script per column, run when a task moves into it (see status_script.rs).
        conn.execute_batch("BEGIN; ALTER TABLE projects ADD COLUMN status_scripts TEXT NOT NULL DEFAULT '{}'; PRAGMA user_version=36; COMMIT;")?;
    }
    if version < 37 {
        // How full the agent's context window is (see context.rs).
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE tasks ADD COLUMN context TEXT;
             ALTER TABLE tasks ADD COLUMN context_detail TEXT;
             PRAGMA user_version=37; COMMIT;",
        )?;
    }
    if version < 38 {
        // Plan, artifact and diagram tasks, and the versions of the document each one makes
        // (see documents.rs).
        conn.execute_batch(
            "BEGIN;
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
             PRAGMA user_version=38; COMMIT;",
        )?;
    }
    if version < 39 {
        // 'tool' for a tool-permission prompt, 'project' for a project change an agent asked
        // the user to approve (see permissions::approve), and since API 58 'delete_task' for a
        // task an agent asked to delete.
        conn.execute_batch("BEGIN; ALTER TABLE permission_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'tool'; PRAGMA user_version=39; COMMIT;")?;
    }
    if version < 40 {
        // The keys a project had before (see Project::former_keys).
        conn.execute_batch("BEGIN; ALTER TABLE projects ADD COLUMN former_keys TEXT NOT NULL DEFAULT '[]'; PRAGMA user_version=40; COMMIT;")?;
    }
    if version < 41 {
        // What the repository folder was, to recognise it after it moves (see Project::repo_root).
        conn.execute_batch("BEGIN; ALTER TABLE projects ADD COLUMN repo_root TEXT; PRAGMA user_version=41; COMMIT;")?;
    }
    if version < 42 {
        // When a project was archived (see Project::archived_at); NULL while it isn't.
        conn.execute_batch("BEGIN; ALTER TABLE projects ADD COLUMN archived_at TEXT; PRAGMA user_version=42; COMMIT;")?;
    }
    if version < 43 {
        // Scratch chats become scratch tasks (see Task::is_scratch), keyed S-<n>, so a project
        // with the key S moves to a free one. A database from a build that had this as version 42
        // (PR previews of it) has work_dir and its scratch tasks already, but not archived_at.
        conn.execute_batch("BEGIN;")?;
        let has = |table: &str, column: &str| -> Result<bool> {
            Ok(conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name=?2", params![table, column], |r| r.get(0))?)
        };
        if !has("projects", "archived_at")? {
            conn.execute_batch("ALTER TABLE projects ADD COLUMN archived_at TEXT;")?;
        }
        if !has("tasks", "work_dir")? {
            conn.execute_batch("ALTER TABLE tasks ADD COLUMN work_dir TEXT;")?;
        }
        free_task_key(&conn, SCRATCH_TASK_KEY, "SP")?;
        migrate_scratch_chats(&conn, path.parent().unwrap_or(std::path::Path::new("")))?;
        conn.execute_batch("PRAGMA user_version=43; COMMIT;")?;
    }
    if version < 44 {
        // Starred tasks, and reminders to come back to a task (see Task::starred, Task::remind_at).
        // A database from a build that had this as version 42 (PR previews of it) has the columns
        // already.
        conn.execute_batch("BEGIN;")?;
        for (column, kind) in [("starred", "INTEGER NOT NULL DEFAULT 0"), ("remind_at", "TEXT"), ("reminder", "TEXT")] {
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('tasks') WHERE name=?1", [column], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE tasks ADD COLUMN {column} {kind};"))?;
            }
        }
        conn.execute_batch("PRAGMA user_version=44; COMMIT;")?;
    }
    if version < 45 {
        // A title renamed by hand, which then doesn't follow the user's prompts (see Task::title_pinned).
        conn.execute_batch("BEGIN; ALTER TABLE tasks ADD COLUMN title_pinned INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=45; COMMIT;")?;
    }
    if version < 46 {
        // The user's own parts of a queued message (see Task::queued_user_text). One queued before
        // is the user's unless other agents sent all of it.
        conn.execute_batch(
            "BEGIN; ALTER TABLE tasks ADD COLUMN queued_user_text TEXT;
             UPDATE tasks SET queued_user_text=queued_message WHERE NOT queued_from_agent;
             PRAGMA user_version=46; COMMIT;",
        )?;
    }
    if version < 47 {
        // The GitHub account a profile's agents use, and a project's own (see Profile::github_account).
        // A database from a PR preview of this, where it was version 42, 44 or 45, has them already,
        // at 44 it doesn't have starred tasks and reminders (version 44 here), and at 45 pinned
        // titles (version 45 here).
        conn.execute_batch("BEGIN;")?;
        let columns = [
            ("profiles", "github_account", "TEXT"),
            ("projects", "github_account", "TEXT"),
            ("tasks", "starred", "INTEGER NOT NULL DEFAULT 0"),
            ("tasks", "remind_at", "TEXT"),
            ("tasks", "reminder", "TEXT"),
            ("tasks", "title_pinned", "INTEGER NOT NULL DEFAULT 0"),
        ];
        for (table, column, kind) in columns {
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name=?2", params![table, column], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {kind};"))?;
            }
        }
        conn.execute_batch("PRAGMA user_version=47; COMMIT;")?;
    }
    if version < 48 {
        // Whether the board fetches and shows a config's subscription usage (see usage.rs); off
        // until the user turns it on, so every copy of a login (previews, test servers) doesn't.
        // Tables created by migrate_claude_configs since have it already.
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('claude_configs') WHERE name='show_usage'", [], |r| r.get(0))?;
        let add = if has { "" } else { "ALTER TABLE claude_configs ADD COLUMN show_usage INTEGER NOT NULL DEFAULT 0;" };
        conn.execute_batch(&format!("BEGIN; {add} PRAGMA user_version=48; COMMIT;"))?;
    }
    if version < 49 {
        // When a task moved into Done (see Task::done_at). Those done already get the time they
        // last changed, which is about when they were done.
        conn.execute_batch("BEGIN; ALTER TABLE tasks ADD COLUMN done_at TEXT; UPDATE tasks SET done_at=updated_at WHERE status='done'; PRAGMA user_version=49; COMMIT;")?;
    }
    if version < 50 {
        // The folder a profile's repositories are cloned into (see Profile::clone_dir). Added only
        // if it isn't there, in case another migration takes this version first.
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('profiles') WHERE name='clone_dir'", [], |r| r.get(0))?;
        let add = if has { "" } else { "ALTER TABLE profiles ADD COLUMN clone_dir TEXT;" };
        conn.execute_batch(&format!("BEGIN; {add} PRAGMA user_version=50; COMMIT;"))?;
    }
    if version < 51 {
        // Tasks' links to the tasks they're for elsewhere (see Task::external_links), and a
        // profile's Asana token and who it's for (see Profile::asana_token).
        conn.execute_batch("BEGIN;")?;
        for (table, column) in [("tasks", "external_links"), ("profiles", "asana_token"), ("profiles", "asana_user")] {
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name=?2", params![table, column], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT;"))?;
            }
        }
        conn.execute_batch("PRAGMA user_version=51; COMMIT;")?;
    }
    if version < 52 {
        // Whether a profile uses Asana (see Profile::asana_enabled), on until it's turned off.
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('profiles') WHERE name='asana_enabled'", [], |r| r.get(0))?;
        let add = if has { "" } else { "ALTER TABLE profiles ADD COLUMN asana_enabled INTEGER NOT NULL DEFAULT 1;" };
        conn.execute_batch(&format!("BEGIN; {add} PRAGMA user_version=52; COMMIT;"))?;
    }
    if version < 53 {
        // What ties the tasks made together from one prompt (see Task::fanout_id).
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('tasks') WHERE name='fanout_id'", [], |r| r.get(0))?;
        let add = if has { "" } else { "ALTER TABLE tasks ADD COLUMN fanout_id TEXT;" };
        conn.execute_batch(&format!("BEGIN; {add} PRAGMA user_version=53; COMMIT;"))?;
    }
    if version < 54 {
        // What a task's agent has been told about each pull request it waited on (see pr_watch.rs).
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS pr_watches (
               task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
               pr TEXT NOT NULL,
               state TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               PRIMARY KEY (task_id, pr)
             );
             PRAGMA user_version=54; COMMIT;",
        )?;
    }
    if version < 55 {
        // Projects' automations and their runs (see automations.rs).
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V55} PRAGMA user_version=55; COMMIT;"))?;
    }
    Ok(conn)
}

/// The latest database version (`PRAGMA user_version`).
#[cfg(test)]
pub const VERSION: i64 = 55;

/// Automations, which create a task or message one on a schedule or when a webhook is
/// delivered, and their runs (including webhook deliveries that didn't run). See automations.rs.
const SCHEMA_V55: &str = r#"
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
"#;

/// The key scratch tasks' numbers go with (see Task::is_scratch), which no project can have.
pub const SCRATCH_TASK_KEY: &str = "S";

/// Scratch chats, a project's and the profile's own, become scratch tasks. They're in no
/// project, and done (they can still be opened and carried on), numbered in the order they were
/// made. Each keeps working in the folder its conversation is in: the project's scratch folder,
/// or its profile's (under `data_dir`).
fn migrate_scratch_chats(c: &Connection, data_dir: &std::path::Path) -> Result<()> {
    let mut st = c.prepare(
        "SELECT t.id, t.profile_id, p.scratch_path FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
         WHERE t.kind='scratch' ORDER BY t.created_at, t.id",
    )?;
    let chats: Vec<(String, String, Option<String>)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
    for (id, profile_id, project_scratch) in chats {
        let dir = project_scratch.unwrap_or_else(|| path_str(&data_dir.join("profiles").join(&profile_id).join("scratch")));
        c.execute(
            "UPDATE tasks SET kind='task', task_type='scratch', project_id=NULL, work_dir=?2, status='done', resolution='done',
               number=(SELECT COALESCE(MAX(number),0)+1 FROM tasks WHERE profile_id=?3 AND project_id IS NULL AND kind='task' AND task_type='scratch'),
               position=(SELECT COALESCE(MAX(position),0)+1 FROM tasks WHERE project_id IS NULL AND status='done' AND kind='task')
             WHERE id=?1",
            params![id, dir, profile_id],
        )?;
    }
    Ok(())
}

/// Gives each project with the key G (which group tasks' keys use, see
/// runner::GROUP_TASK_KEY) the first of GP, GP2, GP3, … free in its profile.
pub fn free_group_task_key(c: &Connection) -> Result<()> {
    free_task_key(c, "G", "GP")
}

/// Gives each project with the key `key` (which tasks in no project use) the first of
/// `instead`, `instead`2, `instead`3, … free in its profile: no project has it, now or before
/// (a key a project had still names its tasks, see Project::former_keys).
pub fn free_task_key(c: &Connection, key: &str, instead: &str) -> Result<()> {
    let mut st = c.prepare("SELECT id, profile_id FROM projects WHERE UPPER(TRIM(key))=?1")?;
    let clashing: Vec<(String, String)> = st.query_map([key], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    // Databases from before version 40 have no former keys.
    let former = c.prepare("SELECT former_keys FROM projects LIMIT 0").is_ok();
    for (id, profile_id) in clashing {
        let taken = |k: &str| -> Result<bool> {
            if c.query_row("SELECT COUNT(*) FROM projects WHERE profile_id=?1 AND UPPER(key)=?2", params![profile_id, k], |r| r.get::<_, i64>(0))? > 0 {
                return Ok(true);
            }
            if !former {
                return Ok(false);
            }
            let mut st = c.prepare("SELECT former_keys FROM projects WHERE profile_id=?1 AND id!=?2")?;
            let lists: Vec<String> = st.query_map(params![profile_id, id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            Ok(lists.iter().any(|l| json_or_default::<Vec<String>>(Some(l.clone())).iter().any(|f| f.eq_ignore_ascii_case(k))))
        };
        let mut n = 1;
        let key = loop {
            let k = if n == 1 { instead.to_string() } else { format!("{instead}{n}") };
            if !taken(&k)? {
                break k;
            }
            n += 1;
        };
        c.execute("UPDATE projects SET key=?2 WHERE id=?1", params![id, key])?;
    }
    Ok(())
}

/// Dependencies are between tasks in one project, so a task without one (a group task) has
/// none; drops any it was given before that was checked, and the queue they held it in.
pub fn clear_projectless_dependencies(c: &Connection) -> Result<()> {
    c.execute("UPDATE tasks SET depends_on='[]', waiting=0 WHERE project_id IS NULL AND (depends_on!='[]' OR waiting=1)", [])?;
    Ok(())
}

/// Claude configs become their own list, which profiles (and projects, to override) pick
/// from. Each config directory profiles used becomes a config named after the first profile
/// that had it, and the profiles pick it. Their threads keep it too, so changing a profile's
/// or project's configs later doesn't move a conversation away from the config it's in.
fn migrate_claude_configs(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE claude_configs (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           config_dir TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL,
           agent TEXT NOT NULL DEFAULT 'claude',
           show_usage INTEGER NOT NULL DEFAULT 0
         );
         ALTER TABLE profiles ADD COLUMN claude_config_ids TEXT NOT NULL DEFAULT '[]';
         ALTER TABLE projects ADD COLUMN claude_config_ids TEXT;
         ALTER TABLE tasks ADD COLUMN claude_config_id TEXT;",
    )?;
    let result = (|| -> Result<()> {
        let profiles: Vec<(String, String, String)> = {
            let mut st = conn.prepare("SELECT id, name, claude_config_dir FROM profiles ORDER BY created_at")?;
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?
        };
        for (id, name, dir) in profiles {
            let config = config_for_dir(conn, &name, &dir)?;
            conn.execute("UPDATE profiles SET claude_config_ids=?1 WHERE id=?2", params![json!([config]).to_string(), id])?;
            conn.execute("UPDATE tasks SET claude_config_id=?1 WHERE profile_id=?2", params![config, id])?;
        }
        conn.execute_batch("PRAGMA user_version=18;")?;
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute_batch("COMMIT;")?,
        Err(e) => {
            conn.execute_batch("ROLLBACK;").ok();
            return Err(e);
        }
    }
    Ok(())
}

/// Per-project skills and MCP servers (see agent_tools.rs).
const SCHEMA_V19: &str = r#"
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
"#;

/// Global skills and MCP servers (no project) join the projects' own, and each profile can
/// switch a global one on by default, which its projects can override (see agent_tools.rs).
const SCHEMA_V20: &str = r#"
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
"#;

pub const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
/// A thread's own effort can also be one only Codex models have (API 25).
pub const THREAD_EFFORTS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/// Host-wide settings (agent defaults).
pub fn get_setting(c: &Connection, key: &str) -> Result<Option<String>> {
    Ok(c.query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0)).optional()?)
}

pub fn set_setting(c: &Connection, key: &str, value: Option<&str>) -> Result<()> {
    match value.filter(|v| !v.trim().is_empty()) {
        Some(v) => c.execute("INSERT INTO settings (key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2", params![key, v.trim()])?,
        None => c.execute("DELETE FROM settings WHERE key=?1", [key])?,
    };
    Ok(())
}

pub const STATUSES: &[&str] = &["todo", "in_progress", "needs_attention", "in_review", "ready_for_merge", "done", "backlog"];
/// What a task can make besides code (see Task::task_type and documents.rs), or `scratch`
/// for a scratch task (see Task::is_scratch).
pub const TASK_TYPES: &[&str] = &["plan", "artifact", "diagram", SCRATCH];
/// The task type of a scratch task.
pub const SCRATCH: &str = "scratch";
/// What a new task's type can also be, to make it a subproject (API 51). It's kept as
/// Task::subproject rather than in `task_type`, which is for tasks with no worktree.
pub const SUBPROJECT: &str = "subproject";
/// How a task in "Done" ended. Only done tasks have one (see update_task).
pub const RESOLUTIONS: &[&str] = &["done", "not_done", "wont_fix"];

/// Check a requested resolution for a task that has (or is moving to) `status`. Null asks for
/// the default.
pub fn check_resolution(status: &str, resolution: &Value) -> std::result::Result<(), String> {
    if resolution.is_null() {
        return Ok(());
    }
    if !resolution.as_str().is_some_and(|r| RESOLUTIONS.contains(&r)) {
        return Err(format!("resolution must be null or one of {RESOLUTIONS:?}"));
    }
    if status != "done" {
        return Err("resolution can only be set on a done task".into());
    }
    Ok(())
}

pub const PERMISSION_MODES: &[&str] = &["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"];

/// The agent CLIs a config can be for: Claude Code (`claude -p`) and Codex (`codex app-server`,
/// see codex.rs).
pub const AGENTS: &[&str] = &["claude", "codex"];

/// An agent's config directory (its login, settings and history): Claude Code's, passed to
/// agents as CLAUDE_CONFIG_DIR, or Codex's, passed as CODEX_HOME. Profiles and projects pick
/// which ones their threads can use, so a thread's config also decides which agent runs it.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ClaudeConfig {
    pub id: String,
    pub name: String,
    /// May start with `~`. Empty means the agent's default (`~/.claude`, `~/.codex`).
    pub config_dir: String,
    /// One of AGENTS.
    pub agent: String,
    /// Whether the board fetches and shows its plan's usage limits (see usage.rs).
    pub show_usage: bool,
    pub created_at: String,
}

impl ClaudeConfig {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            name: r.get("name")?,
            config_dir: r.get("config_dir")?,
            agent: r.get("agent")?,
            show_usage: r.get("show_usage")?,
            created_at: r.get("created_at")?,
        })
    }

    pub fn is_codex(&self) -> bool {
        self.agent == "codex"
    }

    /// The config directory, with the agent's default for an empty one. May start with `~`.
    pub fn dir(&self) -> &str {
        match self.config_dir.trim() {
            "" if self.is_codex() => "~/.codex",
            "" => "~/.claude",
            d => d,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Profile {
    pub id: String,
    pub name: String,
    /// The Claude configs its threads can use, the default first.
    pub claude_config_ids: Vec<String>,
    /// The default config's directory, for clients from before configs were separate.
    pub claude_config_dir: String,
    pub default_model: Option<String>,
    /// Names of the other profiles whose agents may read and change this profile's board
    /// through their board tools (`*` for every profile). Names, since profiles are matched by
    /// name across hosts.
    pub agent_access: Vec<String>,
    /// The GitHub account its agents' gh tools act as (see gh_mcp.rs): a login on github.com, or
    /// `HOST/LOGIN` for another GitHub host. None uses gh's active account on the host.
    #[serde(default)]
    pub github_account: Option<String>,
    /// The folder the new project dialog's GitHub tab clones repositories into, each into a
    /// folder of its own. None for `~/<name>` (see `clone_dir_or_default`). May start with `~`.
    #[serde(default)]
    pub clone_dir: Option<String>,
    /// The Asana personal access token its tasks' Asana links are looked up with (see asana.rs).
    /// Never sent to the board, which sees `asana_user` instead.
    #[serde(default, skip_serializing)]
    pub asana_token: Option<String>,
    /// Who the Asana token belongs to, as Asana named them when it was set; None when there's none.
    #[serde(default)]
    pub asana_user: Option<String>,
    /// Whether it uses Asana (API 60): off, its tasks can't be linked to Asana tasks and the
    /// board leaves Asana out. Its token is kept, for when it's turned on again.
    #[serde(default = "yes")]
    pub asana_enabled: bool,
    pub created_at: String,
}

fn yes() -> bool {
    true
}

/// Profiles with the directory of their default config.
const PROFILE_SELECT: &str = "SELECT p.*, (SELECT config_dir FROM claude_configs WHERE id=json_extract(p.claude_config_ids, '$[0]')) AS default_config_dir FROM profiles p";

impl Profile {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            name: r.get("name")?,
            claude_config_ids: json_list(r.get("claude_config_ids")?),
            claude_config_dir: r.get::<_, Option<String>>("default_config_dir")?.unwrap_or_default(),
            default_model: r.get("default_model")?,
            agent_access: json_list(r.get("agent_access")?),
            github_account: r.get("github_account")?,
            clone_dir: r.get("clone_dir")?,
            asana_token: r.get("asana_token")?,
            asana_user: r.get("asana_user")?,
            asana_enabled: r.get("asana_enabled")?,
            created_at: r.get("created_at")?,
        })
    }

    /// Whether agents in the profile named `name` may use this profile's board.
    pub fn grants(&self, name: &str) -> bool {
        self.name == name || self.agent_access.iter().any(|n| n == "*" || n == name)
    }

    /// The folder its repositories are cloned into: its own, or `~/<name>`. May start with `~`.
    pub fn clone_dir_or_default(&self) -> String {
        match self.clone_dir.as_deref().map(str::trim) {
            Some(d) if !d.is_empty() => d.to_string(),
            _ => default_clone_dir(&self.name),
        }
    }
}

/// The clone folder of a profile that hasn't picked one: `~/<name>` (`~/work`, `~/personal`).
/// The UI has the same (`defaultCloneDir`).
pub fn default_clone_dir(name: &str) -> String {
    let name = name.trim().replace('/', "-");
    if name.is_empty() || name == "." || name == ".." { "~".into() } else { format!("~/{name}") }
}

fn json_list(v: String) -> Vec<String> {
    serde_json::from_str(&v).unwrap_or_default()
}

fn json_or_default<T: serde::de::DeserializeOwned + Default>(v: Option<String>) -> T {
    v.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Project {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    pub key: String,
    /// The keys the project had before its key was changed, newest last, so its tasks' old
    /// keys (e.g. `OS-2` after `OS` became `OMS`) still name them.
    #[serde(default)]
    pub former_keys: Vec<String>,
    pub repo_path: String,
    /// What the repository folder was when last seen, to tell whether a folder it has moved to
    /// is the same repository: its root commits, `git` for one without commits, empty for a
    /// folder that isn't a git repository, or None if not looked at yet (see relocate.rs).
    #[serde(skip)]
    pub repo_root: Option<String>,
    pub scratch_path: String,
    pub worktrees_root: String,
    pub base_branch: Option<String>,
    pub setup_script: String,
    pub teardown_script: String,
    /// Runs whenever one of the project's tasks changes status (see status_script.rs).
    pub status_script: String,
    /// A script per status, run when one of the project's tasks moves into it.
    #[serde(default)]
    pub status_scripts: BTreeMap<String, String>,
    /// Whether new tasks get their own worktree. Kept while the repo isn't a git repository
    /// yet, and only applies once it is (see `is_git`).
    pub use_worktrees: bool,
    /// Whether the repo is a git repository (looked up when the project is loaded).
    #[serde(default)]
    pub is_git: bool,
    /// Falls back to the host's default mode when unset.
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    /// Overrides the profile's Claude configs when set.
    pub claude_config_ids: Option<Vec<String>>,
    /// Review each task's work when it moves to "In review" (see review.rs).
    pub auto_review: bool,
    /// How many times in a row a review's serious issues go back to the agent to fix before
    /// the task is left for the user.
    pub review_rounds: u32,
    /// Who reviews each task's work, each in a review thread of its own. Empty means one
    /// reviewer with the task's config.
    #[serde(default)]
    pub reviewers: Vec<Reviewer>,
    /// The project's instructions for the prompts sent when a task's agent starts, when its
    /// work is reviewed and when it's merged; None uses the default (see prompts.rs).
    pub start_prompt: Option<String>,
    pub review_prompt: Option<String>,
    pub merge_prompt: Option<String>,
    /// The group the project is in on the sidebar, which also has a board of all its projects'
    /// tasks. Projects on a host with the same group name are in the same group.
    pub group_name: Option<String>,
    /// When the project was archived: it's left off the board (and out of its group and of
    /// agents' project lists) until it's unarchived in the board's settings.
    #[serde(default)]
    pub archived_at: Option<String>,
    /// Overrides the profile's GitHub account when set (see Profile::github_account).
    #[serde(default)]
    pub github_account: Option<String>,
    pub created_at: String,
}

impl Project {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            profile_id: r.get("profile_id")?,
            name: r.get("name")?,
            key: r.get("key")?,
            former_keys: json_or_default(r.get("former_keys")?),
            repo_path: r.get("repo_path")?,
            repo_root: r.get("repo_root")?,
            scratch_path: r.get("scratch_path")?,
            worktrees_root: r.get("worktrees_root")?,
            base_branch: r.get("base_branch")?,
            setup_script: r.get("setup_script")?,
            teardown_script: r.get("teardown_script")?,
            status_script: r.get("status_script")?,
            status_scripts: json_or_default(r.get("status_scripts")?),
            use_worktrees: r.get("use_worktrees")?,
            is_git: crate::util::is_git_root(std::path::Path::new(&r.get::<_, String>("repo_path")?)),
            permission_mode: r.get("permission_mode")?,
            model: r.get("model")?,
            claude_config_ids: r.get::<_, Option<String>>("claude_config_ids")?.map(json_list),
            auto_review: r.get("auto_review")?,
            review_rounds: r.get("review_rounds")?,
            reviewers: r.get::<_, Option<String>>("reviewers")?.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default(),
            start_prompt: r.get("start_prompt")?,
            review_prompt: r.get("review_prompt")?,
            merge_prompt: r.get("merge_prompt")?,
            group_name: r.get("group_name")?,
            archived_at: r.get("archived_at")?,
            github_account: r.get("github_account")?,
            created_at: r.get("created_at")?,
        })
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Task {
    pub id: String,
    pub profile_id: String,
    pub project_id: Option<String>,
    /// task, or review (a review thread; `parent_id` is the task it reviews). Scratch chats
    /// were `scratch` before they became scratch tasks.
    pub kind: String,
    /// For a review thread, the task it reviews. For a task, the subproject it belongs to.
    pub parent_id: Option<String>,
    /// A subproject: a task with its own board of tasks, which branch from its branch and are
    /// merged back into it (see worktree::setup). Only top-level tasks can be subprojects.
    pub subproject: bool,
    /// A group task: one without a project that plans the work of a group's projects (those
    /// in its profile with this group name) and creates their tasks. It shows on the group's
    /// board. Kept when the group is renamed (see db::rename_group_tasks).
    #[serde(default)]
    pub group_name: Option<String>,
    /// The task whose agent created this one (with the `create_task` tool), if any.
    #[serde(default)]
    pub created_by: Option<String>,
    /// What a task makes, if not code: one of TASK_TYPES. Its agent writes a document (an HTML
    /// plan or artifact, or a Mermaid diagram) that the board keeps and shows (see documents.rs),
    /// or for a scratch task, nothing in particular (see is_scratch).
    #[serde(default)]
    pub task_type: Option<String>,
    /// Where a scratch task made from a scratch chat works: the chat's folder, where its
    /// conversation is. Other tasks with a type work in their own folder (see documents::dir).
    #[serde(default)]
    pub work_dir: Option<String>,
    /// When its document last changed, so clients know to fetch it again.
    #[serde(default)]
    pub document_at: Option<String>,
    pub number: i64,
    pub title: String,
    /// The title was renamed (with `update_task`), so it stays as it is. Otherwise each prompt
    /// the user sends re-titles the task for what it's about by then (see title::refresh).
    #[serde(default)]
    pub title_pinned: bool,
    pub description: String,
    pub status: String,
    /// How the task ended (see RESOLUTIONS), set while it's done and only then.
    #[serde(default)]
    pub resolution: Option<String>,
    /// When it moved into Done, set while it's done and only then. The board archives a task
    /// that's been done for two days: it leaves the kanban board for the list's Archived section.
    #[serde(default)]
    pub done_at: Option<String>,
    pub position: f64,
    pub use_worktree: bool,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub worktree_state: String,
    pub worktree_error: Option<String>,
    pub session_id: Option<String>,
    pub running: bool,
    /// When the agent started working, if it ever has. A queued message that carries on a run
    /// keeps the time (see runner::start).
    pub run_started_at: Option<String>,
    /// Moved to "Ready for merge" and not merged yet: the agent's work returns the task to
    /// that column, not "In progress". Not running and still in that column means it's queued
    /// behind another merge in its project (see runner::start_next_merge).
    pub merging: bool,
    pub attention_reason: Option<String>,
    /// Tasks in the same project that have to be merged (done, resolution `done`) before this
    /// task's agent starts.
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// In "In progress", queued: its agent was asked to start while some of `depends_on`
    /// weren't merged yet, and starts once they are (see runner::start_unblocked).
    #[serde(default)]
    pub waiting: bool,
    /// Its agent is waiting (in the `wait` tool) rather than working, while its run goes on
    /// and the task stays in its column. Not to be confused with `waiting` (see wait.rs).
    #[serde(default)]
    pub agent_wait: Option<AgentWait>,
    /// Sent while the agent was running; becomes the next prompt once the run ends (see
    /// runner::send).
    #[serde(default)]
    pub queued_message: Option<String>,
    /// The parts of `queued_message` the user sent (not other agents), for re-titling the task
    /// (see title::refresh).
    #[serde(default, skip_serializing)]
    pub queued_user_text: Option<String>,
    /// Sent to the running agent, which hasn't taken them in yet (see runner::steer).
    #[serde(default)]
    pub steering: Vec<Steer>,
    /// While it runs: its run takes messages while it works (see runner::can_steer), rather
    /// than queueing them for when it ends.
    #[serde(default)]
    pub steerable: bool,
    pub model: Option<String>,
    /// Overrides the host's default effort when set.
    pub effort: Option<String>,
    /// Overrides the project's permission mode when set.
    pub permission_mode: Option<String>,
    /// The Claude config it runs with, picked when it's created. Unset (or deleted since)
    /// means its project's or profile's default.
    pub claude_config_id: Option<String>,
    pub auto_allow: Vec<String>,
    /// Where the task's work can be tried, e.g. its PR's preview deployment.
    pub preview_url: Option<String>,
    /// The task's pull request.
    #[serde(default)]
    pub pr_url: Option<String>,
    /// The tasks elsewhere (in Asana) that this one is for.
    #[serde(default)]
    pub external_links: Vec<ExternalLink>,
    /// Shared by the tasks made together from one prompt, each run by another agent (a model
    /// or config), so the board can show them side by side. Unset for a task made on its own.
    #[serde(default)]
    pub fanout_id: Option<String>,
    /// Starred: listed in the sidebar's Starred section.
    #[serde(default)]
    pub starred: bool,
    /// When to remind the user of the task (UTC, RFC 3339): it's listed in the sidebar's
    /// Reminders section, and shows as due from then on until the reminder is cleared.
    #[serde(default)]
    pub remind_at: Option<String>,
    /// What the reminder is for, set with it.
    #[serde(default)]
    pub reminder: Option<String>,
    /// The latest automatic review of the task's work.
    pub review: Option<Review>,
    /// How full its agent's context window is, as of its latest reply (see context.rs).
    #[serde(default)]
    pub context: Option<Context>,
    pub cost_usd: f64,
    pub last_activity_at: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A task in another tracker that a task is for (stored on its task as JSON). Only Asana's for now.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ExternalLink {
    /// Which tracker: `asana`.
    pub provider: String,
    /// The task's id there (an Asana task's gid).
    pub id: String,
    pub url: String,
    /// Its name there, when it was linked.
    #[serde(default)]
    pub title: String,
}

pub const LINK_PROVIDERS: &[&str] = &["asana"];

/// How many external links a task can have.
pub const MAX_LINKS: usize = 20;

/// How much of a thread's context window its agent's session uses (see context.rs), stored on
/// its task as JSON.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Context {
    /// Tokens in the context window as of the agent's latest reply.
    pub tokens: u64,
    /// The model's context window, once known.
    #[serde(default)]
    pub max_tokens: Option<u64>,
    /// Where Claude Code compacts the session by itself, if it does.
    #[serde(default)]
    pub compact_at: Option<u64>,
    #[serde(default)]
    pub model: Option<String>,
    pub updated_at: String,
    /// When the breakdown of what's in it (`GET /tasks/{id}/context`) was taken, if there is one.
    #[serde(default)]
    pub detail_at: Option<String>,
}

/// What an agent in the `wait` tool is waiting for (see wait.rs), stored on its task as JSON.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AgentWait {
    /// What it's waiting on, in the agent's words.
    #[serde(default)]
    pub reason: Option<String>,
    pub since: String,
    /// When the wait ends at the latest.
    pub until: String,
    /// Tasks whose next change of status ends the wait, with the status each had.
    #[serde(default)]
    pub tasks: Vec<WaitTask>,
    /// A shell command run while waiting, whose exit ends the wait.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// The tool call that's waiting, and its run.
    pub call_id: String,
    pub run_id: String,
    /// Set as the task is moved to this column (from the board or `update_task`), which ends
    /// the wait. Recorded with the move, so the wait can tell it from the status changes the
    /// board makes itself (a subagent's permission prompt and its answer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved_to: Option<String>,
    /// The first subagent that finished during the wait, kept until the call returns (also
    /// across a server restart).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_finished: Option<Value>,
    /// A pull request whose news ends the wait (API 62, see pr_watch.rs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request: Option<WaitPr>,
}

/// The pull request a wait watches.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WaitPr {
    pub url: String,
    /// `OWNER/REPO`, or `HOST/OWNER/REPO` off github.com.
    pub repo: String,
    pub number: u64,
    /// What ends the wait (see pr_watch::EVENTS); its being merged or closed always does.
    pub events: Vec<String>,
    /// What a read found that ends the wait, kept until the call returns (also across a server
    /// restart), with what the agent has been told once it has (see pr_watch::News).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub news: Option<Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WaitTask {
    pub id: String,
    pub key: String,
    pub status: String,
}

/// A message sent to a running agent, kept until the agent takes it in (see runner::steer).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Steer {
    /// Also the stream-json message's uuid, which the agent echoes back when it takes it in.
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub from_agent: bool,
    /// The run it was sent to.
    pub run_id: String,
    /// Written to the run's input. Until then it's waiting for the run to start.
    #[serde(default)]
    pub written: bool,
}

/// One of a project's reviewers: the agent that reviews, in a review thread of its own.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Reviewer {
    /// None uses the reviewed task's config.
    #[serde(default)]
    pub claude_config_id: Option<String>,
    /// None uses the default (the project's, profile's or host's, as for any thread).
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

/// A task's latest review (see review.rs), stored on the task as JSON. With several reviewers,
/// `reviewers` has each one's part and the rest combines them.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Review {
    /// The (first) review thread: a `review` task whose parent is this task.
    pub thread_id: String,
    /// running, passed, issues, failed or stopped
    pub state: String,
    /// The commit reviewed.
    pub head: Option<String>,
    /// What the reviewer reported (or why the review failed).
    pub summary: Option<String>,
    /// Serious issues the reviewer found, which go back to the task's agent to fix.
    #[serde(default)]
    pub issues: Vec<String>,
    /// Set by `submit_review` while the review is running: pass or issues.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    /// Reviews in a row that sent issues back to the agent (capped by the project's review_rounds).
    #[serde(default)]
    pub fixes: u32,
    pub updated_at: String,
    /// Each reviewer's part (API 29). Empty in reviews from before there could be several.
    #[serde(default)]
    pub reviewers: Vec<ReviewerRun>,
}

/// One reviewer's part of a review.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ReviewerRun {
    pub thread_id: String,
    /// Which agent reviews, e.g. "Codex · gpt-5.1".
    pub label: String,
    /// running, passed, issues, failed or stopped
    pub state: String,
    pub summary: Option<String>,
    #[serde(default)]
    pub issues: Vec<String>,
    /// Set by `submit_review` while it's running: pass or issues.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    /// The thread's last run before this round (empty if it had none): the round's reviewer is
    /// a later one, so an earlier run's late verdict or end doesn't end this part. Missing on
    /// parts recorded before this was kept, which any run of the thread ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_run: Option<String>,
}

impl Task {
    /// A scratch task: in no project, its agent works in the task's own folder with no
    /// repository, for whatever the user asks of it (planning, questions, running the board).
    pub fn is_scratch(&self) -> bool {
        self.kind == "task" && self.task_type.as_deref() == Some(SCRATCH)
    }

    /// The column a task sits in while its agent works.
    pub fn working_status(&self) -> &'static str {
        if self.merging { "ready_for_merge" } else { "in_progress" }
    }

    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        let auto_allow: String = r.get("auto_allow")?;
        Ok(Self {
            id: r.get("id")?,
            profile_id: r.get("profile_id")?,
            project_id: r.get("project_id")?,
            kind: r.get("kind")?,
            parent_id: r.get("parent_id")?,
            subproject: r.get("subproject")?,
            group_name: r.get("group_name")?,
            created_by: r.get("created_by")?,
            task_type: r.get("task_type")?,
            document_at: r.get("document_at")?,
            work_dir: r.get("work_dir")?,
            number: r.get("number")?,
            title: r.get("title")?,
            title_pinned: r.get("title_pinned")?,
            description: r.get("description")?,
            status: r.get("status")?,
            resolution: r.get("resolution")?,
            done_at: r.get("done_at")?,
            position: r.get("position")?,
            use_worktree: r.get("use_worktree")?,
            worktree_path: r.get("worktree_path")?,
            branch: r.get("branch")?,
            base_branch: r.get("base_branch")?,
            worktree_state: r.get("worktree_state")?,
            worktree_error: r.get("worktree_error")?,
            session_id: r.get("session_id")?,
            running: r.get("running")?,
            run_started_at: r.get("run_started_at")?,
            merging: r.get("merging")?,
            attention_reason: r.get("attention_reason")?,
            depends_on: json_list(r.get("depends_on")?),
            waiting: r.get("waiting")?,
            agent_wait: r.get::<_, Option<String>>("agent_wait")?.and_then(|v| serde_json::from_str(&v).ok()),
            queued_message: r.get("queued_message")?,
            queued_user_text: r.get("queued_user_text")?,
            steering: json_or_default(r.get::<_, Option<String>>("steering")?),
            steerable: r.get("steerable")?,
            model: r.get("model")?,
            effort: r.get("effort")?,
            permission_mode: r.get("permission_mode")?,
            claude_config_id: r.get("claude_config_id")?,
            auto_allow: serde_json::from_str(&auto_allow).unwrap_or_default(),
            preview_url: r.get("preview_url")?,
            pr_url: r.get("pr_url")?,
            external_links: json_or_default(r.get::<_, Option<String>>("external_links")?),
            fanout_id: r.get("fanout_id")?,
            starred: r.get("starred")?,
            remind_at: r.get("remind_at")?,
            reminder: r.get("reminder")?,
            review: r.get::<_, Option<String>>("review")?.and_then(|v| serde_json::from_str(&v).ok()),
            context: r.get::<_, Option<String>>("context")?.and_then(|v| serde_json::from_str(&v).ok()),
            cost_usd: r.get("cost_usd")?,
            last_activity_at: r.get("last_activity_at")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
        })
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Message {
    pub id: i64,
    pub task_id: String,
    pub kind: String,
    pub data: Value,
    pub created_at: String,
}

impl Message {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        let data: String = r.get("data")?;
        Ok(Self {
            id: r.get("id")?,
            task_id: r.get("task_id")?,
            kind: r.get("kind")?,
            data: serde_json::from_str(&data).unwrap_or(Value::Null),
            created_at: r.get("created_at")?,
        })
    }
}

impl Task {
    /// The thread's own permission mode, else what it inherits.
    pub fn effective_permission_mode(&self, c: &Connection, project: Option<&Project>) -> Result<String> {
        match &self.permission_mode {
            Some(m) => Ok(m.clone()),
            None => inherited_permission_mode(c, project),
        }
    }
}

/// The mode a thread gets when it doesn't pick one: its project's, else the host default,
/// else `default` (Ask).
pub fn inherited_permission_mode(c: &Connection, project: Option<&Project>) -> Result<String> {
    if let Some(m) = project.and_then(|p| p.permission_mode.clone()) {
        return Ok(m);
    }
    Ok(get_setting(c, "default_permission_mode")?.unwrap_or_else(|| "default".into()))
}

// ---------- profiles ----------

pub fn list_profiles(c: &Connection) -> Result<Vec<Profile>> {
    let mut st = c.prepare(&format!("{PROFILE_SELECT} ORDER BY p.created_at"))?;
    let rows = st.query_map([], Profile::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get_profile(c: &Connection, id: &str) -> Result<Option<Profile>> {
    Ok(c.query_row(&format!("{PROFILE_SELECT} WHERE p.id=?1"), [id], Profile::from_row).optional()?)
}

pub fn insert_profile(c: &Connection, name: &str, config_ids: &[String], model: Option<&str>) -> Result<Profile> {
    let id = new_id();
    c.execute(
        "INSERT INTO profiles (id,name,claude_config_ids,default_model,created_at) VALUES (?1,?2,?3,?4,?5)",
        params![id, name, json!(config_ids).to_string(), model, now()],
    )?;
    Ok(get_profile(c, &id)?.unwrap())
}

// ---------- Claude configs ----------

pub fn list_claude_configs(c: &Connection) -> Result<Vec<ClaudeConfig>> {
    let mut st = c.prepare("SELECT * FROM claude_configs ORDER BY name COLLATE NOCASE, created_at")?;
    let rows = st.query_map([], ClaudeConfig::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get_claude_config(c: &Connection, id: &str) -> Result<Option<ClaudeConfig>> {
    Ok(c.query_row("SELECT * FROM claude_configs WHERE id=?1", [id], ClaudeConfig::from_row).optional()?)
}

pub fn insert_claude_config(c: &Connection, name: &str, config_dir: &str, agent: &str) -> Result<ClaudeConfig> {
    let id = new_id();
    c.execute(
        "INSERT INTO claude_configs (id,name,config_dir,agent,created_at) VALUES (?1,?2,?3,?4,?5)",
        params![id, name, config_dir.trim(), agent, now()],
    )?;
    Ok(get_claude_config(c, &id)?.unwrap())
}

const CLAUDE_CONFIG_COLUMNS: &[&str] = &["name", "config_dir", "agent", "show_usage"];

pub fn update_claude_config(c: &Connection, id: &str, fields: &[(&str, Value)]) -> Result<Option<ClaudeConfig>> {
    update_generic(c, "claude_configs", CLAUDE_CONFIG_COLUMNS, id, fields)?;
    get_claude_config(c, id)
}

/// Delete a config and take it off every profile and project. Threads that ran with it go
/// back to their project's or profile's default.
pub fn delete_claude_config(c: &Connection, id: &str) -> Result<()> {
    c.execute("DELETE FROM claude_configs WHERE id=?1", [id])?;
    let drop = |list: Vec<String>| json!(list.into_iter().filter(|x| x != id).collect::<Vec<_>>()).to_string();
    for p in list_profiles(c)?.into_iter().filter(|p| p.claude_config_ids.iter().any(|x| x == id)) {
        c.execute("UPDATE profiles SET claude_config_ids=?1 WHERE id=?2", params![drop(p.claude_config_ids), p.id])?;
    }
    let projects: Vec<(String, String)> = {
        let mut st = c.prepare("SELECT id, claude_config_ids FROM projects WHERE claude_config_ids IS NOT NULL")?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
    };
    for (pid, ids) in projects {
        let ids = json_list(ids);
        if ids.iter().any(|x| x == id) {
            let rest: Vec<String> = ids.into_iter().filter(|x| x != id).collect();
            // An override left empty goes back to the profile's.
            let v = (!rest.is_empty()).then(|| json!(rest).to_string());
            c.execute("UPDATE projects SET claude_config_ids=?1 WHERE id=?2", params![v, pid])?;
        }
    }
    Ok(())
}

/// The config using `dir`, creating one called `name` if there's none.
pub fn config_for_dir(c: &Connection, name: &str, dir: &str) -> Result<String> {
    let dir = dir.trim();
    let sql = "SELECT id FROM claude_configs WHERE config_dir=?1 AND agent='claude' ORDER BY created_at LIMIT 1";
    if let Some(id) = c.query_row(sql, [dir], |r| r.get(0)).optional()? {
        return Ok(id);
    }
    Ok(insert_claude_config(c, name, dir, "claude")?.id)
}

/// The configs a new thread can pick from: its project's override, else its profile's, the
/// default first.
pub fn available_configs(c: &Connection, profile_id: &str, project: Option<&Project>) -> Result<Vec<ClaudeConfig>> {
    let ids = match project.and_then(|p| p.claude_config_ids.clone()).filter(|ids| !ids.is_empty()) {
        Some(ids) => ids,
        None => get_profile(c, profile_id)?.map(|p| p.claude_config_ids).unwrap_or_default(),
    };
    let mut out = Vec::new();
    for id in ids {
        if let Some(cfg) = get_claude_config(c, &id)? {
            out.push(cfg);
        }
    }
    Ok(out)
}

/// The config a thread runs with: its own, else the default for its project and profile.
/// None means Claude's default config.
pub fn task_claude_config(c: &Connection, task: &Task) -> Result<Option<ClaudeConfig>> {
    match task.claude_config_id.as_deref() {
        Some(id) => {
            if let Some(cfg) = get_claude_config(c, id)? {
                return Ok(Some(cfg));
            }
        }
        // A thread is given a config when it starts (see runner::launch), so one that has a
        // session without one started in Claude's default config, and its conversation is there.
        None if task.session_id.is_some() => return Ok(None),
        None => {}
    }
    let project = task.project_id.as_deref().map(|id| get_project(c, id)).transpose()?.flatten();
    Ok(available_configs(c, &task.profile_id, project.as_ref())?.into_iter().next())
}

/// The CLAUDE_CONFIG_DIR (or, for Codex, CODEX_HOME) for a thread, if it isn't the agent's default.
pub fn task_config_dir(c: &Connection, task: &Task) -> Result<Option<String>> {
    Ok(task_claude_config(c, task)?.map(|cfg| cfg.config_dir).filter(|d| !d.trim().is_empty()))
}

/// Whether a thread runs on Codex rather than Claude Code (see codex.rs).
pub fn task_is_codex(c: &Connection, task: &Task) -> Result<bool> {
    Ok(task_claude_config(c, task)?.is_some_and(|cfg| cfg.is_codex()))
}

// ---------- projects ----------

pub fn list_projects(c: &Connection, profile_id: &str) -> Result<Vec<Project>> {
    let mut st = c.prepare("SELECT * FROM projects WHERE profile_id=?1 ORDER BY name COLLATE NOCASE")?;
    let rows = st.query_map([profile_id], Project::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get_project(c: &Connection, id: &str) -> Result<Option<Project>> {
    Ok(c.query_row("SELECT * FROM projects WHERE id=?1", [id], Project::from_row).optional()?)
}

pub struct NewProject<'a> {
    pub id: &'a str,
    pub profile_id: &'a str,
    pub name: &'a str,
    pub key: &'a str,
    pub repo_path: &'a str,
    pub scratch_path: &'a str,
    pub worktrees_root: &'a str,
    pub base_branch: Option<&'a str>,
    pub use_worktrees: bool,
}

pub fn insert_project(c: &Connection, p: NewProject) -> Result<Project> {
    c.execute(
        "INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,base_branch,use_worktrees,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![p.id, p.profile_id, p.name, p.key, p.repo_path, p.scratch_path, p.worktrees_root, p.base_branch, p.use_worktrees, now()],
    )?;
    Ok(get_project(c, p.id)?.unwrap())
}

// ---------- tasks ----------

pub fn get_task(c: &Connection, id: &str) -> Result<Option<Task>> {
    Ok(c.query_row("SELECT * FROM tasks WHERE id=?1", [id], Task::from_row).optional()?)
}

pub fn list_tasks_for_project(c: &Connection, project_id: &str, kind: &str) -> Result<Vec<Task>> {
    let mut st = c.prepare(
        "SELECT * FROM tasks WHERE project_id=?1 AND kind=?2 ORDER BY position, created_at",
    )?;
    let rows = st.query_map([project_id, kind], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// A profile's group tasks (see Task::group_name), including any whose group is gone.
pub fn list_group_tasks(c: &Connection, profile_id: &str) -> Result<Vec<Task>> {
    let mut st = c.prepare("SELECT * FROM tasks WHERE profile_id=?1 AND project_id IS NULL AND kind='task' ORDER BY position")?;
    let rows = st.query_map([profile_id], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// The projects of a profile's group, by name (archived ones are out of it).
pub fn group_projects(c: &Connection, profile_id: &str, group: &str) -> Result<Vec<Project>> {
    Ok(list_projects(c, profile_id)?.into_iter().filter(|p| p.group_name.as_deref() == Some(group) && p.archived_at.is_none()).collect())
}

/// Adds a group task, numbered after the profile's other group tasks (in any group), so its
/// key (`G-<n>`) names it on the profile's board.
pub fn insert_group_task(c: &Connection, mut t: NewTask, group: &str) -> Result<Task> {
    t.project_id = None;
    t.kind = "task";
    let task = insert_task(c, t)?;
    c.execute(
        "UPDATE tasks SET group_name=?2, number=(SELECT COALESCE(MAX(number),0)+1 FROM tasks
           WHERE profile_id=?3 AND project_id IS NULL AND kind='task' AND group_name IS NOT NULL) WHERE id=?1",
        params![task.id, group, task.profile_id],
    )?;
    Ok(get_task(c, &task.id)?.unwrap())
}

/// A group's tasks follow it when it's renamed: once none of the profile's projects is in the
/// group `from` any more, its tasks move to `to`. A group that's gone (`to` None) keeps them.
pub fn rename_group_tasks(c: &Connection, profile_id: &str, from: &str, to: Option<&str>) -> Result<Vec<String>> {
    let Some(to) = to else { return Ok(Vec::new()) };
    if !group_projects(c, profile_id, from)?.is_empty() {
        return Ok(Vec::new());
    }
    let mut st = c.prepare("UPDATE tasks SET group_name=?3 WHERE profile_id=?1 AND project_id IS NULL AND group_name=?2 RETURNING id")?;
    let ids = st.query_map(params![profile_id, from, to], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(ids)
}

/// A scratch task (in no project): numbered among its profile's, keyed `S-<n>`.
pub fn insert_scratch_task(c: &Connection, mut t: NewTask) -> Result<Task> {
    t.project_id = None;
    t.kind = "task";
    let task = insert_task(c, t)?;
    c.execute(
        "UPDATE tasks SET task_type=?2, number=(SELECT COALESCE(MAX(number),0)+1 FROM tasks
           WHERE profile_id=?3 AND project_id IS NULL AND kind='task' AND task_type=?2) WHERE id=?1",
        params![task.id, SCRATCH, task.profile_id],
    )?;
    Ok(get_task(c, &task.id)?.unwrap())
}

/// Scratch tasks working in `dir`, which were scratch chats there (see Task::work_dir).
pub fn tasks_in_work_dir(c: &Connection, dir: &str) -> Result<Vec<Task>> {
    let mut st = c.prepare("SELECT * FROM tasks WHERE work_dir=?1")?;
    let rows = st.query_map([dir], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// A profile's scratch task by number (its key is `S-<n>`).
pub fn scratch_task_by_number(c: &Connection, profile_id: &str, number: i64) -> Result<Option<Task>> {
    Ok(c.query_row(
        "SELECT * FROM tasks WHERE profile_id=?1 AND project_id IS NULL AND kind='task' AND task_type=?3 AND number=?2",
        params![profile_id, number, SCRATCH],
        Task::from_row,
    )
    .optional()?)
}

/// A profile's group task by number (its key is `G-<n>`).
pub fn group_task_by_number(c: &Connection, profile_id: &str, number: i64) -> Result<Option<Task>> {
    Ok(c.query_row(
        "SELECT * FROM tasks WHERE profile_id=?1 AND project_id IS NULL AND kind='task' AND group_name IS NOT NULL AND number=?2",
        params![profile_id, number],
        Task::from_row,
    )
    .optional()?)
}

/// The tasks a task's agent created.
pub fn created_tasks(c: &Connection, task_id: &str) -> Result<Vec<Task>> {
    let mut st = c.prepare("SELECT * FROM tasks WHERE created_by=?1 AND kind='task' ORDER BY created_at")?;
    let rows = st.query_map([task_id], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Scratch chats in no project. There are none since they became scratch tasks, but boards
/// from before that still ask.
pub fn list_profile_scratch(c: &Connection, profile_id: &str) -> Result<Vec<Task>> {
    let mut st = c.prepare(
        "SELECT * FROM tasks WHERE profile_id=?1 AND project_id IS NULL AND kind='scratch' ORDER BY last_activity_at DESC",
    )?;
    let rows = st.query_map([profile_id], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn list_tasks_for_profile(c: &Connection, profile_id: &str) -> Result<Vec<Task>> {
    let mut st = c.prepare(
        "SELECT * FROM tasks WHERE profile_id=?1 AND kind='task' ORDER BY project_id, position",
    )?;
    let rows = st.query_map([profile_id], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// The task holding a merge slot: merging, and either running or waiting on the user. Each
/// project has one slot for its top-level tasks and one per subproject (`parent_id`), since
/// those merge into different branches.
pub fn active_merge(c: &Connection, project_id: Option<&str>, parent_id: Option<&str>) -> Result<Option<Task>> {
    Ok(c.query_row(
        "SELECT * FROM tasks WHERE project_id IS ?1 AND parent_id IS ?2 AND kind='task' AND merging=1 AND (running=1 OR status='needs_attention')
         ORDER BY position LIMIT 1",
        params![project_id, parent_id],
        Task::from_row,
    )
    .optional()?)
}

/// Tasks waiting in "Ready for merge" for a merge slot, in column order (an archived project's
/// wait until it's unarchived).
pub fn queued_merges(c: &Connection, project_id: Option<&str>, parent_id: Option<&str>) -> Result<Vec<Task>> {
    let mut st = c.prepare(
        "SELECT * FROM tasks WHERE project_id IS ?1 AND parent_id IS ?2 AND kind='task' AND merging=1 AND running=0 AND status='ready_for_merge'
           AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))
         ORDER BY position, created_at",
    )?;
    let rows = st.query_map(params![project_id, parent_id], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// The merge slots in a project with tasks waiting for them (by subproject, None for the top level;
/// none in an archived project).
pub fn merge_lanes(c: &Connection, project_id: Option<&str>) -> Result<Vec<Option<String>>> {
    let mut st = c.prepare(
        "SELECT DISTINCT parent_id FROM tasks WHERE project_id IS ?1 AND kind='task' AND merging=1 AND running=0 AND status='ready_for_merge'
           AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))",
    )?;
    let rows = st.query_map([project_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// A task's review threads, oldest first.
pub fn review_threads(c: &Connection, task_id: &str) -> Result<Vec<Task>> {
    let mut st = c.prepare("SELECT * FROM tasks WHERE parent_id=?1 AND kind='review' ORDER BY created_at, number")?;
    let rows = st.query_map([task_id], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// A subproject's tasks, in board order.
pub fn subproject_tasks(c: &Connection, subproject_id: &str) -> Result<Vec<Task>> {
    let mut st = c.prepare("SELECT * FROM tasks WHERE parent_id=?1 AND kind='task' ORDER BY position, created_at")?;
    let rows = st.query_map([subproject_id], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Every subproject's id.
pub fn subprojects(c: &Connection) -> Result<Vec<String>> {
    let mut st = c.prepare("SELECT id FROM tasks WHERE subproject=1")?;
    let rows = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// The subproject a task belongs to, if any.
pub fn subproject_of(c: &Connection, task: &Task) -> Result<Option<Task>> {
    if task.kind != "task" {
        return Ok(None);
    }
    let Some(pid) = &task.parent_id else { return Ok(None) };
    Ok(get_task(c, pid)?.filter(|p| p.subproject))
}

/// The column a subproject's tasks (and its own agent) put it in, by priority: "Needs attention"
/// if any of them is waiting on the user, else "In progress" if any is being worked on, else
/// "In review" once they're all in review or merged (it stays there after the last one is
/// merged). Tasks still to do don't count, nor do scratch tasks, which aren't part of its work.
/// None leaves it where it is: nothing has started yet, or it's being merged or is done, which
/// is up to the user.
pub fn subproject_status(sp: &Task, tasks: &[Task]) -> Option<&'static str> {
    if !sp.subproject || sp.merging || ["ready_for_merge", "done"].contains(&sp.status.as_str()) {
        return None;
    }
    let any = |st: &str| tasks.iter().any(|t| t.status == st && !t.is_scratch());
    if sp.attention_reason.is_some() || any("needs_attention") {
        Some("needs_attention")
    } else if sp.running || any("in_progress") {
        Some("in_progress")
    } else if ["in_review", "ready_for_merge", "done"].iter().any(|st| any(st)) {
        Some("in_review")
    } else {
        None
    }
}

/// Whether a task counts as merged for the tasks that depend on it.
pub fn is_merged(t: &Task) -> bool {
    t.status == "done" && t.resolution.as_deref().is_none_or(|r| r == "done")
}

/// The tasks `task` depends on that aren't merged yet, in the order it lists them. Deleted
/// ones don't count.
pub fn unmet_dependencies(c: &Connection, task: &Task) -> Result<Vec<Task>> {
    let mut out = Vec::new();
    for id in &task.depends_on {
        if let Some(t) = get_task(c, id)?.filter(|t| !is_merged(t)) {
            out.push(t);
        }
    }
    Ok(out)
}

/// Tasks queued for their dependencies, in a project (or every project for None), but not in an
/// archived project, whose agents don't start: they keep waiting, queued message and all.
pub fn waiting_tasks(c: &Connection, project_id: Option<&str>) -> Result<Vec<Task>> {
    let mut st = c.prepare(
        "SELECT * FROM tasks WHERE waiting=1 AND kind='task' AND (?1 IS NULL OR project_id=?1)
           AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))
         ORDER BY position, created_at",
    )?;
    let rows = st.query_map([project_id], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Check the dependencies asked for a task (`task_id`, None for a new one) in `project_id`:
/// tasks (ids) in its project, not itself, and not depending on it in turn. Returns them
/// without duplicates.
pub fn check_dependencies(c: &Connection, task_id: Option<&str>, project_id: Option<&str>, ids: &[String]) -> std::result::Result<Vec<String>, String> {
    if project_id.is_none() && !ids.is_empty() {
        return Err("only tasks in a project can have dependencies".into());
    }
    let get = |id: &str| get_task(c, id).map_err(|e| format!("{e:#}"));
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if out.contains(id) {
            continue;
        }
        let dep = get(id)?.ok_or_else(|| format!("no task {id}"))?;
        if dep.kind != "task" || dep.project_id.as_deref() != project_id {
            return Err(format!("\"{}\" isn't a task in the same project", dep.title));
        }
        if Some(dep.id.as_str()) == task_id {
            return Err("a task can't depend on itself".into());
        }
        // Walk what the dependency depends on, looking for the task.
        if let Some(task_id) = task_id {
            let mut stack = vec![dep.clone()];
            let mut seen = vec![dep.id.clone()];
            while let Some(t) = stack.pop() {
                for next in &t.depends_on {
                    if next == task_id {
                        return Err(format!("\"{}\" already depends on this task", dep.title));
                    }
                    if !seen.contains(next) {
                        seen.push(next.clone());
                        stack.extend(get(next)?);
                    }
                }
            }
        }
        out.push(dep.id);
    }
    Ok(out)
}

/// Take a deleted task off every task that depended on it.
pub fn drop_dependency(c: &Connection, id: &str) -> Result<Vec<String>> {
    let mut st = c.prepare(
        "UPDATE tasks SET depends_on=(SELECT json_group_array(value) FROM json_each(tasks.depends_on) WHERE value != ?1)
         WHERE EXISTS (SELECT 1 FROM json_each(tasks.depends_on) WHERE value = ?1) RETURNING id",
    )?;
    let rows = st.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Projects with tasks waiting for their merge slot.
pub fn projects_with_queued_merges(c: &Connection) -> Result<Vec<Option<String>>> {
    let mut st = c.prepare(
        "SELECT DISTINCT project_id FROM tasks WHERE kind='task' AND merging=1 AND running=0 AND status='ready_for_merge'",
    )?;
    let rows = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub struct NewTask<'a> {
    pub profile_id: &'a str,
    pub project_id: Option<&'a str>,
    pub kind: &'a str,
    pub title: &'a str,
    pub description: &'a str,
    pub status: &'a str,
    pub use_worktree: bool,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    /// None for the default of its project and profile.
    pub claude_config_id: Option<&'a str>,
}

/// A position after every task in a column.
pub fn end_position(c: &Connection, project_id: Option<&str>, status: &str, kind: &str) -> Result<f64> {
    Ok(c.query_row(
        "SELECT COALESCE(MAX(position),0)+1 FROM tasks WHERE project_id IS ?1 AND status=?2 AND kind=?3",
        params![project_id, status, kind],
        |r| r.get(0),
    )?)
}

pub fn insert_task(c: &Connection, t: NewTask) -> Result<Task> {
    let id = new_id();
    let ts = now();
    let mut number = 0i64;
    if let (Some(pid), "task") = (t.project_id, t.kind) {
        number = c.query_row(
            "UPDATE projects SET next_number=next_number+1 WHERE id=?1 RETURNING next_number-1",
            [pid],
            |r| r.get(0),
        )?;
    }
    let position = end_position(c, t.project_id, t.status, t.kind)?;
    // Kept with the thread, so its session stays with the config it started in even if the
    // profile's or project's configs change later.
    let config = match t.claude_config_id {
        Some(id) => Some(id.to_string()),
        None => {
            let project = t.project_id.map(|id| get_project(c, id)).transpose()?.flatten();
            available_configs(c, t.profile_id, project.as_ref())?.into_iter().next().map(|cfg| cfg.id)
        }
    };
    c.execute(
        "INSERT INTO tasks (id,profile_id,project_id,kind,number,title,description,status,position,use_worktree,model,effort,claude_config_id,last_activity_at,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14,?14)",
        params![id, t.profile_id, t.project_id, t.kind, number, t.title, t.description, t.status, position, t.use_worktree, t.model, t.effort, config, ts],
    )?;
    normalize_resolution(c, &id)?;
    Ok(get_task(c, &id)?.unwrap())
}

const TASK_COLUMNS: &[&str] = &[
    "title", "title_pinned", "description", "status", "resolution", "position", "use_worktree", "worktree_path", "branch",
    "base_branch", "worktree_state", "worktree_error", "session_id", "running", "run_started_at", "merging", "attention_reason",
    "queued_message", "steering", "steerable", "depends_on", "waiting", "agent_wait", "model", "effort", "permission_mode", "claude_config_id", "auto_allow", "preview_url", "pr_url", "external_links", "fanout_id", "starred", "remind_at", "reminder", "review", "context", "context_detail", "parent_id", "subproject", "created_by", "task_type", "document_at", "work_dir", "cost_usd", "last_activity_at", "done_at",
];

/// Update whitelisted task columns from a list of (column, json value) pairs.
pub fn update_task(c: &Connection, id: &str, fields: &[(&str, Value)]) -> Result<Option<Task>> {
    if !fields.is_empty() {
        let mut sets = Vec::new();
        let mut vals: Vec<rusqlite::types::Value> = Vec::new();
        for (col, v) in fields {
            anyhow::ensure!(TASK_COLUMNS.contains(col), "unknown task column {col}");
            sets.push(format!("{col}=?{}", vals.len() + 1));
            vals.push(json_to_sql(v));
        }
        sets.push(format!("updated_at=?{}", vals.len() + 1));
        vals.push(rusqlite::types::Value::Text(now()));
        let sql = format!("UPDATE tasks SET {} WHERE id=?{}", sets.join(","), vals.len() + 1);
        vals.push(rusqlite::types::Value::Text(id.to_string()));
        c.execute(&sql, rusqlite::params_from_iter(vals))?;
        if fields.iter().any(|(col, _)| *col == "status" || *col == "resolution") {
            normalize_resolution(c, id)?;
        }
    }
    get_task(c, id)
}

/// Give a task a title written for it (see title.rs), unless it's been pinned, or its title has
/// changed from `old` (if given) since. The task as it is then, if it changed.
pub fn replace_title(c: &Connection, id: &str, old: Option<&str>, title: &str) -> Result<Option<Task>> {
    let n = c.execute(
        "UPDATE tasks SET title=?3, updated_at=?4 WHERE id=?1 AND (?2 IS NULL OR title=?2) AND NOT title_pinned",
        params![id, old, title, now()],
    )?;
    if n == 0 {
        return Ok(None);
    }
    get_task(c, id)
}

/// A done task has a resolution (`done` unless told otherwise) and the time it was done (kept
/// while it stays done); any other task has neither.
fn normalize_resolution(c: &Connection, id: &str) -> Result<()> {
    c.execute(
        "UPDATE tasks SET resolution = CASE WHEN status='done' THEN COALESCE(resolution,'done') END,
           done_at = CASE WHEN status='done' THEN COALESCE(done_at,?2) END WHERE id=?1",
        params![id, now()],
    )?;
    Ok(())
}

const PROJECT_COLUMNS: &[&str] = &[
    "name", "key", "repo_path", "scratch_path", "worktrees_root", "base_branch", "setup_script",
    "teardown_script", "status_script", "status_scripts", "use_worktrees", "permission_mode", "model", "auto_review", "review_rounds", "claude_config_ids",
    "reviewers", "start_prompt", "review_prompt", "merge_prompt", "group_name", "former_keys", "repo_root",
    "archived_at", "github_account",
];

pub fn update_project(c: &Connection, id: &str, fields: &[(&str, Value)]) -> Result<Option<Project>> {
    update_generic(c, "projects", PROJECT_COLUMNS, id, fields)?;
    get_project(c, id)
}

/// The project as `update_project` would leave it, without changing it.
pub fn preview_project_update(c: &Connection, id: &str, fields: &[(&str, Value)]) -> Result<Option<Project>> {
    // Rolled back when dropped.
    let tx = c.unchecked_transaction()?;
    update_project(&tx, id, fields)
}

const PROFILE_COLUMNS: &[&str] = &["name", "claude_config_ids", "default_model", "agent_access", "github_account", "clone_dir", "asana_token", "asana_user", "asana_enabled"];

pub fn update_profile(c: &Connection, id: &str, fields: &[(&str, Value)]) -> Result<Option<Profile>> {
    update_generic(c, "profiles", PROFILE_COLUMNS, id, fields)?;
    get_profile(c, id)
}

fn update_generic(c: &Connection, table: &str, allowed: &[&str], id: &str, fields: &[(&str, Value)]) -> Result<()> {
    if fields.is_empty() {
        return Ok(());
    }
    let mut sets = Vec::new();
    let mut vals: Vec<rusqlite::types::Value> = Vec::new();
    for (col, v) in fields {
        anyhow::ensure!(allowed.contains(col), "unknown column {col}");
        sets.push(format!("{col}=?{}", vals.len() + 1));
        vals.push(json_to_sql(v));
    }
    let sql = format!("UPDATE {table} SET {} WHERE id=?{}", sets.join(","), vals.len() + 1);
    vals.push(rusqlite::types::Value::Text(id.to_string()));
    c.execute(&sql, rusqlite::params_from_iter(vals))?;
    Ok(())
}

fn json_to_sql(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as S;
    match v {
        Value::Null => S::Null,
        Value::Bool(b) => S::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(S::Integer).unwrap_or_else(|| S::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => S::Text(s.clone()),
        other => S::Text(other.to_string()),
    }
}

// ---------- queued messages ----------

/// A message to send, or queued for an agent: the user's, other agents' (MCP `send_to_task`),
/// or both together.
#[derive(Clone, Debug, PartialEq)]
pub struct Queued {
    pub text: String,
    /// Other agents sent all of it, so analytics don't take it for the user's.
    pub from_agent: bool,
    /// The parts the user sent, if any.
    pub user_text: Option<String>,
}

impl Queued {
    pub fn new(text: &str, from_agent: bool) -> Self {
        Self { text: text.to_string(), from_agent, user_text: (!from_agent).then(|| text.to_string()) }
    }

    /// Nothing: what's queued goes as it is (see runner::send_queued).
    pub fn empty() -> Self {
        Self { text: String::new(), from_agent: true, user_text: None }
    }

    /// This message, then `next` after it.
    pub fn then(self, next: Queued) -> Self {
        let join = |a: String, b: String| match (a.trim().is_empty(), b.trim().is_empty()) {
            (true, _) => b,
            (_, true) => a,
            _ => format!("{a}\n\n{b}"),
        };
        let user_text = match (self.user_text, next.user_text) {
            (Some(a), Some(b)) => Some(join(a, b)),
            (a, b) => a.or(b),
        };
        Self { text: join(self.text, next.text), from_agent: self.from_agent && next.from_agent, user_text }
    }
}

/// Add a message to the one queued on a thread.
pub fn queue(c: &Connection, task_id: &str, message: Queued) -> Result<Option<Task>> {
    let Some(task) = get_task(c, task_id)? else { return Ok(None) };
    let queued = match task.queued_message.filter(|q| !q.trim().is_empty()) {
        Some(text) => Queued { text, from_agent: queued_from_agent(c, task_id)?, user_text: task.queued_user_text }.then(message),
        None => message,
    };
    c.execute(
        "UPDATE tasks SET queued_message=?2, queued_from_agent=?3, queued_user_text=?4, updated_at=?5 WHERE id=?1",
        params![task_id, queued.text, queued.from_agent, queued.user_text, now()],
    )?;
    get_task(c, task_id)
}

fn queued_from_agent(c: &Connection, task_id: &str) -> Result<bool> {
    Ok(c.query_row("SELECT queued_from_agent FROM tasks WHERE id=?1", [task_id], |r| r.get(0))?)
}

/// Take the message queued on a thread.
pub fn take_queued(c: &Connection, task_id: &str) -> Result<Option<Queued>> {
    let queued = get_task(c, task_id)?
        .and_then(|t| Some((t.queued_message.filter(|q| !q.trim().is_empty())?, t.queued_user_text)))
        .map(|(text, user_text)| Ok::<_, anyhow::Error>(Queued { text, from_agent: queued_from_agent(c, task_id)?, user_text }))
        .transpose()?;
    clear_queued(c, task_id)?;
    Ok(queued)
}

pub fn clear_queued(c: &Connection, task_id: &str) -> Result<Option<Task>> {
    c.execute("UPDATE tasks SET queued_message=NULL, queued_from_agent=0, queued_user_text=NULL, updated_at=?2 WHERE id=?1", params![task_id, now()])?;
    get_task(c, task_id)
}

// ---------- messages ----------

pub fn insert_message(c: &Connection, task_id: &str, kind: &str, data: &Value) -> Result<Message> {
    let ts = now();
    c.execute(
        "INSERT INTO messages (task_id,kind,data,created_at) VALUES (?1,?2,?3,?4)",
        params![task_id, kind, data.to_string(), ts],
    )?;
    let id = c.last_insert_rowid();
    c.execute("UPDATE tasks SET last_activity_at=?1 WHERE id=?2", params![ts, task_id])?;
    Ok(Message { id, task_id: task_id.to_string(), kind: kind.to_string(), data: data.clone(), created_at: ts })
}

pub fn update_message_data(c: &Connection, id: i64, data: &Value) -> Result<Option<Message>> {
    c.execute("UPDATE messages SET data=?1 WHERE id=?2", params![data.to_string(), id])?;
    Ok(c.query_row("SELECT * FROM messages WHERE id=?1", [id], Message::from_row).optional()?)
}

pub fn list_messages(c: &Connection, task_id: &str) -> Result<Vec<Message>> {
    let mut st = c.prepare("SELECT * FROM messages WHERE task_id=?1 ORDER BY id")?;
    let rows = st.query_map([task_id], Message::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// A page stops once it has this much message data, even short of its limit (some tool results are huge).
const PAGE_BYTES: usize = 1 << 20;

/// The latest messages of a thread with ids between `after` and `before` (both exclusive, if given),
/// oldest first, and whether there are older ones in that range. With a `limit`, the page holds that
/// many of the main conversation's messages (or about a megabyte of messages), with the subagents'
/// own messages among them; it starts with a main-conversation message.
pub fn message_page(c: &Connection, task_id: &str, after: Option<i64>, before: Option<i64>, limit: Option<usize>) -> Result<(Vec<Message>, bool)> {
    let mut st = c.prepare("SELECT * FROM messages WHERE task_id=?1 AND id>?2 AND id<?3 ORDER BY id DESC")?;
    let mut rows = st.query(params![task_id, after.unwrap_or(i64::MIN), before.unwrap_or(i64::MAX)])?;
    let (mut page, mut main, mut bytes) = (Vec::<Message>::new(), 0, 0);
    while let Some(r) = rows.next()? {
        // Subagents' messages carry the call that started them. Those don't count, and a page doesn't stop among them.
        let full = limit.is_some_and(|n| main >= n.max(1) || bytes >= PAGE_BYTES);
        if full && page.last().is_some_and(|m| m.data["parent_tool_use_id"].is_null()) {
            page.reverse();
            return Ok((page, true));
        }
        bytes += r.get_ref("data")?.as_str().map_or(0, str::len);
        let m = Message::from_row(r)?;
        main += m.data["parent_tool_use_id"].is_null() as usize;
        page.push(m);
    }
    page.reverse();
    Ok((page, false))
}

/// What the UI needs to list a thread's subagents from before message `before` (it shows their
/// count and state with only the latest messages loaded): the messages with their launching calls,
/// the results of those calls, and their task_* system messages (only the latest progress of each).
/// They're cut down to the parts about subagents, with their prompts and reports clipped: the
/// thread loads back to a subagent to show it in full.
pub fn subagent_messages(c: &Connection, task_id: &str, before: i64) -> Result<Vec<Message>> {
    // Forked Skills have no Agent/Task call: their local_agent lifecycle identifies the call.
    // Look beyond `before` too, as a page can start between the launch and task_started.
    let mut starts = c.prepare(
        "SELECT json_extract(data, '$.tool_use_id') FROM messages WHERE task_id=?1 AND kind='claude'
         AND data LIKE '%\"task_started\"%' AND json_extract(data, '$.type')='system'
         AND json_extract(data, '$.subtype')='task_started' AND json_extract(data, '$.task_type')='local_agent'
         AND json_type(data, '$.tool_use_id')='text'",
    )?;
    let mut calls = starts.query_map([task_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<std::collections::HashSet<_>>>()?;
    let mut st = c.prepare("SELECT * FROM messages WHERE task_id=?1 AND id<?2 AND kind='claude' ORDER BY id")?;
    let mut rows = st.query(params![task_id, before])?;
    // The ids Claude's task_* messages give subagents, besides the calls.
    let mut task_ids = std::collections::HashSet::<String>::new();
    let mut progress = std::collections::HashMap::<String, usize>::new();
    let mut out: Vec<Option<Message>> = Vec::new();
    let clip = |v: &mut Value| {
        if let Some(s) = v.as_str().filter(|s| s.chars().count() > 200) {
            *v = Value::String(s.chars().take(200).collect());
        }
    };
    while let Some(r) = rows.next()? {
        let data = r.get_ref("data")?.as_str()?;
        let call = data.contains("\"tool_use\"") && (data.contains("\"name\":\"Agent\"") || data.contains("\"name\":\"Task\"") || calls.iter().any(|id| data.contains(id.as_str())));
        let result = !calls.is_empty() && data.contains("\"tool_result\"") && calls.iter().any(|id| data.contains(id.as_str()));
        let system = data.contains("\"subtype\":\"task_");
        if !call && !result && !system {
            continue;
        }
        let mut m = Message::from_row(r)?;
        let d = &mut m.data;
        match d["type"].as_str() {
            Some("assistant") if call => {
                let mut blocks: Vec<Value> = d["message"]["content"].as_array().into_iter().flatten().filter(|b| {
                    b["type"] == "tool_use" && (b["name"] == "Agent" || b["name"] == "Task" || b["id"].as_str().is_some_and(|id| calls.contains(id)))
                }).cloned().collect();
                if blocks.is_empty() {
                    continue;
                }
                blocks.iter_mut().filter_map(|b| b.pointer_mut("/input/prompt")).for_each(clip);
                calls.extend(blocks.iter().filter_map(|b| b["id"].as_str().map(String::from)));
                d["message"] = json!({"content": blocks});
            }
            Some("user") if result => {
                let blocks: Vec<Value> = d["message"]["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|b| b["type"] == "tool_result" && b["tool_use_id"].as_str().is_some_and(|id| calls.contains(id)))
                    .map(|b| {
                        // The start of the report is enough to tell a background subagent's launch.
                        let text = match &b["content"] {
                            Value::String(s) => s.clone(),
                            Value::Array(a) => a.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n"),
                            _ => String::new(),
                        };
                        let mut text = Value::String(text);
                        clip(&mut text);
                        json!({"type": "tool_result", "tool_use_id": b["tool_use_id"], "is_error": b["is_error"], "content": text})
                    })
                    .collect();
                if blocks.is_empty() {
                    continue;
                }
                let meta = &d["tool_use_result"];
                let keep = ["resolvedModel", "agentType", "totalToolUseCount", "isAsync", "status"];
                let meta: serde_json::Map<String, Value> = keep.iter().filter(|k| !meta[**k].is_null()).map(|k| (k.to_string(), meta[*k].clone())).collect();
                *d = json!({"type": "user", "parent_tool_use_id": d["parent_tool_use_id"], "message": {"content": blocks}, "tool_use_result": meta});
            }
            Some("system") if system => {
                let task = d["task_id"].as_str().map(String::from);
                match d["tool_use_id"].as_str() {
                    Some(id) if calls.contains(id) => task_ids.extend(task.clone()),
                    None if task.as_ref().is_some_and(|t| task_ids.contains(t)) => {}
                    _ => continue,
                }
                d.get_mut("prompt").into_iter().for_each(clip);
                d.get_mut("summary").into_iter().for_each(clip);
                if d["subtype"] == "task_progress" {
                    let key = d["tool_use_id"].as_str().map(String::from).or(task).unwrap_or_default();
                    if let Some(i) = progress.insert(key, out.len()) {
                        out[i] = None;
                    }
                }
            }
            _ => continue,
        }
        out.push(Some(m));
    }
    Ok(out.into_iter().flatten().collect())
}

/// The tool calls (`tool_use` blocks) an agent made in a thread, each with its result
/// (`tool_result` block) if it has one, after `since` (a timestamp) if given, oldest first.
pub fn tool_calls_since(c: &Connection, task_id: &str, since: Option<&str>) -> Result<Vec<(Value, Option<Value>)>> {
    let mut st =
        c.prepare("SELECT data FROM messages WHERE task_id=?1 AND kind='claude' AND created_at>?2 AND data LIKE '%tool\\_use%' ESCAPE '\\' ORDER BY id")?;
    let mut rows = st.query(params![task_id, since.unwrap_or("")])?;
    let mut calls = Vec::new();
    let mut results = std::collections::HashMap::new();
    while let Some(r) = rows.next()? {
        let data: String = r.get(0)?;
        let v: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        let Some(blocks) = v["message"]["content"].as_array() else { continue };
        for b in blocks {
            match (v["type"].as_str(), b["type"].as_str()) {
                (Some("assistant"), Some("tool_use")) => calls.push(b.clone()),
                (Some("user"), Some("tool_result")) => {
                    if let Some(id) = b["tool_use_id"].as_str() {
                        results.insert(id.to_string(), b.clone());
                    }
                }
                _ => {}
            }
        }
    }
    Ok(calls
        .into_iter()
        .map(|call| {
            let result = call["id"].as_str().and_then(|id| results.remove(id));
            (call, result)
        })
        .collect())
}

/// The most recent assistant text in a thread (used for summaries in MCP tools).
pub fn last_assistant_text(c: &Connection, task_id: &str) -> Result<Option<String>> {
    let mut st = c.prepare("SELECT data FROM messages WHERE task_id=?1 AND kind='claude' ORDER BY id DESC LIMIT 50")?;
    let mut rows = st.query([task_id])?;
    while let Some(r) = rows.next()? {
        let data: String = r.get(0)?;
        let v: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        if v["type"] == "result" {
            if let Some(s) = v["result"].as_str() {
                if !s.is_empty() {
                    return Ok(Some(s.to_string()));
                }
            }
        }
        if v["type"] == "assistant" {
            if let Some(blocks) = v["message"]["content"].as_array() {
                let text: Vec<&str> = blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
                if !text.is_empty() {
                    return Ok(Some(text.join("\n")));
                }
            }
        }
    }
    Ok(None)
}

/// What the user said in a thread themselves (not the board's messages, nor other agents'): see `user_replies`.
#[derive(Debug, PartialEq, Default)]
pub struct UserReplies {
    /// Oldest first, each with what the agent said last before it (the question it answers, say), if anything.
    pub replies: Vec<(Option<String>, String)>,
    /// What the agent has said since the last of them, if anything.
    pub since: Option<String>,
    /// How many earlier ones a `limit` left out.
    pub earlier: usize,
}

/// The user's own messages in a thread (`UserReplies`), the latest `limit` of them if given.
/// Read newest first, so a long thread is only read back as far as those, and the agent's
/// messages are only parsed while looking for what it said before one (tool results can be big).
pub fn user_replies(c: &Connection, task_id: &str, limit: Option<usize>) -> Result<UserReplies> {
    let mut st = c.prepare("SELECT id, kind, data FROM messages WHERE task_id=?1 AND kind IN ('claude','user') ORDER BY id DESC")?;
    let mut rows = st.query([task_id])?;
    let mut out = UserReplies::default();
    // Nothing from the user yet (going back), so what the agent says is what it said `since`.
    let mut latest = true;
    // The reply found last (id and text), until what the agent said before it is.
    let mut pending: Option<(i64, String)> = None;
    // The id of a reply past the limit: it and those before it are left out.
    let mut cut = None;
    while let Some(r) = rows.next()? {
        let (id, kind) = (r.get::<_, i64>(0)?, r.get_ref(1)?.as_str()?);
        if kind == "user" {
            let Some(text) = reply_text(r.get_ref(2)?.as_str()?) else { continue };
            latest = false;
            // Nothing from the agent between the two.
            out.replies.extend(pending.take().map(|(_, p)| (None, p)));
            if limit.is_some_and(|n| out.replies.len() >= n) {
                cut = Some(id + 1);
                break;
            }
            pending = Some((id, text));
        } else if latest || pending.is_some() {
            let Some(text) = agent_text(r.get_ref(2)?.as_str()?) else { continue };
            if latest {
                out.since = Some(text);
                latest = false;
            } else if let Some((id, p)) = pending.take() {
                out.replies.push((Some(text), p));
                if limit.is_some_and(|n| out.replies.len() >= n) {
                    cut = Some(id);
                    break;
                }
            }
        }
    }
    out.replies.extend(pending.map(|(_, p)| (None, p)));
    out.replies.reverse();
    if let Some(before) = cut {
        drop(rows);
        let mut st = c.prepare("SELECT data FROM messages WHERE task_id=?1 AND kind='user' AND id<?2")?;
        let mut rows = st.query(params![task_id, before])?;
        while let Some(r) = rows.next()? {
            out.earlier += reply_text(r.get_ref(0)?.as_str()?).is_some() as usize;
        }
    }
    Ok(out)
}

/// A user message's text, if the user wrote it themselves.
fn reply_text(data: &str) -> Option<String> {
    let v: Value = serde_json::from_str(data).ok()?;
    // A message sent with other agents' (queued together) has the user's part apart.
    let text = v["user_text"].as_str().or(v["text"].as_str()).map(str::trim).unwrap_or("");
    (v["auto"] != true && v["from_agent"] != true && !text.is_empty()).then(|| text.to_string())
}

/// The text of one of the agent's messages, if it has any.
fn agent_text(data: &str) -> Option<String> {
    // Most of a thread is tool calls and their results, which needn't be parsed.
    if !data.contains("\"assistant\"") || !data.contains("\"text\"") {
        return None;
    }
    let v: Value = serde_json::from_str(data).ok()?;
    if v["type"] != "assistant" {
        return None;
    }
    let blocks = v["message"]["content"].as_array()?;
    let text: Vec<&str> = blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect();
    (!text.is_empty()).then(|| text.join("\n"))
}

// ---------- links (hub) ----------

/// Another host this node shows on its board. `outbound`: we connect to its URL with its
/// token. `inbound`: it dials us (we only remember it). `ssh`: we start it and tunnel to it
/// over SSH.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Link {
    pub id: String,
    pub name: String,
    pub mode: String,
    pub url: Option<String>,
    #[serde(skip_serializing)]
    pub token: Option<String>,
    /// For `ssh` links: the target, as JSON.
    pub ssh: Option<String>,
    pub last_seen: Option<String>,
    pub created_at: String,
}

impl Link {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            name: r.get("name")?,
            mode: r.get("mode")?,
            url: r.get("url")?,
            token: r.get("token")?,
            ssh: r.get("ssh")?,
            last_seen: r.get("last_seen")?,
            created_at: r.get("created_at")?,
        })
    }
}

pub fn list_links(c: &Connection) -> Result<Vec<Link>> {
    let mut st = c.prepare("SELECT * FROM links ORDER BY name COLLATE NOCASE")?;
    let rows = st.query_map([], Link::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get_link(c: &Connection, id: &str) -> Result<Option<Link>> {
    Ok(c.query_row("SELECT * FROM links WHERE id=?1", [id], Link::from_row).optional()?)
}

pub fn upsert_link(c: &Connection, id: &str, name: &str, mode: &str, url: Option<&str>, token: Option<&str>) -> Result<Link> {
    c.execute(
        "INSERT INTO links (id,name,mode,url,token,last_seen,created_at) VALUES (?1,?2,?3,?4,?5,?6,?6)
         ON CONFLICT(id) DO UPDATE SET name=?2, mode=?3, url=COALESCE(?4,url), token=COALESCE(?5,token), last_seen=?6",
        params![id, name, mode, url, token, now()],
    )?;
    Ok(get_link(c, id)?.unwrap())
}

// ---------- runs ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Run {
    pub id: String,
    pub task_id: String,
    /// prompt, or compact (summarising the conversation, see runner::compact)
    pub kind: String,
    /// preparing (worktree setup etc.), running, exited
    pub status: String,
    pub out_offset: i64,
    pub stop_requested: bool,
    pub attention: Option<String>,
    pub result_error: Option<String>,
    pub saw_result: bool,
    /// What the agent has cost so far, as it last reported.
    pub cost_usd: f64,
    pub created_at: String,
    pub ended_at: Option<String>,
}

impl Run {
    fn from_row(r: &Row) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get("id")?,
            task_id: r.get("task_id")?,
            kind: r.get("kind")?,
            status: r.get("status")?,
            out_offset: r.get("out_offset")?,
            stop_requested: r.get("stop_requested")?,
            attention: r.get("attention")?,
            result_error: r.get("result_error")?,
            saw_result: r.get("saw_result")?,
            cost_usd: r.get("cost_usd")?,
            created_at: r.get("created_at")?,
            ended_at: r.get("ended_at")?,
        })
    }
}

pub fn insert_run(c: &Connection, task_id: &str, kind: &str) -> Result<Run> {
    let id = new_id();
    c.execute(
        "INSERT INTO runs (id,task_id,kind,status,created_at) VALUES (?1,?2,?3,'preparing',?4)",
        params![id, task_id, kind, now()],
    )?;
    Ok(get_run(c, &id)?.unwrap())
}

pub fn get_run(c: &Connection, id: &str) -> Result<Option<Run>> {
    Ok(c.query_row("SELECT * FROM runs WHERE id=?1", [id], Run::from_row).optional()?)
}

/// The task's latest run (of `kind`, if given).
pub fn latest_run(c: &Connection, task_id: &str, kind: Option<&str>) -> Result<Option<String>> {
    Ok(c.query_row("SELECT id FROM runs WHERE task_id=?1 AND (?2 IS NULL OR kind=?2) ORDER BY rowid DESC LIMIT 1", rusqlite::params![task_id, kind], |r| r.get(0))
        .optional()?)
}

/// Whether `run_id` is a run of the task started after run `after` (any of its runs if `after` isn't one).
pub fn run_after(c: &Connection, task_id: &str, run_id: &str, after: &str) -> Result<bool> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM runs WHERE id=?1 AND task_id=?2 AND rowid > COALESCE((SELECT rowid FROM runs WHERE id=?3), -1))",
        [run_id, task_id, after],
        |r| r.get(0),
    )?)
}

/// Whether a run has been started on the task since `run_id` was. The latest run's start and end
/// set the task's running state and column; an earlier run that ends after it must leave them.
pub fn later_run(c: &Connection, task_id: &str, run_id: &str) -> Result<bool> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM runs WHERE task_id=?1 AND rowid > COALESCE((SELECT rowid FROM runs WHERE id=?2), -1))",
        [task_id, run_id],
        |r| r.get(0),
    )?)
}

/// Whether a run on the task hasn't exited yet.
pub fn has_active_run(c: &Connection, task_id: &str) -> Result<bool> {
    Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE task_id=?1 AND status != 'exited')", [task_id], |r| r.get(0))?)
}

/// Runs that haven't exited, oldest first.
pub fn active_runs(c: &Connection) -> Result<Vec<Run>> {
    let mut st = c.prepare("SELECT * FROM runs WHERE status != 'exited' ORDER BY created_at")?;
    let rows = st.query_map([], Run::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Threads to compact because they've been idle since `idle_since`, but not since before
/// `not_before`: their last run was a prompt that ended in that window, and nothing has
/// happened on them since. Finished tasks, merges waiting for their turn, tasks being
/// reviewed and archived projects' threads are left alone.
pub fn idle_sessions(c: &Connection, idle_since: &str, not_before: &str) -> Result<Vec<String>> {
    let mut st = c.prepare(
        "SELECT t.id FROM tasks t JOIN runs r ON r.id = (SELECT id FROM runs WHERE task_id=t.id ORDER BY created_at DESC LIMIT 1)
         WHERE t.session_id IS NOT NULL AND t.running=0 AND t.status != 'done' AND t.last_activity_at <= ?1
           AND NOT (t.merging=1 AND t.status='ready_for_merge')
           AND (t.review IS NULL OR json_extract(t.review, '$.state') != 'running')
           AND (t.project_id IS NULL OR t.project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))
           AND r.kind='prompt' AND r.status='exited' AND r.ended_at <= ?1 AND r.ended_at > ?2",
    )?;
    let rows = st.query_map(params![idle_since, not_before], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn commits_dont_sync_to_disk_one_by_one() {
        let dir = std::env::temp_dir().join(format!("ia-test-{}", crate::util::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let c = open(&dir.join("huntaway.db")).unwrap();
        let mode: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "wal");
        // NORMAL
        assert_eq!(c.query_row("PRAGMA synchronous", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        drop(c);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn archived_projects_threads_arent_compacted() {
        let c = open(std::path::Path::new(":memory:")).unwrap();
        let p = insert_profile(&c, "me", &[], None).unwrap();
        let np = NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
        insert_project(&c, np).unwrap();
        let t = NewTask { profile_id: &p.id, project_id: Some("pr"), kind: "task", title: "t", description: "", status: "in_review", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let t = insert_task(&c, t).unwrap();
        // Its last prompt ended 55 minutes ago, and nothing has happened since.
        c.execute("UPDATE tasks SET session_id='s', last_activity_at='2026-01-01T10:05:00Z' WHERE id=?1", [&t.id]).unwrap();
        let run = insert_run(&c, &t.id, "prompt").unwrap();
        c.execute("UPDATE runs SET status='exited', ended_at='2026-01-01T10:05:00Z' WHERE id=?1", [&run.id]).unwrap();
        let idle = |c: &Connection| idle_sessions(c, "2026-01-01T10:10:00Z", "2026-01-01T09:00:00Z").unwrap();
        assert_eq!(idle(&c), [t.id.clone()]);
        update_project(&c, "pr", &[("archived_at", json!("2026-01-01T10:06:00Z"))]).unwrap();
        assert!(idle(&c).is_empty());
        update_project(&c, "pr", &[("archived_at", Value::Null)]).unwrap();
        assert_eq!(idle(&c), [t.id]);
    }

    fn thread(c: &Connection) -> String {
        let p = insert_profile(c, "me", &[], None).unwrap();
        let t = NewTask {
            profile_id: &p.id,
            project_id: None,
            kind: "scratch",
            title: "t",
            description: "",
            status: "todo",
            use_worktree: false,
            model: None,
            effort: None,
            claude_config_id: None,
        };
        insert_task(c, t).unwrap().id
    }

    #[test]
    fn user_replies_are_the_users_own_messages_after_what_the_agent_said() {
        let c = open(std::path::Path::new(":memory:")).unwrap();
        let t = thread(&c);
        let said = |text: &str| json!({"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "hm"}, {"type": "text", "text": text}]}});
        insert_message(&c, &t, "user", &json!({"text": "Start working on this task.", "auto": true, "start": true})).unwrap();
        insert_message(&c, &t, "user", &json!({"text": "Also do the docs"})).unwrap();
        insert_message(&c, &t, "claude", &said("Working on it.")).unwrap();
        insert_message(&c, &t, "claude", &json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {}}]}})).unwrap();
        insert_message(&c, &t, "claude", &said("Should it be A or B?")).unwrap();
        insert_message(&c, &t, "event", &json!({"level": "info", "text": "Needs attention"})).unwrap();
        insert_message(&c, &t, "user", &json!({"text": " A is fine, B is too slow \n", "steered": true})).unwrap();
        insert_message(&c, &t, "user", &json!({"text": "and keep the old flag"})).unwrap();
        insert_message(&c, &t, "claude", &said("Done.")).unwrap();
        insert_message(&c, &t, "user", &json!({"text": "Fix this from IA-2", "from_agent": true})).unwrap();
        insert_message(&c, &t, "user", &json!({"text": "Serious issues found in your changes", "auto": true})).unwrap();
        let all = vec![
            (None, "Also do the docs".to_string()),
            (Some("Should it be A or B?".to_string()), "A is fine, B is too slow".to_string()),
            (None, "and keep the old flag".to_string()),
        ];
        let done = Some("Done.".to_string());
        assert_eq!(user_replies(&c, &t, None).unwrap(), UserReplies { replies: all.clone(), since: done.clone(), earlier: 0 });
        // Only the latest, with how many are left out.
        for n in 0..=4 {
            let skip = 3usize.saturating_sub(n);
            assert_eq!(user_replies(&c, &t, Some(n)).unwrap(), UserReplies { replies: all[skip..].to_vec(), since: done.clone(), earlier: skip }, "limit {n}");
        }
        insert_message(&c, &t, "user", &json!({"text": "Ship it"})).unwrap();
        let r = user_replies(&c, &t, Some(1)).unwrap();
        assert_eq!(r, UserReplies { replies: vec![(done, "Ship it".to_string())], since: None, earlier: 3 });
    }

    #[test]
    fn user_replies_read_a_long_thread_only_back_to_the_latest() {
        let c = open(std::path::Path::new(":memory:")).unwrap();
        let t = thread(&c);
        let said = |text: &str| json!({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}});
        for i in 0..50 {
            insert_message(&c, &t, "claude", &said(&format!("Question {i}?"))).unwrap();
            insert_message(&c, &t, "user", &json!({"text": format!("Answer {i}")})).unwrap();
            insert_message(&c, &t, "claude", &json!({"type": "user", "message": {"content": [{"type": "tool_result", "content": "x".repeat(1000)}]}})).unwrap();
        }
        let all = user_replies(&c, &t, None).unwrap();
        assert_eq!((all.replies.len(), all.since, all.earlier), (50, None, 0));
        let r = user_replies(&c, &t, Some(30)).unwrap();
        assert_eq!(r.replies, all.replies[20..]);
        assert_eq!((r.since, r.earlier), (None, 20));
        assert_eq!(r.replies[0], (Some("Question 20?".to_string()), "Answer 20".to_string()));
    }

    #[test]
    fn queued_messages_remember_whether_an_agent_sent_them() {
        let c = open(std::path::Path::new(":memory:")).unwrap();
        let id = thread(&c);
        assert_eq!(take_queued(&c, &id).unwrap(), None);
        let taken = |c: &Connection| take_queued(c, &id).unwrap().map(|q| (q.text, q.from_agent, q.user_text));
        let mine = |t: &str| Some(t.to_string());

        // From another agent, and it stays that way through the queue.
        queue(&c, &id, Queued::new("rebase please", true)).unwrap();
        queue(&c, &id, Queued::new("and run the tests", true)).unwrap();
        assert_eq!(taken(&c), Some(("rebase please\n\nand run the tests".into(), true, None)));
        assert_eq!(taken(&c), None);

        // Anything the user adds makes it the user's, whichever came first, and their parts are kept apart.
        queue(&c, &id, Queued::new("from an agent", true)).unwrap();
        queue(&c, &id, Queued::new("from me", false)).unwrap();
        assert_eq!(get_task(&c, &id).unwrap().unwrap().queued_user_text, mine("from me"));
        assert_eq!(taken(&c), Some(("from an agent\n\nfrom me".into(), false, mine("from me"))));
        queue(&c, &id, Queued::new("from me", false)).unwrap();
        queue(&c, &id, Queued::new("from an agent", true)).unwrap();
        queue(&c, &id, Queued::new("and me", false)).unwrap();
        assert_eq!(taken(&c), Some(("from me\n\nfrom an agent\n\nand me".into(), false, mine("from me\n\nand me"))));

        // Clearing the queue forgets where it came from.
        queue(&c, &id, Queued::new("dropped", true)).unwrap();
        let t = clear_queued(&c, &id).unwrap().unwrap();
        assert_eq!((t.queued_message, t.queued_user_text), (None, None));
        queue(&c, &id, Queued::new("mine", false)).unwrap();
        assert_eq!(taken(&c), Some(("mine".into(), false, mine("mine"))));
    }

    #[test]
    fn a_users_message_sent_with_other_agents_counts_only_their_part() {
        let c = open(std::path::Path::new(":memory:")).unwrap();
        let t = thread(&c);
        insert_message(&c, &t, "user", &json!({"text": "Build a payment gateway\n\nAdd a search cache", "user_text": "Add a search cache"})).unwrap();
        insert_message(&c, &t, "claude", &json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "A or B?"}]}})).unwrap();
        let r = user_replies(&c, &t, None).unwrap();
        assert_eq!((r.replies, r.since), (vec![(None, "Add a search cache".to_string())], Some("A or B?".to_string())));
    }

    #[test]
    fn subprojects_follow_their_tasks_by_priority() {
        let c = open(std::path::Path::new(":memory:")).unwrap();
        let id = thread(&c);
        let t = get_task(&c, &id).unwrap().unwrap();
        let sp = Task { kind: "task".into(), subproject: true, status: "in_progress".into(), ..t };
        let task = |status: &str| Task { status: status.into(), parent_id: Some(sp.id.clone()), subproject: false, ..sp.clone() };
        let tasks = |sts: &[&str]| sts.iter().map(|st| task(st)).collect::<Vec<_>>();

        // Nothing started yet: it stays put.
        assert_eq!(subproject_status(&sp, &[]), None);
        assert_eq!(subproject_status(&sp, &tasks(&["todo", "backlog"])), None);
        // Needs attention beats in progress, which beats in review.
        assert_eq!(subproject_status(&sp, &tasks(&["in_review", "in_progress", "needs_attention", "todo"])), Some("needs_attention"));
        assert_eq!(subproject_status(&sp, &tasks(&["in_review", "in_progress", "done"])), Some("in_progress"));
        assert_eq!(subproject_status(&sp, &tasks(&["in_review", "ready_for_merge", "done", "todo"])), Some("in_review"));
        // Still in review once everything's merged.
        assert_eq!(subproject_status(&sp, &tasks(&["done", "done"])), Some("in_review"));

        // Its own agent counts too.
        let busy = Task { running: true, ..sp.clone() };
        assert_eq!(subproject_status(&busy, &tasks(&["done"])), Some("in_progress"));
        let asking = Task { attention_reason: Some("Approve Bash?".into()), ..sp.clone() };
        assert_eq!(subproject_status(&asking, &tasks(&["in_progress"])), Some("needs_attention"));

        // Merging it or marking it done is left to the user.
        let merging = Task { merging: true, status: "ready_for_merge".into(), ..sp.clone() };
        assert_eq!(subproject_status(&merging, &tasks(&["in_progress"])), None);
        let done = Task { status: "done".into(), ..sp.clone() };
        assert_eq!(subproject_status(&done, &tasks(&["in_progress"])), None);
        // Its scratch tasks aren't part of its work, so they don't count.
        let scratch = |status: &str| Task { task_type: Some(SCRATCH.into()), ..task(status) };
        assert_eq!(subproject_status(&sp, &[scratch("needs_attention"), scratch("in_progress"), task("todo")]), None);
        assert_eq!(subproject_status(&sp, &[scratch("needs_attention"), task("in_review")]), Some("in_review"));
        // Only subprojects follow their tasks.
        let plain = Task { subproject: false, ..sp.clone() };
        assert_eq!(subproject_status(&plain, &tasks(&["in_progress"])), None);
    }

    #[test]
    fn done_tasks_and_only_done_tasks_have_a_resolution() {
        let c = open(std::path::Path::new(":memory:")).unwrap();
        let id = thread(&c);
        let set = |fields: &[(&str, Value)]| update_task(&c, &id, fields).unwrap().unwrap().resolution;
        assert_eq!(get_task(&c, &id).unwrap().unwrap().resolution, None);

        // Done without saying how means done.
        assert_eq!(set(&[("status", json!("done"))]).as_deref(), Some("done"));
        // A done task's resolution can change, and stays put through other updates.
        assert_eq!(set(&[("resolution", json!("wont_fix"))]).as_deref(), Some("wont_fix"));
        assert_eq!(set(&[("status", json!("done")), ("title", json!("x"))]).as_deref(), Some("wont_fix"));
        // Clearing it falls back to done.
        assert_eq!(set(&[("resolution", Value::Null)]).as_deref(), Some("done"));
        // Out of done clears it, whatever it was.
        set(&[("resolution", json!("not_done"))]);
        assert_eq!(set(&[("status", json!("todo"))]), None);
        assert_eq!(set(&[("status", json!("done")), ("resolution", json!("not_done"))]).as_deref(), Some("not_done"));

        // Created done, it's done.
        let mut t = get_task(&c, &id).unwrap().unwrap();
        t = insert_task(&c, NewTask { profile_id: &t.profile_id, project_id: None, kind: "scratch", title: "t", description: "", status: "done", use_worktree: false, model: None, effort: None, claude_config_id: None }).unwrap();
        assert_eq!(t.resolution.as_deref(), Some("done"));
    }

    #[test]
    fn done_tasks_keep_when_they_were_done() {
        let c = open(std::path::Path::new(":memory:")).unwrap();
        let id = thread(&c);
        let set = |fields: &[(&str, Value)]| update_task(&c, &id, fields).unwrap().unwrap().done_at;
        assert_eq!(get_task(&c, &id).unwrap().unwrap().done_at, None);

        let done = set(&[("status", json!("done"))]).expect("moving it into done sets the time");
        // Staying done keeps the time it was done, through other updates and a new resolution.
        update_task(&c, &id, &[("done_at", json!("2026-01-01T00:00:00Z"))]).unwrap();
        assert_eq!(set(&[("status", json!("done")), ("title", json!("x"))]).as_deref(), Some("2026-01-01T00:00:00Z"));
        assert_eq!(set(&[("resolution", json!("wont_fix"))]).as_deref(), Some("2026-01-01T00:00:00Z"));
        // Out of done clears it, and done again starts over.
        assert_eq!(set(&[("status", json!("in_review"))]), None);
        assert!(set(&[("status", json!("done"))]).is_some_and(|t| t >= done));

        // Created done, it's done from then.
        let t = get_task(&c, &id).unwrap().unwrap();
        let t = insert_task(&c, NewTask { profile_id: &t.profile_id, project_id: None, kind: "task", title: "t", description: "", status: "done", use_worktree: false, model: None, effort: None, claude_config_id: None }).unwrap();
        assert!(t.done_at.is_some_and(|d| d >= t.created_at));
    }

    #[test]
    fn resolutions_are_checked_against_the_status() {
        assert!(check_resolution("done", &json!("wont_fix")).is_ok());
        assert!(check_resolution("todo", &Value::Null).is_ok());
        assert!(check_resolution("done", &json!("maybe")).is_err());
        assert!(check_resolution("done", &json!(1)).is_err());
        assert!(check_resolution("in_review", &json!("done")).is_err());
    }

    #[test]
    fn a_database_from_version_54_gets_automations() {
        let path = std::env::temp_dir().join(format!("huntaway-v54-{}.db", crate::util::new_id()));
        {
            let c = open(&path).unwrap();
            c.execute_batch("DROP TABLE automation_runs; DROP TABLE automations; PRAGMA user_version=54;").unwrap();
        }
        let c = open(&path).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
        for table in ["automations", "automation_runs"] {
            assert!(c.query_row("SELECT COUNT(*) FROM pragma_table_info(?1)", [table], |r| r.get::<_, i64>(0)).unwrap() > 0, "{table}");
        }
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn a_database_from_version_48_has_its_done_tasks_done_since_they_last_changed() {
        let path = std::env::temp_dir().join(format!("huntaway-v48-{}.db", crate::util::new_id()));
        {
            let c = open(&path).unwrap();
            c.execute_batch(
                "ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=48;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,status,resolution,last_activity_at,created_at,updated_at)
                   VALUES ('d','p','task',1,'Done','done','done','1','1','2026-01-02T00:00:00Z'),
                          ('t','p','task',2,'To do','todo',NULL,'1','1','2026-01-03T00:00:00Z');",
            )
            .unwrap();
        }
        let c = open(&path).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
        assert_eq!(get_task(&c, "d").unwrap().unwrap().done_at.as_deref(), Some("2026-01-02T00:00:00Z"));
        assert_eq!(get_task(&c, "t").unwrap().unwrap().done_at, None);
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn a_database_from_version_49_gets_profiles_cloning_into_their_own_folder() {
        let path = std::env::temp_dir().join(format!("huntaway-v49-{}.db", crate::util::new_id()));
        {
            let c = open(&path).unwrap();
            c.execute_batch(
                "ALTER TABLE profiles DROP COLUMN clone_dir;
                 PRAGMA user_version=49;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');",
            )
            .unwrap();
        }
        let c = open(&path).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
        let p = get_profile(&c, "p").unwrap().unwrap();
        assert_eq!((p.clone_dir.as_deref(), p.clone_dir_or_default().as_str()), (None, "~/work"));
        let p = update_profile(&c, "p", &[("clone_dir", json!("~/src/work"))]).unwrap().unwrap();
        assert_eq!(p.clone_dir_or_default(), "~/src/work");
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn a_database_from_version_50_gets_external_links_and_asana_tokens() {
        let path = std::env::temp_dir().join(format!("huntaway-v50-{}.db", crate::util::new_id()));
        {
            let c = open(&path).unwrap();
            c.execute_batch(
                "ALTER TABLE tasks DROP COLUMN external_links;
                 ALTER TABLE profiles DROP COLUMN asana_token;
                 ALTER TABLE profiles DROP COLUMN asana_user;
                 PRAGMA user_version=50;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,description,status,position,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'t','','todo',0,'1','1','1');",
            )
            .unwrap();
        }
        let c = open(&path).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
        let p = get_profile(&c, "p").unwrap().unwrap();
        assert_eq!((p.asana_token, p.asana_user), (None, None));
        assert!(get_task(&c, "t").unwrap().unwrap().external_links.is_empty());
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn a_database_from_version_51_keeps_asana_on_for_its_profiles() {
        let path = std::env::temp_dir().join(format!("huntaway-v51-{}.db", crate::util::new_id()));
        {
            let c = open(&path).unwrap();
            c.execute_batch(
                "ALTER TABLE profiles DROP COLUMN asana_enabled;
                 PRAGMA user_version=51;
                 INSERT INTO profiles (id,name,created_at,asana_token,asana_user) VALUES ('p','work','1','tok','Ivy');",
            )
            .unwrap();
        }
        let c = open(&path).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
        let p = get_profile(&c, "p").unwrap().unwrap();
        assert!(p.asana_enabled);
        assert_eq!((p.asana_token.as_deref(), p.asana_user.as_deref()), (Some("tok"), Some("Ivy")));
        let p = update_profile(&c, "p", &[("asana_enabled", json!(false))]).unwrap().unwrap();
        assert!(!p.asana_enabled);
        assert!(insert_profile(&c, "personal", &[], None).unwrap().asana_enabled, "new profiles use Asana");
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn a_database_from_version_52_gets_fanout_ids() {
        let path = std::env::temp_dir().join(format!("huntaway-v52-{}.db", crate::util::new_id()));
        {
            let c = open(&path).unwrap();
            c.execute_batch(
                "ALTER TABLE tasks DROP COLUMN fanout_id;
                 PRAGMA user_version=52;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,description,status,position,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'t','','todo',0,'1','1','1');",
            )
            .unwrap();
        }
        let c = open(&path).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
        assert_eq!(get_task(&c, "t").unwrap().unwrap().fanout_id, None);
        let t = update_task(&c, "t", &[("fanout_id", json!("f1"))]).unwrap().unwrap();
        assert_eq!(t.fanout_id.as_deref(), Some("f1"));
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn a_database_from_version_53_gets_pull_request_watches() {
        let path = std::env::temp_dir().join(format!("huntaway-v53-{}.db", crate::util::new_id()));
        {
            let c = open(&path).unwrap();
            c.execute_batch(
                "DROP TABLE pr_watches;
                 PRAGMA user_version=53;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,description,status,position,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'t','','todo',0,'1','1','1');",
            )
            .unwrap();
        }
        let c = open(&path).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
        c.execute("INSERT INTO pr_watches (task_id,pr,state,updated_at) VALUES ('t','github.com/o/r#1','{}','1')", []).unwrap();
        // A stored wait from before it had a pull request is read as one without.
        let w = json!({"since": "1", "until": "2", "call_id": "c", "run_id": "r"});
        assert_eq!(update_task(&c, "t", &[("agent_wait", w)]).unwrap().unwrap().agent_wait.unwrap().pull_request, None);
        // They go with their task.
        c.execute("DELETE FROM tasks WHERE id='t'", []).unwrap();
        assert_eq!(c.query_row("SELECT COUNT(*) FROM pr_watches", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn profiles_clone_into_a_folder_named_after_them_by_default() {
        assert_eq!(default_clone_dir("personal"), "~/personal");
        assert_eq!(default_clone_dir(" a/b "), "~/a-b");
        for name in ["", " ", ".", ".."] {
            assert_eq!(default_clone_dir(name), "~", "{name:?}");
        }
    }

    #[test]
    fn a_database_from_version_47_gets_show_usage_off() {
        let path = std::env::temp_dir().join(format!("huntaway-v47-{}.db", crate::util::new_id()));
        {
            let c = open(&path).unwrap();
            c.execute_batch(
                "ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=47;
                 INSERT INTO claude_configs (id,name,config_dir,created_at) VALUES ('c','personal','~/.claude-personal','1');",
            )
            .unwrap();
        }
        let c = open(&path).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
        let configs = list_claude_configs(&c).unwrap();
        assert_eq!(configs.iter().map(|c| (c.id.as_str(), c.show_usage)).collect::<Vec<_>>(), [("c", false)]);
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            std::fs::remove_file(format!("{}{suffix}", path.display())).ok();
        }
    }

    #[test]
    fn a_database_where_github_accounts_were_version_42_44_or_45_keeps_them() {
        // As PR previews of GitHub accounts left it: at 42, before archived projects and scratch
        // tasks took versions 42 and 43, at 44, before starred tasks took 44, and at 45, before
        // pinned titles and queued users' text took 45 and 46.
        let newer = "ALTER TABLE tasks DROP COLUMN title_pinned; ALTER TABLE tasks DROP COLUMN queued_user_text; ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;";
        for (version, before) in [
            (42, format!("ALTER TABLE projects DROP COLUMN archived_at; ALTER TABLE tasks DROP COLUMN work_dir; {newer}")),
            (44, format!("ALTER TABLE tasks DROP COLUMN starred; ALTER TABLE tasks DROP COLUMN remind_at; ALTER TABLE tasks DROP COLUMN reminder; {newer}")),
            (45, newer.to_string()),
        ] {
            let path = std::env::temp_dir().join(format!("huntaway-gh{version}-{}.db", crate::util::new_id()));
            {
                let c = open(&path).unwrap();
                c.execute_batch(&format!(
                    "{before}
                     PRAGMA user_version={version};
                     INSERT INTO profiles (id,name,created_at,github_account) VALUES ('p','work','1','work-me');
                     INSERT INTO tasks (id,profile_id,kind,title,last_activity_at,created_at,updated_at) VALUES ('t','p','task','t','1','1','1');"
                ))
                .unwrap();
            }
            let c = open(&path).unwrap();
            assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
            assert_eq!(get_profile(&c, "p").unwrap().unwrap().github_account.as_deref(), Some("work-me"), "{version}");
            let t = get_task(&c, "t").unwrap().unwrap();
            assert!(!t.starred && !t.title_pinned && t.queued_user_text.is_none(), "{version}");
            drop(c);
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
            }
        }
    }


    #[test]
    fn a_database_where_scratch_tasks_were_version_42_gets_archived_projects() {
        let path = std::env::temp_dir().join(format!("huntaway-v42-{}.db", crate::util::new_id()));
        {
            let c = open(&path).unwrap();
            // As a build of scratch tasks from before archived projects took version 42 left it.
            c.execute_batch(
                "ALTER TABLE projects DROP COLUMN archived_at;
                 ALTER TABLE tasks DROP COLUMN title_pinned;
                 ALTER TABLE tasks DROP COLUMN queued_user_text;
                 ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=42;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','Site','SP','/src/site','/s','/w','1');
                 INSERT INTO tasks (id,profile_id,kind,task_type,number,title,status,work_dir,last_activity_at,created_at,updated_at)
                   VALUES ('s','p','task','scratch',1,'Chat','done','/old','1','1','1');",
            )
            .unwrap();
        }
        let c = open(&path).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
        assert_eq!(get_project(&c, "pr").unwrap().unwrap().archived_at, None);
        let t = get_task(&c, "s").unwrap().unwrap();
        assert_eq!((t.number, t.work_dir.as_deref(), t.is_scratch()), (1, Some("/old"), true));
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn a_database_where_stars_and_reminders_were_version_42_keeps_them() {
        let path = std::env::temp_dir().join(format!("huntaway-v42-{}.db", crate::util::new_id()));
        {
            let c = open(&path).unwrap();
            // As a build of stars and reminders from before archived projects and scratch tasks
            // took versions 42 and 43 left it.
            c.execute_batch(
                "ALTER TABLE projects DROP COLUMN archived_at;
                 ALTER TABLE tasks DROP COLUMN work_dir;
                 ALTER TABLE tasks DROP COLUMN title_pinned;
                 ALTER TABLE tasks DROP COLUMN queued_user_text;
                 ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=42;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO tasks (id,profile_id,kind,number,title,status,starred,remind_at,reminder,queued_message,queued_from_agent,last_activity_at,created_at,updated_at)
                   VALUES ('t','p','task',1,'Later','todo',1,'2030-01-01T00:00:00.000Z','Look again','and the docs',0,'1','1','1'),
                          ('u','p','task',2,'Other','todo',0,NULL,NULL,'from an agent',1,'1','1','1');",
            )
            .unwrap();
        }
        let c = open(&path).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), VERSION);
        let t = get_task(&c, "t").unwrap().unwrap();
        assert_eq!((t.starred, t.remind_at.as_deref(), t.reminder.as_deref()), (true, Some("2030-01-01T00:00:00.000Z"), Some("Look again")));
        // A message queued before is the user's unless other agents sent all of it.
        assert_eq!(t.queued_user_text.as_deref(), Some("and the docs"));
        assert_eq!(get_task(&c, "u").unwrap().unwrap().queued_user_text, None);
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn scratch_chats_become_scratch_tasks() {
        let dir = std::env::temp_dir().join(format!("huntaway-v41-{}", crate::util::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("huntaway.db");
        {
            let c = open(&path).unwrap();
            // As version 41 left it, with a project's scratch chat, two of the profile's and a
            // project that has the key scratch tasks now use.
            c.execute_batch(
                "ALTER TABLE tasks DROP COLUMN work_dir;
                 ALTER TABLE projects DROP COLUMN archived_at;
                 ALTER TABLE tasks DROP COLUMN title_pinned;
                 ALTER TABLE tasks DROP COLUMN queued_user_text;
                 ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=41;
                 INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('pr','p','Site','S','/src/site','/data/projects/pr/scratch','/w','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at)
                   VALUES ('sp','p','Spare','SP','/src/spare','/s','/w','1');
                 INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,former_keys,created_at)
                   VALUES ('aa','p','Again','AA','/src/again','/s','/w','[\"sp2\"]','1');
                 INSERT INTO tasks (id,profile_id,project_id,kind,number,title,status,last_activity_at,created_at,updated_at)
                   VALUES ('old','p','aa','task',1,'Old','todo','1','1','1');
                 INSERT INTO tasks (id,profile_id,project_id,kind,number,title,status,last_activity_at,created_at,updated_at)
                   VALUES ('code','p','pr','task',1,'Code','in_review','1','1','1');
                 INSERT INTO tasks (id,profile_id,project_id,kind,title,status,session_id,last_activity_at,created_at,updated_at)
                   VALUES ('b','p',NULL,'scratch','Second','todo','s2','3','3','3');
                 INSERT INTO tasks (id,profile_id,project_id,kind,title,status,last_activity_at,created_at,updated_at)
                   VALUES ('a','p','pr','scratch','First','todo','2','2','2');",
            )
            .unwrap();
        }
        let c = open(&path).unwrap();
        let a = get_task(&c, "a").unwrap().unwrap();
        let b = get_task(&c, "b").unwrap().unwrap();
        for t in [&a, &b] {
            assert!(t.is_scratch(), "{t:?}");
            assert_eq!((t.project_id.as_deref(), t.status.as_str(), t.resolution.as_deref()), (None, "done", Some("done")));
        }
        // Numbered in the order they were made, each working where its conversation is.
        assert_eq!((a.number, a.work_dir.as_deref()), (1, Some("/data/projects/pr/scratch")));
        let profile_dir = path_str(&dir.join("profiles").join("p").join("scratch"));
        assert_eq!((b.number, b.work_dir.as_deref(), b.session_id.as_deref()), (2, Some(profile_dir.as_str()), Some("s2")));
        assert_eq!(scratch_task_by_number(&c, "p", 2).unwrap().unwrap().id, "b");
        // The project's tasks stay as they were, and it gives up the key S, for one no other
        // project has now (SP) or had before (SP2, whose tasks it still names).
        assert_eq!(get_task(&c, "code").unwrap().unwrap().status, "in_review");
        assert_eq!(get_project(&c, "pr").unwrap().unwrap().key, "SP3");
        // New ones carry on the numbers.
        let p = get_profile(&c, "p").unwrap().unwrap();
        let new = NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let t = insert_scratch_task(&c, new).unwrap();
        assert_eq!((t.number, t.work_dir.as_deref(), t.is_scratch()), (3, None, true));
        drop(c);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_database_from_version_38_gets_permission_request_kinds() {
        let path = std::env::temp_dir().join(format!("huntaway-v38-{}.db", crate::util::new_id()));
        {
            let c = open(&path).unwrap();
            // As version 38 (task documents) left it, before permission requests had a kind (and
            // projects their old keys, repository root and archived time, and tasks stars, reminders, pinned titles and queued users' text).
            c.execute_batch(
                "ALTER TABLE permission_requests DROP COLUMN kind;
                 ALTER TABLE projects DROP COLUMN former_keys;
                 ALTER TABLE projects DROP COLUMN repo_root;
                 ALTER TABLE tasks DROP COLUMN work_dir;
                 ALTER TABLE projects DROP COLUMN archived_at;
                 ALTER TABLE tasks DROP COLUMN starred;
                 ALTER TABLE tasks DROP COLUMN remind_at;
                 ALTER TABLE tasks DROP COLUMN reminder;
                 ALTER TABLE profiles DROP COLUMN github_account;
                 ALTER TABLE projects DROP COLUMN github_account;
                 ALTER TABLE tasks DROP COLUMN title_pinned;
                 ALTER TABLE tasks DROP COLUMN queued_user_text;
                 ALTER TABLE claude_configs DROP COLUMN show_usage; ALTER TABLE tasks DROP COLUMN done_at;
                 PRAGMA user_version=38;",
            )
            .unwrap();
            c.execute("INSERT INTO profiles (id,name,created_at) VALUES ('p','work','1')", []).unwrap();
            c.execute("INSERT INTO tasks (id,profile_id,kind,title,last_activity_at,created_at,updated_at) VALUES ('t','p','scratch','t','1','1','1')", []).unwrap();
            c.execute("INSERT INTO permission_requests (id,task_id,message_id,tool_name,input,created_at) VALUES ('r','t',1,'Bash','{}','1')", []).unwrap();
            c.execute(
                "INSERT INTO projects (id,profile_id,name,key,repo_path,scratch_path,worktrees_root,created_at) VALUES ('x','p','x','X','/x','/s','/w','1')",
                [],
            )
            .unwrap();
        }
        let c = open(&path).unwrap();
        let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        let kind: String = c.query_row("SELECT kind FROM permission_requests WHERE id='r'", [], |r| r.get(0)).unwrap();
        assert_eq!((version, kind.as_str()), (VERSION, "tool"));
        // Projects from before aren't archived.
        assert_eq!(get_project(&c, "x").unwrap().unwrap().archived_at, None);
        let t = get_task(&c, "t").unwrap().unwrap();
        assert_eq!((t.starred, t.remind_at, t.reminder), (false, None, None));
        drop(c);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn profile_config_dirs_become_claude_configs() {
        let c = open(std::path::Path::new(":memory:")).unwrap();
        // Back to how version 17 left things.
        c.execute_batch(
            "DROP TABLE claude_configs;
             ALTER TABLE profiles DROP COLUMN claude_config_ids;
             ALTER TABLE projects DROP COLUMN claude_config_ids;
             ALTER TABLE tasks DROP COLUMN claude_config_id;
             PRAGMA user_version=17;",
        )
        .unwrap();
        for (id, name, dir, at) in [("a", "work", "~/.claude-work", "1"), ("b", "personal", "~/.claude-me", "2"), ("c", "work2", "~/.claude-work", "3")] {
            c.execute("INSERT INTO profiles (id,name,claude_config_dir,created_at) VALUES (?1,?2,?3,?4)", params![id, name, dir, at]).unwrap();
        }
        for (id, profile, session) in [("t1", "a", Some("s1")), ("t2", "b", None)] {
            c.execute(
                "INSERT INTO tasks (id,profile_id,kind,title,session_id,last_activity_at,created_at,updated_at) VALUES (?1,?2,'scratch','t',?3,'1','1','1')",
                params![id, profile, session],
            )
            .unwrap();
        }
        migrate_claude_configs(&c).unwrap();
        let configs = list_claude_configs(&c).unwrap();
        assert_eq!(configs.iter().map(|c| (c.name.as_str(), c.config_dir.as_str())).collect::<Vec<_>>(), [("personal", "~/.claude-me"), ("work", "~/.claude-work")]);
        let a = get_profile(&c, "a").unwrap().unwrap();
        // Profiles that shared a directory share its config.
        assert_eq!(a.claude_config_ids, get_profile(&c, "c").unwrap().unwrap().claude_config_ids);
        assert_eq!(a.claude_config_dir, "~/.claude-work");
        // Threads keep their profile's config, whatever the profile picks later.
        assert_eq!(get_task(&c, "t1").unwrap().unwrap().claude_config_id, a.claude_config_ids.first().cloned());
        update_profile(&c, "a", &[("claude_config_ids", json!(get_profile(&c, "b").unwrap().unwrap().claude_config_ids))]).unwrap();
        assert_eq!(task_config_dir(&c, &get_task(&c, "t1").unwrap().unwrap()).unwrap().as_deref(), Some("~/.claude-work"));
        assert_eq!(task_config_dir(&c, &get_task(&c, "t2").unwrap().unwrap()).unwrap().as_deref(), Some("~/.claude-me"));
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 18);
    }

    #[test]
    fn threads_pick_their_project_or_profile_config() {
        let c = open(std::path::Path::new(":memory:")).unwrap();
        let work = insert_claude_config(&c, "work", "~/.claude-work", "claude").unwrap();
        let me = insert_claude_config(&c, "me", "~/.claude-me", "claude").unwrap();
        let p = insert_profile(&c, "p", &[work.id.clone(), me.id.clone()], None).unwrap();
        assert_eq!(p.claude_config_dir, "~/.claude-work");
        let project = insert_project(
            &c,
            NewProject { id: "pr", profile_id: &p.id, name: "x", key: "X", repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false },
        )
        .unwrap();
        let task = |cfg: Option<&str>| {
            let t = NewTask {
                profile_id: &p.id,
                project_id: Some("pr"),
                kind: "task",
                title: "t",
                description: "",
                status: "todo",
                use_worktree: false,
                model: None,
                effort: None,
                claude_config_id: cfg,
            };
            insert_task(&c, t).unwrap()
        };
        let names = |p: &Project| available_configs(&c, &p.profile_id, Some(p)).unwrap().into_iter().map(|c| c.name).collect::<Vec<_>>();
        // The profile's configs, the default first.
        assert_eq!(names(&project), ["work", "me"]);
        let t = task(None);
        assert_eq!(t.claude_config_id.as_deref(), Some(work.id.as_str()));
        assert_eq!(task(Some(&me.id)).claude_config_id.as_deref(), Some(me.id.as_str()));

        // A project's own list overrides the profile's.
        let project = update_project(&c, "pr", &[("claude_config_ids", json!(json!([me.id]).to_string()))]).unwrap().unwrap();
        assert_eq!(names(&project), ["me"]);
        // A thread keeps the config it started with.
        assert_eq!(task_config_dir(&c, &t).unwrap().as_deref(), Some("~/.claude-work"));

        // Deleting a config takes it off the profile and the project, and its threads go to the default.
        delete_claude_config(&c, &me.id).unwrap();
        let project = get_project(&c, "pr").unwrap().unwrap();
        assert_eq!(project.claude_config_ids, None);
        assert_eq!(get_profile(&c, &p.id).unwrap().unwrap().claude_config_ids, [work.id.clone()]);
        let orphan = task(None);
        assert_eq!(task_claude_config(&c, &orphan).unwrap().map(|c| c.name).as_deref(), Some("work"));
        let mut t = t;
        t.claude_config_id = Some(me.id.clone());
        assert_eq!(task_claude_config(&c, &t).unwrap().map(|c| c.name).as_deref(), Some("work"));

        // A thread that started with no config at all stays in Claude's default one.
        t.claude_config_id = None;
        assert_eq!(task_claude_config(&c, &t).unwrap().map(|c| c.name).as_deref(), Some("work"));
        t.session_id = Some("s".into());
        assert!(task_claude_config(&c, &t).unwrap().is_none());
    }
    #[test]
    fn threads_load_in_pages_of_main_conversation_messages() {
        let c = open(std::path::Path::new(":memory:")).unwrap();
        let p = insert_profile(&c, "p", &[], None).unwrap();
        let t = NewTask { profile_id: &p.id, project_id: None, kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
        let t = insert_task(&c, t).unwrap();
        let add = |kind: &str, data: Value| insert_message(&c, &t.id, kind, &data).unwrap().id;
        let text = |s: &str| json!({"type": "assistant", "message": {"content": [{"type": "text", "text": s}]}});
        let first = add("user", json!({"text": "go"}));
        // A background subagent, then its own messages, a progress line from it and a shell's.
        add("claude", json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "on it"}, {"type": "tool_use", "id": "a1", "name": "Agent", "input": {"description": "look", "prompt": "p".repeat(300)}}]}}));
        let report = "Async agent launched successfully. ".repeat(20);
        add("claude", json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "a1", "content": report}]}, "tool_use_result": {"isAsync": true, "content": ["big"]}}));
        add("claude", json!({"type": "system", "subtype": "task_started", "task_id": "k1", "tool_use_id": "a1", "is_backgrounded": true}));
        add("claude", json!({"type": "system", "subtype": "task_started", "task_id": "sh", "tool_use_id": "b1"}));
        let child = add("claude", json!({"type": "assistant", "parent_tool_use_id": "a1", "message": {"content": [{"type": "text", "text": "reading"}]}}));
        add("claude", json!({"type": "system", "subtype": "task_progress", "task_id": "k1", "description": "Reading a"}));
        let main = add("claude", text("meanwhile"));
        add("claude", json!({"type": "assistant", "parent_tool_use_id": "a1", "message": {"content": [{"type": "text", "text": "still reading"}]}}));
        let progress = add("claude", json!({"type": "system", "subtype": "task_progress", "task_id": "k1", "description": "Reading b"}));
        let last = add("claude", text("done"));

        let ids = |(page, more): (Vec<Message>, bool)| (page.into_iter().map(|m| m.id).collect::<Vec<_>>(), more);
        let all: Vec<i64> = list_messages(&c, &t.id).unwrap().iter().map(|m| m.id).collect();
        assert_eq!(ids(message_page(&c, &t.id, None, None, None).unwrap()), (all.clone(), false));
        // Three of the main conversation's: the subagent's messages among them don't count.
        assert_eq!(ids(message_page(&c, &t.id, None, None, Some(3)).unwrap()), ((main..=last).collect(), true));
        // Older pages: the subagent's message is among the two before `main`, which start at a main-conversation one.
        assert_eq!(ids(message_page(&c, &t.id, None, Some(main), Some(1)).unwrap()), (vec![main - 1], true));
        assert_eq!(ids(message_page(&c, &t.id, None, Some(main), Some(2)).unwrap()), ((child - 1..main).collect(), true));
        assert_eq!(ids(message_page(&c, &t.id, None, Some(main), Some(100)).unwrap()), ((first..main).collect(), false));
        // Everything after a message, as a reload asks for.
        assert_eq!(ids(message_page(&c, &t.id, Some(main), None, None).unwrap()), ((main + 1..=last).collect(), false));
        assert!(message_page(&c, "nope", None, None, Some(5)).unwrap().0.is_empty());

        // The subagent from before `last`: its call alone, its result's start, its own task_* messages (the latest progress).
        let subs = subagent_messages(&c, &t.id, last).unwrap();
        assert_eq!(subs.len(), 4, "{subs:#?}");
        assert_eq!(subs[0].data["message"]["content"], json!([{"type": "tool_use", "id": "a1", "name": "Agent", "input": {"description": "look", "prompt": "p".repeat(200)}}]));
        let result = &subs[1].data;
        assert_eq!(result["message"]["content"][0]["content"].as_str().unwrap().len(), 200);
        assert_eq!(result["tool_use_result"], json!({"isAsync": true}));
        assert_eq!(subs[2].data["subtype"], "task_started");
        assert_eq!(subs[3].id, progress);
        assert!(subagent_messages(&c, &t.id, first).unwrap().is_empty());

        // A megabyte of a subagent's output ends the page, at the main-conversation message before it.
        let call = add("claude", json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "a2", "name": "Agent", "input": {}}]}}));
        add("claude", json!({"type": "user", "parent_tool_use_id": "a2", "message": {"content": [{"type": "tool_result", "tool_use_id": "r", "content": "x".repeat(PAGE_BYTES)}]}}));
        add("claude", json!({"type": "assistant", "parent_tool_use_id": "a2", "message": {"content": []}}));
        let end = add("claude", text("end"));
        assert_eq!(ids(message_page(&c, &t.id, None, None, Some(100)).unwrap()), ((call..=end).collect(), true));
    }

    #[test]
    fn subagent_summaries_include_forked_skills_and_their_launch_calls() {
        let c = open(std::path::Path::new(":memory:")).unwrap();
        let p = insert_profile(&c, "p", &[], None).unwrap();
        let t = insert_task(&c, NewTask { profile_id: &p.id, project_id: None, kind: "review", title: "review", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None }).unwrap();
        let add = |data: Value| insert_message(&c, &t.id, "claude", &data).unwrap().id;
        let call = add(json!({"type": "assistant", "parent_tool_use_id": "outer", "message": {"content": [
            {"type": "tool_use", "id": "inline", "name": "Skill", "input": {"skill": "inline"}},
            {"type": "tool_use", "id": "fork", "name": "Skill", "input": {"skill": "code-review", "args": "low 139"}}
        ]}}));
        let start = add(json!({"type": "system", "subtype": "task_started", "task_type": "local_agent", "tool_use_id": "fork", "task_id": "child", "prompt": "p".repeat(300), "description": "/code-review"}));
        add(json!({"type": "assistant", "parent_tool_use_id": "fork", "message": {"content": [{"type": "text", "text": "child transcript"}]}}));
        add(json!({"type": "system", "subtype": "task_started", "task_type": "local_bash", "tool_use_id": "shell", "task_id": "shell-task"}));
        let end = add(json!({"type": "system", "subtype": "task_notification", "task_id": "child", "status": "completed", "summary": "done"}));
        let result = add(json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "fork", "content": "review report"}]}}));
        let last = add(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "main summary"}]}}));
        let subs = subagent_messages(&c, &t.id, last).unwrap();
        assert_eq!(subs.iter().map(|m| m.id).collect::<Vec<_>>(), vec![call, start, end, result]);
        assert_eq!(subs[0].data["message"]["content"].as_array().unwrap().len(), 1);
        assert_eq!(subs[0].data["message"]["content"][0]["id"], "fork");
        assert_eq!(subs[0].data["parent_tool_use_id"], "outer");
        assert_eq!(subs[1].data["prompt"].as_str().unwrap().len(), 200);
        // A page can start between the Skill call and its task_started event.
        let split = subagent_messages(&c, &t.id, start).unwrap();
        assert_eq!(split.iter().map(|m| m.id).collect::<Vec<_>>(), vec![call]);
    }

    #[test]
    fn dependencies_stay_in_the_project_and_never_loop() {
        let c = open(std::path::Path::new(":memory:")).unwrap();
        let p = insert_profile(&c, "p", &[], None).unwrap();
        for (id, key) in [("a", "A"), ("b", "B")] {
            let np = NewProject { id, profile_id: &p.id, name: id, key, repo_path: "/x", scratch_path: "/s", worktrees_root: "/w", base_branch: None, use_worktrees: false };
            insert_project(&c, np).unwrap();
        }
        let task = |project: &str| {
            let t = NewTask { profile_id: &p.id, project_id: Some(project), kind: "task", title: "t", description: "", status: "todo", use_worktree: false, model: None, effort: None, claude_config_id: None };
            insert_task(&c, t).unwrap()
        };
        let (one, two, three, other) = (task("a"), task("a"), task("a"), task("b"));
        let check = |t: &Task, ids: &[&String]| check_dependencies(&c, Some(&t.id), t.project_id.as_deref(), &ids.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(check(&two, &[&one.id, &one.id]), Ok(vec![one.id.clone()]));
        assert!(check(&two, &[&two.id]).is_err());
        assert!(check(&two, &[&other.id]).is_err());
        assert!(check(&two, &[&"nope".to_string()]).is_err());
        update_task(&c, &two.id, &[("depends_on", json!([one.id]))]).unwrap();
        update_task(&c, &three.id, &[("depends_on", json!([two.id]))]).unwrap();
        // one → two → three, so one can't depend on three.
        assert!(check(&get_task(&c, &one.id).unwrap().unwrap(), &[&three.id]).unwrap_err().contains("already depends"));

        let unmet = |t: &Task| unmet_dependencies(&c, &get_task(&c, &t.id).unwrap().unwrap()).unwrap().into_iter().map(|t| t.id).collect::<Vec<_>>();
        assert_eq!(unmet(&three), [two.id.clone()]);
        // Closed without being merged doesn't count.
        update_task(&c, &two.id, &[("status", json!("done")), ("resolution", json!("wont_fix"))]).unwrap();
        assert_eq!(unmet(&three), [two.id.clone()]);
        update_task(&c, &two.id, &[("resolution", json!("done"))]).unwrap();
        assert!(unmet(&three).is_empty());

        // A deleted task comes off its dependents' lists.
        c.execute("DELETE FROM tasks WHERE id=?1", [&one.id]).unwrap();
        assert_eq!(drop_dependency(&c, &one.id).unwrap(), [two.id.clone()]);
        assert!(get_task(&c, &two.id).unwrap().unwrap().depends_on.is_empty());
        assert_eq!(get_task(&c, &three.id).unwrap().unwrap().depends_on, [two.id.clone()]);
    }
}
