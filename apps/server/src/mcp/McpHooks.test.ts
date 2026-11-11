import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { SqlClient } from "effect/sql"
import { CallId, ProfileId } from "@huntaway/contracts"
import { fakeAgent, TestMcp, TestTools } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { ApprovalRules } from "../agents/ApprovalRules.ts"
import { DONT_ASK_DENIAL, Permissions } from "../permissions/Permissions.ts"
import { McpHooks } from "./McpHooks.ts"
import type { ToolResult } from "./tool.ts"
import { ToolCalls } from "./ToolCalls.ts"

// `McpHooks.layerPermissions` (3.3): a board tool an approval rule asks about waits for the user's answer to its prompt,
// is refused with the reason when they deny it, and is denied by Don't ask without asking; a call the agent gave up on
// has its prompt expire (the old dispatch.test.ts's ask cases, with `Permissions` answering).

const call = (agent: FakeAgent, id: string, tool: string, args: unknown) =>
  Effect.gen(function* () {
    return yield* (yield* ToolCalls).call({ call_id: CallId.make(id), run: agent.run.id, server: "huntaway", tool, args })
  })

const err = (result: ToolResult) => (result._tag === "Err" ? result.message : assert.fail("it didn't fail"))

/** The profile's assistant, whose rules ask about `test_touch`. */
const assistant = Effect.gen(function* () {
  const agent = yield* fakeAgent()
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE tasks SET task_type = 'assistant' WHERE id = ${agent.run.task_id}`.pipe(Effect.orDie)
  yield* (yield* ApprovalRules).set(ProfileId.make("p"), { rules: [{ tool: "mcp__huntaway__test_touch", decision: "ask" }] })
  return agent
})

describe("McpHooks.layerPermissions", () => {
  it.effect("an ask rule waits for the user: allowed, the call runs; denied, it is refused with the reason", () =>
    Effect.gen(function* () {
      const agent = yield* assistant
      const permissions = yield* Permissions
      const allowed = yield* Effect.forkChild(call(agent, "c1", "test_touch", { label: "x" }))
      yield* permissions.answer(yield* permissions.asking("c1"), { decision: "allow" }, "user")
      assert.strictEqual((yield* Fiber.join(allowed))._tag, "Ok")
      assert.deepStrictEqual(yield* (yield* TestTools).touched, ["x"])
      const denied = yield* Effect.forkChild(call(agent, "c2", "test_touch", { label: "y" }))
      yield* permissions.answer(yield* permissions.asking("c2"), { decision: "deny", message: "Not now." }, "user")
      assert.strictEqual(err(yield* Fiber.join(denied)), "Not now.")
      assert.deepStrictEqual(yield* (yield* TestTools).touched, ["x"])
      // Logged as the rule asked and the user answered.
      assert.deepStrictEqual(
        (yield* (yield* ApprovalRules).log({ profile_id: ProfileId.make("p") })).map((a) => [a.tool_name, a.outcome]),
        [
          ["mcp__huntaway__test_touch", "denied"],
          ["mcp__huntaway__test_touch", "allowed"],
        ],
      )
    }).pipe(Effect.provide(TestMcp(McpHooks.layerPermissions))),
  )

  it.effect("Don't ask denies what a rule asks; a call the agent gives up on has its prompt expire", () =>
    Effect.gen(function* () {
      const agent = yield* assistant
      const sql = yield* SqlClient.SqlClient
      const permissions = yield* Permissions
      const hooks = yield* McpHooks
      const asked = yield* Effect.forkChild(call(agent, "c1", "test_touch", { label: "x" }))
      const id = yield* permissions.asking("c1")
      yield* hooks.cancelled(agent.run, CallId.make("c1"))
      assert.strictEqual(err(yield* Fiber.join(asked)), "Request expired")
      assert.deepStrictEqual((yield* permissions.pending({})).map((p) => p.id).includes(id), false)
      yield* sql`UPDATE tasks SET permission_mode = 'dontAsk' WHERE id = ${agent.run.task_id}`.pipe(Effect.orDie)
      assert.strictEqual(err(yield* call(agent, "c2", "test_touch", { label: "y" })), DONT_ASK_DENIAL)
      assert.deepStrictEqual(yield* (yield* TestTools).touched, [])
    }).pipe(Effect.provide(TestMcp(McpHooks.layerPermissions))),
  )
})
