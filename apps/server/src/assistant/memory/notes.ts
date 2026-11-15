import { LOG_DIR, NOTE_TYPES } from "../../prompts/memory.ts"
import type { Note, NoteType } from "../../prompts/memory.ts"

// The assistant's notes by topic (HE-36): files in its workspace's `memory/` folder (not the daily logs) whose
// frontmatter gives keywords, as a skill's gives its name and description. A run's instructions list them by name and
// description only; a note's body is put before a message that names one of its keywords, and the assistant reads it
// at its path when its topic comes up otherwise.
//
// ```
// ---
// name: Invoices
// description: How the user bills their clients
// keywords: [invoice, billing, Xero]
// metadata:
//   type: project
// ---
// ```
//
// `keywords` may be a list (`[a, b]` or `- a` lines) or words split by commas; `triggers` is taken as another name for
// it. The type is `metadata.type` (or `type`): `user`, `feedback`, `project` or `reference`. A file without keywords
// is as it was before notes: not loaded, nor listed.

/** The most notes a run looks at, and how long a description it lists. */
export const MAX_NOTES = 100
export const MAX_NOTE_DESCRIPTION = 300
/** The most keywords a note has, and the most notes put before one message. */
export const MAX_KEYWORDS = 30
export const MAX_NOTES_LOADED = 5

/** A daily log's name in `memory/`. */
const LOG_NAME = /^\d{4}-\d{2}-\d{2}\.md$/u

/** Whether `rel` is a daily log: `memory/YYYY-MM-DD.md`. */
export const isLog = (rel: string): boolean => rel.startsWith(`${LOG_DIR}/`) && LOG_NAME.test(rel.slice(LOG_DIR.length + 1))

/** Whether the file `name` in `memory/` may be a note: a Markdown file that isn't a daily log. */
export const mayBeNote = (name: string): boolean => name.endsWith(".md") && !name.startsWith(".") && !LOG_NAME.test(name)

// ---- frontmatter ----

/** A frontmatter value: a scalar, or a list. Nested keys are dotted (`metadata.type`). */
type Value = string | ReadonlyArray<string>

const indentOf = (l: string) => l.length - l.trimStart().length

/** `s` without a comment after it (` # …`). */
const uncommented = (s: string) => {
  const i = s.search(/(^|\s)#/u)
  return (i >= 0 ? s.slice(0, i) : s).trim()
}

/** A scalar, quoted or not. */
const scalar = (raw: string): string => {
  const s = raw.trim()
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    if (end > 0) return s.slice(1, end)
  }
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1)
    if (end > 0) return s.slice(1, end)
  }
  return uncommented(s)
}

/** The items of a flow list's inside (`a, "b, c", 'd'`), split on commas outside quotes. */
const flowItems = (inside: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  let cur = ""
  let quote: string | null = null
  for (const c of inside) {
    if (quote !== null) {
      if (c === quote) quote = null
      cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === ",") {
      out.push(cur)
      cur = ""
    } else cur += c
  }
  out.push(cur)
  return out.map(scalar).filter((s) => s !== "")
}

/** A value on its key's line: a flow list (`[a, b]`) or a scalar. */
const inline = (raw: string): Value => {
  const s = raw.trim()
  if (s.startsWith("[")) {
    const end = s.lastIndexOf("]")
    return flowItems(s.slice(1, end > 0 ? end : s.length))
  }
  return scalar(s)
}

/** A line's `key: value`, if it is one. */
const KEY = /^([A-Za-z0-9_-]+)\s*:(?:\s+(.*))?$/u

/**
 * A Markdown file's frontmatter and the rest of it: the frontmatter's keys (nested ones dotted, one level deep) with
 * their values, or null when it has none (and the body is the whole file).
 */
export const splitFrontmatter = (text: string): { readonly fields: ReadonlyMap<string, Value> | null; readonly body: string } => {
  const content = text.replace(/^\u{feff}/u, "")
  const all = content.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
  if ((all[0] ?? "").trimEnd() !== "---") return { fields: null, body: text }
  const end = all.findIndex((l, i) => i > 0 && (l.trimEnd() === "---" || l.trimEnd() === "..."))
  if (end < 0) return { fields: null, body: text }
  const ls = all.slice(1, end)
  const fields = new Map<string, Value>()
  // The top-level key whose nested keys follow, and its indent.
  let parent: string | null = null
  let parentIndent = 0
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i] ?? ""
    if (line.trim() === "" || line.trim().startsWith("#")) continue
    const ind = indentOf(line)
    if (parent !== null && ind <= parentIndent) parent = null
    // Only a top-level key, or one nested in a top-level key.
    if (ind > 0 && parent === null) continue
    const m = KEY.exec(line.trim())
    if (m === null) continue
    const name = m[1] ?? ""
    const key = parent === null ? name : `${parent}.${name}`
    const value = uncommented(m[2] ?? "") === "" ? "" : (m[2] ?? "").trim()
    if (value.startsWith(">") || value.startsWith("|")) {
      const block: Array<string> = []
      while (i + 1 < ls.length && ((ls[i + 1] ?? "").trim() === "" || indentOf(ls[i + 1] ?? "") > ind)) block.push((ls[++i] ?? "").trim())
      fields.set(key, block.join(value.startsWith(">") ? " " : "\n").trim())
      continue
    }
    if (value !== "") {
      fields.set(key, inline(value))
      continue
    }
    // Nothing on its line: a list of `- ` items below it, or (at the top) keys nested in it.
    const items: Array<string> = []
    let j = i + 1
    for (; j < ls.length; j++) {
      const l = ls[j] ?? ""
      if (l.trim() === "") continue
      const t = l.trim()
      if (indentOf(l) < ind || !(t === "-" || t.startsWith("- "))) break
      const item = scalar(t.slice(1))
      if (item !== "") items.push(item)
    }
    if (items.length > 0) {
      fields.set(key, items)
      i = j - 1
    } else if (parent === null) {
      parent = name
      parentIndent = ind
    }
  }
  return { fields, body: all.slice(end + 1).join("\n") }
}

const asText = (v: Value | undefined): string | null => (v === undefined ? null : typeof v === "string" ? v : v.join(", "))

/** A list given as a list or as words split by commas. */
const asList = (v: Value | undefined): ReadonlyArray<string> =>
  v === undefined ? [] : typeof v === "string" ? flowItems(v) : v.map((s) => s.trim()).filter((s) => s !== "")

const isType = (s: string): s is NoteType => (NOTE_TYPES as ReadonlyArray<string>).includes(s)

/** The note in file `rel` (with text `text`) and its body, or null when it gives no keywords (it isn't a note). */
export const parseNote = (rel: string, text: string): { readonly note: Note; readonly body: string } | null => {
  const { fields, body } = splitFrontmatter(text)
  if (fields === null) return null
  const keywords = [
    ...new Set(
      [...asList(fields.get("keywords")), ...asList(fields.get("triggers")), ...asList(fields.get("metadata.keywords"))]
        .map((k) => k.replace(/\s+/gu, " ").trim())
        .filter((k) => k.replace(/\*$/u, "").trim() !== ""),
    ),
  ].slice(0, MAX_KEYWORDS)
  if (keywords.length === 0) return null
  const type = (asText(fields.get("metadata.type")) ?? asText(fields.get("type")) ?? "").trim()
  const base = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.md$/u, "")
  const description = (asText(fields.get("description")) ?? "").replace(/\s+/gu, " ").trim()
  return {
    note: {
      rel,
      name: (asText(fields.get("name")) ?? "").trim() || base,
      description: description.length > MAX_NOTE_DESCRIPTION ? `${description.slice(0, MAX_NOTE_DESCRIPTION - 1)}…` : description,
      type: isType(type) ? type : null,
      keywords,
    },
    body: body.replace(/^\s*\n/u, ""),
  }
}

// ---- keywords ----

const fold = (s: string) => s.normalize("NFKC").toLowerCase()
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

/**
 * Whether `text` names `keyword`: as whole words, in any case, with any spaces between its words. A keyword ending in
 * `*` is the start of a word (`invoic*` names "invoices").
 */
export const namesKeyword = (text: string, keyword: string): boolean => {
  const k = fold(keyword).trim()
  const prefix = k.endsWith("*")
  const words = k
    .replace(/\*$/u, "")
    .trim()
    .split(/\s+/u)
    .filter((w) => w !== "")
  if (words.length === 0) return false
  const pattern = `(?<![\\p{L}\\p{N}_])${words.map(escaped).join("\\s+")}${prefix ? "" : "(?![\\p{L}\\p{N}_])"}`
  return new RegExp(pattern, "u").test(fold(text))
}

/** The notes `text` names a keyword of. */
export const notesNamed = (notes: ReadonlyArray<Note>, text: string): ReadonlyArray<Note> =>
  text.trim() === "" ? [] : notes.filter((n) => n.keywords.some((k) => namesKeyword(text, k)))
