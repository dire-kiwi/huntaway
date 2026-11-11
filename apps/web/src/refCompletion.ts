// `@` completion of projects and tasks (HA-303), in a task's message box and the new task dialog: typing `@` lists the
// projects and tasks on the boards the profile's agents can use, and picking one puts its key in place of the `@`
// (`HA-12`, `HA`), qualified with its profile when it's on another profile's board (`work:SD-3`), as the board's MCP
// tools take it, so an agent can look it up with get_task or get_project.
import { isAssistants, taskKey, type HostProfile as Profile, type HostProject as Project, type HostTask as Task } from "@huntaway/client"
import type { Status } from "@huntaway/contracts"

export interface RefItem {
  kind: "project" | "task"
  /** What picking it puts in the text: its key, qualified off the profile's own board. */
  value: string
  /** Its key as its board has it. */
  key: string
  /** The project's name, or the task's title. */
  title: string
  /** A task's project (none for a scratch or group task). */
  project?: { key: string; name: string } | undefined
  status?: Status
  /** On the profile's own board. */
  own: boolean
  /** The profile whose board it's on. */
  profile: string
  /** When a task last changed, to put recent ones first. */
  updated?: string
  /** Its host and id, to tell items apart. */
  id: string
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The profiles whose boards `owner`'s agents can use: its own (by name, on every host), and those that let it in. */
export function refBoards(profiles: ReadonlyArray<Pick<Profile, "id" | "host_id" | "name" | "agent_access">>, owner: { host_id: string; profile_id: string }) {
  const name = profiles.find((p) => p.host_id === owner.host_id && p.id === owner.profile_id)?.name
  if (name === undefined) return []
  return profiles
    .filter((p) => same(p.name, name) || (p.agent_access ?? []).some((n) => n === "*" || same(n, name)))
    .map((p) => ({ host_id: p.host_id, id: p.id, name: p.name, own: same(p.name, name) }))
}

/** A profile as a key's qualifier: its name, or its id when the name wouldn't read as one (`Ops team:SD-3`). */
const qualifier = (p: { id: string; name: string }) => (/^[\w.-]+$/.test(p.name) ? p.name : p.id)

/** A key as `owner`'s agents name it: qualified with its profile when it's on another profile's board. */
const qualify = (b: { own: boolean; id: string; name: string }, key: string) => (b.own ? key : `${qualifier(b)}:${key}`)

/** The projects and tasks on the boards `owner`'s agents can use (see refBoards). */
export function refItems(
  profiles: ReadonlyArray<Pick<Profile, "id" | "host_id" | "name" | "agent_access">>,
  projects: ReadonlyArray<Project>,
  tasks: Iterable<Task>,
  owner: { host_id: string; profile_id: string },
): RefItem[] {
  const boards = refBoards(profiles, owner)
  const boardOf = (x: { host_id: string; profile_id: string }) => boards.find((b) => b.host_id === x.host_id && b.id === x.profile_id)
  const out: RefItem[] = []
  const inBoards = projects.filter((p) => boardOf(p))
  for (const p of inBoards) {
    const b = boardOf(p)
    if (!b) continue
    out.push({ kind: "project", value: qualify(b, p.key), key: p.key, title: p.name, own: b.own, profile: b.name, id: `${p.host_id}:${p.id}` })
  }
  for (const t of tasks) {
    const b = boardOf(t)
    // Tasks only (not review threads), and another profile's assistant isn't reachable (see the MCP tools' resolve_task).
    if (!b || t.kind !== "task" || (!b.own && isAssistants(t))) continue
    const p = t.project_id ? inBoards.find((x) => x.host_id === t.host_id && x.id === t.project_id) : undefined
    // A task in a project that's off the board (archived) isn't loaded, and one that is anyway is skipped.
    if (t.project_id && !p) continue
    const key = taskKey(t)
    out.push({
      kind: "task",
      value: qualify(b, key),
      key,
      title: t.title,
      project: p && { key: p.key, name: p.name },
      status: t.status,
      own: b.own,
      profile: b.name,
      updated: t.updated_at,
      id: `${t.host_id}:${t.id}`,
    })
  }
  return out
}

/** How well `item` matches `q` (lower case): 0 its key exactly, 1 something starting with it, 2 something with it, null not at all. */
function tier(item: RefItem, q: string): 0 | 1 | 2 | null {
  if (!q) return 1
  const keys = [item.key, item.value].map((k) => k.toLowerCase())
  if (keys.includes(q)) return 0
  const texts = [...keys, item.title, item.project?.key ?? "", item.project?.name ?? "", item.profile].map((s) => s.toLowerCase())
  // A word of a title or name starting with it counts as starting with it.
  if (texts.some((s) => s.startsWith(q) || s.split(/[\s/._:-]+/).some((w) => w.startsWith(q)))) return 1
  if (texts.some((s) => s.includes(q))) return 2
  return null
}

/**
 * The items matching what's typed after the `@`, best first: its key exactly, then those with something starting with
 * it, then those with it anywhere. Within each, the profile's own board first, then projects, then open tasks, then
 * done ones, the most recently changed first.
 */
export function refMatches(items: RefItem[], query: string, limit = 30): RefItem[] {
  const q = query.toLowerCase()
  const rank = (i: RefItem) => (i.kind === "project" ? 0 : i.status === "done" ? 2 : 1)
  return items
    .map((item) => ({ item, tier: tier(item, q) }))
    .filter((x): x is { item: RefItem; tier: 0 | 1 | 2 } => x.tier !== null)
    .toSorted(
      (a, b) =>
        a.tier - b.tier ||
        Number(b.item.own) - Number(a.item.own) ||
        rank(a.item) - rank(b.item) ||
        (b.item.updated ?? "").localeCompare(a.item.updated ?? "") ||
        a.item.key.localeCompare(b.item.key),
    )
    .slice(0, limit)
    .map((x) => x.item)
}

/** The `@` being typed at `caret`: where it starts, what's typed after it, and where the word ends. Not one in a word (`me@x.io`). */
export function refTyped(text: string, caret: number): { start: number; end: number; query: string } | null {
  const m = /(?<=^|[\s([{"'])@([\w.:-]*)$/.exec(text.slice(0, caret))
  if (!m) return null
  const rest = /^[\w.:-]*/.exec(text.slice(caret))?.[0] ?? ""
  return { start: m.index, end: caret + rest.length, query: m[1] ?? "" }
}

/** `text` with the `@` word at `at` replaced by `value` and a space (unless one follows), and where the caret goes. */
export function refPick(text: string, at: { start: number; end: number }, value: string): { text: string; caret: number } {
  const after = text.slice(at.end)
  const space = /^[ \t]/.test(after) ? "" : " "
  return { text: text.slice(0, at.start) + value + space + after, caret: at.start + value.length + 1 }
}

/** A key in a text that names one of `items`: where it is, and what it names. */
export interface RefMention {
  start: number
  end: number
  item: RefItem
}

// A word that may be a key: `HA`, `HA-12`, `work:SD-3`. Keys are found as they're written, capitals and all.
const REF_WORD = /[\w.:-]+/g
const KEY_LIKE = /(^|:)[A-Z][A-Z0-9]*(-\d+)?$/

/** The words of `text` that could be keys, without the punctuation that ends them (`HA-12.`). */
function refWords(text: string): { start: number; end: number; word: string }[] {
  const out = []
  for (const m of text.matchAll(REF_WORD)) {
    const word = m[0].replace(/[.:-]+$/, "")
    const start = m.index
    // Not part of a path, an address or a token of the new task dialog (`#HA-12`, `in:HA`).
    if (!KEY_LIKE.test(word) || /[/@#!^\\]/.test(text[start - 1] ?? "") || text[start + m[0].length] === "/") continue
    out.push({ start, end: start + word.length, word })
  }
  return out
}

/** Whether `text` has a word that could be a key, so the items are worth listing (see refMentions). */
export const mayMention = (text: string) => refWords(text).length > 0

/**
 * The keys in `text` that name one of `items` (HA-400), picked from the `@` list or typed: what's shown as mentioned,
 * with its name. A key is matched as picking it writes it (`HA`, `HA-12`, `work:SD-3`), whole and in capitals.
 */
export function refMentions(text: string, items: RefItem[]): RefMention[] {
  const words = refWords(text)
  if (!words.length) return []
  const byValue = new Map<string, RefItem>()
  for (const i of items) if (!byValue.has(i.value)) byValue.set(i.value, i)
  return words.flatMap((w) => {
    const item = byValue.get(w.word)
    return item ? [{ start: w.start, end: w.end, item }] : []
  })
}
