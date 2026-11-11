import { Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import type { Pen, Profile } from "@huntaway/contracts"
import { ProjectRepo } from "../../projects/ProjectRepo.ts"
import { PenRepo } from "../../tasks/PenRepo.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { makeReach } from "../resolve.ts"
import type { Reach } from "../resolve.ts"
import { ForPlanning, Rerunnable } from "../tool.ts"
import { boardTool, given, Json, ProfileArg } from "./common.ts"
import type { JsonObject } from "./common.ts"

// The board's pen tool that reads (docs/plan/inventory/03-mcp.md 2.5; the old mcp/schemas/pens.ts and mcp/tools/pens.ts):
// `list_pens`. `create_pen`, `update_pen` and `delete_pen` are 3.4's.

export const ListPens = Tool.make("list_pens", {
  description:
    "List your profile's pens (or another board's, with profile): named sets of tasks from any of its projects, each active or inactive. The board shows the active ones as tabs, in this order, beside an All tab. Each comes with whether it's active, its colour (on its tab, and on a label on its tasks' cards), its tasks (key, title, status, project), and the id of its own thread (thread) once it has one. A task is in one pen at most; move one with update_task's pen.",
  parameters: Schema.Struct({ profile: Schema.optionalKey(ProfileArg) }),
  success: Json,
})
  .annotate(Rerunnable, true)
  .annotate(ForPlanning, true)

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
  const penJson = yield* makePenJson(reach)

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

  return { listPens }
})
