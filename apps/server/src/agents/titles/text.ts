import { HashMap, Option } from "effect"
import type { Steer } from "@huntaway/contracts"

// The text side of task titles (huntaway's agent/title.ts): what the model is sent, what of its reply is a title, and
// which refresh is the latest. Plain functions; `agents/Titles` calls the model and saves.

/** Longest reply to the refresh prompt taken as a title, in words (it's asked for 8 at most). */
export const MAX_WORDS = 10
/** What of each message goes to the model: so much of a message, so much of the end of what the agent said before it, and the user's latest so many messages. */
export const MESSAGE_CHARS = 1500
export const AGENT_CHARS = 300
export const DESCRIPTION_CHARS = 3000
export const MESSAGES = 30

/** The heading of a message that lists attached files (huntaway's attachments.ts `HEADER`). */
const ATTACHED = "Attached files:"

const chars = (s: string) => Array.from(s)

/** Rust's `str::lines`. */
const lines = (s: string): Array<string> => {
  if (s === "") return []
  const out = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
  if (s.endsWith("\n")) out.pop()
  return out
}

/** The model's reply as a title: its first non-empty line, without a heading's `#`, a `Title:` label, quotes, emphasis or trailing punctuation, at most 120 characters. */
export const clean = (s: string): string => {
  let line =
    lines(s)
      .map((l) => l.trim())
      .find((l) => l !== "") ?? ""
  line = line.replace(/^#+/, "").trim()
  if (line.startsWith("Title:")) line = line.slice(6)
  line = line.trim()
  line = line.replace(/^["'`*“”]+|["'`*“”]+$/gu, "")
  line = line.replace(/[.!:;]+$/, "").trim()
  return chars(line).slice(0, 120).join("")
}

/** `s` lowercased, with its quotes and punctuation as spaces and its spaces collapsed, to compare titles by. */
const wordsOf = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()

/** Words a sentence saying the title still fits is made of ("Keep the task's current title as is", "No changes needed"), in `wordsOf`'s form. */
const KEEP_FILLER = new Set(
  (
    "keep keeping kept the task s title current existing same original present its it this as is unchanged no change changes changed needed " +
    "still fits fine applies accurate stays remains nothing needs ok good"
  ).split(" "),
)
/** Those of them that say it: one of these makes a sentence of filler a KEEP. */
const KEEP_SAYS = /^(?:keep|keeping|kept|unchanged|change|changes|changed|fits|fine|applies|accurate|stays|remains)$/u

/**
 * A reply (cleaned, see `clean`) that the title (`current`) still fits: KEEP, or KEEP with an explanation after it, or
 * a sentence that says so instead (as Codex sometimes answers: "Keep the task title “Say hello”", "The title “Say hello”
 * still fits", "No changes needed"), in any order: one that, besides the current title (once), is only words like
 * these, with one that says to keep it. A title that only starts with "Keep" ("Keep the title bar visible", "Keep dark
 * mode in sync" for a task titled "Dark mode") is a title.
 */
export const isKeep = (reply: string, current: string): boolean => {
  if (/^KEEP(?![\p{L}\p{N}])/u.test(reply.trim())) return true
  let r = ` ${wordsOf(reply)} `
  const t = wordsOf(current)
  if (t !== "") r = r.replace(` ${t} `, " ")
  const words = r.split(" ").filter((w) => w !== "")
  return words.length > 0 && words.every((w) => KEEP_FILLER.has(w)) && words.some((w) => KEEP_SAYS.test(w))
}

/**
 * The title in a reply to the refresh prompt for a task titled `current`, if it gives one: not KEEP (or a sentence
 * saying to keep it, see `isKeep`), and not so long that it's more of a summary than a title.
 */
export const newTitle = (reply: string, current: string): string | null => {
  const words = reply.split(/\s+/u).filter((w) => w !== "").length
  return !isKeep(reply, current) && words >= 1 && words <= MAX_WORDS ? reply : null
}

/** Whether a message the user sent may say something about what the task is about: it has words besides links and attached files. */
export const worthAsking = (text: string): boolean => {
  let attached = false
  return lines(text)
    .map((l) => l.trim())
    .some((line) => {
      attached = line === ATTACHED || (attached && line.startsWith("- "))
      return !attached && line.split(/\s+/u).some((w) => w !== "" && !w.startsWith("http://") && !w.startsWith("https://"))
    })
}

/** The first `n` characters of `s`, marked if cut. */
const head = (s: string, n: number): string => {
  const cs = chars(s)
  return cs.length > n ? `${cs.slice(0, n).join("")}…` : s
}

/** The last `n` characters of `s` (where an agent's question usually is), marked if cut. */
const tail = (s: string, n: number): string => {
  const cs = chars(s)
  return cs.length <= n ? s : `…${cs.slice(cs.length - n).join("")}`
}

/** What of a task a refresh reads: its title and description, and the user's messages still waiting for its agent. */
export interface RefreshTask {
  readonly title: string
  readonly description: string
  /** Messages sent to the running agent and not taken in yet: the user's are those not `from_agent`. */
  readonly steering: ReadonlyArray<Pick<Steer, "text" | "from_agent">>
  /** The user's parts of what is queued for its next run, joined with a blank line (the old `queued_user_text`). */
  readonly queued_user_text: string | null
}

/**
 * What a refresh asks the model about: the task's title and description, and the user's own messages
 * (`ThreadReaders.userReplies`, oldest first, after `earlier` ones left out), with those still waiting for its agent to
 * take them in (sent while it works, or the user's parts of what's queued for its next run) at the end, after what the
 * agent has said `since` the last of the others.
 */
export const refreshInput = (task: RefreshTask, replies: ReadonlyArray<readonly [string | null, string]>, since: string | null, earlier: number): string => {
  const all: Array<readonly [string | null, string]> = replies.map(([said, text]) => [said ?? null, text] as const)
  const pending: Array<string> = task.steering.filter((s) => !s.from_agent).map((s) => s.text)
  if (task.queued_user_text !== null) pending.push(task.queued_user_text)
  let saidSince = since
  for (const text of pending.filter((t) => t.trim() !== "")) {
    all.push([saidSince, text])
    saidSince = null
  }
  // A message sent again with nothing from the agent in between (after a run that failed, say) is the same message;
  // the same words answering something new aren't.
  const messages: Array<readonly [string | null, string]> = []
  for (const m of all) {
    const prev = messages[messages.length - 1]
    if (prev !== undefined && m[0] === null && prev[1].trim() === m[1].trim()) continue
    messages.push(m)
  }
  let out = `<title>${task.title.trim()}</title>\n\n<task>\n${head(task.description.trim(), DESCRIPTION_CHARS)}\n</task>\n`
  const skip = Math.max(0, messages.length - MESSAGES)
  if (skip + earlier > 0) out += `\n(${skip + earlier} earlier messages left out)\n`
  for (const [said, text] of messages.slice(skip)) {
    out += "\n<message>\n"
    const s = said?.trim() ?? ""
    if (s !== "") out += `<agent>${tail(s, AGENT_CHARS)}</agent>\n`
    out += `${head(text.trim(), MESSAGE_CHARS)}\n</message>\n`
  }
  return out
}

// ---- which refresh is the latest --------------------------------------------------------------------------------

/**
 * The latest refresh asked for each task, so an older one that finishes late is dropped. Each refresh gets a number of
 * its own (`next`, which never repeats one).
 */
export interface Refreshes {
  readonly next: number
  readonly latest: HashMap.HashMap<string, number>
}

export const noRefreshes: Refreshes = { next: 1, latest: HashMap.empty() }

/** Start a refresh of a task's title: its number, which is now the latest. */
export const beginRefresh = (state: Refreshes, task: string): readonly [number, Refreshes] => [
  state.next,
  { next: state.next + 1, latest: HashMap.set(state.latest, task, state.next) },
]

/** End a refresh: whether it's still the latest one asked for the task. */
export const endRefresh = (state: Refreshes, task: string, id: number): readonly [boolean, Refreshes] => {
  const latest = HashMap.get(state.latest, task)
  const is = Option.isSome(latest) && latest.value === id
  return [is, is ? { next: state.next, latest: HashMap.remove(state.latest, task) } : state]
}
