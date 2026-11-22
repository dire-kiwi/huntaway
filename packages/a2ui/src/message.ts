// A2UI in a thread's messages (HE-77, docs/plan/09-frontend.md, Interactive replies): an agent puts A2UI Express between
// `<a2ui>` and `</a2ui>` in the text of a reply (the contract `@a2ui/agent`'s prompt generator teaches), and the board
// draws it as UI where the text is. A click on one of its buttons comes back to the agent as a message of the user's,
// in the form `actionMessage` writes and `actionOf` reads. Plain string work, so the server, the web app and the phone
// can all split a reply the same way.

const OPEN = "<a2ui>"
const CLOSE = "</a2ui>"
/** The fence an action's JSON goes in, in the message a click sends. */
export const ACTION_FENCE = "a2ui-action"

/** A piece of a reply: Markdown, or an `<a2ui>` block's Express source (`closed` false while it is still streaming). */
export type Segment =
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "a2ui"; readonly source: string; readonly closed: boolean; readonly offset: number }

/**
 * Where the `</a2ui>` that ends a block whose source starts at `from` is, or -1 while it hasn't come. As in the Express
 * lexer, the tag counts only outside strings (`"…"`, `"""…"""`, raw ones with no escapes) and comments (`#`, `//`,
 * `/* … *\/`), so `Text("</a2ui>")` stays source.
 */
export function closeOf(text: string, from: number): number {
  let i = from
  while (i < text.length) {
    if (text.startsWith(CLOSE, i)) return i
    const c = text[i]
    if (c === '"' || ((c === "r" || c === "R") && text[i + 1] === '"' && !isIdentChar(text[i - 1]))) {
      const raw = c !== '"'
      const start = raw ? i + 1 : i
      const triple = text.startsWith('"""', start)
      const quote = triple ? '"""' : '"'
      let j = start + quote.length
      while (j < text.length && !text.startsWith(quote, j)) {
        if (!raw && text[j] === "\\") j += 1
        else if (!triple && raw && (text[j] === "\n" || text[j] === "\r")) break
        j += 1
      }
      if (j >= text.length) return -1
      i = j + quote.length
    } else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      const eol = text.indexOf("\n", i)
      // A comment runs to the end of its line, which hasn't come yet.
      if (eol === -1) return -1
      i = eol + 1
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      if (end === -1) return -1
      i = end + 2
    } else i += 1
  }
  return -1
}

const isIdentChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c)

/** A fence that opens a code block at the start of a line: its character and its length. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * A reply split into Markdown and `<a2ui>` blocks. A tag in fenced code or in inline code stays Markdown (an agent
 * showing how a block is written), and so does one that isn't at the start of a line. An unclosed block is the rest
 * of the text, `closed: false`: it is still streaming in, or the agent forgot to close it.
 */
export function segments(text: string): ReadonlyArray<Segment> {
  if (!text.includes(OPEN)) return [{ kind: "markdown", text }]
  const out: Array<Segment> = []
  let markdownFrom = 0
  let fence: { char: string; length: number } | null = null
  let lineStart = 0
  while (lineStart <= text.length) {
    const nl = text.indexOf("\n", lineStart)
    const lineEnd = nl === -1 ? text.length : nl
    const line = text.slice(lineStart, lineEnd)
    const f = FENCE.exec(line)
    if (fence !== null) {
      if (f?.[1] !== undefined && f[1][0] === fence.char && f[1].length >= fence.length && line.trim() === f[1]) fence = null
    } else if (f?.[1] !== undefined) {
      fence = { char: f[1][0] ?? "`", length: f[1].length }
    } else if (line.trimStart().startsWith(OPEN)) {
      const open = lineStart + line.indexOf(OPEN)
      const sourceFrom = open + OPEN.length
      const close = closeOf(text, sourceFrom)
      pushMarkdown(out, text.slice(markdownFrom, open))
      const source = text.slice(sourceFrom, close === -1 ? text.length : close)
      out.push({ kind: "a2ui", source: trimNewlines(source), closed: close !== -1, offset: open })
      if (close === -1) return out
      markdownFrom = close + CLOSE.length
      const after = text.indexOf("\n", markdownFrom)
      if (after === -1) break
      lineStart = after + 1
      continue
    }
    if (nl === -1) break
    lineStart = nl + 1
  }
  pushMarkdown(out, text.slice(markdownFrom))
  return out
}

function pushMarkdown(out: Array<Segment>, text: string) {
  if (text.trim() !== "") out.push({ kind: "markdown", text })
}

const trimNewlines = (s: string) => s.replace(/^\s*\n/, "").replace(/\n\s*$/, "")

/** Whether a reply has an `<a2ui>` block the board draws (not one shown in code). */
export const hasBlock = (text: string): boolean => text.includes(OPEN) && segments(text).some((s) => s.kind === "a2ui")

/** What a click on an A2UI surface's action says, as the agent reads it back. */
export interface Action {
  readonly surfaceId: string
  readonly name: string
  readonly sourceComponentId: string
  readonly context: Readonly<Record<string, unknown>>
}

/**
 * The message a click sends the agent: a line a person reads, then the action as JSON in an `a2ui-action` fence (what the
 * rules tell the agent to read). `label` is the line, by default the action's name.
 */
export function actionMessage(action: Action, label?: string): string {
  const body = { surfaceId: action.surfaceId, name: action.name, sourceComponentId: action.sourceComponentId, context: action.context }
  const line = label !== undefined && label.trim() !== "" ? label.trim() : `Chose “${action.name}”`
  return `${line}\n\n\`\`\`${ACTION_FENCE}\n${JSON.stringify(body)}\n\`\`\``
}

const ACTION_BLOCK = new RegExp(`^([\\s\\S]*?)\\n*\`\`\`${ACTION_FENCE}\\n([\\s\\S]*?)\\n\`\`\`\\s*$`)

/** A message `actionMessage` wrote: its line and its action, or null for any other message. */
export function actionOf(text: string): { readonly label: string; readonly action: Action } | null {
  const m = ACTION_BLOCK.exec(text)
  if (m === null) return null
  const json = m[2] ?? ""
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const { surfaceId, name, sourceComponentId, context } = value
  if (typeof surfaceId !== "string" || typeof name !== "string") return null
  return {
    label: (m[1] ?? "").trim(),
    action: {
      surfaceId,
      name,
      sourceComponentId: typeof sourceComponentId === "string" ? sourceComponentId : "",
      context: isRecord(context) ? context : {},
    },
  }
}

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null && !Array.isArray(v)
