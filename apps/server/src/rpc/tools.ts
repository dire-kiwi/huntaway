import { Effect } from "effect"
import { Session, ToolRpcs } from "@huntaway/contracts"
import { HostTools } from "../hosts/HostTools.ts"

/** Board tool calls of other hosts' agents (docs/plan/08-hosts.md, Board tools across hosts). */
export const ToolHandlers = ToolRpcs.toLayer(
  Effect.gen(function* () {
    const tools = yield* HostTools
    return ToolRpcs.of({
      "tools.call": (payload, { client }) => Effect.flatMap(Effect.service(Session), (session) => tools.call(payload, session, client)),
    })
  }),
)
