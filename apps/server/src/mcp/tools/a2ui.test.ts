import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Timestamp } from "@huntaway/contracts"
import { TestMcp } from "@huntaway/testing"
import { Threads } from "../../threads/Threads.ts"
import { agentOf, call, ok, profile } from "./tests/board.ts"

// Interactive replies' tools (HE-77): the rules, and the check of a reply after the thread's earlier blocks.

const AT = "2026-11-22T00:00:00.000Z"

describe("a2ui tools", () => {
  it.effect("give the rules, and check a reply after the thread's earlier blocks", () =>
    Effect.gen(function* () {
      const me = yield* agentOf(yield* profile("personal"))
      const rules = yield* call(me, "a2ui_rules", {})
      assert.isTrue(rules._tag === "Ok" && typeof rules.value === "string" && rules.value.startsWith("# Interactive replies on the Huntaway board"))

      const update = '<a2ui>\nsurface("pick", update=true)\nroot = Text("Done")\n</a2ui>'
      // No surface "pick" in the thread yet: an update of it fails.
      assert.strictEqual(ok(yield* call(me, "a2ui_check", { text: update }))["ok"], false)
      // A subagent's reply that draws it doesn't count: the board draws the main conversation's blocks.
      const sub = 'Sub:\n<a2ui>\nsurface("pick")\nroot = Text("sub")\n</a2ui>'
      yield* (yield* Threads).appendFromAgent(me.run.task_id, [
        { type: "item.added", item: { id: "s1", type: "assistant_message", text: sub, parent_id: "call-1", created_at: Timestamp.make(AT) } },
      ])
      assert.strictEqual(ok(yield* call(me, "a2ui_check", { text: update }))["ok"], false)
      const first = 'Pick one:\n<a2ui>\nsurface("pick")\nroot = Button(Text("A"), action=Event("a"))\n</a2ui>'
      yield* (yield* Threads).appendFromAgent(me.run.task_id, [
        { type: "item.added", item: { id: "m1", type: "assistant_message", text: first, created_at: Timestamp.make(AT) } },
      ])
      assert.deepStrictEqual(ok(yield* call(me, "a2ui_check", { text: update })), { ok: true, blocks: 1, surfaces: ["pick"] })
      const bad = ok(yield* call(me, "a2ui_check", { text: "<a2ui>\nroot = Nope()\n</a2ui>" }))
      assert.strictEqual(bad["ok"], false)
      assert.include(String(bad["error"]), "Nope")
    }).pipe(Effect.provide(TestMcp())),
  )
})
