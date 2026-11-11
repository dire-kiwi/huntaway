import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Schema, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { ItemAdded, RequestId, RequestOpened, ThreadSnapshot } from "@huntaway/contracts"
import type { Item, ThreadRequest } from "@huntaway/contracts"
import { ensureShim, FAKE_CLAUDE } from "@huntaway/testing"
import { CliRpcs, httpRpcClientLayer } from "../../src/cli/rpc.ts"
import { socketRpcClientLayer, startServer } from "./launch.ts"

// Permission prompts on a whole server (plan task 3.3): the fake `claude` under the real ia-shim asks for permission on
// its output (`can_use_tool`, for "fake-ask-permission" and "fake-ask-question" in its prompt), the board opens the
// requests in the thread and lists them in `permissions.pending`, and `permissions.answer` lets the agent carry on: its
// reply says what each answer was.

const isSnapshot = Schema.is(ThreadSnapshot)
const isAdded = Schema.is(ItemAdded)
const isOpened = Schema.is(RequestOpened)

const shim = ensureShim()

describe.skipIf(shim === null)("permission prompts on a whole server", () => {
  it.live("the agent asks, the requests open in the thread, and an RPC answer lets it continue", () =>
    Effect.gen(function* () {
      const { port, token } = yield* startServer(["--claude-bin", FAKE_CLAUDE])
      const http = yield* RpcClient.make(CliRpcs).pipe(Effect.provide(httpRpcClientLayer(`http://127.0.0.1:${port}`, token)))
      const profile = yield* http["profiles.create"]({ profile: { name: "me" } })
      const task = yield* http["tasks.create"]({ task: { profile_id: profile.id, title: "Ask" } })

      const reply = yield* Effect.gen(function* () {
        const socket = yield* RpcClient.make(CliRpcs)
        const watch = socket["threads.watch"]({ task_id: task.id, limit: 50 })
        // The first open request of each kind, as the thread shows it.
        const opened = (type: ThreadRequest["type"]) =>
          watch.pipe(
            Stream.flatMap((m) => Stream.fromIterable(isSnapshot(m) ? m.requests : isOpened(m) ? [m.request] : [])),
            Stream.filter((r) => r.type === type && r.resolution === undefined),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          )
        const replied = yield* watch.pipe(
          Stream.flatMap((m) => Stream.fromIterable(isSnapshot(m) ? m.items : isAdded(m) ? [m.item] : [])),
          Stream.filter((item: Item) => item.type === "assistant_message"),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        )
        const permission = yield* opened("permission")
        yield* http["tasks.send"]({ id: task.id, text: "fake-ask-permission then fake-ask-question" })

        const bash = yield* Fiber.join(permission)
        assert.isTrue(bash._tag === "Some" && bash.value.type === "permission" && bash.value.name === "Bash")
        const waiting = yield* http["permissions.pending"]({ task_id: task.id })
        assert.deepStrictEqual(
          waiting.map((p) => p.tool_name),
          ["Bash"],
        )
        const [first] = waiting
        if (first === undefined) return assert.fail("nothing pending")
        const question = yield* opened("question")
        assert.deepStrictEqual(yield* http["permissions.answer"]({ id: first.id, answer: { decision: "allow" } }), { status: "allowed" })
        // A second answer is too late.
        const again = yield* Effect.flip(http["permissions.answer"]({ id: first.id, answer: { decision: "deny" } }))
        assert.strictEqual(again._tag, "Conflict")

        const asked = yield* Fiber.join(question)
        if (asked._tag === "None") return assert.fail("no question")
        yield* http["permissions.answer"]({ id: RequestId.make(asked.value.id), answer: { decision: "allow", answers: [["b"]] } })
        return yield* Fiber.join(replied)
      }).pipe(Effect.scoped, Effect.provide(socketRpcClientLayer(port, token)))

      const text = reply._tag === "Some" && reply.value.type === "assistant_message" ? reply.value.text : ""
      assert.isTrue(text.includes("permission Bash: allow"), text)
      assert.isTrue(text.includes('permission AskUserQuestion: allow {"Which one?":"b"}'), text)
      assert.deepStrictEqual(yield* http["permissions.pending"]({}), [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
})
