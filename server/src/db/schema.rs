//! The database schema: `open` creates it, or migrates an older database to the latest version
//! (`PRAGMA user_version`, `VERSION`).

use super::*;

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
        // starts, when it's reviewed and when it's merged (see agent/prompts.rs); NULL for the default.
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
        // Runs whenever one of the project's tasks changes status (see integrations/status_script.rs).
        conn.execute_batch("BEGIN; ALTER TABLE projects ADD COLUMN status_script TEXT NOT NULL DEFAULT ''; PRAGMA user_version=35; COMMIT;")?;
    }
    if version < 36 {
        // A script per column, run when a task moves into it (see integrations/status_script.rs).
        conn.execute_batch("BEGIN; ALTER TABLE projects ADD COLUMN status_scripts TEXT NOT NULL DEFAULT '{}'; PRAGMA user_version=36; COMMIT;")?;
    }
    if version < 37 {
        // How full the agent's context window is (see agent/context.rs).
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE tasks ADD COLUMN context TEXT;
             ALTER TABLE tasks ADD COLUMN context_detail TEXT;
             PRAGMA user_version=37; COMMIT;",
        )?;
    }
    if version < 38 {
        // Plan, artifact and diagram tasks, and the versions of the document each one makes
        // (see agent/documents.rs).
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
        // Whether the board fetches and shows a config's subscription usage (see agent/usage.rs); off
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
        // What a task's agent has been told about each pull request it waited on (see mcp/pr_watch.rs).
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
        // Projects' automations and their runs (see integrations/automations.rs).
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V55} PRAGMA user_version=55; COMMIT;"))?;
    }
    if version < 56 {
        // Whether a task whose pull request was merged on GitHub moves to Done (see review/merged.rs),
        // on until it's turned off, and what its last read found.
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('projects') WHERE name='done_when_merged'", [], |r| r.get(0))?;
        let add = if has { "" } else { "ALTER TABLE projects ADD COLUMN done_when_merged INTEGER NOT NULL DEFAULT 1;" };
        conn.execute_batch(&format!(
            "BEGIN; {add}
             CREATE TABLE IF NOT EXISTS pr_states (
               task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
               pr_url TEXT NOT NULL,
               state TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               PRIMARY KEY (task_id, pr_url)
             );
             PRAGMA user_version=56; COMMIT;"
        ))?;
    }
    if version < 57 {
        // A merging task that stepped out of the merge queue to fix something (see Task::remerge).
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('tasks') WHERE name='remerge'", [], |r| r.get(0))?;
        let add = if has { "" } else { "ALTER TABLE tasks ADD COLUMN remerge INTEGER NOT NULL DEFAULT 0;" };
        conn.execute_batch(&format!("BEGIN; {add} PRAGMA user_version=57; COMMIT;"))?;
    }
    if version < 58 {
        // Checkpoints of tasks' worktrees, a conversation rollback waiting for a task's next run,
        // and where each run's turn is (see git/checkpoints.rs). Columns added only if they aren't
        // there, in case another migration takes this version first.
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V58}"))?;
        for (table, column) in [("tasks", "rewind TEXT"), ("runs", "turn_message_id INTEGER"), ("runs", "agent_at TEXT")] {
            let name = column.split(' ').next().unwrap();
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name=?2", params![table, name], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column};"))?;
            }
        }
        conn.execute_batch("PRAGMA user_version=58; COMMIT;")?;
    }
    if version < 59 {
        // Plans, artifacts and diagrams are labels any task can have, with a document each
        // (see agent/documents.rs), rather than types of task. A task that was one of those types gets
        // its type as its label, and keeps working in its own folder (as a `work_dir` in the data
        // dir), where its agent's conversation is.
        let has = |table: &str, column: &str| {
            conn.query_row(&format!("SELECT COUNT(*) > 0 FROM pragma_table_info('{table}') WHERE name='{column}'"), [], |r| r.get::<_, bool>(0))
        };
        let tasks = if has("tasks", "labels")? { "" } else { "ALTER TABLE tasks ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';" };
        let documents = if has("documents", "label")? { "" } else { "ALTER TABLE documents ADD COLUMN label TEXT NOT NULL DEFAULT 'plan';" };
        conn.execute_batch(&format!(
            "BEGIN; {tasks} {documents}
             UPDATE documents SET label=(SELECT t.task_type FROM tasks t WHERE t.id=documents.task_id)
               WHERE (SELECT t.task_type FROM tasks t WHERE t.id=documents.task_id) IN ('plan','artifact','diagram');
             DROP INDEX IF EXISTS documents_task;
             CREATE UNIQUE INDEX documents_task ON documents(task_id, label, version);
             UPDATE tasks SET labels=json_array(task_type), work_dir=COALESCE(work_dir, 'documents/' || id), task_type=NULL
               WHERE task_type IN ('plan','artifact','diagram');
             PRAGMA user_version=59; COMMIT;"
        ))?;
    }
    if version < 60 {
        // Whether a project's tasks' pull requests are watched while they're in review (see
        // Project::watch_pull_requests), off until it's turned on.
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('projects') WHERE name='watch_pull_requests'", [], |r| r.get(0))?;
        let add = if has { "" } else { "ALTER TABLE projects ADD COLUMN watch_pull_requests TEXT NOT NULL DEFAULT 'off';" };
        conn.execute_batch(&format!("BEGIN; {add} PRAGMA user_version=60; COMMIT;"))?;
    }
    if version < 61 {
        // The thread that helps get a project's folder ready for worktrees (see Project::setup_task_id).
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('projects') WHERE name='setup_task_id'", [], |r| r.get(0))?;
        let add = if has { "" } else { "ALTER TABLE projects ADD COLUMN setup_task_id TEXT;" };
        conn.execute_batch(&format!("BEGIN; {add} PRAGMA user_version=61; COMMIT;"))?;
    }
    if version < 62 {
        // The devices that get this board's notifications by Web Push (see integrations/push.rs).
        conn.execute_batch(
            "BEGIN;
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
             PRAGMA user_version=62; COMMIT;",
        )?;
    }
    if version < 63 {
        // Where a project's tasks' pull requests are previewed (see Project::pr_preview_url).
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('projects') WHERE name='pr_preview_url'", [], |r| r.get(0))?;
        let add = if has { "" } else { "ALTER TABLE projects ADD COLUMN pr_preview_url TEXT;" };
        conn.execute_batch(&format!("BEGIN; {add} PRAGMA user_version=63; COMMIT;"))?;
    }
    if version < 64 {
        // Runs are looked up by task (the latest one, every minute for idle sessions; whether one is
        // active) and prompts counted by task on every task read; both tables only grow.
        conn.execute_batch(
            "BEGIN;
             CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, created_at);
             CREATE INDEX IF NOT EXISTS permission_requests_task ON permission_requests(task_id, status);
             PRAGMA user_version=64; COMMIT;",
        )?;
    }
    if version < 65 {
        // When the usage limit a task's agent ran out of resets (see Task::limit_reset_at), and what
        // a profile's tasks do when their config runs out (see Profile::limit_wait). Added only if
        // they aren't there, in case another migration takes this version first.
        conn.execute_batch("BEGIN;")?;
        for (table, column, kind) in [("tasks", "limit_reset_at", "TEXT"), ("profiles", "limit_wait", "INTEGER NOT NULL DEFAULT 0"), ("profiles", "limit_switch", "INTEGER NOT NULL DEFAULT 0")] {
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name=?2", params![table, column], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {kind};"))?;
            }
        }
        conn.execute_batch("PRAGMA user_version=65; COMMIT;")?;
    }
    if version < 66 {
        // Ignored files copied, and folders linked, into each new task worktree (see git/worktree_files.rs).
        let mut add = String::new();
        for col in ["copy_files", "link_folders"] {
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('projects') WHERE name=?1", [col], |r| r.get(0))?;
            if !has {
                add.push_str(&format!("ALTER TABLE projects ADD COLUMN {col} TEXT NOT NULL DEFAULT '';"));
            }
        }
        conn.execute_batch(&format!("BEGIN; {add} PRAGMA user_version=66; COMMIT;"))?;
    }
    if version < 67 {
        // A summary of each task's changes once its review passes (see review/summary.rs): whether a
        // project makes them and who writes them, and the task's latest. Added only if they
        // aren't there, in case another migration takes this version first.
        conn.execute_batch("BEGIN;")?;
        for (table, column, kind) in [("projects", "auto_summary", "INTEGER NOT NULL DEFAULT 1"), ("projects", "summarizer", "TEXT"), ("tasks", "summary", "TEXT")] {
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name=?2", params![table, column], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {kind};"))?;
            }
        }
        conn.execute_batch("PRAGMA user_version=67; COMMIT;")?;
    }
    if version < 68 {
        // Whether a project's agents open pull requests for their tasks, and for its subprojects'
        // tasks (see Project::pull_requests), on until they're turned off. Added only if they
        // aren't there, in case another migration takes this version first.
        conn.execute_batch("BEGIN;")?;
        for col in ["pull_requests", "subproject_pull_requests"] {
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('projects') WHERE name=?1", [col], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE projects ADD COLUMN {col} INTEGER NOT NULL DEFAULT 1;"))?;
            }
        }
        conn.execute_batch("PRAGMA user_version=68; COMMIT;")?;
    }
    if version < 69 {
        // How big threads' contexts get and when they're compacted (see context::record_turn),
        // with the compactions threads already show.
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V69} {BACKFILL_V69}"))?;
        for column in ["turn_start_tokens", "turn_tokens"] {
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('runs') WHERE name=?1", [column], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE runs ADD COLUMN {column} INTEGER;"))?;
            }
        }
        conn.execute_batch("PRAGMA user_version=69; COMMIT;")?;
    }
    if version < 70 {
        // Who reviews and summarises the tasks of a profile's projects that don't choose their own
        // (see Profile::reviewers). Added only if they aren't there, in case another migration
        // takes this version first.
        conn.execute_batch("BEGIN;")?;
        for col in ["reviewers", "summarizer"] {
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('profiles') WHERE name=?1", [col], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE profiles ADD COLUMN {col} TEXT;"))?;
            }
        }
        conn.execute_batch("PRAGMA user_version=70; COMMIT;")?;
    }
    if version < 71 {
        // Whether the board starts a config's next 5-hour window as soon as one ends (see
        // agent/window.rs); off until the user turns it on. Added only if it isn't there, in case
        // another migration takes this version first (tables created by migrate_claude_configs
        // since have it already).
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('claude_configs') WHERE name='restart_window'", [], |r| r.get(0))?;
        let add = if has { "" } else { "ALTER TABLE claude_configs ADD COLUMN restart_window INTEGER NOT NULL DEFAULT 0;" };
        conn.execute_batch(&format!("BEGIN; {add} PRAGMA user_version=71; COMMIT;"))?;
    }
    if version < 72 {
        // Whether a profile's and a project's merges wait for the user's approval, and where a
        // task's merge is with it (see review/merge_gate.rs). Added only if they aren't there, in case
        // another migration takes this version first.
        conn.execute_batch("BEGIN;")?;
        for (table, column, kind) in [("profiles", "merge_approval", "INTEGER NOT NULL DEFAULT 0"), ("projects", "merge_approval", "INTEGER"), ("tasks", "merge_approval", "TEXT")] {
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name=?2", params![table, column], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {kind};"))?;
            }
        }
        conn.execute_batch("PRAGMA user_version=72; COMMIT;")?;
    }
    if version < 73 {
        // The Claude Code session a run is in and its total cost as it last said, which a run that
        // resumes the session goes on from (see db::add_cost), and the costs counted twice before.
        // Added only if they aren't there, in case another migration takes this version first.
        conn.execute_batch("BEGIN;")?;
        for column in ["session_id TEXT", "session_cost REAL"] {
            let name = column.split(' ').next().unwrap();
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('runs') WHERE name=?1", [name], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE runs ADD COLUMN {column};"))?;
            }
        }
        recount_run_costs(&conn)?;
        conn.execute_batch("PRAGMA user_version=73; COMMIT;")?;
    }
    if version < 74 {
        // How a task's pull request's checks stood at the latest read (see Task::pr_checks).
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('tasks') WHERE name='pr_checks'", [], |r| r.get(0))?;
        let add = if has { "" } else { "ALTER TABLE tasks ADD COLUMN pr_checks TEXT;" };
        conn.execute_batch(&format!("BEGIN; {add} PRAGMA user_version=74; COMMIT;"))?;
    }
    if version < 75 {
        // Whether a task needs an approving review on its pull request to go to "Ready for merge".
        conn.execute_batch("BEGIN;")?;
        for (table, kind) in [("profiles", "INTEGER NOT NULL DEFAULT 0"), ("projects", "INTEGER")] {
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name='require_pr_approval'", [table], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN require_pr_approval {kind};"))?;
            }
        }
        conn.execute_batch("PRAGMA user_version=75; COMMIT;")?;
    }
    if version < 76 {
        // What a task's worktree starts from, when not the project's base branch (see Task::start_from).
        // Builds of this before it was version 76 had it as version 65, 71, 73, 74 or 75, and skipped what those
        // versions add, so their columns are added here too if they aren't there (and 73's recount).
        conn.execute_batch("BEGIN;")?;
        let cols = [
            ("tasks", "start_from", "TEXT"),
            ("tasks", "limit_reset_at", "TEXT"),
            ("profiles", "limit_wait", "INTEGER NOT NULL DEFAULT 0"),
            ("profiles", "limit_switch", "INTEGER NOT NULL DEFAULT 0"),
            ("claude_configs", "restart_window", "INTEGER NOT NULL DEFAULT 0"),
            ("tasks", "pr_checks", "TEXT"),
            ("profiles", "require_pr_approval", "INTEGER NOT NULL DEFAULT 0"),
            ("projects", "require_pr_approval", "INTEGER"),
        ];
        for (table, column, kind) in cols {
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name=?2", params![table, column], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {kind};"))?;
            }
        }
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('runs') WHERE name='session_id'", [], |r| r.get(0))?;
        if !has {
            conn.execute_batch("ALTER TABLE runs ADD COLUMN session_id TEXT; ALTER TABLE runs ADD COLUMN session_cost REAL;")?;
            recount_run_costs(&conn)?;
        }
        conn.execute_batch("PRAGMA user_version=76; COMMIT;")?;
    }
    if version < 77 {
        // When a task went into "now" (see Task::now_at); the others are in "later". Added only if it isn't
        // there, in case another migration takes this version first.
        conn.execute_batch("BEGIN;")?;
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('tasks') WHERE name='now_at'", [], |r| r.get(0))?;
        if !has {
            conn.execute_batch("ALTER TABLE tasks ADD COLUMN now_at TEXT;")?;
        }
        conn.execute_batch("PRAGMA user_version=77; COMMIT;")?;
    }
    if version < 79 {
        // The tokens each run used, per model (see agent/tokens.rs), counted from runs' output as
        // they end (and from older runs' that are still kept), and what reviewers reported (see
        // review/stats.rs), with the reviews threads already show. Added only if they aren't
        // there, in case another migration takes this version first. Builds of this before it was
        // version 79 had it as version 74, 75, 76 or 78, and skipped what the versions below theirs
        // add (a database can have taken it as 75, then 76, then 78, skipping them all), or added
        // less than this does: 74's, 75's and 76's columns are added here if they aren't there, as
        // are the runs' usage columns, and a `review_stats` from before its rounds were kept is
        // made again.
        conn.execute_batch("BEGIN;")?;
        let cols = [
            ("tasks", "pr_checks", "TEXT"),
            ("profiles", "require_pr_approval", "INTEGER NOT NULL DEFAULT 0"),
            ("projects", "require_pr_approval", "INTEGER"),
            ("tasks", "start_from", "TEXT"),
        ];
        for (table, column, kind) in cols {
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name=?2", params![table, column], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {kind};"))?;
            }
        }
        let stale: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='review_stats') AND NOT EXISTS(SELECT 1 FROM pragma_table_info('review_stats') WHERE name='round')",
            [],
            |r| r.get(0),
        )?;
        if stale {
            conn.execute_batch("DROP TABLE review_stats;")?;
        }
        conn.execute_batch(SCHEMA_V79)?;
        for column in ["usage_at TEXT", "usage_session TEXT", "usage_snapshot TEXT", "usage_tail TEXT"] {
            let name = column.split(' ').next().unwrap();
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('runs') WHERE name=?1", [name], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE runs ADD COLUMN {column};"))?;
            }
        }
        crate::review::stats::backfill(&conn)?;
        conn.execute_batch("PRAGMA user_version=79; COMMIT;")?;
    }
    if version < 80 {
        // The tokens of model calls that aren't runs: task titles and 5-hour window restarts (see
        // agent/tokens/calls.rs).
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V80} PRAGMA user_version=80; COMMIT;"))?;
    }
    if version < 81 {
        // Which call each `call_usage` row is from (a call has a row for each model it used). The
        // rows written before were one call's if they agree on all but the model.
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('call_usage') WHERE name='call_id'", [], |r| r.get(0))?;
        let add = if has { "" } else { "ALTER TABLE call_usage ADD COLUMN call_id TEXT;" };
        conn.execute_batch(&format!(
            "BEGIN; {add}
             UPDATE call_usage SET call_id=lower(hex(randomblob(16))) WHERE call_id IS NULL AND id IN (SELECT MIN(id) FROM call_usage WHERE call_id IS NULL GROUP BY at, purpose, task_id, config_id);
             UPDATE call_usage SET call_id=(SELECT c.call_id FROM call_usage c WHERE c.id=(SELECT MIN(d.id) FROM call_usage d WHERE d.at=call_usage.at
               AND d.purpose=call_usage.purpose AND d.task_id IS call_usage.task_id AND d.config_id IS call_usage.config_id)) WHERE call_id IS NULL;
             PRAGMA user_version=81; COMMIT;"
        ))?;
    }
    if version < 82 {
        // The effort the reviewed task's agent worked at when its review was submitted (see review/stats.rs). The rows
        // from before are given the task's effort now, which is what it was unless the user changed it since. Added only
        // if it isn't there: a `review_stats` made at version 79 or later by this build has it already.
        conn.execute_batch("BEGIN;")?;
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('review_stats') WHERE name='effort'", [], |r| r.get(0))?;
        if !has {
            conn.execute_batch("ALTER TABLE review_stats ADD COLUMN effort TEXT;")?;
            crate::review::stats::backfill_efforts(&conn)?;
        }
        conn.execute_batch("PRAGMA user_version=82; COMMIT;")?;
    }
    if version < 83 {
        // The effort each run was started with, as its agent was given it (see runner/launch.rs): an empty one is the
        // agent's own default, and null a run from before this, whose reviews' efforts are their tasks' (see review/stats.rs).
        conn.execute_batch("BEGIN;")?;
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('runs') WHERE name='effort'", [], |r| r.get(0))?;
        if !has {
            conn.execute_batch("ALTER TABLE runs ADD COLUMN effort TEXT;")?;
        }
        conn.execute_batch("PRAGMA user_version=83; COMMIT;")?;
    }
    if version < 84 {
        // Several summarizers for a project or profile (see Project::summarizers). The `summarizer`
        // saved before is read as the only one until they're saved again. Added only if they
        // aren't there, in case another migration takes this version first.
        conn.execute_batch("BEGIN;")?;
        for table in ["projects", "profiles"] {
            let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name='summarizers'", [table], |r| r.get(0))?;
            if !has {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN summarizers TEXT;"))?;
            }
        }
        conn.execute_batch("PRAGMA user_version=84; COMMIT;")?;
    }
    if version < 85 {
        // Git repositories that global skills come from (see agent/agent_tools/sources.rs). A guard
        // for a database that got `agent_skills.source_id` and then lost its version.
        let has: bool = conn.query_row("SELECT COUNT(*) > 0 FROM pragma_table_info('agent_skills') WHERE name='source_id'", [], |r| r.get(0))?;
        let add = if has { "" } else { SCHEMA_V85_COLUMNS };
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V85} {add} PRAGMA user_version=85; COMMIT;"))?;
    }
    if version < 86 {
        // The board skills a review or summary thread was given on top of its project's (see review::start).
        conn.execute_batch(&format!("BEGIN; {SCHEMA_V86} PRAGMA user_version=86; COMMIT;"))?;
    }
    Ok(conn)
}

/// The latest database version (`PRAGMA user_version`).
#[cfg(test)]
pub const VERSION: i64 = 86;

/// The board skills (by name) a review or summary thread has on top of its project's, from its
/// reviewer's `skills` when the review started (see agent/agent_tools.rs, `for_run`).
const SCHEMA_V86: &str = r#"
CREATE TABLE IF NOT EXISTS review_thread_skills (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  skills TEXT NOT NULL DEFAULT '[]'
);
"#;

/// What each run used of each model (see agent/tokens.rs): `input_tokens` is what wasn't read
/// from or written to the cache, and `reasoning_tokens` is the part of `output_tokens` the model
/// thought in. `estimated` rows are guesses: a run whose output was gone has its cost and no
/// tokens. A run's `usage_at` says when it was counted, and `usage_session` and `usage_snapshot`
/// the totals its agent's session (or Codex's threads) had reached, which a later run that resumes
/// the session goes on from; `usage_tail` the part of them its requests after its last result add.
///
/// `review_stats` has a row for each `submit_review` (see review/stats.rs), for the task reviewed,
/// with when its review round started (`round`).
/// `minor` is how many minor issues it listed, null for reviews from before they were listed;
/// `minor_noted` whether it found any or its summary mentions them. `effort` (version 82) is the effort
/// the reviewed task's agent was set to work at, null for the agent's own default.
const SCHEMA_V79: &str = r#"
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
"#;

/// What each model call that isn't a run used (see agent/tokens/calls.rs), counted as
/// `token_usage` is: `purpose` `title` for a task's title, written for task `task_id`, and `window`
/// for the prompt that restarts config `config_id`'s 5-hour window. `cost_usd` is null for Codex,
/// which doesn't say. From version 81, `call_id` says which call a row is from: a call has a row
/// for each model it used, and they share it.
const SCHEMA_V80: &str = r#"
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
"#;

/// A row for the end of each agent turn (`kind` `turn`: `tokens` is the context it left and
/// `start_tokens` what its first request to the model held) and for
/// each compaction (`compact`: `tokens` before it and `post_tokens` after, and its `source`:
/// `auto` when the agent compacted by itself as its context filled up, `user` for a `/compact`,
/// `idle` for the board's after a session sat idle). See agent/context.rs. A run's `turn_start_tokens`
/// and `turn_tokens` follow its current turn's requests to the model, until the turn's row is written.
const SCHEMA_V69: &str = r#"
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
"#;

/// The compactions in threads from before `context_stats`, each with the run it was in (the
/// task's latest to start before it). Its source is worked out as context::compaction_source does.
const BACKFILL_V69: &str = r#"
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
"#;

/// Checkpoints of a task's worktree (see git/checkpoints.rs), each kept as a commit under
/// `refs/huntaway/checkpoints/<task>/<n>` in its repository.
const SCHEMA_V58: &str = r#"
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
"#;

/// Automations, which create a task or message one on a schedule or when a webhook is
/// delivered, and their runs (including webhook deliveries that didn't run). See integrations/automations.rs.
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

/// Until version 73 a run's `cost_usd` was its session's total as Claude Code last said it, and
/// the task was charged what that went up by in the run, from nothing: so a run that resumed a
/// session charged the task for all of the session's earlier runs again (see db::add_cost). Each
/// run's cost becomes what the session's total went up by in it, and its task's cost and its
/// first turn's (in `context_stats`) lose what they were charged twice.
///
/// Runs don't say which session they were in, but a thread's session is only replaced by a review
/// round or a summary (a review run, see review.rs) or a rewind that starts a new conversation
/// (its event says so, see checkpoints::handlers): any other run resumes the session its thread's
/// previous run was in. Checkpoints say the session of the runs they were taken in, which starts
/// a new one where it changes; and a total lower than the session's last means Claude Code
/// started counting again. A run with no total (it ended before its first result) is left out.
/// The runs of the thread's current session are put in it, so the next one's goes on from them.
fn recount_run_costs(c: &Connection) -> Result<()> {
    struct R {
        id: String,
        task_id: String,
        kind: String,
        cost: f64,
        created_at: String,
        session: Option<String>,
    }
    let mut st = c.prepare(
        "SELECT r.id, r.task_id, r.kind, r.cost_usd, r.created_at,
           (SELECT k.session FROM checkpoints k WHERE k.task_id=r.task_id AND k.run_id=r.id AND k.session IS NOT NULL ORDER BY k.n DESC LIMIT 1)
         FROM runs r ORDER BY r.task_id, r.rowid",
    )?;
    let runs: Vec<R> = st
        .query_map([], |r| Ok(R { id: r.get(0)?, task_id: r.get(1)?, kind: r.get(2)?, cost: r.get(3)?, created_at: r.get(4)?, session: r.get(5)? }))?
        .collect::<rusqlite::Result<_>>()?;
    let mut rewinds = c.prepare(
        "SELECT created_at FROM messages WHERE task_id=?1 AND kind='event'
           AND json_extract(data, '$.text') LIKE 'Rewound to before turn %the next message starts a new conversation%'",
    )?;
    for task in runs.chunk_by(|a, b| a.task_id == b.task_id) {
        let task_id = &task[0].task_id;
        let session: Option<String> = c.query_row("SELECT session_id FROM tasks WHERE id=?1", [task_id], |r| r.get(0)).optional()?.flatten();
        let fresh: Vec<String> = rewinds.query_map([task_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        // The session's total before each run, where the latest session started and what it's
        // known to be.
        let (mut total, mut start, mut known, mut twice) = (0.0, 0, None, 0.0);
        for (i, run) in task.iter().enumerate() {
            let rewound = i > 0 && fresh.iter().any(|at| *at > task[i - 1].created_at && *at < run.created_at);
            let other = known.is_some() && run.session.is_some() && known != run.session.as_ref();
            if run.kind == "review" || rewound || other || (run.cost > 0.0 && run.cost < total) {
                (total, start, known) = (0.0, i, None);
            }
            known = run.session.as_ref().or(known);
            if run.cost <= 0.0 {
                continue;
            }
            let before = total;
            total = run.cost;
            if before > 0.0 {
                twice += before;
                c.execute("UPDATE runs SET cost_usd=?1 WHERE id=?2", params![run.cost - before, run.id])?;
                c.execute(
                    "UPDATE context_stats SET cost_usd=MAX(cost_usd-?1, 0) WHERE id=(SELECT MIN(id) FROM context_stats WHERE run_id=?2 AND kind='turn') AND cost_usd >= ?1",
                    params![before, run.id],
                )?;
            }
        }
        if twice > 0.0 {
            c.execute("UPDATE tasks SET cost_usd=MAX(cost_usd-?1, 0) WHERE id=?2", params![twice, task_id])?;
        }
        // Unless the latest runs are known to have been in another session.
        if let Some(session) = session.as_ref().filter(|s| known.is_none_or(|k| k == *s)) {
            for run in &task[start..] {
                // Its old cost was the session's total.
                c.execute("UPDATE runs SET session_id=?1, session_cost=?2 WHERE id=?3", params![session, (run.cost > 0.0).then_some(run.cost), run.id])?;
            }
        }
    }
    Ok(())
}

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

/// Claude configs become their own list, which profiles (and projects, to override) pick
/// from. Each config directory profiles used becomes a config named after the first profile
/// that had it, and the profiles pick it. Their threads keep it too, so changing a profile's
/// or project's configs later doesn't move a conversation away from the config it's in.
pub(super) fn migrate_claude_configs(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "BEGIN;
         CREATE TABLE claude_configs (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           config_dir TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL,
           agent TEXT NOT NULL DEFAULT 'claude',
           show_usage INTEGER NOT NULL DEFAULT 0,
           restart_window INTEGER NOT NULL DEFAULT 0
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

/// Skill sources: git repositories whose skills the host offers as global skills. `git_ref` is the
/// branch or tag cloned (null: the default branch), `notes` a JSON list of what a refresh skipped, and
/// `error` why the last refresh failed. A skill from one has `source_id` and its folder in the clone.
const SCHEMA_V85: &str = r#"
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
"#;
const SCHEMA_V85_COLUMNS: &str = "ALTER TABLE agent_skills ADD COLUMN source_id TEXT REFERENCES skill_sources(id) ON DELETE CASCADE;
ALTER TABLE agent_skills ADD COLUMN source_path TEXT;";

/// Per-project skills and MCP servers (see agent/agent_tools.rs).
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
/// switch a global one on by default, which its projects can override (see agent/agent_tools.rs).
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
