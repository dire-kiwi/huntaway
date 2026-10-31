//! Sample data for a fresh deployment started with `--demo` (PR previews): a profile, a
//! project and a few tasks, so the board can be tried without linking a host first.

use anyhow::{Result, anyhow};

use crate::api::{CreateProject, create_project_inner};
use crate::db::{self, NewTask};
use crate::state::Shared;
use crate::util::path_str;
use serde_json::json;

const README: &str = "# Demo\n\nA scratch folder for the demo project that this preview creates on its first start.\n";

/// (title, description, status)
const TASKS: &[(&str, &str, &str)] = &[
    ("Try dragging this card to another column", "Cards can be dragged between columns and reordered within one.", "todo"),
    ("Edit this task's title and description", "Open the card and change it. Everything here is scratch data.", "todo"),
    ("Something being worked on", "A task with an agent at work sits here.", "in_progress"),
    ("A task waiting on an answer", "The agent asked a question and the task needs attention.", "needs_attention"),
    ("Finished work to look over", "The agent is done and the change is ready for review.", "in_review"),
    ("Merged and closed", "", "done"),
    ("An idea for later", "Backlog items come first on the board, in a column that starts collapsed.", "backlog"),
];

/// Tasks with a label that asks for a document, each with one version of it: (label, title, description, document).
const DOCUMENTS: &[(&str, &str, &str, &str)] = &[
    (
        "diagram",
        "How a task moves across the board",
        "Draw the columns a task goes through and what moves it between them.",
        r#"---
title: A task's way across the board
---
flowchart TD
    todo["To do"] -->|Start| progress["In progress"]
    progress -->|"the agent asks"| attention["Needs attention"]
    attention -->|"you reply"| progress
    progress -->|"turn ends"| review["In review"]
    review -->|"you ask for changes"| progress
    review -->|"you approve"| merge["Ready for merge"]
    merge -->|"the agent merges"| done["Done"]
"#,
    ),
    (
        "plan",
        "Plan a dark mode for the demo site",
        "Plan how to add a dark mode that follows the system setting, with a toggle to override it.",
        r#"<h1>Dark mode</h1>
<ia-lede>A sample plan. Reply in the task to change it; each turn keeps a version.</ia-lede>

<h2>Goal</h2>
<p>The site follows the system's light or dark setting, and a toggle in the header overrides it.</p>
<ia-callout kind="note" title="Out of scope">Per-page themes, and a theme editor.</ia-callout>

<h2>How it works today</h2>
<ul class="files">
  <li><code>styles/site.css</code> every colour is written out where it's used</li>
  <li><code>components/Header.tsx</code> the header, where the toggle goes</li>
</ul>

<h2>Approach</h2>
<ia-cards>
  <ia-card kind="chosen">
    <h3>CSS custom properties</h3>
    <p>Colours move into variables, with a dark set under <code>prefers-color-scheme: dark</code>. The toggle sets <code>data-theme</code> on the root element.</p>
  </ia-card>
  <ia-card kind="rejected">
    <h3>A second stylesheet</h3>
    <p>Swapping whole stylesheets doubles what has to be kept in step, and flashes on load.</p>
  </ia-card>
</ia-cards>
<ia-diagram>
  <svg viewBox="0 0 520 90" width="520">
    <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="arrow" d="M0 0L10 5L0 10z"/></marker></defs>
    <rect class="box" x="4" y="20" width="140" height="50" rx="8"/><text x="74" y="50" text-anchor="middle">System setting</text>
    <rect class="box" x="190" y="20" width="140" height="50" rx="8"/><text x="260" y="50" text-anchor="middle">Header toggle</text>
    <rect class="box accent" x="376" y="20" width="140" height="50" rx="8"/><text x="446" y="50" text-anchor="middle">data-theme</text>
    <path class="edge" d="M144 45H186" marker-end="url(#a)"/><path class="edge accent" d="M330 45H372" marker-end="url(#a)"/>
  </svg>
</ia-diagram>

<h2>Steps</h2>
<ia-steps>
  <ia-step size="M"><h3>Move every colour into custom properties</h3><p>No visible change yet.</p></ia-step>
  <ia-step size="S"><h3>Add the dark palette</h3><p>Check contrast against <ia-badge kind="ok">WCAG AA</ia-badge>.</p></ia-step>
  <ia-step size="S"><h3>Add the header toggle</h3><p>Remember its setting in local storage.</p></ia-step>
</ia-steps>
<h3>The toggle</h3>
<ia-html><template>
  <style>
    .toggle { display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--panel-2); }
    button { border: 0; border-radius: 999px; padding: 4px 14px; background: none; color: var(--muted); font: 13px var(--font-sans); cursor: pointer; }
    button.on { background: var(--accent); color: white; }
  </style>
  <div class="toggle"><button onclick="pick(this)">Light</button><button class="on" onclick="pick(this)">System</button><button onclick="pick(this)">Dark</button></div>
  <script>
    function pick(b) { document.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); }
  </script>
</template></ia-html>

<h2>Risks</h2>
<ia-callout kind="risk">Third-party widgets with their own colours won't follow the theme.</ia-callout>

<h2>Open questions</h2>
<ia-question name="toggle-choices" type="radio" title="Which choices should the toggle offer?">
  <option value="three" selected>Light, system and dark</option>
  <option value="two">Only light and dark</option>
</ia-question>
<ia-question name="pages" type="checkbox" title="Which pages get the dark palette first?" other>
  <option value="home" selected>Home</option>
  <option value="docs">Docs</option>
  <option value="blog">Blog</option>
</ia-question>
<ia-question name="notes" type="textarea" title="Anything else the plan should cover?" placeholder="Optional"></ia-question>
"#,
    ),
    (
        "artifact",
        "A release notes card",
        "Make a small card announcing this release's three main changes.",
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Release notes</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f3ef; font: 15px/1.5 system-ui, sans-serif; color: #1f1f1c; }
  .card { width: min(420px, 90vw); background: #fff; border-radius: 16px; padding: 28px; box-shadow: 0 10px 30px rgba(0,0,0,.08); }
  .tag { display: inline-block; font-size: 12px; font-weight: 600; letter-spacing: .04em; color: #3b5bdb; background: #edf2ff; border-radius: 999px; padding: 3px 10px; }
  h1 { font-size: 22px; margin: 12px 0 16px; }
  li { margin: 10px 0; }
  li b { display: block; }
  li span { color: #6b6b66; }
</style>
</head>
<body>
  <div class="card">
    <span class="tag">Version 2.0</span>
    <h1>What's new</h1>
    <ul>
      <li><b>Plans</b><span>An agent writes an HTML plan you iterate on together.</span></li>
      <li><b>Artifacts</b><span>Designed pages kept on the board, not uploaded anywhere.</span></li>
      <li><b>Diagrams</b><span>Mermaid diagrams, drawn from the real code.</span></li>
    </ul>
  </div>
</body>
</html>
"#,
    ),
];

/// Seed the demo data, unless this host already has profiles (it's only for a fresh data dir).
pub async fn seed(s: &Shared) -> Result<()> {
    if !db::list_profiles(&s.db())?.is_empty() {
        return Ok(());
    }
    let config = db::config_for_dir(&s.db(), "Default", "~/.claude")?;
    let profile = db::insert_profile(&s.db(), "Default", &[config], None)?;
    std::fs::create_dir_all(s.profile_scratch_dir(&profile.id))?;
    let repo = s.data_dir.join("demo");
    std::fs::create_dir_all(&repo)?;
    std::fs::write(repo.join("README.md"), README)?;
    let project = create_project_inner(
        s,
        &profile.id,
        CreateProject { name: "Demo".into(), repo_path: path_str(&repo), key: Some("DEMO".into()), base_branch: None, use_worktrees: Some(false) },
    )
    .await
    .map_err(|e| anyhow!(e.1))?;
    for (title, description, status) in TASKS {
        db::insert_task(
            &s.db(),
            NewTask {
                profile_id: &profile.id,
                project_id: Some(&project.id),
                kind: "task",
                title,
                description,
                status,
                use_worktree: false,
                model: None,
                effort: None,
                claude_config_id: None,
            },
        )?;
    }
    // Done for longer than the board keeps it in Done, so it's archived.
    let old = db::insert_task(
        &s.db(),
        NewTask {
            profile_id: &profile.id,
            project_id: Some(&project.id),
            kind: "task",
            title: "Shipped last week",
            description: "Tasks done for two days are archived: they leave the board for the list view's Archived section.",
            status: "done",
            use_worktree: false,
            model: None,
            effort: None,
            claude_config_id: None,
        },
    )?;
    let week_ago = (chrono::Utc::now() - chrono::Duration::days(7)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    db::update_task(&s.db(), &old.id, &[("done_at", json!(week_ago))])?;
    for (label, title, description, document) in DOCUMENTS {
        let t = db::insert_task(
            &s.db(),
            NewTask {
                profile_id: &profile.id,
                project_id: Some(&project.id),
                kind: "task",
                title,
                description,
                status: "in_review",
                use_worktree: false,
                model: None,
                effort: None,
                claude_config_id: None,
            },
        )?;
        let t = db::update_task(&s.db(), &t.id, &[("labels", json!([label]))])?.ok_or_else(|| anyhow!("task not found"))?;
        // Kept as an agent's turn would have kept it.
        let file = crate::documents::path(s, &t, label).ok_or_else(|| anyhow!("no document for {label}"))?;
        std::fs::create_dir_all(crate::documents::dir(s, &t.id))?;
        std::fs::write(file, document)?;
        crate::documents::turn_ended(s, &t.id);
    }
    // A scratch task, in no project, on the profile's board.
    db::insert_scratch_task(
        &s.db(),
        NewTask {
            profile_id: &profile.id,
            project_id: None,
            kind: "task",
            title: "Try a scratch task",
            description: "A scratch task isn't in a project: its agent works in its own folder, with no repository. Ask it anything, or have it look across the board.",
            status: "todo",
            use_worktree: false,
            model: None,
            effort: None,
            claude_config_id: None,
        },
    )?;
    tracing::info!("seeded the demo project in {}", repo.display());
    Ok(())
}
