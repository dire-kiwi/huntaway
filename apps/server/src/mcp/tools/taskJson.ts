import { Effect, Schema } from "effect"
import { DocumentLabel } from "@huntaway/contracts"
import type { ProjectId, StartFrom, Task } from "@huntaway/contracts"
import { toJson } from "../../platform/columns.ts"
import { DataDir } from "../../platform/DataDir.ts"
import { isMerged } from "../../tasks/checks.ts"
import { PenRepo } from "../../tasks/PenRepo.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { ThreadReaders } from "../../threads/ThreadReaders.ts"
import type { Reach } from "../resolve.ts"
import { ToolError } from "../tool.ts"
import type { McpCaller } from "../tool.ts"
import type { JsonObject } from "./common.ts"

// A task as the board's tools give it to agents (docs/plan/inventory/03-mcp.md, section 3 "Task JSON given to
// agents"; the old mcp/tools/tasks.ts): never the stored row, which has fields the tools don't show. `summary` is what
// every list has, `summarize` adds how it stands with the tasks around it, and `details` what `get_task` reads, which
// it bounds (`overview`) and `get_task_field` pages (`field`).

/** How many characters `get_task_field` gives by default, and at most. */
export const TASK_FIELD_DEFAULT_LIMIT = 2000
export const TASK_FIELD_MAX_LIMIT = 4000

const PrettyJson = Schema.fromJsonString(Schema.Unknown, { space: 2 })

/** Unicode characters, as Rust's `chars()` counts them. */
const chars = (s: string): ReadonlyArray<string> => Array.from(s)

/** A value with its object keys sorted at every level, as serde_json writes one; undefined is null. */
const sorted = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sorted)
  if (typeof v === "object" && v !== null) {
    const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(v))
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .filter((k) => record[k] !== undefined)
        .map((k) => [k, sorted(record[k])]),
    )
  }
  return v === undefined ? null : v
}

/** Pretty JSON with sorted keys, two-space indents. */
const pretty = (v: unknown) => Schema.encodeEffect(PrettyJson)(sorted(v)).pipe(Effect.orDie)

/** A field as it is read: strings as plain text, anything else (null too) as pretty JSON. */
const fieldText = (v: unknown) => (typeof v === "string" ? Effect.succeed(v) : pretty(v))

const bytes = (s: string) => new TextEncoder().encode(s).length

/**
 * `get_task`'s bounded overview of `details`: each field inline if its pretty JSON is at most 1000 bytes and fits what is
 * left of 6000 for them all, with every field's length (`field_lengths`) and the ones left out (`omitted_fields`).
 */
export const overview = Effect.fnUntraced(function* (details: JsonObject) {
  const out: JsonObject = {}
  const lengths: Record<string, number> = {}
  const omitted: Array<string> = []
  // Bound each value and the whole response, counting serialized bytes too: escapes and nested JSON can be much larger
  // than plain text.
  let budget = 6000
  for (const name of Object.keys(details).toSorted()) {
    const value = details[name] ?? null
    lengths[name] = chars(yield* fieldText(value)).length
    const size = bytes(yield* pretty(value))
    if (size <= 1000 && size <= budget) {
      budget -= size
      out[name] = value
    } else omitted.push(name)
  }
  out["field_lengths"] = lengths
  out["omitted_fields"] = omitted
  return out
})

/** `get_task_field`'s page of one field of `details`, counted in Unicode characters. */
export const field = Effect.fnUntraced(function* (details: JsonObject, name: string, offset: number, limit: number) {
  if (!Object.hasOwn(details, name)) {
    return yield* ToolError.other(
      `unknown task field ${yield* toJson(name)}; available fields: ${Object.keys(details).toSorted().join(", ")} (see get_task's field_lengths)`,
    )
  }
  if (limit === 0 || limit > TASK_FIELD_MAX_LIMIT) return yield* ToolError.other(`limit must be between 1 and ${TASK_FIELD_MAX_LIMIT}`)
  const value = details[name] ?? null
  const text = chars(yield* fieldText(value))
  const content = offset >= text.length ? "" : text.slice(offset, offset + limit).join("")
  const length = chars(content).length
  const next = offset + length
  const page: JsonObject = {
    task_id: details["id"] ?? null,
    field: name,
    format: typeof value === "string" ? "text" : "json",
    offset,
    limit,
    length,
    total_length: text.length,
    next_offset: next < text.length ? next : null,
    content,
  }
  return page
})

const documentFile: { readonly [L in DocumentLabel]: string } = { plan: "plan.html", artifact: "artifact.html", diagram: "diagram.mmd" }

/** What a stack level's state says, for an open task (null: nothing to say). */
const STACK_SAID = {
  open: "waits for the task it lands after to be merged before it merges",
  conflict: "it couldn't be restacked onto where the task it lands after went: its agent rebases it",
  merged: null,
  closed: "the task it lands after was closed without being merged: ask the user where it merges now",
  deleted: "the task it landed after was deleted: ask the user where it merges now",
} as const

const brief = (t: Task) => ({ key: t.key, title: t.title, status: t.status, merged: isMerged(t) })

/** The task stack level `t` lands after (its `start_from` task, when it merges into none); undefined for none. */
const stackedBelow = (t: Task, all: ReadonlyMap<string, Task>) =>
  t.kind !== "task" || t.merges_into !== null || t.start_from?.type !== "task"
    ? undefined
    : { id: t.start_from.task_id, task: all.get(t.start_from.task_id) ?? null }

/** Where what `t` merges into stands, past its targets that are merged (the old `target_state`). */
const targetState = (t: Task, all: ReadonlyMap<string, Task>) => {
  if (t.merges_into === null) return "none"
  let at = t
  for (let i = 0; i < 16 && at.merges_into !== null; i++) {
    const target = all.get(at.merges_into)
    if (target === undefined) return "deleted"
    if (!isMerged(target)) return target.status === "done" ? "closed" : "open"
    at = target
  }
  return "merged"
}

/** Where stack level `t` stands (the old `stack_state`). */
const stackState = (t: Task, all: ReadonlyMap<string, Task>) => {
  if (t.status !== "done" && t.restack === "due") return "restack"
  if (t.status !== "done" && t.restack === "conflict") return "conflict"
  const below = stackedBelow(t, all)
  if (below === undefined) return "none"
  if (below.task === null) return "deleted"
  if (isMerged(below.task)) return "merged"
  return below.task.status === "done" ? "closed" : "open"
}

/** What a task starts from, as people and agents read it: `task ABC-12`, `branch feature`, `pull request #12`, `commit 0123abcd`. */
const describe = (sf: StartFrom, all: ReadonlyMap<string, Task>): string => {
  if (sf.type === "branch") return `branch ${sf.branch}`
  if (sf.type === "task") {
    const t = all.get(sf.task_id)
    return t === undefined ? "a deleted task" : `task ${t.key}`
  }
  if (sf.type === "pull_request") return `pull request ${sf.repo ?? ""}#${sf.number}`
  return `commit ${chars(sf.commit).slice(0, 12).join("")}`
}

/** The bottom of the stack `t` is in (the old `stack_of`), or null for a task in none. */
const stackBottom = (t: Task, siblings: ReadonlyArray<Task>) => {
  const all: ReadonlyMap<string, Task> = new Map(siblings.map((x) => [x.id, x]))
  const belowOf = (x: Task) => {
    const b = stackedBelow(x, all)?.task ?? null
    return b !== null && b.kind === "task" && b.project_id === x.project_id && b.profile_id === x.profile_id ? b : null
  }
  let bottom = t
  const down = new Set<string>([t.id])
  for (let b = belowOf(t); b !== null && !down.has(b.id); b = belowOf(b)) {
    down.add(b.id)
    bottom = b
  }
  if (bottom.kind !== "task") return null
  // In a stack only if something lands after its bottom.
  return bottom.id !== t.id || siblings.some((x) => belowOf(x)?.id === bottom.id) ? bottom : null
}

export interface TaskJson {
  /** What every list has of a task. */
  readonly summary: (t: Task) => Effect.Effect<JsonObject>
  /** The summary with how the task stands with the tasks around it: dependencies, merges, stacks, pens, documents. */
  readonly summarize: (t: Task) => Effect.Effect<JsonObject>
  /** Everything `get_task` reads, for `caller` (the tasks it created are those on boards the caller can use). */
  readonly details: (caller: McpCaller, t: Task) => Effect.Effect<JsonObject>
}

/** A task's JSON for agents, over the board's services and `reach` (profile names, the host's name). */
export const makeTaskJson = (reach: Reach) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    const pens = yield* PenRepo
    const readers = yield* ThreadReaders
    const dataDir = yield* DataDir

    const projectTasks = (project: ProjectId | null) => (project === null ? Effect.succeed([]) : repo.projectTasks(project))

    const summary = Effect.fnUntraced(function* (t: Task) {
      const profile = yield* reach.profile(t.profile_id)
      const v: JsonObject = {
        id: t.id,
        key: t.key,
        title: t.title,
        status: t.status,
        resolution: t.resolution,
        running: t.running,
        attention_reason: t.attention_reason,
        branch: t.branch,
        preview_url: t.preview_url,
        pr_url: t.pr_url,
        review: t.review === null ? null : { state: t.review.state, summary: t.review.summary, issues: t.review.issues },
        project_id: t.project_id,
        profile: profile?.name ?? null,
        host: reach.hostName,
      }
      if (t.external_links.length > 0) v["external_links"] = t.external_links
      if (t.starred) v["starred"] = true
      // Its own model and effort, when it has them; without, it runs on the defaults.
      if (t.model !== null && t.model !== "") v["model"] = t.model
      if (t.effort !== null) v["effort"] = t.effort
      if (t.remind_at !== null) {
        v["remind_at"] = t.remind_at
        v["reminder"] = t.reminder
      }
      return v
    })

    const summarizeIn = Effect.fnUntraced(function* (t: Task, siblings: ReadonlyArray<Task>) {
      const v = yield* summary(t)
      const all: ReadonlyMap<string, Task> = new Map(siblings.map((x) => [x.id, x]))
      if (t.depends_on.length > 0) {
        // Only ever in its own project (and so on its board); anything else is left out.
        const deps = (yield* repo.getMany(t.depends_on)).filter((d) => d.project_id !== null && d.project_id === t.project_id).map(brief)
        if (deps.length > 0) v["depends_on"] = deps
      }
      if (t.start_from !== null) {
        v["start_from"] = describe(t.start_from, all)
        // Where that took it, once its worktree is made: what its pull request targets.
        if (t.branch !== null) v["base_branch"] = t.base_branch
      }
      // What it merges into, and the tasks that merge into it, with how far each has got.
      if (t.merges_into !== null) {
        const target = all.get(t.merges_into)
        v["merges_into"] = target === undefined ? { key: null, title: null, status: "deleted", merged: false } : brief(target)
        const st = targetState(t, all)
        if (st === "closed" || st === "deleted") {
          v["merge_held"] = "the task it merges into was closed without being merged, or deleted: ask the user where it merges now"
        }
      }
      // A stack level: how its landing after the one below stands.
      const stack = stackState(t, all)
      if (stack !== "none" && t.status !== "done") {
        const said =
          stack === "restack"
            ? `${t.github_stack !== null ? "GitHub is" : "the board is"} restacking it onto where the task it lands after went`
            : STACK_SAID[stack]
        if (said !== null) v["stack"] = said
        // Only one whose pull request is in a stack on GitHub is "stacked".
        if (said !== null && stack !== "closed" && stack !== "deleted") {
          v["github_stack"] = t.github_stack !== null ? `its pull request is in stack #${t.github_stack} on GitHub, with the one below's` : null
        }
        if (stack === "closed" || stack === "deleted") v["merge_held"] = said
      }
      if (t.stack_run !== null && t.status !== "done") {
        v["stack_merge"] = "merging with its stack as one run: its levels merge bottom first, and nothing else merges between them"
      }
      if (t.carries !== null && t.status !== "done") {
        v["carries"] =
          `its branch may still have the commits of ${t.carries.key ?? "a deleted task"}, which was closed without being merged: its merge asks the user whether to keep them`
      }
      if (t.kind === "task") {
        const incoming = siblings
          .filter((x) => x.merges_into === t.id && x.kind === "task")
          .toSorted((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
        if (incoming.length > 0) v["merging_into_it"] = incoming.map(brief)
      }
      if (t.waiting) v["queued_for_dependencies"] = true
      if (t.project_id === null && t.group_name !== null) v["group_task"] = t.group_name
      // Its labels, and where the plan, artifact or diagram each asks for is, for agents on this host to read.
      const labels = t.kind === "task" ? DocumentLabel.literals.filter((l) => t.labels.includes(l)) : []
      if (labels.length > 0) {
        v["labels"] = labels
        v["documents"] = Object.fromEntries(labels.map((l) => [l, `${dataDir.documents(t.id)}/${documentFile[l]}`]))
      }
      if (t.kind === "task" && t.task_type !== null) v["type"] = t.task_type
      if (t.kind === "task" && t.task_type === "pen") {
        const pen = (yield* pens.all).find((p) => p.thread_id === t.id)
        if (pen !== undefined) v["thread_of_pen"] = pen.name
      }
      if (t.pen_id !== null) {
        const pen = yield* pens.get(t.pen_id)
        if (pen !== null) v["pen"] = pen.name
      }
      return v
    })

    const summarize = Effect.fnUntraced(function* (t: Task) {
      return yield* summarizeIn(t, yield* projectTasks(t.project_id))
    })

    const details = Effect.fnUntraced(function* (caller: McpCaller, t: Task) {
      const siblings = yield* projectTasks(t.project_id)
      const out = yield* summarizeIn(t, siblings)
      out["description"] = t.description
      out["worktree_path"] = t.worktree_path
      out["last_message"] = yield* readers.lastAssistantText(t.id)
      // The title and description of the stack it's in, kept on the stack's bottom.
      const bottom = stackBottom(t, siblings)
      if (bottom !== null) {
        out["stack_title"] = bottom.stack_title
        out["stack_description"] = bottom.stack_description
      }
      // A task can create tasks on boards the caller cannot use (or no longer can).
      const readable = new Set((yield* reach.boards(caller)).map((b) => b.id))
      const created = (yield* repo.all)
        .filter((c) => c.created_by === t.id && c.kind === "task" && readable.has(c.profile_id))
        .toSorted((a, b) => a.created_at.localeCompare(b.created_at))
      if (created.length > 0) out["created_tasks"] = yield* Effect.forEach(created, summary, { concurrency: 1 })
      return out
    })

    const json: TaskJson = { summary, summarize, details }
    return json
  })
