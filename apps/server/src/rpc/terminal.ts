import { Effect } from "effect"
import { NotFound, TerminalRpcs, Unavailable } from "@huntaway/contracts"
import { Terminals } from "../terminal/Terminals.ts"

const taskNotFound = (e: { readonly id: string }) => Effect.fail(new NotFound({ what: "task", id: e.id }))
const toolNotFound = (e: { readonly id: string }) => Effect.fail(new NotFound({ what: "terminal tool", id: e.id }))
const unavailable = (e: { readonly reason: string }) => Effect.fail(new Unavailable({ what: "terminal", reason: e.reason }))

export const TerminalHandlers = TerminalRpcs.toLayer(
  Effect.gen(function* () {
    const terminals = yield* Terminals
    return TerminalRpcs.of({
      "terminal.status": ({ task_id, tool }) =>
        terminals.status(task_id, tool ?? null).pipe(Effect.catchTags({ TaskNotFound: taskNotFound, ToolNotFound: toolNotFound })),
      "terminal.open": ({ task_id, tool }) =>
        terminals.open(task_id, tool ?? null).pipe(
          Effect.map((ticket) => ({ ticket })),
          Effect.catchTags({ TaskNotFound: taskNotFound, ToolNotFound: toolNotFound, TerminalUnavailable: unavailable }),
        ),
      "terminal.kill": ({ task_id, tool }) => terminals.kill(task_id, tool ?? null).pipe(Effect.catchTag("TaskNotFound", taskNotFound)),
      "terminal.keepalive": ({ task_id, tool }) => terminals.keepalive(task_id, tool).pipe(Effect.catchTag("TaskNotFound", taskNotFound)),
    })
  }),
)
