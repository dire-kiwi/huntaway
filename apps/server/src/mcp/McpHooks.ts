import { Context, Effect, Layer } from "effect"
import type { CallId } from "@huntaway/contracts"
import type { Rule } from "@huntaway/shared"
import type { Run } from "../runs/Run.ts"
import { ToolError } from "./tool.ts"
import type { McpCaller } from "./tool.ts"

// What a board call needs of the services built over `ToolCalls`' area (docs/plan/07-agents.md, Dispatch): the run's
// wait (`Wait`: `callMade`, and its part of `cancelled`) and the user's answer to an approval rule that asks
// (`Permissions`: `askRule`, and its part of `cancelled`). `ToolCalls` calls these at its gates and when the agent gives
// up on a call. `Wait.hooks` is `Wait`'s with `refuseAsk` until `Permissions`' is combined with it in `Main.ts`;
// `layerNone` is for tests that want neither.

export interface McpHooksShape {
  /** Any board call but `wait` means the run is working again: it ends the run's current wait. */
  readonly callMade: (caller: McpCaller) => Effect.Effect<void>
  /**
   * An approval rule asks about the call (`name` is the tool as the rule matched it, `mcp__huntaway__<tool>`): the
   * user, or the thread's mode, decides. Fails with what the agent is told when it is denied.
   */
  readonly askRule: (caller: McpCaller, name: string, input: unknown, rule: Rule) => Effect.Effect<void, ToolError>
  /** The agent gave up on call `call` of `run`: the prompt it raised expires and its wait ends (it is not answered). */
  readonly cancelled: (run: Run, call: CallId) => Effect.Effect<void>
}

/** An ask rule's call refused (closed rather than open), with the reason, while the board can't ask the user. */
export const refuseAsk: McpHooksShape["askRule"] = (_caller, name, _input, rule) =>
  Effect.fail(ToolError.other(`The user's approval rules ask about ${name} (ask: ${rule.tool}), and this board can't ask the user yet, so it wasn't run.`))

export class McpHooks extends Context.Service<McpHooks, McpHooksShape>()("huntaway-server/mcp/McpHooks") {
  /**
   * No wait to end and no one to ask: a call an ask rule matches is refused (closed rather than open), with the
   * reason, until `Permissions` asks the user.
   */
  static readonly layerNone = Layer.succeed(
    McpHooks,
    McpHooks.of({
      callMade: () => Effect.void,
      askRule: refuseAsk,
      cancelled: () => Effect.void,
    }),
  )
}
