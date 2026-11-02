//! Tasks: the `Task` row, and queries over tasks, their dependencies and merges.

use super::*;

/// The key scratch tasks' numbers go with (see Task::is_scratch), which no project can have.
pub const SCRATCH_TASK_KEY: &str = "S";

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
    /// What a task is, if not a code task: one of TASK_TYPES (a scratch task, see is_scratch).
    #[serde(default)]
    pub task_type: Option<String>,
    /// Some of LABELS: the documents its agent writes (an HTML plan or artifact, or a Mermaid
    /// diagram) besides its other work, which the board keeps and shows (see documents.rs).
    #[serde(default)]
    pub labels: Vec<String>,
    /// Where the task's agent works, if not where its kind and project say: for a scratch task
    /// made from a scratch chat, the chat's folder, where its conversation is; for a task made as a
    /// plan, artifact or diagram before they were labels, its own folder (relative, in the data
    /// dir; see documents::work_dir). Other scratch tasks work in their own folder too.
    #[serde(default)]
    pub work_dir: Option<String>,
    /// When one of its documents last changed, so clients know to fetch them again.
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
    /// Its agent stepped out of the merge queue while merging it, to fix what the merge turned
    /// up (failing checks, review comments) without holding up the tasks queued behind it. It
    /// works in "In progress" meanwhile, and rejoins the back of the queue when its run ends,
    /// rather than going to "In review" (see runner::finish). Moving it to another column
    /// (bar "Needs attention") drops it.
    #[serde(default)]
    pub remerge: bool,
    /// Where its merge is with the user's approval, when its project asks for it (see
    /// merge_gate.rs): `pending` while its agent summarises what it would merge and the user
    /// decides, `approved` once they have. Cleared when it leaves the merge.
    #[serde(default)]
    pub merge_approval: Option<String>,
    pub attention_reason: Option<String>,
    /// Tasks in the same project that have to be merged (done, resolution `done`) before this
    /// task's agent starts.
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// In "In progress", queued: its agent was asked to start while some of `depends_on`
    /// weren't merged yet, and starts once they are (see runner::start_unblocked).
    #[serde(default)]
    pub waiting: bool,
    /// When the usage limit its agent last ran out of resets (UTC, RFC 3339), set as the run
    /// stops and cleared when the next starts. With `waiting`, the agent carries on then (see
    /// usage.rs); without, the task needs attention and offers to.
    #[serde(default)]
    pub limit_reset_at: Option<String>,
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
    /// The latest summary of its changes, written once its review passed (see summary.rs).
    #[serde(default)]
    pub summary: Option<ChangeSummary>,
    /// How full its agent's context window is, as of its latest reply (see context.rs).
    #[serde(default)]
    pub context: Option<Context>,
    /// The conversation rollback its next run makes, after a rewind (see checkpoints::Rewind).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rewind: Option<crate::checkpoints::Rewind>,
    pub cost_usd: f64,
    pub last_activity_at: String,
    pub created_at: String,
    pub updated_at: String,
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
            labels: json_list(r.get("labels")?),
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
            remerge: r.get("remerge")?,
            merge_approval: r.get("merge_approval")?,
            attention_reason: r.get("attention_reason")?,
            depends_on: json_list(r.get("depends_on")?),
            waiting: r.get("waiting")?,
            limit_reset_at: r.get("limit_reset_at")?,
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
            summary: r.get::<_, Option<String>>("summary")?.and_then(|v| serde_json::from_str(&v).ok()),
            context: r.get::<_, Option<String>>("context")?.and_then(|v| serde_json::from_str(&v).ok()),
            rewind: r.get::<_, Option<String>>("rewind")?.and_then(|v| serde_json::from_str(&v).ok()),
            cost_usd: r.get("cost_usd")?,
            last_activity_at: r.get("last_activity_at")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
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

/// All of a project's threads, whatever their kind.
pub fn project_threads(c: &Connection, project_id: &str) -> Result<Vec<Task>> {
    let mut st = c.prepare("SELECT * FROM tasks WHERE project_id=?1 ORDER BY created_at")?;
    let rows = st.query_map([project_id], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
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

/// Every task on this host (not review threads).
pub fn list_all_tasks(c: &Connection) -> Result<Vec<Task>> {
    let mut st = c.prepare("SELECT * FROM tasks WHERE kind='task'")?;
    let rows = st.query_map([], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn list_tasks_for_profile(c: &Connection, profile_id: &str) -> Result<Vec<Task>> {
    let mut st = c.prepare(
        "SELECT * FROM tasks WHERE profile_id=?1 AND kind='task' ORDER BY project_id, position",
    )?;
    let rows = st.query_map([profile_id], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Tasks in "In review" or "Needs attention" with a pull request, not running or merging, in
/// projects whose merged pull requests move them to Done (see merged.rs).
pub fn tasks_with_open_prs(c: &Connection) -> Result<Vec<Task>> {
    let mut st = c.prepare(
        "SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.kind='task' AND t.status IN ('in_review','needs_attention') AND t.pr_url IS NOT NULL AND t.merging=0 AND t.running=0
           AND t.task_type IS NULL AND p.done_when_merged=1
         ORDER BY t.project_id, t.number",
    )?;
    let rows = st.query_map([], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// The task holding a merge slot: merging, and either running or waiting on the user. Each
/// project has one slot for its top-level tasks and one per subproject (`parent_id`), since
/// those merge into different branches.
pub fn active_merge(c: &Connection, project_id: Option<&str>, parent_id: Option<&str>) -> Result<Option<Task>> {
    Ok(c.query_row(
        "SELECT * FROM tasks WHERE project_id IS ?1 AND parent_id IS ?2 AND kind='task' AND merging=1 AND (running=1 OR status='needs_attention')
           AND merge_approval IS NOT 'pending'
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
           AND merge_approval IS NOT 'pending' AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))
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
           AND merge_approval IS NOT 'pending' AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))",
    )?;
    let rows = st.query_map([project_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// A task's review threads, oldest first, its summary threads (see `summary_threads`) included:
/// they all work in its worktree.
pub fn review_threads(c: &Connection, task_id: &str) -> Result<Vec<Task>> {
    let mut st = c.prepare("SELECT * FROM tasks WHERE parent_id=?1 AND kind='review' ORDER BY created_at, number")?;
    let rows = st.query_map([task_id], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// A task's summary threads (review threads that summarise its changes, see summary.rs), oldest first.
pub fn summary_threads(c: &Connection, task_id: &str) -> Result<Vec<Task>> {
    let mut st = c.prepare("SELECT * FROM tasks WHERE parent_id=?1 AND kind='review' AND task_type='summary' ORDER BY created_at, number")?;
    let rows = st.query_map([task_id], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// The tasks made together from one prompt (`fanout_id`, see api::CreateTask) in a profile, in the order they were made.
pub fn fanout_tasks(c: &Connection, profile_id: &str, fanout_id: &str) -> Result<Vec<Task>> {
    let mut st = c.prepare("SELECT * FROM tasks WHERE profile_id=?1 AND fanout_id=?2 AND kind='task' ORDER BY created_at, number")?;
    let rows = st.query_map([profile_id, fanout_id], Task::from_row)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// How long a task's agent has run, in seconds, over all of its runs (one still going counts up to `now`), and how many
/// runs it has had.
pub fn run_time(c: &Connection, task_id: &str, now: &str) -> Result<(f64, i64)> {
    Ok(c.query_row(
        "SELECT COALESCE(SUM(MAX(0, julianday(COALESCE(ended_at, ?2)) - julianday(created_at))), 0) * 86400, COUNT(*) FROM runs WHERE task_id=?1",
        [task_id, now],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
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
/// The tasks in "In review" with a pull request, in projects that watch them (see
/// pr_watch::watch_in_review) and aren't archived, with their project's `watch_pull_requests`.
pub fn tasks_to_watch(c: &Connection) -> Result<Vec<(Task, String)>> {
    let mut st = c.prepare(
        "SELECT t.*, p.watch_pull_requests AS watch_mode FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.kind='task' AND t.status='in_review' AND COALESCE(t.pr_url, '') != ''
           AND p.watch_pull_requests != 'off' AND p.archived_at IS NULL",
    )?;
    let rows = st.query_map([], |r| Ok((Task::from_row(r)?, r.get("watch_mode")?)))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Whether the user (not the board or another agent) sent `task_id`'s agent a message after `since`.
pub fn user_wrote_since(c: &Connection, task_id: &str, since: &str) -> Result<bool> {
    Ok(c.query_row(
        "SELECT EXISTS (SELECT 1 FROM messages WHERE task_id=?1 AND kind='user' AND created_at > ?2
           AND json_extract(data, '$.auto') IS NULL AND json_extract(data, '$.from_agent') IS NULL)",
        [task_id, since],
        |r| r.get(0),
    )?)
}

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
        "SELECT DISTINCT project_id FROM tasks WHERE kind='task' AND merging=1 AND running=0 AND status='ready_for_merge' AND merge_approval IS NOT 'pending'",
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

/// Adds a thread. In a savepoint, so one that fails doesn't use up its project's next key number
/// (and it works within a transaction as well).
pub fn insert_task(c: &Connection, t: NewTask) -> Result<Task> {
    c.execute_batch("SAVEPOINT insert_task")?;
    match insert_task_now(c, t) {
        Ok(task) => {
            c.execute_batch("RELEASE insert_task")?;
            Ok(task)
        }
        Err(e) => {
            let _ = c.execute_batch("ROLLBACK TO insert_task; RELEASE insert_task");
            Err(e)
        }
    }
}

fn insert_task_now(c: &Connection, t: NewTask) -> Result<Task> {
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
    "base_branch", "worktree_state", "worktree_error", "session_id", "running", "run_started_at", "merging", "remerge", "merge_approval", "attention_reason",
    "queued_message", "steering", "steerable", "depends_on", "waiting", "limit_reset_at", "agent_wait", "model", "effort", "permission_mode", "claude_config_id", "auto_allow", "preview_url", "pr_url", "external_links", "fanout_id", "starred", "remind_at", "reminder", "review", "summary", "context", "context_detail", "rewind", "parent_id", "subproject", "created_by", "task_type", "labels", "document_at", "work_dir", "cost_usd", "last_activity_at", "done_at",
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
        // Whoever moves it (the user, a review, a run's end), a task that stepped out of the merge
        // queue keeps its place to rejoin only while its agent works on it (see Task::remerge).
        if fields.iter().any(|(col, _)| *col == "status") && !fields.iter().any(|(col, _)| *col == "remerge") {
            c.execute("UPDATE tasks SET remerge=0 WHERE id=?1 AND remerge=1 AND status NOT IN ('in_progress','needs_attention')", [id])?;
        }
        // A merge's approval goes with the merge, unless it stepped out to rejoin it.
        if fields.iter().any(|(col, _)| ["status", "merging", "remerge"].contains(col)) {
            c.execute("UPDATE tasks SET merge_approval=NULL WHERE id=?1 AND merge_approval IS NOT NULL AND merging=0 AND remerge=0", [id])?;
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
