import { Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import { Connections } from "../../assistant/Connections.ts"
import { alreadyConnected, ASKED, attentionOf, CONNECTION_KINDS, unattended } from "../../assistant/connectionText.ts"
import { owner } from "../../assistant/trackedList.ts"
import { RunRepo } from "../../runs/RunRepo.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { WriteNo } from "../../threads/model.ts"
import { ThreadReaders } from "../../threads/ThreadReaders.ts"
import { ForPlanning, Rerunnable, ToolError } from "../tool.ts"
import { threadTool } from "./common.ts"

// `request_connection` (HE-28; bot-hq's `request_app_connection`): the assistant, or a thread under it, asks the user to
// connect what it needs and isn't there, with a card in its thread (`assistant/Connections.ts`), and ends its turn. A
// routine's run, which nobody watches, gets no card: it's told to say so in its report.

export const NOT_THE_ASSISTANT = "request_connection is the profile's assistant's: only it and its routines' threads can use it."

export const RequestConnection = Tool.make("request_connection", {
  description:
    "For the profile's assistant (and its routines): ask the user to connect something you need that isn't set up, rather than telling " +
    "them to go to Settings. Use it when a tool you need is missing (no mcp__google__… tools) or fails for want of a sign-in (not signed " +
    "in, no refresh token, the token expired or revoked). If it's connected already you're told so (try the tool again). Otherwise " +
    "the board shows the user a card with what's missing and your reason, with a link to set it up; end your turn then. You get a " +
    "message when it's connected (carry on with what you were doing) or skipped (carry on without it). In a routine's run nobody is " +
    "there: no card is shown, and you say in your report that it isn't connected.",
  parameters: Schema.Struct({
    connection: Schema.Literals(CONNECTION_KINDS).annotate({ description: "What to connect: google (Gmail, Calendar and Drive)" }),
    reason: Schema.String.annotate({
      description: "Why you need it, in a sentence the user reads on the card (e.g. 'To find the flight confirmation in your mail')",
    }),
  }),
  success: Schema.Struct({
    ok: Schema.Boolean,
    connected: Schema.Boolean,
    account: Schema.optionalKey(Schema.NullOr(Schema.String)),
    problem: Schema.optionalKey(Schema.NullOr(Schema.String)),
    note: Schema.String,
  }),
})
  // It records its card once per call, so a call cut short by a restart runs again.
  .annotate(Rerunnable, true)
  .annotate(ForPlanning, true)

/** The connection tool's handler. */
export const connectionTools = Effect.gen(function* () {
  const connections = yield* Connections
  const runs = yield* RunRepo
  const tasks = yield* TaskRepo
  const readers = yield* ThreadReaders

  const requestConnection = threadTool(RequestConnection, (params, caller) =>
    Effect.gen(function* () {
      const t = caller.task
      const parent = t.parent_id === null ? null : yield* tasks.get(t.parent_id)
      if (owner(t, parent) === null) return yield* ToolError.other(NOT_THE_ASSISTANT)
      const reason = params.reason.trim()
      if (reason === "") return yield* ToolError.other("request_connection needs a reason")
      const kind = params.connection
      const now = yield* connections.state(kind, t.profile_id)
      if (now.connected) return { ok: true, connected: true, account: now.account, note: alreadyConnected(kind, now.account) }
      // A routine's turn (its message is marked so): nobody is there to answer a card.
      const turn = caller.run.write_no === null ? null : yield* readers.userMessage(t.id, WriteNo.make(caller.run.write_no))
      if (turn?.routine === true) return { ok: false, connected: false, problem: now.problem, note: unattended(kind, now.problem) }
      // Read when the run ends: it ends in Needs attention, waiting on the card.
      yield* runs.update(caller.run.id, { attention: attentionOf(kind) })
      yield* connections
        .ask(t.id, caller.call_id, kind, reason, now.problem)
        .pipe(Effect.catchTag("TaskNotFound", () => Effect.fail(ToolError.other("unknown task"))))
      return { ok: true, connected: false, problem: now.problem, note: ASKED }
    }),
  )

  return { requestConnection }
})
