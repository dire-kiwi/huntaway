import { Effect, Option, Result, Schema } from "effect"
import { Tool } from "effect/ai"
import { SecureRandom } from "effect/crypto"
import { Status, TaskId } from "@huntaway/contracts"
import type { TrackedItem } from "@huntaway/contracts"
import { effectiveStatus, MAX_ITEMS, NOT_THE_ASSISTANT, owner, track, TRACKED_STATUSES, untrack } from "../../assistant/tracked.ts"
import type { Link, Linked } from "../../assistant/tracked.ts"
import { nowTimestamp } from "../../platform/columns.ts"
import { isMerged } from "../../tasks/checks.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { Tasks } from "../../tasks/Tasks.ts"
import { makeAcross } from "../acrossHosts.ts"
import { makeReach } from "../resolve.ts"
import { ForPlanning, Rerunnable, ToolError } from "../tool.ts"
import type { LocalCaller } from "../tool.ts"
import { Json, threadTool, told } from "./common.ts"
import type { JsonObject } from "./common.ts"

// The assistant's tracked work tools (docs/plan/inventory/03-mcp.md 2.5; the old mcp/schemas/tracked.ts and
// mcp/tools/dispatch.ts `tracked_tool`): `track_work`, `untrack_work` and `list_tracked_work`, on the assistant task's
// `tracked` list. The rules of the list are `assistant/tracked.ts`; each change reads and writes the list in one
// `Tasks.change`, so two calls at once both land. Listed for everyone, but only the assistant and its routines' threads
// may use them.

export const TrackWork = Tool.make("track_work", {
  description:
    "For the profile's assistant (and its routines): add an item to the list of what you're working on or following for the user, or change one, " +
    "which the board shows in the assistant's details and keeps across restarts and compactions. Add one when you take on a request that " +
    "goes on in the background (a task you created, a subagent's research, a plan or question waiting on the user), change its status as " +
    "things change, and mark it done (or failed) when you report back. Leave out id to add an item (title needed); give the id " +
    "list_tracked_work or an earlier call returned to change one, with only the fields to change. An item following a board task shows " +
    "that task's live status, and shows as done once the task is done. Returns the item, with its id.",
  parameters: Schema.Struct({
    id: Schema.optionalKey(Schema.String.annotate({ description: "The item to change; leave out to add one" })),
    title: Schema.optionalKey(Schema.String.annotate({ description: "What it is, in a few words (e.g. 'Write up the hosting options')" })),
    note: Schema.optionalKey(Schema.String.annotate({ description: "Where it stands, or what it waits on, in a sentence; an empty string clears it" })),
    status: Schema.optionalKey(
      Schema.Literals(TRACKED_STATUSES).annotate({
        description:
          "working (you or a subagent are on it; the default for a new item), waiting_user (a plan, question or review waits on the user), waiting_task (a board task is doing it), done or failed",
      }),
    ),
    task: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "A board task it follows (id or key like ABC-12; <profile>:ABC-12 for one on another profile's board), on any board you can use; an empty string unlinks it",
      }),
    ),
    url: Schema.optionalKey(
      Schema.String.annotate({ description: "A document, pull request or other page it's about (an http(s) URL); an empty string clears it" }),
    ),
  }),
  success: Json,
})

export const UntrackWork = Tool.make("untrack_work", {
  description:
    "For the profile's assistant: take items off your tracked work list (see track_work), by id, or all those that are done with done=true. " +
    "Done items can also stay, as a record, until the user clears them.",
  parameters: Schema.Struct({
    ids: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: "The items to remove" })),
    done: Schema.optionalKey(Schema.Boolean.annotate({ description: "Also remove every item that is done (or whose task is), but not failed ones" })),
  }),
  success: Json,
}).annotate(Rerunnable, true)

export const ListTrackedWork = Tool.make("list_tracked_work", {
  description:
    `For the profile's assistant: your tracked work list (see track_work), oldest first, at most ${MAX_ITEMS} items: each item's id, title, note, status, ` +
    "url and times, and for one that follows a board task, that task's key, title and live status. Read it after a restart or compaction to pick up where you were.",
  parameters: Schema.Struct({}),
  success: Json,
})
  .annotate(Rerunnable, true)
  .annotate(ForPlanning, true)

/** What a tracked item needs of a task `get_task` found on another host. */
const OtherTask = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  title: Schema.String,
  status: Status,
  resolution: Schema.optional(Schema.NullOr(Schema.String)),
  pr_url: Schema.optional(Schema.NullOr(Schema.String)),
  profile: Schema.optional(Schema.String),
})

/** The tracked work tools' handlers. */
export const trackingTools = Effect.gen(function* () {
  const reach = yield* makeReach
  const repo = yield* TaskRepo
  const tasks = yield* Tasks
  const random = yield* SecureRandom.SecureRandom
  const across = yield* makeAcross

  /** The assistant whose list the caller's calls change. */
  const ownerOf = Effect.fnUntraced(function* (caller: LocalCaller) {
    const t = caller.task
    const parent = t.parent_id === null ? null : yield* repo.get(t.parent_id)
    const id = owner(t, parent)
    if (id === null) return yield* ToolError.other(NOT_THE_ASSISTANT)
    return id
  })

  const listOf = (id: TaskId) => Effect.map(repo.get(id), (t) => t?.tracked ?? [])

  /** `get_task` of `ref` on the other hosts (what isn't on this one): the task as that host gives it. */
  const elsewhere = (caller: LocalCaller, ref: string, here: ToolError) =>
    across
      .run({ caller, tool: "get_task", args: { task_id: ref }, local: () => Effect.fail(here), from: null, upById: false })
      .pipe(Effect.flatMap((v) => Schema.decodeUnknownEffect(OtherTask)(v).pipe(Effect.mapError(() => ToolError.other(`task ${ref}: not a task`)))))

  /**
   * A tracked item's task as it is now, if the caller can still read it: on a board it can use here, else on a linked
   * host (or a hub) that has it.
   */
  const linkedTask = Effect.fnUntraced(function* (caller: LocalCaller, id: TaskId) {
    const t = yield* repo.get(id)
    if (t === null) {
      const there = yield* Effect.option(elsewhere(caller, id, ToolError.notFound(`task ${id}`)))
      if (Option.isNone(there)) return null
      const v = there.value
      const linked: Linked = { key: v.key, title: v.title, status: v.status, resolution: v.resolution ?? null, pr_url: v.pr_url ?? null }
      return linked
    }
    // Only on a board the caller can still use, as get_task has it.
    if (!(yield* reach.boards(caller)).some((b) => b.id === t.profile_id)) return null
    const linked: Linked = { key: t.key, title: t.title, status: t.status, resolution: t.resolution, merged: isMerged(t), pr_url: t.pr_url }
    return linked
  })

  /**
   * Tracked items as the tools give them: with what they show as their status (done once the task they follow is), and
   * that task's state (null if it can't be read now).
   */
  const trackedJson = (caller: LocalCaller, items: ReadonlyArray<TrackedItem>) =>
    Effect.forEach(
      items,
      Effect.fnUntraced(function* (i) {
        const linked = i.task_id === null ? null : yield* linkedTask(caller, i.task_id)
        const status = effectiveStatus(i, linked)
        const out: JsonObject = {}
        Object.assign(out, i, { status })
        if (status !== i.status) out["own_status"] = i.status
        if (i.task_id !== null) out["task"] = linked
        return out
      }),
      { concurrency: 1 },
    )

  /** Changes the owner's list with `f` in one read and write; what `f` gave, or why it refused. */
  const changeList = <A>(
    caller: LocalCaller,
    id: TaskId,
    f: (list: ReadonlyArray<TrackedItem>) => Result.Result<{ readonly list: ReadonlyArray<TrackedItem>; readonly out: A }, string>,
  ) =>
    Effect.gen(function* () {
      let outcome: Result.Result<A, string> = Result.fail("the assistant is gone")
      yield* tasks
        .change(
          id,
          (t) => {
            const r = f(t.tracked)
            outcome = Result.map(r, (x) => x.out)
            return Result.isSuccess(r) && r.success.list !== t.tracked ? { tracked: r.success.list } : null
          },
          { _tag: "Agent", task_id: caller.task.id },
        )
        .pipe(Effect.catchTag("TaskNotFound", () => Effect.void))
      if (Result.isFailure(outcome)) return yield* ToolError.other(outcome.failure)
      return outcome.success
    })

  const trackWork = threadTool(TrackWork, (params, caller) =>
    Effect.gen(function* () {
      const assistant = yield* ownerOf(caller)
      const ref = params.task === undefined ? null : params.task.trim()
      let link: Link | null | undefined = undefined
      if (ref === "") link = null
      else if (ref !== null) {
        const here = yield* Effect.result(reach.task(caller, ref, null))
        if (here._tag === "Success") {
          const t = here.success
          const board = yield* reach.profile(t.profile_id)
          link = { task_id: t.id, task_key: board !== null && board.id !== caller.profile.id ? `${board.name}:${t.key}` : t.key }
        } else {
          // Not here: a linked host's (or a hub's) task, as get_task finds it there.
          const failed = here.failure
          const t = yield* (failed.notFound ? elsewhere(caller, ref, failed) : Effect.fail(failed)).pipe(
            Effect.mapError((e) => ToolError.other(`task ${ref}: ${e.message}`)),
          )
          link = { task_id: TaskId.make(t.id), task_key: t.profile !== undefined && t.profile !== caller.profile.name ? `${t.profile}:${t.key}` : t.key }
        }
      }
      const newId = (yield* random.uuidV4()).slice(0, 8)
      const at = yield* nowTimestamp
      const item = yield* changeList(caller, assistant, (list) => Result.map(track(list, params, link, newId, at), (r) => ({ list: r.list, out: r.item })))
      const [shown] = yield* trackedJson(caller, [item])
      return { item: shown, note: "The board shows it in the assistant's details. Keep it up to date with track_work and its id." }
    }).pipe(told),
  )

  const untrackWork = threadTool(UntrackWork, (params, caller) =>
    Effect.gen(function* () {
      const assistant = yield* ownerOf(caller)
      const ids = [...(params.ids ?? [])]
      if (ids.length === 0 && params.done !== true) return yield* ToolError.other("give the ids of the items to remove, or done: true for the done ones")
      if (params.done === true) for (const i of yield* trackedJson(caller, yield* listOf(assistant))) if (i["status"] === "done") ids.push(String(i["id"]))
      const removed = yield* changeList(caller, assistant, (list) => {
        const r = untrack(list, ids)
        return Result.succeed({ list: r.removed === 0 ? list : r.list, out: r.removed })
      })
      return { removed, left: (yield* listOf(assistant)).length }
    }).pipe(told),
  )

  const listTrackedWork = threadTool(ListTrackedWork, (_params, caller) =>
    Effect.gen(function* () {
      const assistant = yield* ownerOf(caller)
      return { items: yield* trackedJson(caller, yield* listOf(assistant)) }
    }),
  )

  return { trackWork, untrackWork, listTrackedWork }
})
