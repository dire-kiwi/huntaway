import type { Project, Reviewer, WorkflowEdge, WorkflowGraph, WorkflowNode } from "@huntaway/contracts"

/** What a preset reads from the project: its review settings, with its profile's reviewers and summarizers where it has none. */
export type PresetSource = Pick<Project, "reviewers" | "summarizers" | "auto_review" | "auto_summary" | "review_rounds">

const SUMMARY_PROMPT =
  "Summarise what the work on {{task.key}} changed, for someone deciding whether to merge it: what it does and how, what was tested, and anything to check or decide before it's merged. Keep it short, with headings and lists where they help."

const ANY_REVIEWER: Reviewer = { claude_config_id: null, model: null, effort: null }

const shift = (n: WorkflowNode): WorkflowNode => ({ ...n, x: n.x + 440 })

/**
 * What the board does with the project's tasks without workflows, as one (HA-276): the agent starts in In progress with
 * the project's start prompt, and once it's done the task moves to In review, where (with the Review tab's automatic
 * review on) a task with commits of its own that changed is reviewed by its reviewers, their issues go back to the
 * agent for up to its rounds of fixes (then Needs attention), and once it passes its summarizers summarise it (with
 * summaries on). Ready for merge's agent merges it with the project's merge prompt, and says so with finish_work, for
 * the workflow to move it to Done.
 */
function boardDefault(p: PresetSource): WorkflowGraph {
  // Its summarizers only with summaries on (as fromReviewSettings has them).
  const review = fromReviewSettings(p)
  const nodes: WorkflowNode[] = [
    { id: "work", kind: "column", status: "in_progress", prompt: "", x: 20, y: 120 },
    { id: "review", kind: "column", status: "in_review", prompt: "", x: 240, y: 120 },
    { id: "merge", kind: "column", status: "ready_for_merge", prompt: "", x: 20, y: 300 },
    { id: "done", kind: "column", status: "done", prompt: "", x: 240, y: 300 },
  ]
  // Once the merging agent says it's merged, the workflow moves the task to Done.
  const edges: WorkflowEdge[] = [
    { from: "work", port: "done", to: "review" },
    { from: "merge", port: "done", to: "done" },
  ]
  if (p.auto_review) {
    // Only a branch with commits of its own is reviewed, and only once for each change.
    nodes.push({ id: "commits", kind: "condition", check: "has_commits", x: 440, y: 120 })
    edges.push({ from: "review", port: "done", to: "commits" })
    for (const n of review.nodes) if (n.id !== "start") nodes.push(shift(n))
    for (const e of review.edges) if (e.from !== "start") edges.push(e)
    edges.push({ from: "commits", port: "yes", to: "changed" })
  }
  return { nodes, edges }
}

/** A reviewer's agent, as an agent step's settings (those it leaves unset left out). */
const agentOf = (r: Reviewer) => ({
  ...(r.claude_config_id ? { claude_config_id: r.claude_config_id } : {}),
  ...(r.model ? { model: r.model } : {}),
  ...(r.effort ? { effort: r.effort } : {}),
  skills: r.skills ?? [],
})

/** The Review tab's reviews and summaries, as a workflow: its reviewers, fix rounds and summarizers. */
function fromReviewSettings(p: PresetSource): WorkflowGraph {
  const reviewers: ReadonlyArray<Reviewer> = p.reviewers.length ? p.reviewers : [ANY_REVIEWER]
  const nodes: WorkflowNode[] = [
    { id: "start", kind: "column", status: "in_review", prompt: "", x: 20, y: 120 },
    { id: "changed", kind: "condition", check: "changed", x: 220, y: 120 },
  ]
  const edges: WorkflowEdge[] = [{ from: "start", port: "done", to: "changed" }]
  const reviewerId = (i: number) => (reviewers.length > 1 ? `reviewer${i + 1}` : "reviewer")
  reviewers.forEach((r, i) => {
    const id = reviewerId(i)
    nodes.push({
      id,
      kind: "agent",
      name: reviewers.length > 1 ? `Reviewer ${i + 1}` : "Reviewer",
      prompt: r.prompt ?? "",
      output: "verdict",
      tab: "Review",
      ...agentOf(r),
      x: 420,
      y: 40 + i * 120,
    })
    edges.push({ from: "changed", port: "yes", to: id }, { from: id, port: "issues", to: "fix" })
  })
  nodes.push({ id: "fix", kind: "send_to_task", message: "", max_rounds: Math.max(0, p.review_rounds), x: 640, y: 30 })
  if (p.auto_summary) {
    const summarizers: ReadonlyArray<Reviewer> = p.summarizers.length ? p.summarizers : [ANY_REVIEWER]
    summarizers.forEach((r, i) => {
      const id = summarizers.length > 1 ? `summary${i + 1}` : "summary"
      nodes.push({
        id,
        kind: "agent",
        name: r.name || "Summary",
        prompt: r.prompt || SUMMARY_PROMPT,
        output: "text",
        tab: "Summary",
        ...agentOf(r),
        x: 640,
        y: 190 + i * 110,
        ...(reviewers.length > 1 ? { join: "all" as const } : {}),
      })
      reviewers.forEach((_, k) => edges.push({ from: reviewerId(k), port: "pass", to: id }))
    })
  }
  return { nodes, edges }
}

/** A starting point for a new workflow: `title` is the new workflow's name; `replacesBoard`, creating it (on) switches the project to use workflows. */
export interface Preset {
  readonly name: string
  readonly title?: string
  readonly hint?: string
  readonly replacesBoard?: boolean
  readonly graph: (p: PresetSource) => WorkflowGraph
}

/** Starting points for a new workflow, drawn with column nodes. */
export const PRESETS: ReadonlyArray<Preset> = [
  {
    name: "Board's default",
    title: "The board's default",
    hint: "What the board does with this project's tasks without workflows, as one to change: In progress with the start prompt, then In review, where the Review tab's reviewers review the work, send its issues back for its rounds of fixes, and its summarizers summarise it once it passes, and Ready for merge with the merge prompt. Creating it switches the project to use workflows instead of the board's default.",
    replacesBoard: true,
    graph: boardDefault,
  },
  {
    name: "Work, PR and review",
    title: "Work, pull request and review",
    hint: "A task's way across the board: the agent works in In progress, then the board opens its pull request and moves it to In review, where a reviewer sends the issues it finds back to the agent (which goes round again) or, once it passes, a summary is written.",
    graph: () => ({
      nodes: [
        { id: "work", kind: "column", status: "in_progress", prompt: "", x: 20, y: 120 },
        { id: "commits", kind: "condition", check: "has_commits", x: 220, y: 120 },
        { id: "pr", kind: "open_pr", title: "", body: "", x: 420, y: 40 },
        { id: "review", kind: "column", status: "in_review", prompt: "", x: 650, y: 120 },
        { id: "reviewer", kind: "agent", name: "Reviewer", prompt: "", output: "verdict", tab: "Review", skills: [], x: 870, y: 120 },
        { id: "fix", kind: "send_to_task", message: "", max_rounds: 2, x: 1090, y: 40 },
        { id: "summary", kind: "agent", name: "Summary", prompt: SUMMARY_PROMPT, output: "text", tab: "Summary", skills: [], x: 1090, y: 190 },
        { id: "attention", kind: "column", status: "needs_attention", prompt: "", x: 650, y: 280 },
      ],
      edges: [
        { from: "work", port: "done", to: "commits" },
        { from: "commits", port: "yes", to: "pr" },
        { from: "commits", port: "no", to: "review" },
        { from: "pr", port: "opened", to: "review" },
        { from: "pr", port: "exists", to: "review" },
        { from: "pr", port: "failed", to: "attention" },
        { from: "review", port: "done", to: "reviewer" },
        { from: "reviewer", port: "issues", to: "fix" },
        { from: "reviewer", port: "pass", to: "summary" },
      ],
    }),
  },
  {
    name: "Open a PR when done",
    title: "Open a pull request, then review",
    hint: "When the task's agent is done in In progress, open a pull request for its branch (if it has commits of its own) and move the task to In review.",
    graph: () => ({
      nodes: [
        { id: "start", kind: "column", status: "in_progress", prompt: "", x: 20, y: 120 },
        { id: "commits", kind: "condition", check: "has_commits", x: 220, y: 120 },
        { id: "pr", kind: "open_pr", title: "", body: "", x: 420, y: 40 },
        { id: "review", kind: "column", status: "in_review", prompt: "", x: 650, y: 20 },
        { id: "attention", kind: "column", status: "needs_attention", prompt: "", x: 650, y: 150 },
      ],
      edges: [
        { from: "start", port: "done", to: "commits" },
        { from: "commits", port: "yes", to: "pr" },
        { from: "commits", port: "no", to: "review" },
        { from: "pr", port: "opened", to: "review" },
        { from: "pr", port: "exists", to: "review" },
        { from: "pr", port: "failed", to: "attention" },
      ],
    }),
  },
  {
    name: "Summarise, then a skill",
    hint: "When a task moves to In review, summarise its changes, then have another agent process that summary with a skill, in a fresh context.",
    graph: () => ({
      nodes: [
        { id: "start", kind: "column", status: "in_review", prompt: "", x: 20, y: 120 },
        { id: "summary", kind: "agent", name: "Summary", prompt: SUMMARY_PROMPT, output: "text", tab: "Summary", skills: [], x: 220, y: 120 },
        {
          id: "skill",
          kind: "agent",
          name: "Skill",
          prompt: "Process the summary above with your skill.",
          output: "text",
          tab: "Skill",
          skills: [],
          input_only: true,
          x: 440,
          y: 120,
        },
      ],
      edges: [
        { from: "start", port: "done", to: "summary" },
        { from: "summary", port: "done", to: "skill" },
      ],
    }),
  },
  {
    name: "From the Review tab",
    title: "Review and summarise",
    hint: "The reviewers, fix rounds and summarizers of this project's Review tab (or its profile's), as a workflow. Creating it (on) switches the project to use workflows, so the board's reviews don't run as well.",
    replacesBoard: true,
    graph: fromReviewSettings,
  },
  {
    name: "Review and summarise",
    graph: () => ({
      nodes: [
        { id: "start", kind: "column", status: "in_review", prompt: "", x: 20, y: 120 },
        { id: "changed", kind: "condition", check: "changed", x: 220, y: 120 },
        { id: "reviewer", kind: "agent", name: "Reviewer", prompt: "", output: "verdict", tab: "Review", skills: [], x: 420, y: 100 },
        { id: "fix", kind: "send_to_task", message: "", max_rounds: 2, x: 640, y: 30 },
        { id: "summary", kind: "agent", name: "Summary", prompt: SUMMARY_PROMPT, output: "text", tab: "Summary", skills: [], x: 640, y: 190 },
      ],
      edges: [
        { from: "start", port: "done", to: "changed" },
        { from: "changed", port: "yes", to: "reviewer" },
        { from: "reviewer", port: "issues", to: "fix" },
        { from: "reviewer", port: "pass", to: "summary" },
      ],
    }),
  },
  { name: "Blank", graph: () => ({ nodes: [{ id: "start", kind: "trigger", on: "manual", x: 20, y: 120 }], edges: [] }) },
]
