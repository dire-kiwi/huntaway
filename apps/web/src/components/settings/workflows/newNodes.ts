import type { Status, WorkflowGraph, WorkflowNodeKindName } from "@huntaway/contracts"
import type { NodeBody } from "./graph"

/** A node the editor adds: its kind, its button's label, the base of its id, and how it's made in a graph. */
export interface NewNode {
  readonly kind: WorkflowNodeKindName
  readonly label: string
  readonly base: string
  readonly make: (g: WorkflowGraph) => NodeBody
}

const ORDER: ReadonlyArray<Status> = ["in_progress", "in_review", "ready_for_merge", "needs_attention", "todo", "backlog", "done"]

/** The steps the editor adds. */
export const NEW_NODES: ReadonlyArray<NewNode> = [
  {
    kind: "column",
    label: "Column",
    base: "column",
    // The first column the graph has no node for.
    make: (g) => ({
      kind: "column",
      status: ORDER.find((st) => !g.nodes.some((n) => n.kind === "column" && n.status === st)) ?? "in_progress",
      prompt: "",
    }),
  },
  { kind: "condition", label: "Check", base: "check", make: () => ({ kind: "condition", check: "changed" }) },
  { kind: "agent", label: "Agent", base: "agent", make: () => ({ kind: "agent", name: "Agent", prompt: "", output: "text", skills: [] }) },
  {
    kind: "agent",
    label: "Review",
    base: "review",
    make: () => ({ kind: "agent", name: "Reviewer", prompt: "", output: "verdict", tab: "Review", skills: [] }),
  },
  { kind: "open_pr", label: "Open a PR", base: "pr", make: () => ({ kind: "open_pr", title: "", body: "" }) },
  { kind: "split", label: "A/B test", base: "ab", make: () => ({ kind: "split", weights: [50, 50] }) },
  { kind: "send_to_task", label: "Send to task", base: "send", make: () => ({ kind: "send_to_task", message: "", max_rounds: 2 }) },
]

/** The data nodes the editor adds, which build the text that goes into steps' inputs. */
export const NEW_VALUES: ReadonlyArray<NewNode> = [
  { kind: "text", label: "Text", base: "text", make: () => ({ kind: "text", text: "" }) },
  { kind: "task", label: "Task", base: "task", make: () => ({ kind: "task" }) },
  { kind: "project_prompt", label: "Project prompt", base: "prompt", make: () => ({ kind: "project_prompt", which: "start" }) },
  { kind: "compose", label: "Compose", base: "compose", make: () => ({ kind: "compose", template: "{{a}}\n\n{{b}}" }) },
  { kind: "join", label: "Join", base: "join", make: () => ({ kind: "join", separator: "\n\n", count: 2 }) },
  { kind: "switch", label: "Switch", base: "switch", make: () => ({ kind: "switch", check: "has_pr" }) },
]
