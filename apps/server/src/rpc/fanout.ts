import { Effect } from "effect"
import { FanoutRpcs, Invalid, NotFound } from "@huntaway/contracts"
import { Fanout } from "../review/Fanout.ts"
import type { FanoutRefused } from "../review/Fanout.ts"
import type { TaskNotFound } from "../tasks/Tasks.ts"

// 6.11: comparing and picking among tasks made from one prompt.
const taskNotFound = (e: TaskNotFound) => Effect.fail(new NotFound({ what: "task", id: e.id }))
const refused = (e: FanoutRefused) => Effect.fail(new Invalid({ field: "fanout_id", reason: e.reason }))

export const FanoutHandlers = FanoutRpcs.toLayer(
  Effect.gen(function* () {
    const fanout = yield* Fanout
    return FanoutRpcs.of({
      "tasks.fanout": ({ id }) => fanout.facts(id).pipe(Effect.catchTags({ TaskNotFound: taskNotFound, FanoutRefused: refused })),
      "tasks.pickFanout": ({ id, pick }) => fanout.pick(id, pick).pipe(Effect.catchTags({ TaskNotFound: taskNotFound, FanoutRefused: refused })),
    })
  }),
)
