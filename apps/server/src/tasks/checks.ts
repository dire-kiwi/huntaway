import { DateTime, Result } from "effect"
import { DocumentLabel, Invalid, Timestamp } from "@huntaway/contracts"
import type { ExternalLink, ProfileId, ProjectId, StartFrom, StartFromInput, Task, TaskId, Todo } from "@huntaway/contracts"

// The field checks a task's create and update share (huntaway's api/new_task.ts, api/tasks.ts, api/extract.ts,
// db/tasks/deps.ts and agent/documents.ts): pure functions over the request and the tasks the decision was given.

/** What a decision knows of a task's project. */
export interface ProjectFacts {
  readonly id: ProjectId
  readonly profile_id: ProfileId
  readonly name: string
  readonly key: string
  readonly former_keys: ReadonlyArray<string>
  readonly archived: boolean
  readonly base_branch: string | null
  readonly use_worktrees: boolean
  readonly is_git: boolean
  /** Its pull requests' previews: a URL with `{pr}` for the number; null for none. */
  readonly pr_preview_url: string | null
}

export const invalid = (field: string, reason: string) => Result.fail(new Invalid({ field, reason }))
const badStart = (m: string) => invalid("start_from", `start_from: ${m}`)
const badTarget = (m: string) => invalid("merges_into", `merges_into: ${m}`)
const badDeps = (m: string) => invalid("depends_on", m)

const chars = (s: string) => Array.from(s)
const bytes = (s: string) => new TextEncoder().encode(s).length
/** Rust's `eq_ignore_ascii_case`. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())
export const sameKey = (a: string, b: string) => asciiLower(a) === asciiLower(b)

// ---- what a task is -----------------------------------------------------------------------------------------------

export const isScratch = (t: Task) => t.kind === "task" && t.task_type === "scratch"
export const isAssistants = (t: Task) => t.kind === "task" && (t.task_type === "assistant" || t.task_type === "routine")
/** A task that makes only documents, in its own folder (the old plan, artifact and diagram tasks). */
export const documentsOnly = (t: Task) => t.kind === "task" && !isScratch(t) && !isAssistants(t) && t.work_dir !== null
/** Whether a task counts as merged for the tasks that depend on it or merge into it. */
export const isMerged = (t: Pick<Task, "status" | "resolution">) => t.status === "done" && (t.resolution === null || t.resolution === "done")
/** A task with a branch of its own (made, or to be made in its worktree), which others can start from or merge into. */
const hasOwnBranch = (t: Task) => !isScratch(t) && !documentsOnly(t) && (t.use_worktree || t.branch !== null)

// ---- text ---------------------------------------------------------------------------------------------------------

/** The heading of a message that lists attached files (huntaway's attachments.ts `HEADER`). */
const ATTACHED = "Attached files:"

/**
 * The title a task described but not titled gets until a generated one arrives: the description's first line,
 * shortened, or for a task that's only attached files, their names (huntaway's agent/title.ts `placeholder`).
 */
export const placeholderTitle = (description: string): string => {
  const lines = description
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
  if (lines[0] === ATTACHED) {
    const names = lines
      .slice(1)
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2))
      .map((p) => p.split(/[/\\]/).pop() ?? p)
    if (names.length === 0) return "New task"
    if (names.length === 1) return `Attached ${names[0]}`
    return `Attached ${names[0]} and ${names.length - 1} more`
  }
  const line = (lines[0] ?? "New task").replace(/^#+/, "").trim()
  if (chars(line).length <= 60) return line
  let cut = chars(line).slice(0, 60).join("")
  const space = cut.lastIndexOf(" ")
  if (space >= 0 && bytes(cut.slice(0, space)) > 20) cut = cut.slice(0, space)
  return `${cut.trimEnd()}…`
}

/**
 * A branch name git takes (`git check-ref-format --branch`), checked without git: no `..`, `@{`, control characters,
 * spaces or `~^:?*[\`; not `@`, not starting with `-`; no empty part, none starting with `.` or ending with `.lock`; not
 * ending with `.` or `/`.
 */
export const validBranchName = (name: string): boolean => {
  if (name === "" || name === "@" || name.startsWith("-") || name.endsWith(".") || name.endsWith("/")) return false
  if (name.includes("..") || name.includes("@{")) return false
  for (const c of name) {
    const code = c.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || " ~^:?*[\\".includes(c)) return false
  }
  return name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
}

const daysFromCivil = (year: number, month: number, day: number): number => {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}
const daysInMonth = (year: number, month: number) =>
  month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31

/** An RFC 3339 time in any offset as the board keeps times (UTC, milliseconds), or null if it isn't one. */
export const rfc3339Utc = (s: string): Timestamp | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(s)
  if (m === null) return null
  const [y = 0, mo = 0, d = 0, h = 0, mi = 0, se = 0] = m.slice(1, 7).map(Number)
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 60 || d > daysInMonth(y, mo)) return null
  const ms = m[7] === undefined ? 0 : Math.floor(Number(`0${m[7]}`) * 1000)
  let t = (((daysFromCivil(y, mo, d) * 24 + h) * 60 + mi) * 60 + Math.min(se, 59)) * 1000 + ms
  const offset = m[8] ?? "Z"
  if (offset !== "Z" && offset !== "z") {
    const sign = offset.startsWith("-") ? -1 : 1
    const [oh = 0, om = 0] = offset.slice(1).split(":").map(Number)
    if (oh > 23 || om > 59) return null
    t -= sign * (oh * 60 + om) * 60_000
  }
  return Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(t)))
}

// ---- fields -------------------------------------------------------------------------------------------------------

/** Most external links a task can have. */
export const MAX_LINKS = 20

/** A task's external links as they're stored: trimmed, each task elsewhere once, at most `MAX_LINKS`; null is none. */
export const checkExternalLinks = (given: ReadonlyArray<ExternalLink> | null | undefined): Result.Result<Array<ExternalLink>, Invalid> => {
  const out: Array<ExternalLink> = []
  for (const l of given ?? []) {
    const link: ExternalLink = { provider: l.provider, id: l.id.trim(), url: l.url.trim(), title: chars(l.title.trim()).slice(0, 500).join("") }
    if (link.id === "" || bytes(link.id) > 100) return invalid("external_links", "external_links need an id")
    if (!(link.url.startsWith("https://") || link.url.startsWith("http://"))) return invalid("external_links", "external_links need an http(s) url")
    if (!out.some((o) => o.provider === link.provider && o.id === link.id)) out.push(link)
  }
  if (out.length > MAX_LINKS) return invalid("external_links", `external_links can have at most ${MAX_LINKS}`)
  return Result.succeed(out)
}

/** A fan-out id (blank for none): up to 64 letters, digits, `-` and `_`. */
export const checkFanout = (given: string | null | undefined): Result.Result<string | null, Invalid> => {
  const f = given?.trim() ?? ""
  if (f === "") return Result.succeed(null)
  if (f.length > 64 || !/^[A-Za-z0-9_-]+$/.test(f)) return invalid("fanout_id", "fanout_id must be up to 64 letters, digits, - or _")
  return Result.succeed(f)
}

/** Labels in the board's order (plan, artifact, diagram), each once. */
export const orderLabels = (given: ReadonlyArray<DocumentLabel>): Array<DocumentLabel> => DocumentLabel.literals.filter((l) => given.includes(l))

/** `preview_url` or `pr_url`: null or blank clears it, otherwise an http(s) URL. */
export const checkUrl = (field: string, given: string | null): Result.Result<string | null, Invalid> => {
  const url = given?.trim() ?? ""
  if (url === "") return Result.succeed(null)
  if (!(url.startsWith("http://") || url.startsWith("https://"))) return invalid(field, `${field} must be null or an http(s) URL`)
  return Result.succeed(url)
}

/** `base_branch`: null or blank for none, otherwise a valid branch name. */
export const checkBaseBranch = (given: string | null): Result.Result<string | null, Invalid> => {
  const name = given?.trim() ?? ""
  if (name === "") return Result.succeed(null)
  if (!validBranchName(name)) return invalid("base_branch", `base_branch "${name}" isn't a valid branch name`)
  return Result.succeed(name)
}

/** Longest a reminder's note can be. */
export const MAX_REMINDER = 500

export interface Marks {
  readonly starred?: boolean | undefined
  readonly remind_at?: string | null | undefined
  readonly reminder?: string | null | undefined
}

/**
 * `starred`, `remind_at` and `reminder` of a task (`before`, null for a new one), with the time in UTC. Clearing the time
 * (null or blank) clears the note too; a note needs a time (huntaway's api/tasks.ts `check_reminder`).
 */
export const checkMarks = (
  before: Pick<Task, "remind_at" | "reminder"> | null,
  given: Marks,
): Result.Result<{ starred?: boolean; remind_at?: Timestamp | null; reminder?: string | null }, Invalid> => {
  const out: { starred?: boolean; remind_at?: Timestamp | null; reminder?: string | null } = {}
  if (given.starred !== undefined) out.starred = given.starred
  if (given.remind_at !== undefined) {
    const v = given.remind_at?.trim() ?? ""
    if (v === "") out.remind_at = null
    else {
      const at = rfc3339Utc(v)
      if (at === null) return invalid("remind_at", "remind_at must be null or a time like 2026-05-01T09:00:00Z")
      out.remind_at = at
    }
  }
  const timed = out.remind_at !== undefined ? out.remind_at !== null : before !== null && before.remind_at !== null
  if (given.reminder !== undefined) {
    const note = given.reminder?.trim() ?? ""
    if (chars(note).length > MAX_REMINDER) return invalid("reminder", `reminder must be at most ${MAX_REMINDER} characters`)
    if (note !== "" && !timed) return invalid("reminder", "a reminder needs remind_at, the time to remind you")
    out.reminder = note === "" ? null : note
  } else if (!timed && before !== null && before.reminder !== null) out.reminder = null
  return Result.succeed(out)
}

// ---- the agent's todo list (HA-330) ------------------------------------------------------------------------------

/** The items of a task's todo list that aren't completed. */
export const unfinished = (t: Task): ReadonlyArray<Todo> => (t.kind === "task" ? t.todos.filter((x) => x.status !== "completed") : [])

/** The unfinished items that hold `t` where it is when it's moved to `to`: out of In progress, to anywhere but Needs attention. */
export const holding = (t: Task, to: string): ReadonlyArray<Todo> =>
  t.status !== "in_progress" || to === "in_progress" || to === "needs_attention" ? [] : unfinished(t)

/** Why a move that `items` hold is refused: an agent's (`agent`), or the user's. */
export const todosRefusal = (items: ReadonlyArray<Todo>, agent: boolean): string => {
  const list = items.map((x) => `- [${x.status === "in_progress" ? "in progress" : x.status}] ${x.text}`).join("\n")
  const how = agent
    ? "Its agent finishes them, or marks them completed (or takes them off its list) if they no longer apply. For another task, ask its agent " +
      "with send_to_task, or ask the user, who can move it anyway on the board."
    : 'Its agent finishes them, or you can move it anyway (with "todos_override": true).'
  return `the task's todo list has ${items.length} unfinished item${items.length === 1 ? "" : "s"}, so it stays in progress until the list is complete:\n${list}\n${how}`
}

// ---- links between tasks ----------------------------------------------------------------------------------------

/** The tasks a decision was given, by id. */
export type TaskIndex = ReadonlyMap<string, Task>

export const indexTasks = (tasks: ReadonlyArray<Task>): TaskIndex => new Map(tasks.map((t) => [t.id, t]))

/** The task in `project` that `word` names: its id, or its key (with the project's key or one it had before), in any case. */
export const findTask = (tasks: TaskIndex, project: ProjectFacts, word: string): Task | null => {
  const byId = tasks.get(word)
  if (byId !== undefined && byId.project_id === project.id) return byId
  const dash = word.lastIndexOf("-")
  if (dash < 0) return null
  const key = word.slice(0, dash)
  const n = word.slice(dash + 1)
  if (!/^[+-]?\d+$/.test(n)) return null
  if (![project.key, ...project.former_keys].some((k) => sameKey(k, key))) return null
  return byNumber(tasks, project.id, Number(n))
}

/** A project's task by number, as the old `task_by_number` picks one (board order). */
export const byNumber = (tasks: TaskIndex, project: ProjectId, n: number): Task | null =>
  [...tasks.values()]
    .filter((t) => t.project_id === project && t.kind === "task" && t.number === n)
    .toSorted((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))[0] ?? null

/** Whether following `links` from `from` (a task id) through `tasks` reaches `to`. */
const reaches = (tasks: TaskIndex, from: Task, to: string, links: (t: Task) => ReadonlyArray<string | null>): boolean => {
  const stack: Array<Task> = [from]
  const seen = new Set<string>([from.id])
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    for (const id of links(next)) {
      if (id === null) continue
      if (id === to) return true
      if (!seen.has(id)) {
        seen.add(id)
        const n = tasks.get(id)
        if (n !== undefined) stack.push(n)
      }
    }
  }
  return false
}

const startTask = (t: Task): string | null => (t.start_from?.type === "task" ? t.start_from.task_id : null)

const isHex = (w: string) => w.length >= 7 && w.length <= 40 && /^[0-9A-Fa-f]+$/.test(w)
const parseCount = (w: string): number | null => (/^\+?\d+$/.test(w) && Number(w) <= Number.MAX_SAFE_INTEGER ? Number(w) : null)

/** `#12`, `pr:12`'s `12`, or a pull request's URL (with anything after it), as a number and the `OWNER/REPO` the URL names. */
const pullRequest = (w: string, prefixed: boolean): StartFrom | null => {
  const n = w.startsWith("#") ? w.slice(1) : prefixed ? w : null
  if (n !== null) {
    const number = parseCount(n)
    return number === null ? null : { type: "pull_request", number }
  }
  const rest = w.startsWith("https://") ? w.slice(8) : w.startsWith("http://") ? w.slice(7) : null
  if (rest === null) return null
  const slash = rest.indexOf("/")
  if (slash < 0) return null
  const parts = rest.slice(slash + 1).split(/[/#?]/)
  const [owner, repo, pull, num] = parts
  if (parts.length >= 4 && pull === "pull" && owner && repo && num !== undefined) {
    const number = parseCount(num)
    return number === null ? null : { type: "pull_request", number, repo: `${owner}/${repo}` }
  }
  return null
}

/**
 * What a task's worktree starts from (huntaway's api/new_task.ts `check_start_from`), for task `taskId` (null for a new
 * one) in `project`: null or blank for the project's base branch, a `StartFrom`, or text: `task:`, `branch:`, `pr:` or
 * `commit:` and what it names, or bare, tried as a task's key or id, a pull request (`#12` or its URL), a commit's SHA
 * and then a branch. Whether a branch or commit exists is found out as the worktree is made.
 */
export const checkStartFrom = (
  tasks: TaskIndex,
  project: ProjectFacts,
  taskId: TaskId | null,
  given: StartFromInput | null | undefined,
): Result.Result<StartFrom | null, Invalid> => {
  if (given === null || given === undefined) return Result.succeed(null)
  let sf: StartFrom
  if (typeof given === "string") {
    const text = given.trim()
    if (text === "") return Result.succeed(null)
    const colon = text.indexOf(":")
    const prefix = colon >= 0 ? text.slice(0, colon) : ""
    const kind = ["task", "branch", "pr", "commit"].includes(prefix) ? prefix : null
    const what = kind === null ? text : text.slice(colon + 1).trim()
    if (kind === "task") {
      const t = findTask(tasks, project, what)
      if (t === null) return badStart(`no task ${what} in ${project.name}`)
      sf = { type: "task", task_id: t.id }
    } else if (kind === "pr") {
      const pr = pullRequest(what, true)
      if (pr === null) return badStart(`"${what}" isn't a pull request's number or URL`)
      sf = pr
    } else if (kind === "commit") {
      if (!isHex(what)) return badStart(`"${what}" isn't a commit's SHA (7 to 40 hex digits)`)
      sf = { type: "commit", commit: what.toLowerCase() }
    } else if (kind === "branch") sf = { type: "branch", branch: what }
    else {
      const t = findTask(tasks, project, what)
      const pr = pullRequest(what, false)
      if (t !== null) sf = { type: "task", task_id: t.id }
      else if (pr !== null) sf = pr
      else if (isHex(what)) sf = { type: "commit", commit: what.toLowerCase() }
      else sf = { type: "branch", branch: what }
    }
  } else sf = given
  if (sf.type === "branch" && !validBranchName(sf.branch)) return badStart(`"${sf.branch}" isn't a valid branch name`)
  if (sf.type === "commit" && !isHex(sf.commit)) return badStart(`"${sf.commit}" isn't a commit's SHA (7 to 40 hex digits)`)
  if (sf.type === "pull_request" && sf.number < 1) return badStart("a pull request's number starts at 1")
  if (sf.type === "task") {
    const t = tasks.get(sf.task_id)
    if (t === undefined) return badStart(`no task ${sf.task_id}`)
    if (t.kind !== "task" || t.project_id !== project.id) return badStart(`"${t.title}" isn't a task in the same project`)
    if (t.id === taskId) return badStart("a task can't start from itself")
    if (!hasOwnBranch(t)) return badStart(`"${t.title}" has no branch of its own to start from`)
    // Nor from one whose worktree (by way of others) needs this one's first.
    if (taskId !== null && reaches(tasks, t, taskId, (x) => [startTask(x), x.parent_id])) {
      return badStart(`"${t.title}" needs this task's worktree first (it starts from it, or is in it)`)
    }
  }
  return Result.succeed(sf)
}

/**
 * The task a task in `project` merges into (huntaway's api/new_task.ts `check_merges_into`): null or blank for none,
 * else a task's id or key in the project, with a branch of its own, not done, and not one whose merge needs this task's
 * first (following what it merges into and starts from never leads back to `task`). Chains are fine.
 */
export const checkMergesInto = (
  tasks: TaskIndex,
  project: ProjectFacts,
  task: Task | null,
  given: string | null | undefined,
): Result.Result<Task | null, Invalid> => {
  const text = given?.trim() ?? ""
  if (text === "") return Result.succeed(null)
  const t = findTask(tasks, project, text)
  if (t === null) return badTarget(`no task ${text} in ${project.name}`)
  if (t.kind !== "task") return badTarget(`${text} isn't a task`)
  if (task !== null && t.id === task.id) return badTarget("a task can't merge into itself")
  if (!hasOwnBranch(t)) return badTarget(`"${t.title}" has no branch of its own to merge into`)
  if (t.status === "done") return badTarget(`"${t.title}" is done already, so there's nothing to merge into`)
  if (task !== null && reaches(tasks, t, task.id, (x) => [x.merges_into, startTask(x), x.parent_id])) {
    return badTarget(`"${t.title}" merges into this task already, or builds on it`)
  }
  return Result.succeed(t)
}

/**
 * The dependencies asked for a task (`taskId`, null for a new one) in `projectId` (huntaway's db/tasks/deps.ts
 * `check_dependencies`): tasks in its project, not itself, and not depending on it in turn; each once.
 */
export const checkDependencies = (
  tasks: TaskIndex,
  taskId: TaskId | null,
  projectId: ProjectId | null,
  ids: ReadonlyArray<TaskId>,
): Result.Result<Array<TaskId>, Invalid> => {
  if (projectId === null && ids.length > 0) return badDeps("only tasks in a project can have dependencies")
  const out: Array<TaskId> = []
  for (const id of ids) {
    if (out.includes(id)) continue
    const dep = tasks.get(id)
    if (dep === undefined) return badDeps(`no task ${id}`)
    if (dep.kind !== "task" || dep.project_id !== projectId) return badDeps(`"${dep.title}" isn't a task in the same project`)
    if (dep.id === taskId) return badDeps("a task can't depend on itself")
    if (taskId !== null && reaches(tasks, dep, taskId, (x) => x.depends_on)) return badDeps(`"${dep.title}" already depends on this task`)
    out.push(dep.id)
  }
  return Result.succeed(out)
}
