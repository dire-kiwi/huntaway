import { Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import { PenColor } from "@huntaway/contracts"
import type { Pen, Profile } from "@huntaway/contracts"
import { ProjectRepo } from "../../projects/ProjectRepo.ts"
import { PenRepo } from "../../tasks/PenRepo.ts"
import { Pens } from "../../tasks/Pens.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { makeReach } from "../resolve.ts"
import type { Reach } from "../resolve.ts"
import { ForPlanning, Rerunnable, ToolError } from "../tool.ts"
import type { McpCaller } from "../tool.ts"
import { boardTool, given, Json, ProfileArg, told } from "./common.ts"
import type { JsonObject } from "./common.ts"

// The board's pen tools (docs/plan/inventory/03-mcp.md 2.5; the old mcp/schemas/pens.ts and mcp/tools/pens.ts):
// `list_pens`, `create_pen`, `update_pen` and `delete_pen`, over `Pens`. A task goes into a pen with `update_task`'s (or
// `create_task`'s) `pen`.

const penRef = Schema.String.annotate({ description: "The pen's name (in any case) or id" })
const penColor = (description: string) => PenColor.annotate({ description })

export const ListPens = Tool.make("list_pens", {
  description:
    "List your profile's pens (or another board's, with profile): named sets of tasks from any of its projects, each active or inactive. The board shows the active ones as tabs, in this order, beside an All tab. Each comes with whether it's active, its colour (on its tab, and on a label on its tasks' cards), its tasks (key, title, status, project), and the id of its own thread (thread) once it has one. A task is in one pen at most; move one with update_task's pen.",
  parameters: Schema.Struct({ profile: Schema.optionalKey(ProfileArg) }),
  success: Json,
})
  .annotate(Rerunnable, true)
  .annotate(ForPlanning, true)

export const CreatePen = Tool.make("create_pen", {
  description: "Make a pen (a named set of tasks the board shows as a tab while it's active), at the end of the tabs. Put tasks in it with update_task's pen.",
  parameters: Schema.Struct({
    name: Schema.String.annotate({ description: "Its name, shown on its tab (e.g. Today, Parked, Billing rework)" }),
    active: Schema.optionalKey(Schema.Boolean.annotate({ description: "Whether it's active, shown as a tab (default true); false makes it inactive" })),
    color: Schema.optionalKey(penColor("Its colour, on its tab and on its tasks' cards; by default one the profile's other pens don't have")),
    profile: Schema.optionalKey(ProfileArg),
  }),
  success: Json,
})

export const UpdatePen = Tool.make("update_pen", {
  description:
    "Rename a pen, change its colour, mark it active (shown as a tab on the board) or inactive (off the tabs), or move its tab; leave out what to keep. An inactive pen keeps its tasks.",
  parameters: Schema.Struct({
    pen: penRef,
    name: Schema.optionalKey(Schema.String.annotate({ description: "Its new name" })),
    active: Schema.optionalKey(Schema.Boolean.annotate({ description: "Mark it active (true) or inactive (false)" })),
    color: Schema.optionalKey(penColor("Its new colour, on its tab and on its tasks' cards")),
    index: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
        description: "Where its tab goes among the profile's pens (inactive ones too, as list_pens has them): 0 is the first",
      }),
    ),
    profile: Schema.optionalKey(ProfileArg),
  }),
  success: Json,
})

export const DeletePen = Tool.make("delete_pen", {
  description: "Delete a pen. Its tasks aren't deleted: they're in no pen after. Ask the user before deleting one that has tasks.",
  parameters: Schema.Struct({ pen: penRef, profile: Schema.optionalKey(ProfileArg) }),
  success: Json,
})

/** A pen as the pen tools return it: with its place among the profile's tabs, and its tasks. */
export const makePenJson = (reach: Reach) =>
  Effect.gen(function* () {
    const projects = yield* ProjectRepo
    const tasks = yield* TaskRepo
    return Effect.fnUntraced(function* (p: Pen, index: number, board: Profile) {
      const names = new Map((yield* projects.list(board.id)).map((x) => [x.id, x.name]))
      const inPen = (yield* tasks.list({ _tag: "ByProfile", profile_id: board.id })).filter((t) => t.pen_id === p.id)
      const json: JsonObject = {
        id: p.id,
        name: p.name,
        active: p.active,
        color: p.color,
        index,
        thread: p.thread_id,
        profile: board.name,
        host: reach.hostName,
        tasks: inPen.map((t) => ({
          key: t.key,
          id: t.id,
          title: t.title,
          status: t.status,
          project: t.project_id === null ? null : (names.get(t.project_id) ?? null),
        })),
      }
      return json
    })
  })

/** The pen tools' handlers. */
export const penTools = Effect.gen(function* () {
  const reach = yield* makeReach
  const pens = yield* PenRepo
  const service = yield* Pens
  const penJson = yield* makePenJson(reach)

  /** A pen as the tools show it, with its place among its profile's tabs. */
  const shown = Effect.fnUntraced(function* (p: Pen) {
    const board = yield* reach.profile(p.profile_id)
    if (board === null) return yield* ToolError.notFound("profile")
    return yield* penJson(
      p,
      (yield* pens.list(p.profile_id)).findIndex((x) => x.id === p.id),
      board,
    )
  })

  /** The pen a call names: its id, or its name on the caller's boards (its own first). */
  const resolvePen = Effect.fnUntraced(function* (caller: McpCaller, ref: string, profile: string | null) {
    const boards = yield* reach.pickBoards(caller, profile)
    const byId = yield* pens.get(ref)
    if (byId !== null && boards.some((b) => b.id === byId.profile_id)) return byId
    const found: Array<readonly [Profile, Pen]> = []
    for (const b of boards) {
      const p = yield* pens.byName(b.id, ref)
      if (p !== null) found.push([b, p])
    }
    const own = found.find(([b]) => b.id === caller.profile.id)
    if (own !== undefined) return own[1]
    const [one, ...more] = found
    if (one === undefined) return yield* ToolError.notFound(`pen ${ref}`)
    if (more.length > 0) {
      return yield* ToolError.other(`pen ${ref} is on more than one profile's board: pass profile (one of ${found.map(([b]) => b.name).join(", ")})`)
    }
    return one[1]
  })

  const listPens = boardTool(ListPens, (params, caller) =>
    Effect.gen(function* () {
      const out: Array<JsonObject> = []
      for (const b of yield* reach.ownBoards(caller, given(params.profile))) {
        const list = yield* pens.list(b.id)
        for (const [i, p] of list.entries()) out.push(yield* penJson(p, i, b))
      }
      return out
    }),
  )

  const createPen = boardTool(CreatePen, (params, caller) =>
    Effect.gen(function* () {
      const board = (yield* reach.ownBoards(caller, given(params.profile)))[0]
      if (board === undefined) return yield* ToolError.notFound("your profile's board")
      const made = yield* service.create({
        profile_id: board.id,
        name: params.name,
        ...(params.active === undefined ? {} : { active: params.active }),
        ...(params.color === undefined ? {} : { color: params.color }),
      })
      return yield* shown(made)
    }).pipe(told),
  )

  const updatePen = boardTool(UpdatePen, (params, caller) =>
    Effect.gen(function* () {
      const p = yield* resolvePen(caller, params.pen, given(params.profile))
      const patch = {
        ...(params.name === undefined ? {} : { name: params.name }),
        ...(params.active === undefined ? {} : { active: params.active }),
        ...(params.color === undefined ? {} : { color: params.color }),
        ...(params.index === undefined ? {} : { index: params.index }),
      }
      return yield* shown(yield* service.update(p.id, patch))
    }).pipe(told),
  )

  const deletePen = boardTool(DeletePen, (params, caller) =>
    Effect.gen(function* () {
      const p = yield* resolvePen(caller, params.pen, given(params.profile))
      // It would delete the thread asking.
      if (p.thread_id === caller.task.id) {
        return yield* ToolError.other("a pen's own thread can't delete its pen: the user can, from the board or the pens thread")
      }
      const left = yield* service.delete(p.id, { _tag: "Agent", task_id: caller.task.id })
      const out: JsonObject = { deleted: p.name, tasks_left_in_no_pen: left.length }
      return out
    }).pipe(told),
  )

  return { listPens, createPen, updatePen, deletePen }
})
