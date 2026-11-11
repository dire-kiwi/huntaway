import { Result, Schema } from "effect"
import type { DocLabelNode } from "@huntaway/contracts"

// The rules of published documents that read no state (huntaway's db/docs.ts and api/docs.ts; docs/plan/inventory/
// 02-agent-support.md 2.8): slugs, labels, folders' renames, the label tree, and the message that sends comments to an
// agent. Each is the hosted docs app's rule, so an agent gets the same answer from either.

/** The longest folder, in characters (docs-render's `MAX_FOLDER_CHARS`). */
export const MAX_FOLDER_CHARS = 200
/** The most labels a document has, and the longest label, in characters. */
export const MAX_LABELS = 20
export const MAX_LABEL_CHARS = 100

/** How many characters (code points) a string has, as the hosted app counts them. */
export const chars = (s: string): number => Array.from(s).length

const jsonString = Schema.encodeResult(Schema.fromJsonString(Schema.String))
/** A string quoted as JSON writes it, for messages. */
export const quoted = (s: string): string => Result.getOrElse(jsonString(s), () => `"${s}"`)

/** The hosted app's slug for a title or a given slug (its `db::doc_slug`): lowercase ASCII letters and digits, with dashes between, at most about 60. */
export const docSlug = (title: string): string => {
  let s = ""
  for (const ch of title.toLowerCase()) {
    if (/^[a-z0-9]$/.test(ch)) s += ch
    else if (s !== "" && !s.endsWith("-")) s += "-"
    if (s.length >= 60) break
  }
  s = s.replace(/^-+|-+$/g, "")
  return s === "" ? "doc" : s
}

const trimmed = (s: string) => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")

/** A label as it's kept (trimmed segments, no empty ones), or why it can't be one. */
export const normalizeLabel = (raw: string): { readonly label: string } | { readonly error: string } => {
  const segments: Array<string> = []
  for (const part of raw.split("/")) {
    const seg = trimmed(part)
    if (seg === "") continue
    if (/\p{Cc}/u.test(seg)) return { error: `invalid label ${quoted(raw)}: no control characters` }
    segments.push(seg)
  }
  const label = segments.join("/")
  if (label === "") return { error: `invalid label ${quoted(raw)}: it's empty` }
  if (chars(label) > MAX_LABEL_CHARS) return { error: `invalid label: at most ${MAX_LABEL_CHARS} characters` }
  return { label }
}

/** Labels as a document keeps them: normalised, each once (whatever its case), at most MAX_LABELS; or why not. */
export const normalizeLabels = (raw: ReadonlyArray<string>): { readonly labels: ReadonlyArray<string> } | { readonly error: string } => {
  const out = new Map<string, string>()
  for (const r of raw) {
    const one = normalizeLabel(r)
    if ("error" in one) return one
    if (!out.has(one.label.toLowerCase())) out.set(one.label.toLowerCase(), one.label)
  }
  if (out.size > MAX_LABELS) return { error: `a document has at most ${MAX_LABELS} labels` }
  return { labels: [...out.values()] }
}

/** Whether label `l` is `label` or inside it, whatever their case. */
export const inLabel = (l: string, label: string): boolean => {
  const [a, b] = [l.toLowerCase(), label.toLowerCase()]
  return a === b || a.startsWith(`${b}/`)
}

/** Labels' order on a document, as the hosted app gives them: by their lowercase. */
export const byLowercase = (a: string, b: string): number => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()]
  return x < y ? -1 : x > y ? 1 : 0
}

const byLabel = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }) || a.localeCompare(b)

/**
 * `labels` spelt as `known` (the profile's labels, oldest first) spell them already, segment by segment, whatever case
 * they're given in, each once: what a document's labels become when they're set.
 */
export const spelt = (known: ReadonlyArray<string>, labels: ReadonlyArray<string>): ReadonlyArray<string> => {
  const spellings = new Map<string, string>()
  const learn = (label: string) => {
    const segs = label.split("/")
    for (let i = 1; i <= segs.length; i++) {
      const p = segs.slice(0, i).join("/")
      if (!spellings.has(p.toLowerCase())) spellings.set(p.toLowerCase(), p)
    }
  }
  known.forEach(learn)
  const spell = (label: string) => {
    let out = ""
    for (const seg of label.split("/")) {
      const p = out === "" ? seg : `${out}/${seg}`
      out = spellings.get(p.toLowerCase()) ?? p
    }
    learn(out)
    return out
  }
  const seen = new Set<string>()
  const result: Array<string> = []
  for (const l of labels.map(spell)) {
    if (seen.has(l.toLowerCase())) continue
    seen.add(l.toLowerCase())
    result.push(l)
  }
  return result
}

interface MutableNode {
  name: string
  path: string
  documents: number
  children: Array<MutableNode>
}

/**
 * A profile's labels as a tree from its documents' labels, each with its count of documents (a document counts once
 * in a label, however many of its labels are in it), sorted by name; how many documents there are, and how many have
 * no label (the hosted app's `list_labels`).
 */
export const labelTree = (docs: ReadonlyArray<{ readonly labels: ReadonlyArray<string> }>) => {
  const root: MutableNode = { name: "", path: "", documents: 0, children: [] }
  let unlabelled = 0
  for (const d of docs) {
    if (d.labels.length === 0) unlabelled++
    const counted = new Set<MutableNode>()
    for (const l of d.labels) {
      let at = root
      for (const name of l.split("/")) {
        const path = at.path === "" ? name : `${at.path}/${name}`
        let next = at.children.find((n) => n.name.toLowerCase() === name.toLowerCase())
        if (next === undefined) {
          next = { name, path, documents: 0, children: [] }
          at.children.push(next)
        }
        if (!counted.has(next)) next.documents++
        counted.add(next)
        at = next
      }
    }
  }
  const sort = (n: MutableNode): DocLabelNode => ({
    ...n,
    children: n.children.toSorted((a, b) => byLabel(a.name, b.name)).map(sort),
  })
  return { labels: sort(root).children, documents: docs.length, unlabelled }
}

/**
 * The folders documents in `from` (or in a folder inside it) move to when it's renamed `to` (`""`: the top level), as
 * the hosted app's `rename_folder` does (`docs2` isn't inside `docs`); or why it can't (a folder that would be too long).
 */
export const renamedFolders = <D extends { readonly folder: string }>(
  docs: ReadonlyArray<D>,
  from: string,
  to: string,
): { readonly moved: ReadonlyArray<{ readonly doc: D; readonly folder: string }> } | { readonly error: string } => {
  if (from === "") return { error: "choose a folder to rename" }
  const moved = docs
    .filter((d) => d.folder === from || d.folder.startsWith(`${from}/`))
    .map((doc) => ({ doc, folder: `${to}${doc.folder.slice(from.length)}`.replace(/^\/+/, "") }))
  const long = moved.find((m) => chars(m.folder) > MAX_FOLDER_CHARS)
  if (long !== undefined) return { error: `${quoted(long.folder)} would be longer than ${MAX_FOLDER_CHARS} characters` }
  return { moved }
}

/** A quote as a Markdown block quote, cut short past `max` characters. */
export const blockQuote = (quote: string, max = 1000): string => {
  const all = Array.from(quote)
  const q = all.length > max ? `${all.slice(0, max).join("")}…` : quote
  return q
    .split("\n")
    .map((l) => `> ${l}`.trimEnd())
    .join("\n")
}

/** A comment as the message that sends it names it. */
export interface SentComment {
  readonly version: number
  readonly page: string
  readonly quote: string
  readonly comment: string
  /** The board's URL of the page it's on, in its version. */
  readonly url: string
}

/** The message that sends a document's `comments` to its agent (huntaway's api/docs.ts `comments_message`). */
export const commentsMessage = (doc: { readonly title: string; readonly slug: string }, comments: ReadonlyArray<SentComment>): string => {
  const n = comments.length
  const parts = [`The user left ${n === 1 ? "a comment" : `${n} comments`} on the document "${doc.title}" (slug \`${doc.slug}\`):`]
  comments.forEach((m, i) => {
    parts.push(`${i + 1}. On version ${m.version}, page \`${m.page}\` (${m.url}):\n\n${blockQuote(m.quote)}\n\n${m.comment || "(No comment: just the quote.)"}`)
  })
  parts.push(`The docs server's \`get_feedback\` (slug "${doc.slug}") has them too.`)
  return parts.join("\n\n")
}

/** Where the board shows a document (its latest version, or version `version`), ending in `/`: page URLs follow it. */
export const docBase = (profile: string, slug: string, version: number | null): string => {
  const d = `/docs/${encodeURIComponent(profile)}/d/${encodeURIComponent(slug)}/`
  return version === null ? d : `${d}-/v/${version}/`
}
