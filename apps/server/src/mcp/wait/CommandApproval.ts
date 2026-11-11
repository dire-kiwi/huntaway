import { Context, Effect, Layer } from "effect"
import { Permissions } from "../../permissions/Permissions.ts"
import type { LocalCaller } from "../tool.ts"

// The approval of a wait's command (docs/plan/inventory/03-mcp.md 2.8; huntaway's mcp/tools/dispatch.ts `wait_tool`):
// the command runs as the agent's own Bash calls would, so it is asked about as one, a `Bash` permission prompt of the
// call, unless the agent's own reviewer has already reviewed the call (and no approval rule asks about or refuses
// Bash). The wait tool decides whether to ask; asking is `Permissions`' (plan task 3.3), which supplies the live layer:
// the user (or the thread's mode, Don't ask refusing at once) answers the prompt (`layerPermissions`); `layerNone` refuses.

/** What the prompt shows: the command, where it runs, and why. */
export interface CommandInput {
  readonly command: string
  readonly cwd: string
  /** `Run while waiting: <reason>`. */
  readonly description: string
}

/** The answer: allowed, or not with the message the user (or the mode) gave. */
export type CommandAnswer = { readonly allowed: true } | { readonly allowed: false; readonly message: string | null }

export interface CommandApprovalShape {
  /** Ask about running `input` for the wait call of `caller`, as a `Bash` permission prompt of the call. */
  readonly ask: (caller: LocalCaller, input: CommandInput) => Effect.Effect<CommandAnswer>
}

export class CommandApproval extends Context.Service<CommandApproval, CommandApprovalShape>()("huntaway-server/mcp/wait/CommandApproval") {
  /** No one to ask until `Permissions` comes: a command that needs asking about isn't run. */
  static readonly layerNone = Layer.succeed(
    CommandApproval,
    CommandApproval.of({ ask: () => Effect.succeed({ allowed: false, message: "this board can't ask the user yet" }) }),
  )

  /**
   * `Permissions` asks (3.3): a `Bash` permission prompt of the wait call, decided as any of the agent's tool calls is
   * (an approval rule, the thread's always-allowed tools, its mode, else the user).
   */
  static readonly layerPermissions = Layer.effect(
    CommandApproval,
    Effect.gen(function* () {
      const permissions = yield* Permissions
      return CommandApproval.of({
        ask: (caller, input) =>
          Effect.map(
            permissions.ask({ run: caller.run, call_id: caller.call_id }, { tool_name: "Bash", input, tool_use_id: null }),
            (decision): CommandAnswer => (decision.behavior === "allow" ? { allowed: true } : { allowed: false, message: decision.message }),
          ),
      })
    }),
  )
}
