//! What a workflow's agent steps are asked, and the messages its sends make: templates filled in from the task and
//! the run's earlier steps.

use super::*;

/// How much of the task agent's last message, and of an earlier step's output, goes in a prompt.
const QUOTE_CHARS: usize = 6000;

/// What an agent step's prompt needs to know about the task's work.
pub(super) struct Work {
    pub key: String,
    pub branch: String,
    pub base: Option<String>,
    pub commit: String,
    /// The branch has no commits of its own: the agent worked somewhere else (or not at all).
    pub elsewhere: bool,
    /// Its work starts later than where it left its base branch (see worktree::work_scope).
    pub own_start: bool,
    pub last_message: Option<String>,
}

fn quote(s: &str) -> String {
    let mut s = s.trim().to_string();
    if let Some((i, _)) = s.char_indices().nth(QUOTE_CHARS) {
        s.truncate(i);
        s.push_str(" [...]");
    }
    s.lines().map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n")
}

/// The issues the run's verdict steps found, each with its step's name when there are several, as a numbered list.
pub(super) fn issues(run: &Run) -> Vec<String> {
    let steps: Vec<(&str, &NodeRun)> = run
        .graph
        .nodes
        .iter()
        .filter_map(|n| match &n.kind {
            NodeKind::Agent { name, output: Output::Verdict, .. } => Some((name.as_str(), run.nodes.get(&n.id)?)),
            _ => None,
        })
        .filter(|(_, r)| r.port.as_deref() == Some("issues"))
        .collect();
    let several = steps.len() > 1;
    steps.iter().flat_map(|(name, r)| r.issues.iter().map(move |i| if several { format!("({name}) {i}") } else { i.clone() })).collect()
}

fn numbered(list: &[String]) -> String {
    list.iter().enumerate().map(|(i, s)| format!("{}. {s}", i + 1)).collect::<Vec<_>>().join("\n\n")
}

/// `text` with its `{{…}}` filled in: `task.key`, `task.title`, `task.description`, `branch`, `commit`, `workflow`,
/// `issues` (those the run found), and `<node id>.text` and `<node id>.issues` for its steps.
pub fn render(text: &str, task: &db::Task, key: &str, workflow: &str, run: &Run) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("{{") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        let Some(j) = after.find("}}") else {
            out.push_str(&rest[i..]);
            return out;
        };
        let name = after[..j].trim();
        let value = match name {
            "task.key" => Some(key.to_string()),
            "task.title" => Some(task.title.clone()),
            "task.description" => Some(task.description.clone()),
            "branch" => Some(task.branch.clone().unwrap_or_default()),
            "commit" => Some(run.head.clone().unwrap_or_default()),
            "workflow" => Some(workflow.to_string()),
            "issues" => Some(numbered(&issues(run))),
            _ => name.split_once('.').and_then(|(node, field)| {
                let r = run.nodes.get(node)?;
                match field {
                    "text" => Some(r.text.clone().unwrap_or_default()),
                    "issues" => Some(numbered(&r.issues)),
                    "verdict" => Some(r.verdict.clone().unwrap_or_default()),
                    _ => None,
                }
            }),
        };
        match value {
            Some(v) => out.push_str(&v),
            None => out.push_str(&rest[i..i + 2 + j + 2]),
        }
        rest = &after[j + 2..];
    }
    out.push_str(rest);
    out
}

/// What the task's agent is sent by a send step with no message of its own: the issues the run found.
pub(super) fn fixes(workflow: &str, list: &[String]) -> String {
    let n = list.len();
    let what = if n == 1 { "a serious issue" } else { "serious issues" };
    format!(
        "The workflow \"{workflow}\" found {what} in your changes:\n\n{}\n\nFix them, then commit (and push, if the branch has a pull \
         request), and end with a summary of what you changed. You don't have to agree: if you think an issue is mistaken, or fixing it \
         needs a decision or information from the user, leave that issue alone and call `request_user_input` explaining your reasoning \
         or question, so the task moves to \"Needs attention\" for the user to decide.",
        numbered(list)
    )
}

/// An agent step's prompt: the task, where its work is, what the steps before it said, what the step is asked to
/// do (`instructions`, already filled in), and how it reports.
#[allow(clippy::too_many_arguments)]
pub(super) fn agent(
    task: &db::Task, work: &Work, workflow: &str, step: &str, instructions: &str, output: Output, skills: &[String], codex: bool, earlier: &[(String, String)],
    replies: Option<&db::UserReplies>, recheck: &[String],
) -> String {
    let key = &work.key;
    let mut p = format!("You are \"{step}\", a step of the workflow \"{workflow}\", for task {key}: \"{}\".\n", task.title);
    if !task.description.trim().is_empty() {
        p.push_str(&format!("\nThe task's description:\n\n{}\n", task.description.trim()));
    }
    let (branch, commit) = (&work.branch, &work.commit);
    if work.elsewhere {
        p.push_str(&format!(
            "\nThe task's branch `{branch}`, checked out in your working directory, has no commits of its own (it's still at commit \
             {commit}), so the agent made its changes somewhere else, such as in another repository, or made none. Find them from what \
             it says it did"
        ));
        if let Some(url) = task.pr_url.as_deref().filter(|u| !u.is_empty()) {
            p.push_str(&format!(" and from the task's pull request, {url}"));
        }
        p.push_str(" (the gh MCP server's `pr_view` and `pr_diff` tools take a pull request's URL).\n");
        match work.last_message.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            Some(m) => p.push_str(&format!("\nThe agent's last message:\n\n{}\n", quote(m))),
            None => p.push_str("\nThe agent didn't leave a message saying what it did.\n"),
        }
    } else if let (true, Some(b)) = (work.own_start, work.base.as_deref()) {
        p.push_str(&format!(
            "\nThe work is on branch `{branch}` (commit {commit}), checked out in your working directory. It started from commit {b}, \
             after where it left its base branch, so its pull request's diff (if it has one) also has commits that aren't its own: read \
             the branch's changes (`git diff {b}...HEAD`, `git log {b}..HEAD`) rather than `pr_diff`.\n"
        ));
    } else {
        let fallback = match work.base.as_deref() {
            Some(b) => format!("the branch's changes (`git diff {b}...HEAD`, `git log {b}..HEAD`)"),
            None => "the branch's commits".into(),
        };
        p.push_str(&format!(
            "\nThe work is on branch `{branch}` (commit {commit}), checked out in your working directory. Find its pull request with the \
             gh MCP server's `pr_view` tool (pr `{branch}`) and read its changes (`pr_diff`). If it has no pull request, read {fallback} \
             instead.\n"
        ));
    }
    if let Some(r) = replies {
        p.push_str(&crate::review::user_said(&r.replies, r.earlier > 0));
    }
    for (name, said) in earlier {
        p.push_str(&format!("\nThe step \"{name}\" before you said:\n\n{}\n", quote(said)));
    }
    let instructions = instructions.trim();
    if !instructions.is_empty() {
        p.push_str(&format!("\n{instructions}\n"));
    }
    if !skills.is_empty() {
        let named: Vec<String> = skills.iter().map(|s| format!("`{}{s}`", if codex { '$' } else { '/' })).collect();
        p.push_str(&format!(
            "\nUse {} while you work: {}{}. If a skill asks for something against the rest of this message (changing files, say), \
             follow this message instead.\n",
            if skills.len() == 1 { "this skill" } else { "these skills" },
            named.join(", "),
            if codex { "" } else { " (invoke each with the `Skill` tool)" },
        ));
    }
    match output {
        Output::Verdict => {
            p.push_str(
                "\nDon't change anything. When you're done, call `submit_review` once. If anything must be fixed before merging (for \
                 example, a bug you confirmed), the verdict is `needs_fixes` and each such problem goes in `serious_issues`, with where it \
                 is, what goes wrong and how to fix it. Otherwise the verdict is `pass`. Put minor issues and suggestions in the summary, \
                 and list each of them in `minor_issues` too. Then end your turn with a short summary.",
            );
            if !recheck.is_empty() {
                p.push_str("\n\nThe last time this step ran it found these serious issues, and the agent was asked to fix them. Check that they're fixed:\n");
                for i in recheck {
                    p.push_str(&format!("\n- {i}"));
                }
            }
        }
        Output::Text => p.push_str(
            "\nDon't change anything. Your last message is this step's output, shown as it is on the task: end your turn with only \
             that, without a preamble.",
        ),
    }
    p
}
