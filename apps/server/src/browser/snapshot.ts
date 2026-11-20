import { isRecord, jsonText } from "./cdp.ts"

// A page as the agent reads it (HE-62): Chrome's accessibility tree (`Accessibility.getFullAXTree`) as an indented
// outline, one line per thing that matters, each with a ref (`e<backend node id>`) that `click`, `type` and `scroll`
// take back. Nodes that only group (`generic`, `none`) and ignored nodes give their place to their children; text a
// named node already says isn't repeated; a node whose only child is text says it on its own line.

interface AxNode {
  readonly id: string
  readonly role: string
  readonly name: string
  readonly value: string
  readonly ignored: boolean
  readonly children: ReadonlyArray<string>
  readonly backend: number | null
  readonly props: ReadonlyArray<string>
}

/** Roles that only group: their children take their place. */
const GROUPING = new Set([
  "generic",
  "none",
  "presentation",
  "InlineTextBox",
  "LineBreak",
  "Ignored",
  "IgnoredRole",
  "LayoutTable",
  "LayoutTableRow",
  "LayoutTableCell",
])
/** Boolean states worth saying, and the ones said with their value. */
const STATES = new Set(["checked", "selected", "expanded", "pressed", "disabled", "focused", "required", "invalid", "readonly", "modal"])
const VALUED = new Set(["level", "valuetext", "autocomplete", "haspopup"])

/** The most lines a snapshot gives; the rest are counted. */
export const SNAPSHOT_MAX_LINES = 1500
/** The longest a name or a text is shown. */
const TEXT_MAX = 200

const field = (v: unknown, key: string): unknown => (isRecord(v) ? v[key] : undefined)
const text = (v: unknown): string => {
  const inner = field(v, "value")
  return typeof inner === "string" ? inner : typeof inner === "number" || typeof inner === "boolean" ? String(inner) : ""
}
const clip = (s: string) => {
  const one = s.replace(/\s+/gu, " ").trim()
  return one.length > TEXT_MAX ? `${one.slice(0, TEXT_MAX)}…` : one
}
const quoted = (s: string) => jsonText(s)

const propsOf = (raw: unknown): ReadonlyArray<string> => {
  const list = field(raw, "properties")
  if (!Array.isArray(list)) return []
  const out: Array<string> = []
  for (const p of list) {
    const name = field(p, "name")
    if (typeof name !== "string") continue
    const v = field(field(p, "value"), "value")
    if (STATES.has(name)) {
      if (v === true || v === "true") out.push(name)
      else if (v === "mixed") out.push(`${name}=mixed`)
    } else if (VALUED.has(name) && v !== undefined && v !== false && v !== "" && v !== "false") {
      out.push(`${name}=${typeof v === "string" || typeof v === "number" ? v : jsonText(v)}`)
    }
  }
  return out
}

const nodeOf = (raw: unknown): AxNode | null => {
  const id = field(raw, "nodeId")
  if (typeof id !== "string") return null
  const children = field(raw, "childIds")
  const backend = field(raw, "backendDOMNodeId")
  return {
    id,
    role: text(field(raw, "role")),
    name: clip(text(field(raw, "name"))),
    value: clip(text(field(raw, "value"))),
    ignored: field(raw, "ignored") === true,
    children: Array.isArray(children) ? children.filter((c): c is string => typeof c === "string") : [],
    backend: typeof backend === "number" ? backend : null,
    props: propsOf(raw),
  }
}

/** A ref the agent gives back (`e123`, or `123`): the backend node id, or null. */
export const parseRef = (ref: string): number | null => {
  const m = /^e?(\d+)$/u.exec(ref.trim())
  return m?.[1] === undefined ? null : Number(m[1])
}

/** Whether a node has a line of its own (else its children take its place). */
const shown = (n: AxNode) => !n.ignored && !GROUPING.has(n.role) && n.role !== "RootWebArea"

/** The outline of `nodes` (`Accessibility.getFullAXTree`'s), at most `maxLines` lines. */
export const formatSnapshot = (nodes: ReadonlyArray<unknown>, maxLines = SNAPSHOT_MAX_LINES): string => {
  const all = nodes.map(nodeOf).filter((n): n is AxNode => n !== null)
  const byId = new Map(all.map((n) => [n.id, n]))
  const childIds = new Set(all.flatMap((n) => n.children))
  const roots = all.filter((n) => !childIds.has(n.id))
  const lines: Array<string> = []
  let left = 0

  /** The nodes `n`'s place goes to: itself if it's shown, else its shown descendants. */
  const childrenOf = (n: AxNode): ReadonlyArray<AxNode> =>
    n.children.flatMap((c) => {
      const child = byId.get(c)
      return child === undefined ? [] : placed(child)
    })
  const placed = (n: AxNode): ReadonlyArray<AxNode> => (shown(n) ? [n] : childrenOf(n))

  const visit = (n: AxNode, depth: number, said: string) => {
    if (lines.length >= maxLines) {
      left += 1
      return
    }
    const indent = "  ".repeat(depth)
    if (n.role === "StaticText") {
      if (n.name !== "" && !said.includes(n.name)) lines.push(`${indent}- text: ${n.name}`)
      return
    }
    const kids = childrenOf(n)
    const onlyText = kids.length === 1 && kids[0]?.role === "StaticText" && n.name === "" ? kids[0].name : null
    let line = `${indent}- ${n.role}`
    if (n.name !== "") line += ` ${quoted(n.name)}`
    if (n.value !== "" && n.value !== n.name) line += ` value=${quoted(n.value)}`
    if (n.props.length > 0) line += ` [${n.props.join(", ")}]`
    if (n.backend !== null) line += ` [ref=e${n.backend}]`
    if (onlyText !== null && onlyText !== "") line += `: ${onlyText}`
    lines.push(line)
    if (onlyText !== null) return
    for (const k of kids) visit(k, depth + 1, `${n.name}\n${n.value}`)
  }

  for (const r of roots) for (const k of placed(r)) visit(k, 0, "")
  if (left > 0) lines.push(`[… ${left} more not shown: scroll to the part you want, or read it with evaluate]`)
  return lines.join("\n")
}
