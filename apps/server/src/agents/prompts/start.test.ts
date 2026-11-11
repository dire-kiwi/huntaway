import { assert, describe, it } from "@effect/vitest"
import { ProjectId, TaskId, threadKindOf } from "@huntaway/contracts"
import type { ThreadKindFields } from "@huntaway/contracts"
import { DEFAULT_MERGE, DEFAULT_REVIEW, DEFAULT_START, PROJECT_PROMPT_DEFAULTS } from "../../prompts/projectDefaults.ts"
import type { DocumentFile } from "../../prompts/documentGuide.ts"
import type { PromptProject, PromptTask } from "./context.ts"
import { projectMerge, projectReview, projectStart, reviewerInstructions } from "./project.ts"
import { isSlashCommand, planRest, runPrompt, taskStartPrompt, withLostNote } from "./start.ts"

// The prompt a run starts with (huntaway's agent/runner/prompt.test.ts, the first prompt's cases; agent/prompts.test.ts;
// and the launch's `/plan`, lost background work and mentions, agent/runner/launch.ts), on the pure builders.

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
  use_worktree: false,
  number: 1,
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

const project = (start_prompt: string | null = null): PromptProject => ({
  id: ProjectId.make("pr"),
  name: "X",
  key: "X",
  repo_path: "/x",
  base_branch: null,
  pull_requests: true,
  start_prompt,
})

const start = (task: Thread, p: PromptProject | null, text: string, workflowStart: string | null = null) =>
  taskStartPrompt(threadKindOf(task), { task, project: p, workflowStart }, text)

describe("taskStartPrompt", () => {
  it("starts with the project's instructions", () => {
    const task = thread()
    assert.strictEqual(start(task, project(), ""), `# X-1: Fix it\n\nIt's broken.\n\n---\n\n${DEFAULT_START}\n`)
    const own = project("Write a plan and ask me about it first.")
    let text = start(task, own, "Only the server.")
    assert.isTrue(text.endsWith("---\n\nWrite a plan and ask me about it first.\n\nOnly the server.\n"), text)
    // A skill's command goes first, where Claude Code expands it, with the task as its arguments.
    text = start(task, own, " /code-review the server\n")
    assert.strictEqual(text, "/code-review the server\n\n# X-1: Fix it\n\nIt's broken.\n\n---\n\nWrite a plan and ask me about it first.\n")
    text = start(task, own, "/plugin:skill")
    assert.isTrue(text.startsWith("/plugin:skill\n\n# X-1"), text)
    // A path isn't a command.
    text = start(task, own, "/home/me/x.log has the error")
    assert.isTrue(text.startsWith("# X-1") && text.endsWith("\n/home/me/x.log has the error\n"), text)
    // Followed by what it's for elsewhere.
    const links = [{ provider: "asana" as const, id: "12", url: "https://app.asana.com/0/1/12", title: "Fix signup" }]
    text = start(thread({ external_links: links }), own, "")
    assert.isTrue(text.startsWith("# X-1: Fix it\n\nIt's broken.\n\nThis task is for:\n- Asana task: Fix signup (https://app.asana.com/0/1/12)\n\n---\n"), text)
    // A workflow's In progress text takes the place of the project's.
    assert.isTrue(start(task, own, "", "Write a failing test.").endsWith("---\n\nWrite a failing test.\n"))
  })

  it("keys a task in no project by its kind", () => {
    assert.isTrue(start(thread({ project_id: null, group_name: "Shop", title: "Plan it" }), null, "").startsWith("# G-1: Plan it\n"))
    assert.isTrue(start(thread({ project_id: null, task_type: "scratch", title: "Ask" }), null, "").startsWith("# S-1: Ask"))
    assert.isTrue(start(thread({ task_type: "scratch", number: 2, title: "Ask" }), project(), "").startsWith("# X-2: Ask"))
  })

  it("the assistant's, a routine's and the pens threads' first prompt is the message as it is", () => {
    for (const task_type of ["assistant", "routine", "pens", "pen"] as const) {
      const task = thread({ project_id: null, task_type })
      assert.strictEqual(start(task, null, " What's on today?\n"), "What's on today?")
      assert.isTrue(!start(task, null, "Hi").includes(DEFAULT_START))
    }
  })

  it("a project's start instructions are for its code tasks", () => {
    const own = project("Write a failing test first.")
    assert.isTrue(start(thread({ labels: ["plan"], work_dir: "documents/t1" }), own, "").includes(DEFAULT_START))
    assert.isTrue(start(thread({ task_type: "scratch" }), own, "").includes(DEFAULT_START))
    assert.isTrue(start(thread({ labels: ["plan", "diagram"] }), own, "").includes("Write a failing test first."))
  })
})

describe("the project's prompts", () => {
  it("a project without its own uses the default", () => {
    const p = { start_prompt: null, review_prompt: null, merge_prompt: null }
    assert.deepStrictEqual([projectStart(p), projectReview(p), projectMerge(p)], [DEFAULT_START, DEFAULT_REVIEW, DEFAULT_MERGE])
    assert.strictEqual(projectStart(null), DEFAULT_START)
    const own = { ...p, start_prompt: "  Plan first.\n", merge_prompt: "   " }
    assert.deepStrictEqual([projectStart(own), projectMerge(own)], ["Plan first.", DEFAULT_MERGE])
    assert.strictEqual(PROJECT_PROMPT_DEFAULTS.review_prompt, DEFAULT_REVIEW)
  })

  it("a reviewer's own instructions win over the project's", () => {
    assert.strictEqual(reviewerInstructions(null, {}), DEFAULT_REVIEW)
    assert.strictEqual(reviewerInstructions(null, { prompt: "  Look at the SQL only.  " }), "Look at the SQL only.")
    assert.strictEqual(reviewerInstructions({ review_prompt: "Ours." }, { prompt: "   " }), "Ours.")
  })
})

/** No keys named. */
const none = () => ""

describe("runPrompt", () => {
  const plan: ReadonlyArray<DocumentFile> = [["plan", "/data/documents/t1/plan.html"]]

  it("tells a command from a path, and reads `/plan`", () => {
    for (const [text, is] of [
      ["/code-review", true],
      ["/plugin:skill args", true],
      ["/home/me/x.log", false],
      ["/", false],
      ["code-review", false],
    ] as const) {
      assert.strictEqual(isSlashCommand(text), is, text)
    }
    assert.deepStrictEqual(["/plan", "  /plan the API ", "/planning", "/plan\nsteps", "plan"].map(planRest), ["", "the API", null, "steps", null])
  })

  it("rewrites `/plan` into how to write the plan, once the task has the label, and says nothing of its keys", () => {
    const c = { task: thread({ labels: ["plan"], session_id: "s" }), project: project(), workflowStart: null, docs: plan }
    const text = runPrompt(threadKindOf(c.task), c, { text: "/plan the X API", lost: [], mentions: () => "\n\n[Mentions]" })
    assert.strictEqual(
      text,
      "Write a plan to /data/documents/t1/plan.html, as your instructions for this task's plan say, and iterate on it with me before you start on the work.\n\nWhat to plan: the X API",
    )
    // Without the label, it's the message as it is.
    const plain = { ...c, task: thread({ session_id: "s" }), docs: [] }
    assert.strictEqual(runPrompt(threadKindOf(plain.task), plain, { text: "/plan", lost: [], mentions: none }), "/plan")
  })

  it("puts a task's first prompt around the message, and the mentions note after it", () => {
    const c = { task: thread({ description: "See HA." }), project: project(), workflowStart: null, docs: [] }
    let scanned = ""
    const text = runPrompt(threadKindOf(c.task), c, {
      text: "Fix it in HA-2.",
      lost: [],
      mentions: (s) => {
        scanned = s
        return "\n\n[Mentions, from the board:\n- HA-2: …]"
      },
    })
    assert.isTrue(text.startsWith("# X-1: Fix it\n\nSee HA.\n") && text.endsWith("Fix it in HA-2.\n\n[Mentions, from the board:\n- HA-2: …]"), text)
    // The description is read for keys with a first prompt; the instructions aren't the user's words.
    assert.strictEqual(scanned, "See HA.\nFix it in HA-2.")
    // Later, the message alone; a thread under a task isn't told.
    const later = { ...c, task: thread({ session_id: "s" }) }
    assert.strictEqual(runPrompt(threadKindOf(later.task), later, { text: "Go on.", lost: [], mentions: (s) => `\n\n[${s}]` }), "Go on.\n\n[Go on.]")
    const review = { ...c, task: thread({ kind: "review", session_id: null }) }
    assert.strictEqual(runPrompt(threadKindOf(review.task), review, { text: "Review it.", lost: [], mentions: () => "\n\n[x]" }), "Review it.")
  })

  it("tells a session that goes on of the background work its last run stopped, once, after a command", () => {
    const lost = [
      { kind: "shell", label: "npm run dev" },
      { kind: "subagent", label: "Look it up" },
    ]
    const note =
      "Note: this background work of yours was stopped (by the user, or as your last run ended), so it isn't running and " +
      "won't report back. Start again what you still need, and don't tell the user it's running:\n- shell: npm run dev\n- subagent: Look it up\n\n"
    assert.strictEqual(withLostNote(lost, true, "Go on."), `${note}Go on.`)
    assert.strictEqual(withLostNote(lost, true, "/review now\n"), `/review now\n\n${note.trimEnd()}`)
    // A session started afresh never had it.
    assert.strictEqual(withLostNote(lost, false, "Go on."), "Go on.")
    assert.strictEqual(withLostNote([], true, "Go on."), "Go on.")
    // At most the latest ten.
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: "shell", label: `job ${i}` }))
    const c = { task: thread({ session_id: "s" }), project: project(), workflowStart: null, docs: [] }
    const text = runPrompt(threadKindOf(c.task), c, { text: "Go on.", lost: many, mentions: none })
    assert.isTrue(!text.includes("job 1\n") && text.includes("- shell: job 2\n") && text.includes("- shell: job 11\n"), text)
  })
})
