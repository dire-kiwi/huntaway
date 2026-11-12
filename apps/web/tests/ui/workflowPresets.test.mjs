// The workflow editor's presets and inspectors (HA-276, HA-277), as the old checks had them; workflows and the project
// are read and changed over RPC in place of the REST API. Left out until their pages come over: what the project
// settings' Review tab says about workflows (6.12), and the project's skills and MCP servers an agent step picks from
// (6.4: until then a step's skills are typed).
import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vite-plus/test"
import { eventually, makeTask, seedBoard, startServer, withBrowser } from "./harness.mjs"

let server, project
beforeAll(async () => {
  server = startServer()
  ;({ project } = await seedBoard(server))
})
afterAll(() => server?.stop())

const workflows = () => server.rpc("workflows.list", { project_id: project.id })
const deleteAll = async () => {
  for (const w of await workflows()) await server.rpc("workflows.delete", { id: w.id })
}
const updateProject = (patch) => server.rpc("projects.update", { id: project.id, patch })
const getProject = () => server.rpc("projects.get", { id: project.id })

/** The workflow named `name`, once it's saved. */
const workflow = (name) =>
  eventually(async () => {
    const w = (await workflows()).find((x) => x.name === name)
    assert.ok(w, `no workflow ${name}`)
    return w
  })

// HA-276: a workflow whose In progress column, once the agent is done, opens the pull request and moves the task to In review.
test("the pull request preset saves its columns and its pull request step", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "click role=button[name='Open a PR when done']",
      "wait Pushes the branch",
      "click [data-node=pr]",
      "click Open it as a draft",
      "click Create workflow",
      "gone [role=dialog]",
      "wait In progress → In review → Needs attention · pull request",
    ])
    const w = await workflow("Open a pull request, then review")
    const kinds = Object.fromEntries(w.graph.nodes.map((n) => [n.id, n]))
    assert.deepEqual([kinds.start.kind, kinds.start.status, kinds.review.kind, kinds.review.status], ["column", "in_progress", "column", "in_review"])
    assert.deepEqual([kinds.pr.kind, kinds.pr.draft], ["open_pr", true])
    assert.ok(w.graph.edges.some((e) => e.from === "pr" && e.port === "opened" && e.to === "review"))
  })
})

// HA-276: a column's prompt, when its work is done, and what the board adds to the prompt about what comes next.
test("a column step's prompt and done signal are saved, with what's added to the prompt", async () => {
  // In progress belongs to one workflow that's on: not the first test's.
  await deleteAll()
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "click role=button[name='Work, PR and review']",
      "wait Pushes the branch",
      "click [data-node=work]",
      "click [data-testid=workflow-inspector] textarea",
      "type Build it, with tests.",
      "wait [data-testid=column-done-note]",
    ])
    const note = await ui.page.textContent("[data-testid=column-done-note]")
    assert.ok(note.includes("The board then pushes your branch and opens its pull request (so don't open one yourself) and moves the task to In review"), note)
    await ui.page.selectOption("[data-testid=workflow-inspector] select >> nth=1", "finish")
    await ui.run(["wait call `finish_work`", "click Create workflow", "gone [role=dialog]"])
    const w = await workflow("Work, pull request and review")
    const work = w.graph.nodes.find((n) => n.id === "work")
    assert.deepEqual([work.kind, work.status, work.prompt, work.done_when], ["column", "in_progress", "Build it, with tests.", "finish"])
  })
})

test("an agent step's input-only switch is saved", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "click role=button[name='Summarise, then a skill']",
      "wait from the steps before",
      "click [data-node=skill]",
      "click Work only on what the steps before it wrote",
      "click [data-node=summary]",
      "click Work only on what the steps before it wrote",
      "click Create workflow",
      "gone [role=dialog]",
    ])
    const w = await workflow("Summarise, then a skill")
    const n = Object.fromEntries(w.graph.nodes.map((x) => [x.id, x]))
    // The preset's skill step had it on, and the summary off: each was switched.
    assert.deepEqual([n.summary.input_only, "input_only" in n.skill], [true, false])
  })
})

// Review of HA-276: lines back into In progress give the agent its work a limited number of times in a row, which
// In progress's step sets once a line goes into it.
test("In progress's rounds are set once a line goes back into it", async () => {
  await deleteAll()
  const w = await server.rpc("workflows.create", {
    workflow: {
      project_id: project.id,
      name: "Loop back",
      graph: {
        nodes: [
          { id: "work", kind: "column", status: "in_progress", prompt: "", x: 0, y: 0 },
          { id: "review", kind: "column", status: "in_review", prompt: "", x: 300, y: 0 },
          { id: "c", kind: "condition", check: "has_pr", x: 600, y: 0 },
        ],
        edges: [
          { from: "work", port: "done", to: "review" },
          { from: "review", port: "done", to: "c" },
          { from: "c", port: "no", to: "work" },
        ],
      },
    },
  })
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "click role=button[name=/^Edit$/]",
      "wait [data-node=work]",
      "click [data-node=work]",
      "wait Rounds",
      "click [data-testid=workflow-inspector] input[type=number]",
      "type 5",
      "click Save",
      "gone [role=dialog]",
    ])
  })
  const saved = await server.rpc("workflows.get", { id: w.id })
  assert.equal(saved.graph.nodes.find((n) => n.id === "work").max_rounds, 5)
})

// A template's {{…}} values are listed as one is typed: the task's, and each step's output by its id.
test("a template's values are completed as they're typed", async () => {
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "click role=button[name='Work, PR and review']",
      "wait Pushes the branch",
      "click [data-node=fix]",
      "click [data-testid=workflow-inspector] textarea",
      "type Fix {{iss",
      "wait role=option[name=/reviewer\\.issues/]",
      "press ArrowDown",
      "press Enter",
      "gone [role=listbox]",
      "press Space",
      "type for {{ task.ti",
      "wait role=option[name=/task\\.title/]",
      "press Tab",
      "gone [role=listbox]",
      "press Space",
      "type {{",
      "wait [role=listbox]",
      "press Escape",
      "gone [role=listbox]",
      // Escape closed the list, not the dialog.
      "wait Pushes the branch",
    ])
    const text = await ui.page.inputValue("[data-testid=workflow-inspector] textarea")
    assert.equal(text, "Fix {{reviewer.issues}} for {{task.title}} {{")
  })
})

// An agent step names the skills it's asked to use, as a thread does. (The old check picked them, and the MCP servers
// it turns off, from the project's agent tools, which come with 6.4.)
test("an agent step's skills are saved", async () => {
  await deleteAll()
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "click role=button[name='Work, PR and review']",
      "wait Pushes the branch",
      "click [data-node=reviewer]",
      "click [data-testid=step-skills] >> role=textbox",
      "type security-review",
      "press Enter",
      "wait [data-testid=step-skills] >> role=button[name=/security-review/]",
      "click Create workflow",
      "gone [role=dialog]",
    ])
  })
  const [w] = await workflows()
  const reviewer = w.graph.nodes.find((n) => n.id === "reviewer")
  assert.deepEqual([reviewer.skills, "disabled_mcp_servers" in reviewer], [["security-review"], false])
})

// The board's default as a workflow: In progress, In review with the Review tab's reviewer, fix rounds and summarizer,
// and Ready for merge; creating it switches the project to its workflows, which the switch turns back off.
test("Board's default replicates the board's handling and switches the project to workflows", async () => {
  await deleteAll()
  await updateProject({ use_workflows: false, auto_review: true, auto_summary: true, review_rounds: 3 })
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "wait [data-testid=use-workflows] >> text=The board handles this project's tasks itself",
      'click role=button[name="Board\'s default"]',
      "wait [data-node=reviewer]",
      "click Create workflow",
      "gone [role=dialog]",
      "wait [data-testid=use-workflows] >> text=Tasks entering a column start the workflows",
    ])
    const [w] = await workflows()
    const g = w.graph
    const n = Object.fromEntries(g.nodes.map((x) => [x.id, x]))
    assert.deepEqual(
      ["work", "review", "merge"].map((id) => n[id].status),
      ["in_progress", "in_review", "ready_for_merge"],
    )
    assert.deepEqual(
      [n.commits.check, n.changed.check, n.reviewer.output, n.fix.max_rounds, n.summary.output],
      ["has_commits", "changed", "verdict", 3, "text"],
    )
    const has = (from, port, to) => g.edges.some((e) => e.from === from && e.port === port && e.to === to)
    assert.ok(has("work", "done", "review") && has("review", "done", "commits") && has("commits", "yes", "changed") && has("changed", "yes", "reviewer"))
    assert.ok(has("reviewer", "issues", "fix") && has("reviewer", "pass", "summary"))
    assert.deepEqual([n.done.status, has("merge", "done", "done")], ["done", true])
    assert.equal((await getProject()).use_workflows, true)
    // Off again from the switch.
    await ui.run(["click [data-testid=use-workflows] [role=switch]", "wait text=The board handles this project's tasks itself"])
    assert.equal((await getProject()).use_workflows, false)
  })
})

// HA-277: with workflows on, the board doesn't review or summarise: switching them on moves the Review tab's reviews
// into a workflow, and its tasks have no board's Review tab. Off again, they're back.
test("switching to workflows moves the Review tab's reviews into a workflow", async () => {
  const task = await makeTask(server, project, { title: "Reviewed by whom", status: "todo" })
  // The board's own Review tab button (a workflow's has its icon and a title).
  const boardReviewTab = "[...document.querySelectorAll('button')].some((b) => b.textContent.trim().toLowerCase() === 'review' && !b.querySelector('[title]'))"
  await deleteAll()
  await updateProject({ use_workflows: false, auto_review: true, auto_summary: true, review_rounds: 4 })
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      "click [data-testid=use-workflows] [role=switch]",
      "wait text=workflows' steps review and summarise instead",
      "wait In review · Reviewer, Summary",
    ])
    const w = await workflow("Review and summarise")
    assert.ok(w.enabled)
    assert.equal(w.graph.nodes.find((n) => n.id === "fix").max_rounds, 4)
    await ui.run([
      // Its tasks have no board's Review tab: a workflow's steps add their own.
      `goto /t/${task.id}`,
      "wait Changes",
      `assert !${boardReviewTab}`,
      `goto /p/${project.id}/settings/workflows`,
      "click [data-testid=use-workflows] [role=switch]",
      "wait text=The board handles this project's tasks itself",
      `goto /t/${task.id}`,
      "wait Changes",
      `assert ${boardReviewTab}`,
    ])
  })
})

// A column's preview shows what its agent is sent: its prompt, or the project's when it's blank, and the line the
// board adds about what comes next (none for Ready for merge, whose done is the merge itself). The old check showed
// the board's own start prompt for a project without one; until `host.defaultPrompts` is here (6.12) the preview says
// it's the board's default.
test("a column shows the prompt its agent is sent, the project's when it's blank", async () => {
  await updateProject({ merge_prompt: "Squash it, then delete the branch." })
  await withBrowser(server, {}, async (ui) => {
    await ui.run([
      `goto /p/${project.id}/settings/workflows`,
      'click role=button[name="Board\'s default"]',
      "click [data-node=merge]",
      "wait [data-testid=column-prompt-preview] >> text=Squash it, then delete the branch.",
    ])
    const merge = await ui.page.textContent("[data-testid=column-prompt-preview]")
    assert.ok(merge.includes("The project's merge prompt:") && !merge.includes("When you're done"), merge)
    // Its done goes into Done: the agent says it's merged, and the workflow moves the task there.
    assert.ok(merge.includes("Once it is merged, call `finish_work`") && merge.includes("the board then moves the task to Done."), merge)
    // In progress: the project's start prompt (the board's default here), then what the board does once it's done.
    await ui.run(["click [data-node=work]", "wait [data-testid=column-prompt-preview] >> text=The board's default start prompt."])
    const start = await ui.page.textContent("[data-testid=column-prompt-preview]")
    assert.ok(start.includes("The board then moves the task to In review."), start)
    // In review has no prompt here, so its agent is sent nothing, and its steps run as soon as the task moves there.
    await ui.run(["click [data-node=review]", "wait text=Its done comes as soon as a task moves here", "gone [data-testid=column-prompt-preview]"])
    // Its own prompt replaces the project's.
    await ui.run([
      "click [data-node=merge]",
      "click [data-testid=workflow-inspector] textarea",
      "type Rebase, then merge.",
      "wait [data-testid=column-prompt-preview] >> text=Rebase, then merge.",
    ])
    assert.ok(!(await ui.page.textContent("[data-testid=column-prompt-preview]")).includes("Squash it"))
  })
  await updateProject({ merge_prompt: null })
})
