import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { migration } from "../src/platform/migration.ts"

/**
 * The whole schema (docs/plan/04-database.md, The schema): the old database's final tables (docs/plan/inventory/09-data-model.md,
 * section 3a) with the changes the plan lists. Every table is STRICT. Statements run one by one, in this order.
 */
const statements: ReadonlyArray<string> = [
  // Profiles and agent configs (profiles area)
  `CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    default_model TEXT,
    created_at TEXT NOT NULL,
    claude_config_ids TEXT NOT NULL DEFAULT '[]',
    agent_access TEXT NOT NULL DEFAULT '[]',
    github_account TEXT,
    clone_dir TEXT,
    asana_token TEXT,
    asana_user TEXT,
    asana_enabled INTEGER NOT NULL DEFAULT 1,
    limit_wait INTEGER NOT NULL DEFAULT 0,
    limit_switch INTEGER NOT NULL DEFAULT 0,
    reviewers TEXT,
    summarizers TEXT,
    merge_approval INTEGER NOT NULL DEFAULT 0,
    require_pr_approval INTEGER NOT NULL DEFAULT 0,
    assistant_host TEXT,
    assistant_config_id TEXT,
    threads_config_id TEXT,
    telemetry INTEGER NOT NULL DEFAULT 0,
    telemetry_titles INTEGER NOT NULL DEFAULT 1,
    tint TEXT,
    approval_rules TEXT
  ) STRICT`,

  `CREATE TABLE agent_configs (
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
  ) STRICT`,

  // Projects (projects area)
  `CREATE TABLE projects (
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
    created_at TEXT NOT NULL,
    auto_review INTEGER NOT NULL DEFAULT 1,
    review_rounds INTEGER NOT NULL DEFAULT 2,
    claude_config_ids TEXT,
    start_prompt TEXT,
    review_prompt TEXT,
    merge_prompt TEXT,
    reviewers TEXT,
    group_name TEXT,
    status_script TEXT NOT NULL DEFAULT '',
    status_scripts TEXT NOT NULL DEFAULT '{}',
    former_keys TEXT NOT NULL DEFAULT '[]',
    repo_root TEXT,
    archived_at TEXT,
    github_account TEXT,
    done_when_merged INTEGER NOT NULL DEFAULT 1,
    watch_pull_requests TEXT NOT NULL DEFAULT 'off',
    setup_task_id TEXT,
    pr_preview_url TEXT,
    copy_files TEXT NOT NULL DEFAULT '',
    link_folders TEXT NOT NULL DEFAULT '',
    auto_summary INTEGER NOT NULL DEFAULT 1,
    summarizers TEXT,
    pull_requests INTEGER NOT NULL DEFAULT 1,
    merge_approval INTEGER,
    require_pr_approval INTEGER,
    use_workflows INTEGER NOT NULL DEFAULT 0,
    is_git INTEGER NOT NULL DEFAULT 0,
    has_commits INTEGER NOT NULL DEFAULT 0
  ) STRICT`,

  // Tasks, and the messages waiting for or steered into their runs (tasks area)
  `CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'task',
    parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    group_name TEXT,
    created_by TEXT,
    task_type TEXT,
    labels TEXT NOT NULL DEFAULT '[]',
    work_dir TEXT,
    document_at TEXT,
    number INTEGER NOT NULL DEFAULT 0,
    pen_id TEXT,
    fanout_id TEXT,
    position REAL NOT NULL DEFAULT 0,

    title TEXT NOT NULL,
    title_pinned INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    resolution TEXT,
    done_at TEXT,
    attention_reason TEXT,
    starred INTEGER NOT NULL DEFAULT 0,
    remind_at TEXT,
    reminder TEXT,
    preview_url TEXT,
    pr_url TEXT,
    pr_checks TEXT,
    external_links TEXT,
    todos TEXT,
    tracked TEXT,
    context TEXT,
    context_detail TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    last_activity_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    use_worktree INTEGER NOT NULL DEFAULT 0,
    worktree_path TEXT,
    branch TEXT,
    base_branch TEXT,
    worktree_state TEXT NOT NULL DEFAULT 'none',
    worktree_error TEXT,
    start_from TEXT,
    merges_into TEXT,
    carries TEXT,
    restack TEXT,
    github_stack INTEGER,
    stack_title TEXT,
    stack_description TEXT,
    stack_pinned INTEGER NOT NULL DEFAULT 0,
    stack_input TEXT,
    stack_run TEXT,
    merging INTEGER NOT NULL DEFAULT 0,
    remerge INTEGER NOT NULL DEFAULT 0,
    merge_approval TEXT,
    depends_on TEXT NOT NULL DEFAULT '[]',
    waiting INTEGER NOT NULL DEFAULT 0,

    session_id TEXT,
    running INTEGER NOT NULL DEFAULT 0,
    run_started_at TEXT,
    limit_reset_at TEXT,
    agent_wait TEXT,
    background_work TEXT,
    servers TEXT,
    lost_background TEXT,
    steerable INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    effort TEXT,
    permission_mode TEXT,
    claude_config_id TEXT,
    auto_allow TEXT NOT NULL DEFAULT '[]',
    review TEXT,
    summaries TEXT NOT NULL DEFAULT '[]',
    rewind TEXT
  ) STRICT`,
  `CREATE INDEX tasks_project ON tasks(project_id, kind)`,
  `CREATE INDEX tasks_profile ON tasks(profile_id, kind)`,
  `CREATE INDEX tasks_parent ON tasks(parent_id)`,
  `CREATE UNIQUE INDEX tasks_one_assistant ON tasks(profile_id) WHERE task_type = 'assistant'`,
  `CREATE UNIQUE INDEX tasks_one_pens_thread ON tasks(profile_id) WHERE task_type = 'pens'`,
  `CREATE INDEX tasks_pen ON tasks(pen_id) WHERE pen_id IS NOT NULL`,
  `CREATE INDEX tasks_merges_into ON tasks(merges_into) WHERE merges_into IS NOT NULL`,

  `CREATE TABLE task_queue (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    automation_run_id TEXT,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX task_queue_task ON task_queue(task_id, seq)`,

  `CREATE TABLE task_steers (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    automation_run_id TEXT,
    written INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX task_steers_task ON task_steers(task_id, seq)`,

  // Board-wide counters: 'thread_write', the write number (platform)
  `CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT`,

  // Threads: items, requests, the event log (threads area)
  `CREATE TABLE threads (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE thread_items (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    pos INTEGER NOT NULL,
    type TEXT NOT NULL,
    parent_id TEXT,
    write_no INTEGER,
    data TEXT NOT NULL,
    meta TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, id)
  ) STRICT, WITHOUT ROWID`,
  `CREATE UNIQUE INDEX thread_items_pos ON thread_items(task_id, pos)`,
  // Partial so that a query for one task's items never picks it (inventory 09, section 9: query-plan traps).
  `CREATE INDEX thread_items_user_time ON thread_items(type, created_at) WHERE type = 'user_message'`,

  `CREATE TABLE thread_requests (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    pos INTEGER NOT NULL,
    type TEXT NOT NULL,
    tool_call_id TEXT,
    write_no INTEGER,
    open INTEGER NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, id)
  ) STRICT, WITHOUT ROWID`,
  `CREATE UNIQUE INDEX thread_requests_pos ON thread_requests(task_id, pos)`,

  `CREATE TABLE thread_events (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, seq)
  ) STRICT`,

  `CREATE TABLE thread_tools (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    skills TEXT NOT NULL DEFAULT '[]',
    disabled_mcp_servers TEXT NOT NULL DEFAULT '[]'
  ) STRICT`,

  // Runs and what they cost (agents area). "Later run" is the larger seq.
  `CREATE TABLE runs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'prompt',
    status TEXT NOT NULL,
    out_offset INTEGER NOT NULL DEFAULT 0,
    stop TEXT NOT NULL DEFAULT 'none',
    stop_id TEXT,
    attention TEXT,
    result_error TEXT,
    saw_result INTEGER NOT NULL DEFAULT 0,
    finished INTEGER NOT NULL DEFAULT 0,
    between_turns INTEGER NOT NULL DEFAULT 0,
    write_no INTEGER,
    agent_at TEXT,
    turn_start_tokens INTEGER,
    turn_tokens INTEGER,
    session_id TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    session_cost REAL,
    usage_at TEXT,
    usage_session TEXT,
    usage_snapshot TEXT,
    usage_tail TEXT,
    effort TEXT,
    config_dir TEXT,
    board_tools INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    ended_at TEXT
  ) STRICT`,
  `CREATE INDEX runs_status ON runs(status)`,
  `CREATE INDEX runs_task ON runs(task_id, created_at)`,

  `CREATE TABLE token_usage (
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
    cache_write_1h_tokens INTEGER,
    cache_write_5m_tokens INTEGER,
    PRIMARY KEY (run_id, model)
  ) STRICT`,

  `CREATE TABLE call_usage (
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
    cost_usd REAL,
    call_id TEXT,
    cache_write_1h_tokens INTEGER,
    cache_write_5m_tokens INTEGER
  ) STRICT`,
  `CREATE INDEX call_usage_time ON call_usage(at)`,
  `CREATE INDEX call_usage_task ON call_usage(task_id)`,

  `CREATE TABLE context_stats (
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
  ) STRICT`,
  `CREATE INDEX context_stats_time ON context_stats(at)`,
  `CREATE INDEX context_stats_task ON context_stats(task_id, at)`,

  // Git checkpoints of a task's turns (git area)
  `CREATE TABLE checkpoints (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    kind TEXT NOT NULL,
    sha TEXT NOT NULL,
    tree TEXT NOT NULL,
    head TEXT,
    before_n INTEGER,
    run_id TEXT,
    turn INTEGER,
    write_no INTEGER,
    status TEXT,
    session TEXT,
    agent_at TEXT,
    stats TEXT,
    stale INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, n)
  ) STRICT`,

  // Reviews, pull requests and task documents (review area)
  `CREATE TABLE review_stats (
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
  ) STRICT`,
  `CREATE INDEX review_stats_task ON review_stats(task_id, at)`,
  `CREATE INDEX review_stats_time ON review_stats(at)`,

  `CREATE TABLE pr_watches (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    pr TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, pr)
  ) STRICT`,

  `CREATE TABLE pr_states (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    pr_url TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, pr_url)
  ) STRICT`,

  `CREATE TABLE documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT 'plan',
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    open INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX documents_task ON documents(task_id, label, version)`,

  // Permissions, board-tool calls and the approval log (mcp area)
  `CREATE TABLE permission_requests (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    write_no INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    input TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    kind TEXT NOT NULL DEFAULT 'tool',
    call_id TEXT,
    note TEXT,
    expires_at TEXT,
    rule TEXT,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX permission_requests_call ON permission_requests(call_id)`,
  `CREATE INDEX permission_requests_task ON permission_requests(task_id, status)`,
  `CREATE INDEX permission_requests_expiry ON permission_requests(expires_at) WHERE status = 'pending' AND expires_at IS NOT NULL`,

  // No foreign keys: pruned by time.
  `CREATE TABLE mcp_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'executing',
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE approval_log (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    request_id TEXT,
    tool_name TEXT NOT NULL,
    summary TEXT NOT NULL,
    rule TEXT NOT NULL,
    decision TEXT NOT NULL,
    outcome TEXT NOT NULL,
    answered_by TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  ) STRICT`,
  `CREATE INDEX approval_log_profile ON approval_log(profile_id, created_at)`,
  `CREATE INDEX approval_log_request ON approval_log(request_id)`,

  // Computer use (desktop area)
  `CREATE TABLE desktop_ops (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    run_id TEXT,
    op_id TEXT,
    tool TEXT NOT NULL,
    summary TEXT NOT NULL,
    args TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    boot TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT
  ) STRICT`,
  `CREATE UNIQUE INDEX desktop_ops_op ON desktop_ops(task_id, op_id) WHERE op_id IS NOT NULL`,
  `CREATE INDEX desktop_ops_task ON desktop_ops(task_id, created_at)`,

  // Skills, MCP servers and their switches (agent tools area). The switches have no foreign keys: triggers clean them.
  `CREATE TABLE skill_sources (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    git_ref TEXT,
    subdir TEXT,
    name TEXT NOT NULL,
    commit_sha TEXT,
    synced_at TEXT,
    error TEXT,
    notes TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE agent_skills (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    source_id TEXT REFERENCES skill_sources(id) ON DELETE CASCADE,
    source_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX agent_skills_name ON agent_skills(ifnull(project_id, ''), name)`,

  `CREATE TABLE agent_mcp_servers (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    auto_allow INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX agent_mcp_servers_name ON agent_mcp_servers(ifnull(project_id, ''), name)`,

  `CREATE TABLE agent_tool_switches (
    scope TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    PRIMARY KEY (scope, scope_id, item_id)
  ) STRICT`,
  `CREATE TRIGGER agent_tool_switches_profile AFTER DELETE ON profiles BEGIN
    DELETE FROM agent_tool_switches WHERE scope = 'profile' AND scope_id = OLD.id;
  END`,
  `CREATE TRIGGER agent_tool_switches_project AFTER DELETE ON projects BEGIN
    DELETE FROM agent_tool_switches WHERE scope = 'project' AND scope_id = OLD.id;
  END`,
  `CREATE TRIGGER agent_tool_switches_skill AFTER DELETE ON agent_skills BEGIN
    DELETE FROM agent_tool_switches WHERE item_id = OLD.id;
  END`,
  `CREATE TRIGGER agent_tool_switches_server AFTER DELETE ON agent_mcp_servers BEGIN
    DELETE FROM agent_tool_switches WHERE item_id = OLD.id;
  END`,

  `CREATE TABLE project_agent_tools (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    disabled_skills TEXT NOT NULL DEFAULT '[]',
    disabled_mcp_servers TEXT NOT NULL DEFAULT '[]',
    seen TEXT NOT NULL DEFAULT '{}'
  ) STRICT`,

  // Automations and workflows (integrations area). workflow_runs' seq is the order "later" means.
  `CREATE TABLE automations (
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
  ) STRICT`,
  `CREATE INDEX automations_project ON automations(project_id)`,
  `CREATE INDEX automations_profile ON automations(profile_id)`,

  `CREATE TABLE automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT,
    task_id TEXT,
    agent_run_id TEXT,
    delivery_id TEXT,
    event TEXT,
    count INTEGER NOT NULL DEFAULT 1,
    batch_key TEXT,
    batch_id TEXT,
    payload TEXT,
    due_at TEXT,
    outcome TEXT,
    cost_usd REAL,
    created_at TEXT NOT NULL,
    finished_at TEXT
  ) STRICT`,
  `CREATE INDEX automation_runs_automation ON automation_runs(automation_id, created_at)`,
  `CREATE INDEX automation_runs_status ON automation_runs(status, due_at)`,
  `CREATE INDEX automation_runs_delivery ON automation_runs(automation_id, delivery_id)`,
  `CREATE INDEX automation_runs_task ON automation_runs(task_id)`,
  `CREATE INDEX automation_runs_agent_run ON automation_runs(agent_run_id)`,

  `CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    graph TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX workflows_project ON workflows(project_id)`,

  `CREATE TABLE workflow_runs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
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
  ) STRICT`,
  `CREATE INDEX workflow_runs_task ON workflow_runs(task_id, workflow_id)`,
  `CREATE INDEX workflow_runs_state ON workflow_runs(state)`,

  // Pens (pens area)
  `CREATE TABLE pens (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position REAL NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    color TEXT NOT NULL DEFAULT '',
    thread_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX pens_name ON pens(profile_id, name COLLATE NOCASE)`,

  // Docs, and publishing them to a hosted docs site (docs area)
  `CREATE TABLE docs (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (profile_id, slug)
  ) STRICT`,
  `CREATE INDEX docs_profile_folder ON docs(profile_id, folder)`,

  `CREATE TABLE doc_versions (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    message TEXT,
    task_id TEXT,
    run_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (doc_id, number)
  ) STRICT`,

  `CREATE TABLE doc_pages (
    version_id TEXT NOT NULL REFERENCES doc_versions(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    format TEXT NOT NULL,
    source TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (version_id, path)
  ) STRICT`,

  `CREATE TABLE doc_labels (
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    PRIMARY KEY (doc_id, label)
  ) STRICT`,

  `CREATE TABLE doc_images (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL,
    data BLOB NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, sha256)
  ) STRICT`,

  `CREATE TABLE doc_version_images (
    version_id TEXT NOT NULL REFERENCES doc_versions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (version_id, name)
  ) STRICT`,
  `CREATE INDEX doc_version_images_sha ON doc_version_images(sha256)`,

  `CREATE TABLE doc_comments (
    id INTEGER PRIMARY KEY,
    version_id TEXT NOT NULL REFERENCES doc_versions(id) ON DELETE CASCADE,
    page_path TEXT NOT NULL,
    quote TEXT NOT NULL,
    prefix TEXT NOT NULL DEFAULT '',
    suffix TEXT NOT NULL DEFAULT '',
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT
  ) STRICT`,
  `CREATE INDEX doc_comments_version ON doc_comments(version_id, page_path)`,

  `CREATE TABLE docs_site_clients (
    site_url TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT`,

  // expires_at is milliseconds since the epoch, not a timestamp string.
  `CREATE TABLE docs_site_connections (
    profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    site_url TEXT NOT NULL,
    kind TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at INTEGER,
    login TEXT,
    connected_at TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE docs_site_published (
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    site_url TEXT NOT NULL,
    remote_slug TEXT NOT NULL,
    remote_version INTEGER NOT NULL,
    local_version INTEGER NOT NULL,
    url TEXT NOT NULL,
    version_url TEXT NOT NULL,
    login TEXT,
    published_at TEXT NOT NULL,
    PRIMARY KEY (doc_id, site_url)
  ) STRICT`,

  // Other hosts, paired devices and push (hosts area)
  `CREATE TABLE links (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mode TEXT NOT NULL,
    url TEXT,
    token TEXT,
    ssh TEXT,
    uplink INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT,
    created_at TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE device_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  ) STRICT`,

  `CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'web',
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    device_id TEXT,
    events TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_sent_at TEXT,
    last_error TEXT
  ) STRICT`,

  `CREATE TABLE push_answer_tokens (
    token_hash TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    claimed_at TEXT,
    expires_at TEXT
  ) STRICT`,
  `CREATE INDEX push_answer_tokens_request ON push_answer_tokens(request_id, host_id)`,

  // Host settings, settings synced between hosts, telemetry (platform)
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,

  // changed_at and since are '' for "unknown".
  `CREATE TABLE setting_versions (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    vv TEXT NOT NULL DEFAULT '{}',
    changed_at TEXT NOT NULL DEFAULT '',
    changed_by TEXT NOT NULL DEFAULT '',
    lost TEXT NOT NULL DEFAULT '[]',
    seen TEXT,
    since TEXT NOT NULL DEFAULT ''
  ) STRICT`,

  // AUTOINCREMENT: an id is never reused, because ids are in a batch's dedup token.
  `CREATE TABLE telemetry_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL,
    row TEXT NOT NULL,
    at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX telemetry_outbox_target ON telemetry_outbox(target, id)`,

  // The migration runner's record (platform). The runner makes it before running anything, so it may be here already.
  `CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT`,
]

export default migration({
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of statements) yield* sql.unsafe(statement)
  }),
})
