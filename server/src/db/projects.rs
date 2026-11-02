//! Projects: a repository and the settings its tasks inherit.

use super::*;

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
    /// Ignored files copied into each new task worktree from the repository folder, as
    /// .gitignore-style patterns, one per line (see worktree_files.rs).
    #[serde(default)]
    pub copy_files: String,
    /// Ignored folders of the repository linked into each new task worktree, one per line.
    #[serde(default)]
    pub link_folders: String,
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
    /// Whether it has a commit checked out, which a worktree needs to branch from (looked up
    /// when the project is loaded; false when it isn't a git repository).
    #[serde(default)]
    pub has_commits: bool,
    /// The task whose thread helps the user get the folder ready for worktrees (a git
    /// repository with a commit), which the board shows in its place until it is (API 73).
    #[serde(default)]
    pub setup_task_id: Option<String>,
    /// Falls back to the host's default mode when unset.
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    /// Overrides the profile's Claude configs when set.
    pub claude_config_ids: Option<Vec<String>>,
    /// Review each task's work when it moves to "In review" (see review.rs).
    pub auto_review: bool,
    /// Move a task to Done when its pull request is merged on GitHub (see merged.rs).
    #[serde(default = "yes")]
    pub done_when_merged: bool,
    /// Agents open a pull request for their task's branch when the repository is on GitHub
    /// (see runner::system_prompt). Subprojects themselves follow it too.
    #[serde(default = "yes")]
    pub pull_requests: bool,
    /// The same for the tasks in the project's subprojects, whose pull requests target the
    /// subproject's branch.
    #[serde(default = "yes")]
    pub subproject_pull_requests: bool,
    /// How many times in a row a review's serious issues go back to the agent to fix before
    /// the task is left for the user.
    pub review_rounds: u32,
    /// Who reviews each task's work, each in a review thread of its own. Empty uses the
    /// profile's (see `reviewers_for`).
    #[serde(default)]
    pub reviewers: Vec<Reviewer>,
    /// Summarise each task's changes once its review passes, for the user to read before
    /// merging (see summary.rs).
    #[serde(default = "yes")]
    pub auto_summary: bool,
    /// Who writes those summaries, in a thread of its own. None uses the profile's (see
    /// `summarizer_for`).
    #[serde(default)]
    pub summarizer: Option<Reviewer>,
    /// Whether its merges wait for the user's approval (see merge_gate.rs). None follows its
    /// profile's `merge_approval`.
    #[serde(default)]
    pub merge_approval: Option<bool>,
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
    /// Which news about the pull request of a task in "In review" wakes its agent: off,
    /// failures (failed checks and conflicts) or all (comments and reviews too). See
    /// pr_watch::watch_in_review.
    #[serde(default = "watch_off")]
    pub watch_pull_requests: String,
    /// Where a task's pull request is previewed, with `{pr}` for its number: a task gets it as its
    /// `preview_url` once it has a pull request (see `preview_for`).
    #[serde(default)]
    pub pr_preview_url: Option<String>,
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
            copy_files: r.get("copy_files")?,
            link_folders: r.get("link_folders")?,
            status_script: r.get("status_script")?,
            status_scripts: json_or_default(r.get("status_scripts")?),
            use_worktrees: r.get("use_worktrees")?,
            is_git: crate::util::is_git_root(std::path::Path::new(&r.get::<_, String>("repo_path")?)),
            has_commits: crate::util::has_commits(std::path::Path::new(&r.get::<_, String>("repo_path")?)),
            setup_task_id: r.get("setup_task_id")?,
            permission_mode: r.get("permission_mode")?,
            model: r.get("model")?,
            claude_config_ids: r.get::<_, Option<String>>("claude_config_ids")?.map(json_list),
            auto_review: r.get("auto_review")?,
            done_when_merged: r.get("done_when_merged")?,
            pull_requests: r.get("pull_requests")?,
            subproject_pull_requests: r.get("subproject_pull_requests")?,
            review_rounds: r.get("review_rounds")?,
            reviewers: r.get::<_, Option<String>>("reviewers")?.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default(),
            auto_summary: r.get("auto_summary")?,
            summarizer: r.get::<_, Option<String>>("summarizer")?.and_then(|v| serde_json::from_str(&v).ok()),
            merge_approval: r.get("merge_approval")?,
            start_prompt: r.get("start_prompt")?,
            review_prompt: r.get("review_prompt")?,
            merge_prompt: r.get("merge_prompt")?,
            group_name: r.get("group_name")?,
            archived_at: r.get("archived_at")?,
            github_account: r.get("github_account")?,
            watch_pull_requests: r.get("watch_pull_requests")?,
            pr_preview_url: r.get("pr_preview_url")?,
            created_at: r.get("created_at")?,
        })
    }

    /// Whether agents open pull requests for the project's tasks (`in_subproject`: for a
    /// subproject's tasks, while a subproject itself is one of the project's).
    pub fn pull_requests(&self, in_subproject: bool) -> bool {
        if in_subproject { self.subproject_pull_requests } else { self.pull_requests }
    }

    /// Where pull request `pr_url` is previewed (see `pr_preview_url`): None if the project
    /// doesn't preview them or it isn't a pull request's URL.
    pub fn preview_for(&self, pr_url: Option<&str>) -> Option<String> {
        let template = self.pr_preview_url.as_deref()?;
        let pr = crate::pr_watch::Target::parse(pr_url?, None).ok()?;
        Some(template.replace("{pr}", &pr.number.to_string()))
    }
}

fn watch_off() -> String {
    "off".into()
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

const PROJECT_COLUMNS: &[&str] = &[
    "name", "key", "repo_path", "scratch_path", "worktrees_root", "base_branch", "setup_script",
    "teardown_script", "status_script", "status_scripts", "use_worktrees", "permission_mode", "model", "auto_review", "review_rounds", "claude_config_ids",
    "reviewers", "auto_summary", "summarizer", "merge_approval", "done_when_merged", "pull_requests", "subproject_pull_requests", "start_prompt", "review_prompt", "merge_prompt", "group_name", "former_keys", "repo_root",
    "archived_at", "github_account", "watch_pull_requests", "setup_task_id", "pr_preview_url",
    "copy_files", "link_folders",
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
