import type { Task } from "@huntaway/contracts"
import { stackedBelow } from "../../tasks/lanes.ts"
import type { Rows } from "../../tasks/lanes.ts"
import { clean } from "../titles/text.ts"

// The text side of a stack's title and description (huntaway's agent/stack_title.ts `input`, `parse`): what the model
// is sent of the stack's levels, and what of its reply is a title and a description. Plain functions; `StackTitles`
// asks the model and saves.

/** What of each level goes to the model, and how many levels. */
export const DESCRIPTION_CHARS = 1000
export const LEVELS = 30
/** Longest title taken from a reply, in words (it's asked for 8 at most), and longest description, in characters. */
export const MAX_WORDS = 12
export const MAX_DESCRIPTION = 400

const chars = (s: string) => Array.from(s)
const head = (s: string, n: number) => (chars(s).length > n ? `${chars(s).slice(0, n).join("")}…` : s)

/**
 * What a stack's title and description are written from: its levels' titles and descriptions in landing order
 * (`stackOf`), each marked with the level it lands after when that isn't the one before it (in a fork). `rows` are the
 * stack's project's tasks, for what each lands after.
 */
export const stackInput = (rows: Rows, levels: ReadonlyArray<Task>): string => {
  const index = new Map<string, number>(levels.map((t, i) => [t.id, i + 1]))
  let out = "<stack>\n"
  if (levels.length > LEVELS) out += `(${levels.length - LEVELS} later tasks left out)\n`
  levels.slice(0, LEVELS).forEach((t, i) => {
    const after = i > 0 ? (index.get(stackedBelow(rows, t)?.id ?? "") ?? null) : null
    out += `<task n="${i + 1}"${after !== null && after !== i ? ` lands_after="${after}"` : ""}>\n<title>${t.title.trim()}</title>\n`
    const d = t.description.trim()
    if (d !== "") out += `<description>\n${head(d, DESCRIPTION_CHARS)}\n</description>\n`
    out += "</task>\n"
  })
  return `${out}</stack>`
}

const label = (l: string, name: string): string | null => new RegExp(`^[*#\\s]*${name}[*\\s]*:[*\\s]*(.*)$`, "i").exec(l)?.[1] ?? null

/** The title and description in a reply to the stack title prompt, if it gives a title that isn't too long. */
export const parseStackReply = (reply: string): { readonly title: string; readonly description: string | null } | null => {
  const lines = reply
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
  // "Title: …" and "Description: …", in either order, or a title and then the description.
  const t = Math.max(
    0,
    lines.findIndex((l) => label(l, "title") !== null),
  )
  const d = lines.findIndex((l) => label(l, "description") !== null)
  const titleLine = label(lines[t] ?? "", "title") ?? lines[t] ?? ""
  const rest = d >= 0 ? [label(lines[d] ?? "", "description") ?? "", ...lines.slice(d + 1).filter((_, i) => d + 1 + i !== t)] : lines.filter((_, i) => i !== t)
  const name = clean(titleLine)
  const words = name.split(/\s+/u).filter((w) => w !== "").length
  if (words < 1 || words > MAX_WORDS) return null
  let description = rest
    .join(" ")
    .replace(/[*`#]+/g, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^["“]+|["”]+$/gu, "")
  if (chars(description).length > MAX_DESCRIPTION) description = head(description, MAX_DESCRIPTION)
  return { title: name, description: description === "" ? null : description }
}
