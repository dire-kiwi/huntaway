import type { Profile, Project, Reviewer, WorkflowEdge, WorkflowGraph, WorkflowNode } from "@huntaway/contracts"
import { reviewersFor, summarizersFor } from "../review/model.ts"
import { cutBytes, MAX_SKILLS, modelOk, skillName } from "./check.ts"
import { agentWorks, columnNode, MAX_AGENTS, MAX_ROUNDS, MAX_TEXT } from "./graph.ts"

// A project's Review tab as a workflow (HA-277; inventory 06, 2.2 "Review settings as a workflow"; huntaway's
// integrations/workflows/store.ts review_settings_graph): what turning `use_workflows` on moves its automatic reviews,
// rounds of fixes and summaries into, as the web app's "From the Review tab" preset draws them.

/** What a summary step is asked to write, as the web app's presets have it. */
export const SUMMARY_PROMPT =
  "Summarise what the work on {{task.key}} changed, for someone deciding whether to merge it: what it does and how, what was tested, and anything to check or decide before it's merged. Keep it short, with headings and lists where they help."

const EFFORTS: ReadonlySet<string> = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"])

/**
 * Project `p`'s automatic reviews as a workflow's graph: In review → _Changed?_ → its reviewers (or its profile's), whose
 * issues go to the task's agent for its rounds of fixes, and, with summaries on, its summarizers once the review passes.
 * Null with its automatic reviews off. A reviewer's config that isn't the project's (`configs`) uses the task's, and
 * those over the agent steps a workflow can have are left out. Only what `checkGraph` takes: one it refused would leave
 * the project without its reviews.
 */
export const reviewSettingsGraph = (
  p: Pick<Project, "auto_review" | "auto_summary" | "review_rounds" | "reviewers" | "summarizers">,
  profile: Pick<Profile, "reviewers" | "summarizers"> | null,
  configs: ReadonlyArray<string>,
): WorkflowGraph | null => {
  if (!p.auto_review) return null
  const reviewers = reviewersFor(p, profile).slice(0, MAX_AGENTS)
  const summarizers = p.auto_summary ? summarizersFor(p, profile).slice(0, MAX_AGENTS - reviewers.length) : []
  const agent = (r: Reviewer) => {
    const model = r.model?.trim()
    const effort = r.effort?.trim()
    const skills = (r.skills ?? [])
      .map(skillName)
      .filter((s) => s !== "")
      .slice(0, MAX_SKILLS)
    return {
      ...(r.claude_config_id !== null && configs.includes(r.claude_config_id) ? { claude_config_id: r.claude_config_id } : {}),
      ...(model !== undefined && model !== "" && modelOk(model) ? { model } : {}),
      ...(effort !== undefined && effort !== "" && EFFORTS.has(effort) ? { effort } : {}),
      ...(skills.length > 0 ? { skills } : {}),
    }
  }
  const several = reviewers.length > 1
  const reviewerId = (i: number) => (several ? `reviewer${i + 1}` : "reviewer")
  const nodes: Array<WorkflowNode> = [
    { id: "start", kind: "column", status: "in_review", prompt: "", x: 20, y: 120 },
    { id: "changed", kind: "condition", check: "changed", x: 220, y: 120 },
  ]
  const edges: Array<WorkflowEdge> = [{ from: "start", port: "done", to: "changed" }]
  reviewers.forEach((r, i) => {
    const id = reviewerId(i)
    nodes.push({
      id,
      kind: "agent",
      name: several ? `Reviewer ${i + 1}` : "Reviewer",
      prompt: cutBytes(r.prompt ?? "", MAX_TEXT),
      output: "verdict",
      tab: "Review",
      ...agent(r),
      x: 420,
      y: 40 + i * 120,
    })
    edges.push({ from: "changed", port: "yes", to: id }, { from: id, port: "issues", to: "fix" })
  })
  nodes.push({ id: "fix", kind: "send_to_task", message: "", max_rounds: Math.max(0, Math.min(MAX_ROUNDS, p.review_rounds)), x: 640, y: 30 })
  summarizers.forEach((r, i) => {
    const id = summarizers.length > 1 ? `summary${i + 1}` : "summary"
    const name = Array.from(r.name?.trim() ?? "")
      .slice(0, 60)
      .join("")
    nodes.push({
      id,
      kind: "agent",
      name: name === "" ? "Summary" : name,
      prompt: cutBytes(r.prompt !== undefined && r.prompt !== null && r.prompt !== "" ? r.prompt : SUMMARY_PROMPT, MAX_TEXT),
      output: "text",
      tab: "Summary",
      ...agent(r),
      // After all the reviewers, as the board summarises once the review (all of them) has passed.
      ...(several ? { join: "all" as const } : {}),
      x: 640,
      y: 190 + i * 110,
    })
    reviewers.forEach((_, k) => edges.push({ from: reviewerId(k), port: "pass", to: id }))
  })
  return { nodes, edges }
}

/**
 * Whether one of the workflows that's on has an In review step that does something (a prompt for the agent, or steps
 * after it), which took the Review tab's reviews over already.
 */
export const hasReviewStep = (workflows: ReadonlyArray<{ readonly enabled: boolean; readonly graph: WorkflowGraph }>): boolean =>
  workflows.some((w) => {
    const n = w.enabled ? columnNode(w.graph, "in_review") : undefined
    return n !== undefined && (agentWorks(n, w.graph) || w.graph.edges.some((e) => e.from === n.id && e.input === undefined))
  })
