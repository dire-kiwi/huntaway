// Port of server/src/demo.rs: sample data for a fresh deployment started with `--demo` (PR previews): a profile, a
// project and a few tasks, so the board can be tried without linking a host first.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "./db.ts";
import type { AppState } from "./state.ts";
import { path_str } from "./util.ts";
import { create_project_inner } from "./api/projects.ts";
import * as documents from "./agent/documents.ts";

const README = "# Demo\n\nA scratch folder for the demo project that this preview creates on its first start.\n";

/** (title, description, status) */
const TASKS: Array<[string, string, string]> = [
  ["Try dragging this card to another column", "Cards can be dragged between columns and reordered within one.", "todo"],
  ["Edit this task's title and description", "Open the card and change it. Everything here is scratch data.", "todo"],
  ["Something being worked on", "A task with an agent at work sits here.", "in_progress"],
  ["A task waiting on an answer", "The agent asked a question and the task needs attention.", "needs_attention"],
  ["Finished work to look over", "The agent is done and the change is ready for review.", "in_review"],
  ["Merged and closed", "", "done"],
  ["An idea for later", "Backlog items come first on the board, in a column that starts collapsed.", "backlog"],
];

/** Tasks with a label that asks for a document, each with one version of it: (label, title, description, document). */
const DOCUMENTS: Array<[string, string, string, string]> = [
  [
    "diagram",
    "How a task moves across the board",
    "Draw the columns a task goes through and what moves it between them.",
    `---
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
`,
  ],
  [
    "plan",
    "Plan a dark mode for the demo site",
    "Plan how to add a dark mode that follows the system setting, with a toggle to override it.",
    `<h1>Dark mode</h1>
<p class="sub">A sample plan. Reply in the task to change it; each turn keeps a version.</p>

<div class="callout"><strong>In short:</strong> the site follows the system's light or dark setting, and a toggle in the header overrides it. Colours move into CSS custom properties, so the dark palette is one more set of values.</div>

<h2>Goal</h2>
<table>
  <thead><tr><th>Question</th><th>Answer</th></tr></thead>
  <tbody>
    <tr><td class="n">Default</td><td>Follows <code>prefers-color-scheme</code>.</td></tr>
    <tr><td class="n">Override</td><td>A toggle in the header, remembered in local storage. <span class="pill ok">decided</span></td></tr>
    <tr><td class="n">Out of scope</td><td>Per-page themes, and a theme editor. <span class="pill grey">later</span></td></tr>
  </tbody>
</table>

<h2>How it works today</h2>
<ul>
  <li><code>styles/site.css</code>: every colour is written out where it's used.</li>
  <li><code>components/Header.tsx</code>: the header, where the toggle goes.</li>
</ul>

<h2>Approach</h2>
<div class="grid2">
  <div class="card"><h4>CSS custom properties <span class="pill ok">chosen</span></h4>Colours move into variables, with a dark set under <code>prefers-color-scheme: dark</code>. The toggle sets <code>data-theme</code> on the root element.</div>
  <div class="card"><h4>A second stylesheet <span class="pill grey">not chosen</span></h4>Swapping whole stylesheets doubles what has to be kept in step, and flashes on load.</div>
</div>
<ia-diagram>
<pre>flowchart LR
  system["System setting"] --> toggle["Header toggle"] --> theme["data-theme"]
</pre>
</ia-diagram>

<h2>Steps</h2>
<ol class="steps">
  <li><strong>Move every colour into custom properties</strong> One variable per role (background, text, accent). <span class="meta">Result: no visible change yet.</span></li>
  <li><strong>Add the dark palette</strong> Check contrast against <span class="pill info">WCAG AA</span>. <span class="meta">Result: the site follows the system setting.</span></li>
  <li><strong>Add the header toggle</strong> Remember its setting in local storage. <span class="meta">Result: the setting can be overridden.</span></li>
</ol>
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
<div class="callout warn"><strong>Embeds:</strong> third-party widgets with their own colours won't follow the theme.</div>

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
`,
  ],
  [
    "artifact",
    "A release notes card",
    "Make a small card announcing this release's three main changes.",
    `<!doctype html>
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
`,
  ],
];

/** A new task in the demo project (or none: a scratch task). */
function new_task(profile_id: string, project_id: string | null, title: string, description: string, status: string): db.NewTask {
  return { profile_id, project_id, kind: "task", title, description, status, use_worktree: false, model: null, effort: null, claude_config_id: null };
}

/** Seed the demo data, unless this host already has profiles (it's only for a fresh data dir). */
export async function seed(s: AppState) {
  if (db.list_profiles(s.db()).length) return;
  const config = db.config_for_dir(s.db(), "Default", "~/.claude");
  const profile = db.insert_profile(s.db(), "Default", [config], null);
  mkdirSync(s.profile_scratch_dir(profile.id), { recursive: true });
  const repo = join(s.data_dir, "demo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), README);
  let project: db.Project;
  try {
    project = await create_project_inner(s, profile.id, { name: "Demo", repo_path: path_str(repo), key: "DEMO", base_branch: null, use_worktrees: false });
  } catch (e: any) {
    throw new Error(e?.message ?? String(e));
  }
  for (const [title, description, status] of TASKS) db.insert_task(s.db(), new_task(profile.id, project.id, title, description, status));
  // Done for longer than the board keeps it in Done, so it's archived.
  const old = db.insert_task(
    s.db(),
    new_task(profile.id, project.id, "Shipped last week", "Tasks done for two days are archived: they leave the board for the list view's Archived section.", "done"),
  );
  const week_ago = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  db.update_task(s.db(), old.id, [["done_at", week_ago]]);
  for (const [label, title, description, document] of DOCUMENTS) {
    const made = db.insert_task(s.db(), new_task(profile.id, project.id, title, description, "in_review"));
    const t = db.update_task(s.db(), made.id, [["labels", [label]]]);
    if (!t) throw new Error("task not found");
    // Kept as an agent's turn would have kept it.
    const file = documents.path(s, t, label);
    if (!file) throw new Error(`no document for ${label}`);
    mkdirSync(documents.dir(s, t.id), { recursive: true });
    writeFileSync(file, document);
    documents.turn_ended(s, t.id);
  }
  // A scratch task, in no project, on the profile's board.
  db.insert_scratch_task(
    s.db(),
    new_task(
      profile.id,
      null,
      "Try a scratch task",
      "A scratch task isn't in a project: its agent works in its own folder, with no repository. Ask it anything, or have it look across the board.",
      "todo",
    ),
  );
  console.info(`seeded the demo project in ${repo}`);
}
