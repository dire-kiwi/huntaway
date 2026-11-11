import { assert, describe, it } from "@effect/vitest"
import { PenId, ProfileId, ProjectId, TaskId, threadKindOf } from "@huntaway/contracts"
import type { StartFrom, ThreadKindFields } from "@huntaway/contracts"
import type { DocumentFile } from "../../prompts/documentGuide.ts"
import { githubNote } from "../../prompts/github.ts"
import type { PromptContext, PromptProject, PromptTask } from "./context.ts"
import { systemPromptGoldens } from "./fixtures/systemPrompts.ts"
import { basePrompt, systemPrompt } from "./system.ts"

// What a run is told (huntaway's agent/runner/prompt.test.ts, the system prompt's cases), on the pure builder: first
// the goldens, what the old builder gave for the same input, then the old test's cases one by one.

type Thread = PromptTask & ThreadKindFields

const thread = (o: Partial<Thread> = {}): Thread => ({
  id: TaskId.make("t1"),
  kind: "task",
  task_type: null,
  project_id: ProjectId.make("pr"),
  parent_id: null,
  group_name: null,
  pen_id: null,
  labels: [],
  work_dir: null,
  use_worktree: true,
  number: 7,
  title: "Fix it",
  description: "It's broken.",
  worktree_path: null,
  branch: null,
  base_branch: null,
  start_from: null,
  merges_into: null,
  github_stack: null,
  external_links: [],
  session_id: null,
  ...o,
})

const web: PromptProject = {
  id: ProjectId.make("pr"),
  name: "Web",
  key: "WEB",
  repo_path: "/src/web",
  base_branch: "main",
  pull_requests: true,
  start_prompt: null,
}

const profiles = [
  { id: ProfileId.make("me"), name: "personal", agent_access: [] },
  { id: ProfileId.make("w"), name: "work", agent_access: ["personal"] },
  { id: ProfileId.make("l"), name: "lab", agent_access: [] },
]

const context = (task: Thread, o: Partial<PromptContext> = {}): PromptContext => ({
  task,
  project: task.project_id === null ? null : web,
  parent: null,
  group: [],
  docs: [],
  target: null,
  codex: false,
  plan: false,
  profile: { id: ProfileId.make("me"), name: "personal" },
  profiles,
  githubAccount: null,
  pen: "",
  github: null,
  ghTools: false,
  boardPr: false,
  workflowStart: null,
  docsTools: false,
  desktopHost: null,
  tmp: null,
  memory: "",
  ...o,
})

const told = (task: Thread, o: Partial<PromptContext> = {}) => systemPrompt(threadKindOf(task), context(task, o))
const base = (task: Thread, o: Partial<PromptContext> = {}) => basePrompt(threadKindOf(task), context(task, o))

const onGithub = { remote: "origin", repo: "o/web" }
const fromTask: StartFrom = { type: "task", task_id: TaskId.make("t3") }
const groupProjects = [
  { id: ProjectId.make("pr"), name: "Web", key: "WEB", repo_path: "/src/web" },
  { id: ProjectId.make("ap"), name: "Api", key: "API", repo_path: "/src/api" },
]
const planAndDiagram: ReadonlyArray<DocumentFile> = [
  ["plan", "/d/plan.html"],
  ["diagram", "/d/diagram.mmd"],
]
const inWorktree = { worktree_path: "/w/7-fix-it", branch: "ia/web-7-fix-it", base_branch: "main" }

/** The cases the goldens were recorded for: (name, thread, context). */
const cases: ReadonlyArray<readonly [string, Thread, Partial<PromptContext>]> = [
  ["code, plain", thread(), {}],
  ["code, worktree on GitHub, gh tools", thread(inWorktree), { github: onGithub, ghTools: true, tmp: "/tmp/ha-1/abc", githubAccount: "octo" }],
  ["code, worktree on GitHub, gh CLI", thread({ ...inWorktree, base_branch: null }), { github: { remote: "origin", repo: "o/web-mirror" } }],
  ["code, the board opens the pull request", thread(inWorktree), { github: onGithub, ghTools: true, boardPr: true }],
  ["code, pull requests off", thread(inWorktree), { project: { ...web, pull_requests: false }, github: onGithub }],
  [
    "code, a stack level",
    thread({ worktree_path: "/w/7", branch: "ia/web-7", base_branch: "ia/web-3", start_from: fromTask }),
    { github: onGithub, ghTools: true },
  ],
  ["code, a stack level on GitHub", thread({ worktree_path: "/w/7", branch: "ia/web-7", base_branch: "ia/web-3", start_from: fromTask, github_stack: 4 }), {}],
  [
    "code, from a pull request",
    thread({ worktree_path: "/w/7", branch: "ia/web-7", base_branch: "feature", start_from: { type: "pull_request", number: 12 } }),
    {},
  ],
  [
    "code, merges into another task",
    thread({ worktree_path: "/w/7", branch: "ia/web-7", base_branch: "ia/web-3", merges_into: TaskId.make("t3") }),
    { target: { number: 3, title: "Big", branch: "ia/web-3" }, ghTools: true },
  ],
  [
    "code, merges into a task without a branch, Codex in plan mode with docs and desktop",
    thread({ merges_into: TaskId.make("t3") }),
    { target: { number: 3, title: "Big", branch: null }, codex: true, plan: true, ghTools: true, docsTools: true, desktopHost: "box", githubAccount: "octo" },
  ],
  ["code, labelled plan and diagram", thread({ labels: ["plan", "diagram"], worktree_path: "/w/1", branch: "ia/web-1-search" }), { docs: planAndDiagram }],
  ["code, labelled artifact", thread({ labels: ["artifact"] }), { docs: [["artifact", "/d/artifact.html"]] }],
  ["documents only, plan", thread({ labels: ["plan"], work_dir: "documents/t1" }), { docs: [["plan", "/data/documents/t1/plan.html"]] }],
  ["documents only, no labels", thread({ work_dir: "documents/t1" }), {}],
  [
    "documents only, for a group",
    thread({ project_id: null, group_name: "Shop", labels: ["diagram", "artifact"], work_dir: "documents/t1" }),
    {
      group: groupProjects,
      docs: [
        ["artifact", "/d/artifact.html"],
        ["diagram", "/d/diagram.mmd"],
      ],
    },
  ],
  ["scratch, no project", thread({ project_id: null, task_type: "scratch", number: 1, title: "Ask" }), { tmp: "/tmp/x" }],
  ["scratch, a chat's folder", thread({ project_id: null, task_type: "scratch", number: 1, title: "Ask", work_dir: "/data/profiles/p/scratch" }), {}],
  ["scratch, in a project", thread({ task_type: "scratch", number: 2, title: "Ask" }), {}],
  ["group", thread({ project_id: null, group_name: "Shop", number: 1, title: "Plan it" }), { group: groupProjects.slice(0, 1) }],
  ["group, no projects", thread({ project_id: null, group_name: "Shop", number: 1, title: "Plan it" }), {}],
  [
    "assistant",
    thread({ project_id: null, task_type: "assistant", number: 1, title: "Assistant", work_dir: "assistants/t1" }),
    { memory: "\n\n## Your memory\n\n(memory)" },
  ],
  ["assistant on Codex, no workspace", thread({ project_id: null, task_type: "assistant", number: 1, title: "Assistant" }), { codex: true }],
  ["routine", thread({ project_id: null, task_type: "routine", number: 2, title: "Inbox", parent_id: TaskId.make("a1"), work_dir: "assistants/a1" }), {}],
  ["pens thread", thread({ project_id: null, task_type: "pens", number: 3, title: "Pens" }), {}],
  ["pens thread on Codex", thread({ project_id: null, task_type: "pens", number: 3, title: "Pens" }), { codex: true }],
  [
    "pen thread",
    thread({ project_id: null, task_type: "pen", number: 4, title: "Pen: Today", pen_id: PenId.make("p1") }),
    { pen: '\n\nYour pen, as it was when this run started: "Today" (id p1), with no tasks in it yet.' },
  ],
  [
    "reviewer with a ready worktree",
    thread({ kind: "review", parent_id: TaskId.make("t3"), number: 0, title: "Review" }),
    {
      parent: { number: 3, title: "Fix it", worktree_path: "/w/3", branch: "ia/web-3", worktree_ready: true },
      tmp: "/tmp/ha/3",
      docsTools: true,
      ghTools: true,
    },
  ],
  [
    "summarizer",
    thread({ kind: "review", task_type: "summary", parent_id: TaskId.make("t3"), number: 0, title: "Summary" }),
    { parent: { number: 3, title: "Fix it", worktree_path: null, branch: null, worktree_ready: false } },
  ],
  ["workflow step, no parent", thread({ kind: "review", task_type: "workflow", parent_id: TaskId.make("t3"), number: 0, title: "Step" }), {}],
]

/**
 * A system prompt is in paragraphs, with a blank line between them: none is empty, and no line starts or ends with a
 * space (as a sentence joined on to the one before would).
 */
const assertParagraphs = (text: string) => {
  assert.isTrue(text.includes("\n\n") && !text.includes("\n\n\n"), text)
  assert.isTrue(
    text.split("\n").every((l) => l.trim() === l),
    text,
  )
  assert.isTrue(
    text.split("\n\n").every((p) => p.trim() !== ""),
    text,
  )
}

describe("systemPrompt", () => {
  it("tells each kind of thread what the old builder told it, word for word", () => {
    assert.deepStrictEqual(
      cases.map(([name]) => name),
      Object.keys(systemPromptGoldens),
    )
    for (const [name, task, o] of cases) assert.strictEqual(told(task, o), systemPromptGoldens[name], name)
  })

  it("tells agents which boards they reach", () => {
    let note = told(thread())
    assert.isTrue(note.includes("also reach these profiles' boards: work."), note)
    assert.isTrue(note.includes("their projects aren't listed: lab."), note)
    note = told(thread(), { profile: { id: ProfileId.make("l"), name: "lab" } })
    assert.isTrue(!note.includes("Your board tools also reach") && note.includes("personal, work"), note)
  })

  it("a group task is told its group's projects", () => {
    const text = base(thread({ project_id: null, group_name: "Shop", number: 1, title: "Plan it" }), { group: groupProjects.slice(0, 1) })
    assert.isTrue(text.includes('task G-1 ("Plan it"') && text.includes("Web (key WEB, id pr, repository /src/web)"), text)
    assertParagraphs(text)
  })

  it("the assistant is told what it is", () => {
    const text = base(thread({ project_id: null, task_type: "assistant", number: 1, work_dir: "assistants/t1" }))
    assert.isTrue(text.includes("thread A-1 (id t1)"), text)
    assert.isTrue(text.includes("personal assistant") && text.includes("aren't a coding agent"), text)
    assert.isTrue(text.includes("(assistants/t1 in the board's data dir)"), text)
    assert.isTrue(text.includes("`create_task`") && text.includes("list_projects") && text.includes("request_user_input"), text)
    assert.isTrue(!text.includes('In review".'), text)
    assert.isTrue(text.includes("`at` routine") && text.includes("message_assistant"), text)
    assertParagraphs(text)
  })

  // HA-322: the long-lived threads hand the user's requests to background subagents and report back.
  it("the assistant and the pens threads are told to hand requests to background subagents", () => {
    const threads = [
      thread({ project_id: null, task_type: "assistant", number: 1 }),
      thread({ project_id: null, task_type: "pens", number: 1 }),
      thread({ project_id: null, task_type: "pen", number: 2 }),
    ]
    for (const t of threads) {
      const text = base(t)
      assert.isTrue(text.includes("run_in_background: true") && text.includes("then end your turn so they can go on"), text)
      assert.isTrue(text.includes("starts with none of this conversation") && text.includes("When a subagent finishes"), text)
      // The delegation paragraphs come before the last one, on asking the user.
      assert.isTrue(text.indexOf("Don't do the user's requests yourself") < text.indexOf("If you need a decision"), text)
      assertParagraphs(text)
    }
    // On Codex the run ends with the turn, and its subagents with it: it waits for them in its turn instead.
    for (const t of threads) {
      const text = base(t, { codex: true })
      assert.isTrue(text.includes("`wait` (collab)") && text.includes("Don't end your turn while any is still running"), text)
      assert.isTrue(!text.includes("run_in_background") && !text.includes("then end your turn so they can go on") && !text.includes("you're woken"), text)
      assert.isTrue(text.indexOf("Don't do the user's requests yourself") < text.indexOf("If you need a decision"), text)
      assertParagraphs(text)
    }
    // A routine's thread keeps its own instructions.
    assert.isTrue(!base(thread({ project_id: null, task_type: "routine", number: 2 })).includes("run_in_background"))
  })

  it("a routine thread is told what it is and works in the assistant's workspace", () => {
    const text = base(thread({ project_id: null, task_type: "routine", number: 2, parent_id: TaskId.make("a1"), work_dir: "assistants/a1" }))
    assert.isTrue(text.includes("thread A-2 (id t1)") && text.includes("(id a1)"), text)
    assert.isTrue(text.includes("(assistants/a1 in the board's data dir)"), text)
    assert.isTrue(text.includes("NO_REPLY") && text.includes("posted to your"), text)
    assertParagraphs(text)
  })

  // HA-198: a question left in a summary puts the task in "In review", where it looks finished.
  it("agents are told to ask rather than leave a question in their summary", () => {
    for (const t of [thread(), thread({ task_type: "scratch", project_id: null }), thread({ project_id: null, group_name: "Shop" })]) {
      const text = base(t)
      assert.isTrue(text.includes("You must call `request_user_input` before you end a turn whose last message needs something from the user"), text)
      assert.isTrue(text.includes("The one exception is an offer of something extra once everything the user asked for is done"), text)
      assertParagraphs(text)
    }
  })

  it("a task on GitHub is told to open a pull request", () => {
    const task = thread({ worktree_path: "/w/1-fix-it", branch: "ia/web-1-fix-it" })
    // Pushed to a mirror: gh is told which repository, as it would pick the fetch remote's.
    const github = { remote: "origin", repo: "o/web-mirror" }
    let text = base(task, { github })
    assert.isTrue(text.includes("Do not merge or switch branches unless asked."), text)
    assert.isTrue(text.includes("on GitHub (o/web-mirror)") && text.includes("`git push -u origin ia/web-1-fix-it`"), text)
    assert.isTrue(text.includes("into `main` in o/web-mirror (`gh pr create --repo o/web-mirror --head ia/web-1-fix-it --base main`"), text)
    // With the gh server, which turns away gh in Bash, through its tools.
    text = base(task, { github, ghTools: true })
    assert.isTrue(text.includes("in o/web-mirror (the gh tools' pr_create with repo `o/web-mirror`, head `ia/web-1-fix-it` and base `main`)"), text)
    assert.isTrue(!text.includes("gh pr create"), text)
    // Without GitHub (or a branch of its own), it leaves pushing to the user.
    text = base(task)
    assert.isTrue(text.includes("Do not push, merge, or switch branches unless asked.") && !text.includes("open a pull request"), text)
    assert.isTrue(!base(thread(), { github }).includes("open a pull request"))
    // Every agent is told it can wait on one, though.
    assert.isTrue(text.includes("For CI or reviews on a pull request, give it the `pull_request`"), text)
    // Its gh tools' note, after the rest.
    assert.isTrue(told(task, { github, ghTools: true }).includes(githubNote(null)))
  })

  it("a project can turn pull requests off", () => {
    const off = "This project's settings turn off pull requests"
    const task = thread(inWorktree)
    let text = base(task, { project: { ...web, pull_requests: false }, github: onGithub })
    assert.isTrue(!text.includes("open a pull request for this task's work") && text.includes(`${off} for its tasks, so don't push`), text)
    assert.isTrue(text.includes("Do not push, merge, or switch branches unless asked."), text)
    // A task without a branch of its own isn't told about them.
    text = base(thread(), { project: { ...web, pull_requests: false }, github: onGithub })
    assert.isTrue(!text.includes(off), text)
  })

  it("a plan task from before labels is told to make only its plan", () => {
    const text = base(thread({ title: "Plan search", number: 1, labels: ["plan"], work_dir: "documents/t1" }), {
      docs: [["plan", "/data/documents/t/plan.html"]],
    })
    assert.isTrue(text.includes('task WEB-1 ("Plan search"') && text.includes("a plan (HTML) to /data/documents/t/plan.html"), text)
    assert.isTrue(text.includes("Rather than changing code") && text.includes("break it into tasks"), text)
    assertParagraphs(text)
    assert.isTrue(text.includes("repository /src/web, which you can read") && !text.includes("worktree"), text)
    assert.isTrue(!text.includes("label plan") && !text.includes("carry it out in this task"), text)
    // It's told about the plan theme's components.
    assert.isTrue(text.includes('<ol class="steps">') && text.includes("<ia-html><template>"), text)
  })

  it("a labelled task is told to write its documents besides its work", () => {
    const task = thread({ title: "Search", worktree_path: "/w/1", branch: "ia/web-1-search" })
    const plain = base(task)
    assert.isTrue(!plain.includes("label") && !plain.includes('<ol class="steps">'), plain)
    const text = base({ ...task, labels: ["plan", "diagram"] }, { docs: planAndDiagram })
    // A code task still, in its worktree.
    assert.isTrue(text.startsWith(plain) && text.includes("dedicated git worktree at /w/1"), text)
    assert.isTrue(text.includes("the labels plan, diagram") && text.includes("a plan (HTML) to /d/plan.html and a Mermaid diagram to /d/diagram.mmd"), text)
    assert.isTrue(text.includes("don't commit them") && text.includes("The plan comes first") && text.includes("carry it out in this task"), text)
    assert.isTrue(text.includes('<ol class="steps">') && text.includes("Mermaid source") && !text.includes("Rather than changing code"), text)
    assert.isTrue(text.includes("<ia-diagram><pre>flowchart LR") && text.includes("Always use Mermaid for plan diagrams"), text)
    assert.isTrue(!text.includes("<ia-diagram><svg"), text)
  })

  it("a reviewer is told what it reviews and not to change it", () => {
    const parent = { number: 1, title: "Fix it", worktree_path: "/w/1", branch: "ia/web-1-fix-it", worktree_ready: true }
    let text = base(thread({ kind: "review", parent_id: TaskId.make("p"), number: 0 }), { parent })
    assert.isTrue(text.startsWith('You are the code reviewer for task WEB-1 ("Fix it")') && text.includes("worktree at /w/1 on branch `ia/web-1-fix-it`"), text)
    assert.isTrue(text.includes("\n\nReview only:") && text.includes("call `submit_review` exactly once"), text)
    assertParagraphs(text)
    text = base(thread({ kind: "review", task_type: "summary", parent_id: TaskId.make("p"), number: 0 }), { parent })
    assert.isTrue(text.startsWith("You summarise the changes made for task WEB-1") && text.includes("\n\nRead only:"), text)
    assertParagraphs(text)
    // Reviewers aren't told of other profiles' boards or the docs server, and share the task's temp folder.
    text = told(thread({ kind: "review", parent_id: TaskId.make("p"), number: 0 }), { parent, docsTools: true, tmp: "/tmp/t" })
    assert.isTrue(
      !text.includes("Your profile on the board") && !text.includes("publish it as a document") && text.includes("shared with the task's agent"),
      text,
    )
  })

  it("a scratch task is told it has no repository", () => {
    let text = base(thread({ project_id: null, task_type: "scratch", number: 1, title: "Ask" }))
    assert.isTrue(text.includes('scratch task S-1 ("Ask"') && text.includes("isn't in a project or a repository"), text)
    assert.isTrue(text.includes("the task's own folder") && text.includes("write freely") && !text.includes("worktree"), text)
    // One from a scratch chat isn't told its (maybe shared) folder is free to write in.
    text = base(thread({ project_id: null, task_type: "scratch", number: 1, title: "Ask", work_dir: "/data/profiles/p/scratch" }))
    assert.isTrue(text.includes("a scratch folder") && !text.includes("write freely"), text)
    assertParagraphs(text)
  })

  it("a scratch task in a project reads it", () => {
    const text = base(thread({ task_type: "scratch", number: 2, title: "Ask" }))
    assert.isTrue(
      text.includes('scratch task WEB-2 ("Ask"') && text.includes("in the project Web") && text.includes("repository /src/web, which you can read"),
      text,
    )
    assert.isTrue(text.includes("Don't change the repository") && !text.includes("subproject") && !text.includes("isn't in a project"), text)
    assertParagraphs(text)
  })

  it("a Codex run in plan mode is told so, and of the gh server in Codex's words", () => {
    const text = told(thread(), { codex: true, plan: true, ghTools: true })
    assert.isTrue(text.includes("You are in plan mode") && text.includes("`gh.pr_view`") && !text.includes(githubNote(null)), text)
    // Claude Code tells Claude itself.
    assert.isTrue(!told(thread(), { plan: true }).includes("You are in plan mode"))
  })
})
