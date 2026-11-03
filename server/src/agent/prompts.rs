//! The prompts the board sends as a task moves across it: to its agent when it starts ("In
//! progress"), to the reviewer when its work is reviewed ("In review"), and to its agent when
//! it's merged ("Ready for merge"). A project can replace each prompt's instructions in its
//! settings (agents can too, with the `update_project` tool). The board adds what it relies on
//! around them: the task and its branch, and how to report back (`submit_review`, setting the
//! task to done), so a project's own instructions can't break the workflow.

use serde_json::{Value, json};

use crate::db::{Project, Task};

pub const DEFAULT_START: &str = "Start working on this task.";

pub const DEFAULT_REVIEW: &str = "Look for correctness problems: bugs, crashes, data loss, security holes, a broken build or \
tests, and anything that doesn't do what the task asks. Read the surrounding code where you need to. If you have a code \
review skill or command (such as /code-review), use it.";

pub const DEFAULT_MERGE: &str = "Commit any outstanding work, then merge its pull request if it has one (e.g. with the gh tools' pr_merge), \
otherwise merge the branch directly. Follow the project's own merge instructions (e.g. in CLAUDE.md) and resolve any \
conflicts.";

/// What the summarizer writes, unless its reviewer settings have instructions of their own (API 101).
pub const DEFAULT_SUMMARY: &str = "The user reads your summary before they merge the work, to see what it does without reading the whole diff. \
Write it in Markdown, briefly: start with a sentence or two on what changed and why, then the main changes (grouped by area, naming the \
files or modules where it helps), any decisions or behaviour changes worth knowing about, and how to try it if that isn't obvious. Leave \
out what the diff makes plain at a glance, and don't review the work or pad it out. Don't change anything.";

/// The project fields holding each prompt's instructions, and their defaults.
pub const FIELDS: [(&str, &str); 3] = [("start_prompt", DEFAULT_START), ("review_prompt", DEFAULT_REVIEW), ("merge_prompt", DEFAULT_MERGE)];

/// `GET /default-prompts`: the instructions a project without its own uses, by field, and the
/// summarizer's (`summary_prompt`, API 101).
pub fn defaults() -> Value {
    let mut all: serde_json::Map<String, Value> = FIELDS.iter().map(|(k, v)| (k.to_string(), json!(v))).collect();
    all.insert("summary_prompt".into(), json!(DEFAULT_SUMMARY));
    Value::Object(all)
}

fn pick<'a>(own: Option<&'a String>, default: &'a str) -> &'a str {
    own.map(|s| s.trim()).filter(|s| !s.is_empty()).unwrap_or(default)
}

/// What a task's agent is told to do when it starts, after the task's title and description.
pub fn start(project: Option<&Project>) -> &str {
    pick(project.and_then(|p| p.start_prompt.as_ref()), DEFAULT_START)
}

/// What `task`'s agent is told to do when it starts. A project's own instructions are for its
/// code tasks, so a scratch task, or one that makes only documents, gets the default.
pub fn start_task<'a>(task: &Task, project: Option<&'a Project>) -> &'a str {
    start(project.filter(|_| task.task_type.is_none() && !crate::agent::documents::documents_only(task)))
}

/// What the reviewer looks for, after the task and where its changes are.
pub fn review(project: Option<&Project>) -> &str {
    pick(project.and_then(|p| p.review_prompt.as_ref()), DEFAULT_REVIEW)
}

/// What the reviewer `own` looks for: its own instructions if it has some, else the project's.
pub fn review_by(project: Option<&Project>, own: &crate::db::Reviewer) -> String {
    pick(own.prompt.as_ref(), review(project)).to_string()
}

/// What the summarizer `own` writes.
pub fn summary(own: &crate::db::Reviewer) -> &str {
    pick(own.prompt.as_ref(), DEFAULT_SUMMARY)
}

/// How the agent merges, after which branch to merge into which.
pub fn merge(project: Option<&Project>) -> &str {
    pick(project.and_then(|p| p.merge_prompt.as_ref()), DEFAULT_MERGE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reviewers_own_instructions_win_over_the_projects() {
        let mut own = crate::db::Reviewer::default();
        assert_eq!(summary(&own), DEFAULT_SUMMARY);
        assert_eq!(review_by(None, &own), DEFAULT_REVIEW);
        own.prompt = Some("  Look at the SQL only.  ".into());
        assert_eq!(review_by(None, &own), "Look at the SQL only.");
        assert_eq!(summary(&own), "Look at the SQL only.");
        own.prompt = Some("   ".into());
        assert_eq!(review_by(None, &own), DEFAULT_REVIEW);
    }

    #[test]
    fn a_project_without_its_own_uses_the_default() {
        let c = crate::db::open(std::path::Path::new(":memory:")).unwrap();
        let profile = crate::db::insert_profile(&c, "me", &[], None).unwrap();
        let new = crate::db::NewProject {
            id: "p",
            profile_id: &profile.id,
            name: "p",
            key: "P",
            repo_path: "/x",
            scratch_path: "/s",
            worktrees_root: "/w",
            base_branch: None,
            use_worktrees: false,
        };
        let mut p = crate::db::insert_project(&c, new).unwrap();
        assert_eq!((start(Some(&p)), review(Some(&p)), merge(Some(&p))), (DEFAULT_START, DEFAULT_REVIEW, DEFAULT_MERGE));
        assert_eq!(start(None), DEFAULT_START);
        p.start_prompt = Some("  Plan first.\n".into());
        p.merge_prompt = Some("   ".into());
        assert_eq!((start(Some(&p)), merge(Some(&p))), ("Plan first.", DEFAULT_MERGE));
        assert_eq!(defaults()["review_prompt"], DEFAULT_REVIEW);
    }
}
