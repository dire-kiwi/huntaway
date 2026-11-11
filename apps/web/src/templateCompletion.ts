// Completion for the `{{…}}` values of a workflow's templates (prompts, messages, a pull request's title and body).

/** What completion reads of a workflow's graph (the contract's `WorkflowGraph`, 6.6, is one). */
export interface TemplateGraph {
  readonly nodes: ReadonlyArray<{
    readonly id: string
    readonly kind: string
    readonly name?: string | null | undefined
    readonly output?: string | null | undefined
  }>
}

export interface TemplateValue {
  readonly name: string
  readonly label: string
}

/** The values every template has, as the server's `render` fills them in. */
const VALUES: TemplateValue[] = [
  { name: "task.key", label: "The task's key" },
  { name: "task.title", label: "The task's title" },
  { name: "task.description", label: "The task's description" },
  { name: "branch", label: "The task's branch" },
  { name: "commit", label: "The commit the run is on" },
  { name: "workflow", label: "The workflow's name" },
  { name: "issues", label: "The issues the run's verdict steps found" },
]

/** The values a template of step `self` in `graph` can use: those of every template, then each other step's output. */
export function templateValues(graph: TemplateGraph, self?: string): TemplateValue[] {
  const out = [...VALUES]
  for (const n of graph.nodes) {
    if (n.id === self) continue
    const name = n.name ?? n.id
    if (n.kind === "agent") {
      out.push({ name: `${n.id}.text`, label: n.output === "verdict" ? `${name}'s summary` : `${name}'s last message` })
      if (n.output === "verdict")
        out.push({ name: `${n.id}.issues`, label: `The issues ${name} found` }, { name: `${n.id}.verdict`, label: `${name}'s verdict: pass or issues` })
    } else if (n.kind === "open_pr") out.push({ name: `${n.id}.text`, label: "The pull request's address" })
    else if (n.kind === "split") out.push({ name: `${n.id}.path`, label: "The path the A/B test took: A, B…" })
  }
  return out
}

/** The `{{` being typed at `caret`: where it starts and what's typed after it, or null when the caret isn't in one. */
export function templateTyped(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const start = before.lastIndexOf("{{")
  if (start < 0) return null
  const query = before.slice(start + 2)
  return /^\s*[\w.-]*$/.test(query) ? { start, query: query.trim() } : null
}

/** The values that match what's typed: those starting with it first, then those containing it. */
export function templateMatches(values: ReadonlyArray<TemplateValue>, query: string): TemplateValue[] {
  const q = query.toLowerCase()
  const starts = values.filter((v) => v.name.toLowerCase().startsWith(q))
  return [...starts, ...values.filter((v) => !starts.includes(v) && v.name.toLowerCase().includes(q))]
}

/** `text` with the `{{` being typed at `caret` replaced by `{{name}}` (and a `}}` already after it taken in), and where the caret goes. */
export function templatePick(text: string, caret: number, start: number, name: string): { text: string; caret: number } {
  let end = caret
  const rest = /^[\w.-]*\s*\}\}/.exec(text.slice(caret))
  if (rest) end += rest[0].length
  const put = `{{${name}}}`
  return { text: text.slice(0, start) + put + text.slice(end), caret: start + put.length }
}
