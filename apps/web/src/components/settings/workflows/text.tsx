import { STATUSES } from "@huntaway/client"
import {
  isDataNode,
  WORKFLOW_PATHS,
  workflowWaits,
  type WorkflowCheck,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKindName,
} from "@huntaway/contracts"
import { Bot, Braces, ClipboardList, Columns3, GitFork, GitPullRequest, Play, Rows3, ScrollText, Send, Split, ToggleLeft, Type } from "lucide-react"
import type { ReactNode } from "react"

// How the editor, a task's workflow tabs and a workflow's approval word a workflow's nodes. Without the legacy kinds
// (`set_status`, a start on a column): every host has column nodes.

export const statusLabel = (s: string | null | undefined): string => STATUSES.find((x) => x.id === s)?.label ?? s ?? "?"

export const CHECK_LABELS: Record<WorkflowCheck, string> = {
  changed: "The work changed since its last run",
  has_commits: "The task has commits of its own",
  has_pr: "The task has a pull request",
  task_type: "The task is of a type",
  label: "The task has a label",
}

/** What a workflow does, in a line: its columns (or its start) and steps. */
export function graphText(g: WorkflowGraph): string {
  const cols = g.nodes.flatMap((n) => (n.kind === "column" ? [statusLabel(n.status)] : []))
  const when = cols.length ? cols.join(" → ") : g.nodes.some((n) => n.kind === "trigger") ? "When run by hand" : "Run by hand"
  const steps = g.nodes.flatMap((n) => (n.kind === "agent" ? [n.name] : n.kind === "open_pr" ? ["pull request"] : []))
  return [when, steps.length ? steps.join(", ") : "no agent steps"].join(" · ")
}

/** What a column node's `done` waits for. */
function columnText(n: Extract<WorkflowNode, { readonly kind: "column" }>, g: WorkflowGraph | undefined): string {
  if (n.status === "ready_for_merge") return n.prompt.trim() ? "Its merge instructions · done once merged" : "Done once merged"
  if (!workflowWaits(n, g ?? { edges: [] })) return "When a task moves here"
  const until = n.done_when === "finish" ? "until the agent says so" : "until the agent's done"
  return n.prompt.trim() ? `${firstLine(n.prompt)} · ${until}` : `The start prompt · ${until}`
}

export const firstLine = (s: string): string => s.trim().split("\n")[0] ?? ""

/** A node's title on the canvas: a value's name, if it has one, or its kind's. */
export function nodeTitle(n: WorkflowNode): string {
  const label = n.label?.trim()
  if (isDataNode(n) && label) return label
  return kindTitle(n)
}

export function kindTitle(n: WorkflowNode): string {
  switch (n.kind) {
    case "trigger":
      return "Start"
    case "condition":
      return "Check"
    case "agent":
      return n.name || "Agent"
    case "send_to_task":
      return "Send to the task's agent"
    case "open_pr":
      return "Open a pull request"
    case "split":
      return "A/B test"
    case "column":
      return statusLabel(n.status)
    case "text":
      return "Text"
    case "task":
      return "Task"
    case "project_prompt":
      return "Project prompt"
    case "compose":
      return "Compose"
    case "join":
      return "Join"
    case "switch":
    default:
      return "Switch"
  }
}

const checkText = (check: WorkflowCheck, value: string | undefined): string =>
  check === "task_type" || check === "label" ? `${CHECK_LABELS[check]}: ${value ?? "?"}` : CHECK_LABELS[check]

/** What a node does, under its title (with its graph, whether a column's wired prompt makes it wait). */
export function nodeText(n: WorkflowNode, g?: WorkflowGraph): string {
  switch (n.kind) {
    case "trigger":
      return "When run by hand"
    case "condition":
      return checkText(n.check, n.value)
    case "agent":
      return `${n.output === "verdict" ? "Pass or issues" : "Writes text"}${n.input_only ? " · from the steps before" : ""}${n.keep_conversation ? " · keeps its conversation" : ""}${n.skills?.[0] !== undefined ? ` · /${n.skills[0]}` : ""}${n.tab ? ` · ${n.tab} tab` : ""}`
    case "split":
      return `${WORKFLOW_PATHS.slice(0, n.weights.length)
        .map((p, i) => `${p.toUpperCase()} ${pathShare(n.weights, i)}%`)
        .join(" · ")}${n.each_run ? " · each run" : ""}`
    case "send_to_task":
      return `${n.message.trim() ? "Its own message" : "The issues found"} · up to ${n.max_rounds} round${n.max_rounds === 1 ? "" : "s"}`
    case "open_pr":
      return `${n.draft ? "A draft · " : ""}Pushes the branch`
    case "column":
      return columnText(n, g)
    case "text":
      return firstLine(n.text) || "Empty"
    case "task":
      return "Its title, description, branch…"
    case "project_prompt":
      return `The ${n.which} prompt`
    case "compose":
      return firstLine(n.template) || "An empty template"
    case "join":
      return `${n.count} texts${n.separator === "\\n\\n" || n.separator === "\n\n" ? ", a blank line between" : ""}`
    case "switch":
    default:
      return `${checkText(n.check, n.value)}?`
  }
}

/** How likely an A/B test's path `i` is, as a whole percentage of its weights. */
export function pathShare(weights: ReadonlyArray<number>, i: number): number {
  const total = weights.reduce((a, w) => a + Math.max(0, w || 0), 0)
  return total > 0 ? Math.round((Math.max(0, weights[i] || 0) / total) * 100) : 0
}

/** What node `n`'s outcome `port` is called: an A/B test's paths with how likely each is. */
export function portLabel(n: WorkflowNode | undefined, port: string): string {
  if (n?.kind === "split") {
    const i = WORKFLOW_PATHS.indexOf(port)
    if (i >= 0) return `${port.toUpperCase()} · ${pathShare(n.weights, i)}%`
  }
  return PORT_LABELS[port] ?? port
}

export const KIND_STYLE: Record<WorkflowNodeKindName, { icon: ReactNode; tone: string }> = {
  trigger: { icon: <Play size={12} />, tone: "text-emerald-400" },
  condition: { icon: <GitFork size={12} />, tone: "text-amber-400" },
  agent: { icon: <Bot size={12} />, tone: "text-accent" },
  send_to_task: { icon: <Send size={12} />, tone: "text-sky-400" },
  open_pr: { icon: <GitPullRequest size={12} />, tone: "text-teal-400" },
  split: { icon: <Split size={12} />, tone: "text-fuchsia-400" },
  column: { icon: <Columns3 size={12} />, tone: "text-emerald-400" },
  text: { icon: <Type size={12} />, tone: "text-amber-300" },
  task: { icon: <ClipboardList size={12} />, tone: "text-amber-300" },
  project_prompt: { icon: <ScrollText size={12} />, tone: "text-amber-300" },
  compose: { icon: <Braces size={12} />, tone: "text-amber-300" },
  join: { icon: <Rows3 size={12} />, tone: "text-amber-300" },
  switch: { icon: <ToggleLeft size={12} />, tone: "text-amber-300" },
}

/** What a node's values and inputs are called on the canvas. */
const DATA_LABELS: Record<string, string> = {
  next: "what happens next",
  pr: "pull request",
  path: "path",
  in1: "1",
  in2: "2",
  in3: "3",
  in4: "4",
  in5: "5",
  in6: "6",
  in7: "7",
  in8: "8",
}
export const dataLabel = (k: string): string => DATA_LABELS[k] ?? k

export const PORT_LABELS: Record<string, string> = {
  out: "then",
  yes: "yes",
  no: "no",
  done: "done",
  failed: "failed",
  pass: "pass",
  issues: "issues",
  sent: "sent",
  exhausted: "out of rounds",
  opened: "opened",
  exists: "had one",
}

/** An input's own text, in a line, as its row on the canvas shows it when nothing is wired into it. */
export function ownText(n: WorkflowNode, input: string): string {
  const own =
    n.kind === "column" || n.kind === "agent"
      ? n.prompt
      : n.kind === "send_to_task"
        ? n.message
        : n.kind === "open_pr"
          ? input === "title"
            ? n.title
            : n.body
          : ""
  return firstLine(own)
}
