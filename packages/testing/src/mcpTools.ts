import { Context, Deferred, Effect, Layer, Ref, Schema } from "effect"
import { Tool } from "effect/ai"
import { mcpLayer } from "huntaway-server/src/Main.ts"
import { McpHooks } from "huntaway-server/src/mcp/McpHooks.ts"
import { McpServers, toolHandler } from "huntaway-server/src/mcp/McpServers.ts"
import { ForPlanning, ForReviewers, Rerunnable, ReviewersOnly } from "huntaway-server/src/mcp/tool.ts"
import { TestBoard } from "./TestBoard.ts"

// Tools of the board's server for the dispatcher's and the transports' tests (docs/plan/07-agents.md, Board tools),
// standing in for the board's own (3.2): they are not in the server. `test_echo` reads (it may run again, and
// reviewers and plan mode may call it), `test_touch` changes something (counted), `test_block` records its key and
// then blocks until the test lets it go, `wait` blocks the same way (it is the name `ToolCalls` treats specially: it
// does not end the run's wait; and it may run again), and `submit_test_review` is offered to reviewers only.

export const TestEcho = Tool.make("test_echo", {
  description: "Say text back, with who called.",
  parameters: Schema.Struct({ text: Schema.String, n: Schema.optional(Schema.Finite) }),
  success: Schema.Struct({ text: Schema.String, task: Schema.String, profile: Schema.String, mode: Schema.String }),
})
  .annotate(Rerunnable, true)
  .annotate(ForReviewers, true)
  .annotate(ForPlanning, true)

export const TestTouch = Tool.make("test_touch", {
  description: "Record a label.",
  parameters: Schema.Struct({ label: Schema.String }),
  success: Schema.Struct({ count: Schema.Finite }),
})

const Keyed = Schema.Struct({ key: Schema.String })

export const TestBlock = Tool.make("test_block", { description: "Record the key, then wait until the test lets it go.", parameters: Keyed, success: Keyed })

export const TestWait = Tool.make("wait", { description: "Wait until the test lets it go.", parameters: Keyed, success: Keyed })
  .annotate(Rerunnable, true)
  .annotate(ForReviewers, true)
  .annotate(ForPlanning, true)

export const TestReview = Tool.make("submit_test_review", { description: "Report.", success: Schema.Struct({ ok: Schema.Boolean }) })
  .annotate(ForReviewers, true)
  .annotate(ReviewersOnly, true)

interface Gate {
  readonly started: Deferred.Deferred<void>
  readonly go: Deferred.Deferred<void>
}

export interface TestToolsShape {
  /** What `test_touch` (its labels) and `test_block` (`block:<key>`) recorded, in order. */
  readonly touched: Effect.Effect<ReadonlyArray<string>>
  /** Done once a `test_block` or `wait` call with this key is waiting. */
  readonly blocked: (key: string) => Effect.Effect<void>
  /** Lets the `test_block` and `wait` calls with this key go. */
  readonly release: (key: string) => Effect.Effect<void>
  /** For the tools: record a label, and how many there are now. */
  readonly record: (label: string) => Effect.Effect<number>
  /** For the tools: say the call with this key is waiting, and wait until it is let go. */
  readonly hold: (key: string) => Effect.Effect<void>
}

/** What the test tools did, and their gates. Outlives a `ToolCalls` (a "restart" builds a new one over the same). */
export class TestTools extends Context.Service<TestTools, TestToolsShape>()("@huntaway/testing/mcpTools/TestTools") {
  static readonly layer = Layer.effect(
    TestTools,
    Effect.gen(function* () {
      const touched = yield* Ref.make<ReadonlyArray<string>>([])
      const gates = yield* Ref.make<ReadonlyMap<string, Gate>>(new Map())
      const gate = (key: string) =>
        Effect.gen(function* () {
          const fresh: Gate = { started: yield* Deferred.make<void>(), go: yield* Deferred.make<void>() }
          return yield* Ref.modify(gates, (all): readonly [Gate, ReadonlyMap<string, Gate>] => {
            const found = all.get(key)
            return found === undefined ? [fresh, new Map([...all, [key, fresh]])] : [found, all]
          })
        })
      return TestTools.of({
        touched: Ref.get(touched),
        blocked: (key) => Effect.flatMap(gate(key), (g) => Deferred.await(g.started)),
        release: (key) => Effect.flatMap(gate(key), (g) => Deferred.succeed(g.go, undefined)),
        record: (label) => Ref.updateAndGet(touched, (all) => [...all, label]).pipe(Effect.map((all) => all.length)),
        hold: (key) => Effect.flatMap(gate(key), (g) => Deferred.succeed(g.started, undefined).pipe(Effect.andThen(Deferred.await(g.go)))),
      })
    }),
  )
}

/** The test tools' handlers, on the board's server of the `McpServers` in the environment. */
export const TestToolsRegistered = McpServers.register(
  "huntaway",
  Effect.gen(function* () {
    const tools = yield* TestTools
    return [
      toolHandler(TestEcho, (params, caller) =>
        params.text === "die"
          ? Effect.die(new Error("the test tool died"))
          : Effect.succeed({ text: params.text, task: caller.task?.id ?? "", profile: caller.profile.name, mode: caller.mode }),
      ),
      toolHandler(TestTouch, (params) => Effect.map(tools.record(params.label), (count) => ({ count }))),
      toolHandler(TestBlock, (params) => tools.record(`block:${params.key}`).pipe(Effect.andThen(tools.hold(params.key)), Effect.as(params))),
      toolHandler(TestWait, (params) => Effect.as(tools.hold(params.key), params)),
      toolHandler(TestReview, () => Effect.succeed({ ok: true })),
    ]
  }),
)

/**
 * The board's MCP area for a test with the test tools: its own `McpServers`, `ToolCalls` and `McpControl` (the ones
 * `TestBoard` has are left alone), with `hooks`. `over` is what it is built over: the whole board's services by default;
 * a test that "restarts" builds it again over the same board (`TestMcpOver`).
 */
export const TestMcpOver = <E = never, R = never>(hooks: Layer.Layer<McpHooks, E, R> = McpHooks.layerNone) =>
  TestToolsRegistered.pipe(Layer.provideMerge(mcpLayer(hooks)))

/** `TestMcpOver` over the test tools' state and a fresh board. */
export const TestMcp = <E = never, R = never>(hooks: Layer.Layer<McpHooks, E, R> = McpHooks.layerNone) =>
  TestMcpOver(hooks).pipe(Layer.provideMerge(TestTools.layer), Layer.provideMerge(TestBoard()))
