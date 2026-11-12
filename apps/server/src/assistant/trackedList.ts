import { Result } from "effect"
import { TrackedItem } from "@huntaway/contracts"
import type { Status, Task, TaskId, Timestamp } from "@huntaway/contracts"

// Each assistant's tracked work (docs/plan/inventory/03-mcp.md 2.5; the old agent/assistant/tracked.ts): what it's doing
// or following for the user (tasks it created, subagents' research, questions waiting on them), kept on the assistant's
// task (`tasks.tracked`), so the board lists it in the assistant's details and it lasts over restarts and compactions.
// The assistant (and its routines' threads, for the assistant's list) sets it with the board tools `track_work`,
// `untrack_work` and `list_tracked_work` (mcp/tools/tracking.ts). Plain functions over the list; the board's `Tracked`
// service (the user's removal from the assistant's details, M6 6.7) builds on them.

/** The most items a list keeps. */
export const MAX_ITEMS = 100
/** The longest title and note, in characters. */
export const MAX_TITLE = 200
export const MAX_NOTE = 2000

export type TrackedStatus = TrackedItem["status"]
export const TRACKED_STATUSES: ReadonlyArray<TrackedStatus> = TrackedItem.fields.status.literals

/** What a thread that is neither the assistant nor one of its routines is told. */
export const NOT_THE_ASSISTANT =
  "Tracked work is the profile's assistant's: only it and its routines' threads can use track_work, untrack_work and list_tracked_work."

/**
 * The assistant whose list `task`'s calls change: the assistant itself, and a routine thread's assistant (its parent,
 * working in the same folder). Null for any other thread, or a routine whose assistant or workspace is gone.
 */
export const owner = (task: Task, parent: Task | null): TaskId | null => {
  if (task.kind === "task" && task.task_type === "assistant") return task.id
  if (task.task_type !== "routine") return null
  if (parent !== null && parent.kind === "task" && parent.task_type === "assistant" && parent.work_dir === task.work_dir) return parent.id
  return null
}

/** The board task an item follows, as `get_task` found it. */
export interface Link {
  readonly task_id: TaskId
  readonly task_key: string
}

/** A task's state as the list shows it with an item that follows it. */
export interface Linked {
  readonly key: string
  readonly title: string
  readonly status: Status
  readonly resolution: string | null
  readonly merged?: boolean
  readonly pr_url: string | null
}

/**
 * What an item shows (as the client's trackedStatus): done once the task it follows is done (merged or closed), unless
 * it failed; and while it says it's working or waiting on that task, waiting on the user once the task needs their
 * attention or is in review, as its own status (what the assistant last said) has fallen behind.
 */
export const effectiveStatus = (item: Pick<TrackedItem, "status">, linked: Pick<Linked, "status"> | null): TrackedStatus => {
  if (item.status === "failed" || item.status === "done" || linked === null) return item.status
  if (linked.status === "done") return "done"
  if ((item.status === "working" || item.status === "waiting_task") && (linked.status === "needs_attention" || linked.status === "in_review")) {
    return "waiting_user"
  }
  return item.status
}

/** What `track_work` gives for an item: left out (undefined), or the text (blank: null). */
export interface TrackArgs {
  readonly id?: string | undefined
  readonly title?: string | undefined
  readonly note?: string | undefined
  readonly status?: TrackedStatus | undefined
  readonly url?: string | undefined
}

const text = (v: string | undefined, name: string, max: number): Result.Result<string | null | undefined, string> => {
  if (v === undefined) return Result.succeed(undefined)
  const t = v.trim()
  if (t.length > max) return Result.fail(`${name} is too long (at most ${max} characters)`)
  return Result.succeed(t === "" ? null : t)
}

/** The fields of `args`, checked: undefined leaves one as it is, null clears it. */
export const checkTrack = (args: TrackArgs) =>
  Result.gen(function* () {
    const title = yield* text(args.title, "title", MAX_TITLE)
    const note = yield* text(args.note, "note", MAX_NOTE)
    const url = yield* text(args.url, "url", 2000)
    if (url !== null && url !== undefined && !/^https?:\/\//i.test(url)) return yield* Result.fail("url must be an http(s) URL")
    return { title, note, url }
  })

/**
 * Adds an item to `list` (no `args.id`, with `newId`), or changes the one with that id: what `args` gives and `link`
 * (undefined leaves it, null clears it). The list after, and the item as it is now.
 */
export const track = (
  list: ReadonlyArray<TrackedItem>,
  args: TrackArgs,
  link: Link | null | undefined,
  newId: string,
  at: Timestamp,
): Result.Result<{ readonly list: ReadonlyArray<TrackedItem>; readonly item: TrackedItem }, string> =>
  Result.gen(function* () {
    const id = args.id === undefined || args.id === "" ? null : args.id
    const { title, note, url } = yield* checkTrack(args)
    if (id === null) {
      if (title === null || title === undefined) return yield* Result.fail("title is required for a new item (pass id to change one)")
      if (list.length >= MAX_ITEMS) return yield* Result.fail(`The list has ${MAX_ITEMS} items, the most it keeps: remove some with untrack_work first.`)
      const item: TrackedItem = {
        id: newId,
        title,
        note: note ?? null,
        status: args.status ?? "working",
        task_id: link?.task_id ?? null,
        task_key: link?.task_key ?? null,
        url: url ?? null,
        created_at: at,
        updated_at: at,
      }
      return { list: [...list, item], item }
    }
    const old = list.find((x) => x.id === id)
    if (old === undefined) return yield* Result.fail(`no tracked item ${id} (list_tracked_work lists them)`)
    if (title === null) return yield* Result.fail("title can't be empty")
    const item: TrackedItem = {
      id: old.id,
      title: title ?? old.title,
      note: note === undefined ? old.note : note,
      status: args.status ?? old.status,
      task_id: link === undefined ? old.task_id : (link?.task_id ?? null),
      task_key: link === undefined ? old.task_key : (link?.task_key ?? null),
      url: url === undefined ? old.url : url,
      created_at: old.created_at,
      updated_at: at,
    }
    return { list: list.map((x) => (x.id === id ? item : x)), item }
  })

/** `list` without the items with these ids, and how many went. */
export const untrack = (list: ReadonlyArray<TrackedItem>, ids: ReadonlyArray<string>) => {
  const kept = list.filter((x) => !ids.includes(x.id))
  return { list: kept, removed: list.length - kept.length }
}
