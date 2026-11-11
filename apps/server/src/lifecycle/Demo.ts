import { DateTime, Effect, FileSystem, Layer, Option } from "effect"
import { Timestamp } from "@huntaway/contracts"
import type { DocumentLabel, Status, Todo } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import { DOCUMENT_FILE, TaskDocuments } from "../docs/TaskDocuments.ts"
import { DataDir } from "../platform/DataDir.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { Tasks } from "../tasks/Tasks.ts"

// The demo board (huntaway's demo.ts): sample data for a fresh deployment started with `--demo` (PR previews and test
// servers), so the board can be tried without setting anything up. It is seeded through the areas' own methods, as a
// user would make it. The published document is left for the docs area (6.3).

export const DEMO_README = "# Demo\n\nA scratch folder for the demo project that this preview creates on its first start.\n"

/** The demo project's tasks: title, description, status. */
const TASKS: ReadonlyArray<readonly [string, string, Status]> = [
  ["Try dragging this card to another column", "Cards can be dragged between columns and reordered within one.", "todo"],
  ["Edit this task's title and description", "Open the card and change it. Everything here is scratch data.", "todo"],
  ["Something being worked on", "A task with an agent at work sits here.", "in_progress"],
  ["A task waiting on an answer", "The agent asked a question and the task needs attention.", "needs_attention"],
  ["Finished work to look over", "The agent is done and the change is ready for review.", "in_review"],
  ["Merged and closed", "", "done"],
  ["An idea for later", "Backlog items come first on the board, in a column that starts collapsed.", "backlog"],
]

/** The todo list of the task at work, as its agent's latest TodoWrite left it: its card lists the first five and counts the rest. */
export const DEMO_TODOS: ReadonlyArray<Todo> = [
  { text: "Read how the board stores tasks", status: "completed" },
  { text: "Add the new column and its migration", status: "completed" },
  { text: "Show it on the task's card", status: "in_progress" },
  { text: "Push it to clients as it changes", status: "pending" },
  { text: "Add it to the demo board", status: "pending" },
  { text: "Write the tests", status: "pending" },
  { text: "Open a pull request", status: "pending" },
]

/** Tasks with a label that asks for a document, each with one version of it: (label, title, description, document). */
const DOCUMENTS: ReadonlyArray<readonly [DocumentLabel, string, string, string]> = [
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
]

/**
 * Seeds the demo board, unless this host has profiles already (it is only for a fresh data folder): a "Default"
 * profile on the `~/.claude` config, a "Demo" project (key `DEMO`) in `<data dir>/demo` with its README, its sample
 * tasks in each column (the one at work with its todo list, and one done a week ago, so archived), a plan, a diagram and
 * an artifact with a version of each (6.2), and a scratch task.
 */
export const seedDemo = Effect.gen(function* () {
  const profiles = yield* Profiles
  const projects = yield* Projects
  const tasks = yield* Tasks
  const documents = yield* TaskDocuments
  const dataDir = yield* DataDir
  const fs = yield* FileSystem.FileSystem
  if ((yield* profiles.list).length > 0) return
  const made = yield* profiles.ensure("Default", "~/.claude")
  if (Option.isNone(made)) return
  const profile = made.value
  const repo = `${dataDir.root}/demo`
  yield* fs.makeDirectory(repo, { recursive: true })
  yield* fs.writeFileString(`${repo}/README.md`, DEMO_README)
  const project = yield* projects.create({ profile_id: profile.id, name: "Demo", repo_path: repo, key: "DEMO", base_branch: null, use_worktrees: false })
  const created = yield* Effect.forEach(
    TASKS,
    ([title, description, status]) => tasks.create({ project_id: project.id, title, description, status }, Actor.board),
    { concurrency: 1 },
  )
  const working = created.find((t) => t.status === "in_progress")
  if (working !== undefined) yield* tasks.change(working.id, () => ({ todos: DEMO_TODOS }), Actor.board)
  // Done for longer than the board keeps it in Done, so it's archived.
  const old = yield* tasks.create(
    {
      project_id: project.id,
      title: "Shipped last week",
      description: "Tasks done for two days are archived: they leave the board for the list view's Archived section.",
      status: "done",
    },
    Actor.board,
  )
  const weekAgo = Timestamp.make(DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 7 })))
  yield* tasks.change(old.id, () => ({ done_at: weekAgo }), Actor.board)
  // 6.2: kept as an agent's turn would have kept them.
  for (const [label, title, description, document] of DOCUMENTS) {
    const task = yield* tasks.create({ project_id: project.id, title, description, status: "in_review", labels: [label] }, Actor.board)
    yield* fs.makeDirectory(documents.folder(task.id), { recursive: true })
    yield* fs.writeFileString(`${documents.folder(task.id)}/${DOCUMENT_FILE[label]}`, document)
    yield* documents.turnEnded(task.id)
  }
  // A scratch task, in no project, on the profile's board.
  yield* tasks.create(
    {
      profile_id: profile.id,
      title: "Try a scratch task",
      description:
        "A scratch task isn't in a project: its agent works in its own folder, with no repository. Ask it anything, or have it look across the board.",
    },
    Actor.board,
  )
  yield* Effect.logInfo(`seeded the demo project in ${repo}`)
}).pipe(Effect.orDie, Effect.withSpan("Demo.seed"))

/** Startup, after every area is built and before `Recovery`: the demo board, with `--demo`. */
export const DemoLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig
    if (config.demo) yield* seedDemo
  }),
)
