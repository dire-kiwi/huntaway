import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Option, Result, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { SUGGESTIONS_CODE, TaskId, TaskSuggestions, Timestamp } from "@huntaway/contracts"
import type { Status } from "@huntaway/contracts"
import { fakeAgent, TestMcp } from "@huntaway/testing"
import { Actor } from "../platform/Changes.ts"
import { NOT_THE_ASSISTANT, POSTED } from "../mcp/tools/suggestions.ts"
import { agentOf, agentOn, call, err, ok, profile, project, task } from "../mcp/tools/tests/board.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Threads } from "../threads/Threads.ts"
import { cardText, DEFAULT_REMIND, suggestionRow } from "./suggestionText.ts"
import { Suggestions } from "./Suggestions.ts"

// The assistant's suggestions cards (HE-61): `suggest_task_actions` with the fake agent, and each row settled from the
// card as the user (`Suggestions.act`): the board does what was picked, once.

/** The thread's suggestions cards: each one's item id and what it is. */
const cards = (thread: TaskId) =>
  Effect.gen(function* () {
    const stored = yield* (yield* Threads).stored(thread)
    return stored.entries.flatMap(({ item }) => {
      if (item.type !== "notice" || item.code !== SUGGESTIONS_CODE) return []
      const card = Schema.decodeUnknownOption(TaskSuggestions)(item.metadata)
      return Option.isSome(card) ? [{ id: item.id, text: item.text, card: card.value }] : []
    })
  })

const taskOf = (id: string) => Effect.flatMap(TaskRepo, (r) => r.get(TaskId.make(id))).pipe(Effect.map((t) => t ?? assert.fail("no task")))
const failure = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) => Effect.map(Effect.flip(effect), (e) => e._tag)

describe("suggest_task_actions", () => {
  it.effect("puts a card of tasks in the assistant's thread; each row does what the user picks, once", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const ha = yield* project(p, "huntaway", "HA")
      const merged = yield* task(ha, "Merged on GitHub")
      const stale = yield* task(ha, "Stale idea")
      const later = yield* task(ha, "Come back to")
      const gone = yield* task(ha, "Duplicate")
      const me = yield* agentOf(p)
      const thread = me.run.task_id

      const told = ok(
        yield* call(me, "suggest_task_actions", {
          title: "  Tidy the board  ",
          suggestions: [
            { task: "HA-1", reason: "Its pull request was merged 3 days ago", actions: ["done", "merge"] },
            { task: "HA-2", reason: "No activity for a month", actions: ["backlog", "wont_fix"] },
            { task: "HA-3", reason: "Waits on the release", actions: ["remind"], remind_at: "3d" },
            { task: "HA-4", reason: "Same as HA-1", actions: ["delete", "remind"] },
          ],
        }),
      )
      assert.deepStrictEqual(told, { ok: true, count: 4, note: POSTED })
      const [posted] = yield* cards(thread)
      const card = posted?.card ?? assert.fail("no card")
      assert.strictEqual(card.title, "Tidy the board")
      assert.strictEqual(posted?.text, cardText(card))
      assert.deepStrictEqual(
        card.suggestions.map((s) => [s.task_id, s.key, s.title, s.actions, s.remind_at, s.outcome]),
        [
          [merged.id, "HA-1", "Merged on GitHub", ["done", "merge"], null, null],
          [stale.id, "HA-2", "Stale idea", ["backlog", "wont_fix"], null, null],
          [later.id, "HA-3", "Come back to", ["remind"], "3d", null],
          [gone.id, "HA-4", "Duplicate", ["delete", "remind"], DEFAULT_REMIND, null],
        ],
      )

      const suggestions = yield* Suggestions
      const item = posted?.id ?? ""
      const moves: Array<[string, Status]> = []
      const noted = (id: TaskId, status: Status) => Effect.sync(() => void moves.push([id, status]))

      // Done: the task is done, the row settled, and its move noted first as the user's own.
      yield* suggestions.act(thread, item, 0, "done", Actor.user, noted)
      const done = yield* taskOf(merged.id)
      assert.deepStrictEqual([done.status, done.resolution], ["done", "done"])
      assert.deepStrictEqual(moves, [[merged.id, "done"]])
      // Once: picked again, or something else, it's settled.
      assert.strictEqual(yield* failure(suggestions.act(thread, item, 0, "merge", Actor.user)), "SuggestionClosed")
      // Only what the row offers.
      assert.strictEqual(yield* failure(suggestions.act(thread, item, 1, "done", Actor.user)), "Invalid")
      assert.strictEqual(yield* failure(suggestions.act(thread, item, 9, "keep", Actor.user)), "SuggestionNotFound")
      assert.strictEqual(yield* failure(suggestions.act(thread, "legacy:999999", 0, "keep", Actor.user)), "SuggestionNotFound")

      // Won't fix.
      yield* suggestions.act(thread, item, 1, "wont_fix", Actor.user)
      assert.deepStrictEqual([(yield* taskOf(stale.id)).status, (yield* taskOf(stale.id)).resolution], ["done", "wont_fix"])

      // Remind me: 3 days from the pick, with the reason as the reminder's note.
      const before = yield* DateTime.now
      yield* suggestions.act(thread, item, 2, "remind", Actor.user)
      const reminded = yield* taskOf(later.id)
      assert.strictEqual(reminded.reminder, "Waits on the release")
      assert.strictEqual(reminded.remind_at, DateTime.formatIso(DateTime.add(before, { days: 3 })))

      // Leave it: nothing changes but the row.
      yield* suggestions.act(thread, item, 3, "keep", Actor.user)
      assert.strictEqual((yield* taskOf(gone.id)).status, "todo")

      const [after] = yield* cards(thread)
      assert.deepStrictEqual(
        after?.card.suggestions.map((s) => [s.outcome?.choice, s.outcome?.remind_at]),
        [
          ["done", undefined],
          ["wont_fix", undefined],
          ["remind", reminded.remind_at],
          ["keep", undefined],
        ],
      )
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("merges, moves to the backlog, sends a message and deletes, as the board's buttons do", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const ha = yield* project(p, "huntaway", "HA")
      const a = yield* task(ha, "To merge")
      const b = yield* task(ha, "Later")
      const c = yield* task(ha, "Ask")
      const d = yield* task(ha, "Delete me")
      const me = yield* agentOf(p)
      ok(
        yield* call(me, "suggest_task_actions", {
          suggestions: [
            { task: "HA-1", reason: "Approved", actions: ["merge"] },
            { task: "HA-2", reason: "Not now", actions: ["backlog"] },
            { task: "HA-3", reason: "Needs a rebase", actions: ["message"], message: "Please rebase onto main" },
            { task: "HA-4", reason: "A duplicate", actions: ["delete"] },
          ],
        }),
      )
      const [posted] = yield* cards(me.run.task_id)
      assert.strictEqual(posted?.card.title, "Tasks to tidy up")
      const item = posted?.id ?? ""
      const suggestions = yield* Suggestions
      // Nothing to merge: it goes straight to Done, as moving it to Ready for merge does.
      yield* suggestions.act(me.run.task_id, item, 0, "merge", Actor.user)
      assert.include(["ready_for_merge", "done"], (yield* taskOf(a.id)).status)
      yield* suggestions.act(me.run.task_id, item, 1, "backlog", Actor.user)
      assert.strictEqual((yield* taskOf(b.id)).status, "backlog")
      yield* suggestions.act(me.run.task_id, item, 2, "message", Actor.user)
      // As the user's message: it starts the task's agent.
      const said = (yield* (yield* Threads).stored(c.id)).entries.find((e) => e.item.type === "user_message" && e.item.text === "Please rebase onto main")
      assert.isDefined(said)
      assert.isTrue((yield* taskOf(c.id)).running)
      yield* suggestions.act(me.run.task_id, item, 3, "delete", Actor.user)
      assert.isNull(yield* Effect.flatMap(TaskRepo, (r) => r.get(d.id)))
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("is the assistant's and its routines' (whose cards go in the assistant's thread), and checks what it's given", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const ha = yield* project(p, "huntaway", "HA")
      yield* task(ha, "One")
      const a = yield* agentOf(p)
      const worker = yield* agentOn(yield* task(ha, "Worker"))
      const one = (s: Readonly<Record<string, unknown>>) => ({ suggestions: [{ task: "HA-1", reason: "Why", actions: ["done"], ...s }] })
      assert.strictEqual(err(yield* call(worker, "suggest_task_actions", one({}))), NOT_THE_ASSISTANT)
      assert.include(err(yield* call(a, "suggest_task_actions", one({ actions: ["archive"] }))), "schema")
      assert.include(err(yield* call(a, "suggest_task_actions", one({ actions: ["done", "merge", "backlog", "remind", "delete"] }))), "schema")
      assert.include(err(yield* call(a, "suggest_task_actions", { suggestions: [] })), "schema")
      assert.include(err(yield* call(a, "suggest_task_actions", one({ task: "HA-99" }))), "not on a board on this host")
      assert.include(err(yield* call(a, "suggest_task_actions", one({ reason: " " }))), "needs a reason")
      assert.include(err(yield* call(a, "suggest_task_actions", one({ actions: ["done", "done"] }))), "an action twice")
      assert.include(err(yield* call(a, "suggest_task_actions", one({ actions: ["message"] }))), "give the message")
      assert.include(err(yield* call(a, "suggest_task_actions", one({ actions: ["remind"], remind_at: "soon" }))), "remind_at must be")
      assert.include(
        err(yield* call(a, "suggest_task_actions", { suggestions: [one({}).suggestions[0], { task: "HA-1", reason: "Again", actions: ["backlog"] }] })),
        "suggested twice",
      )
      assert.deepStrictEqual(yield* cards(a.run.task_id), [])

      // A routine's thread: its card goes in the assistant's thread, where the user reads its report.
      const AT = Timestamp.make("2026-11-12T00:00:00.000Z")
      const routine = TaskId.make("routine-1")
      yield* (yield* SqlClient.SqlClient)`INSERT INTO tasks (id, profile_id, parent_id, title, status, task_type, kind, number, last_activity_at, created_at, updated_at)
        VALUES (${routine}, ${p.id}, ${a.run.task_id}, 'Tidy', 'todo', 'routine', 'task', 2, ${AT}, ${AT}, ${AT})`.pipe(Effect.orDie)
      const r = yield* fakeAgent({ task: routine })
      ok(yield* call(r, "suggest_task_actions", one({})))
      assert.strictEqual((yield* cards(a.run.task_id)).length, 1)
      assert.deepStrictEqual(yield* cards(routine), [])
    }).pipe(Effect.provide(TestMcp())),
  )
})

describe("suggestionRow", () => {
  const now = DateTime.makeUnsafe("2026-11-19T00:00:00.000Z")
  const zone = DateTime.zoneMakeOffset(0)
  const row = (s: Partial<Parameters<typeof suggestionRow>[0]>) =>
    suggestionRow({ task_id: "t", key: "HA-1", title: "One", reason: "Why", actions: ["done"], ...s }, now, zone)

  it("keeps what the actions use, trimmed, and nothing they don't", () => {
    const r = row({ reason: "  Why  ", actions: ["remind", "message"], remind_at: " 2w ", message: " Rebase " })
    assert.deepStrictEqual(Result.getOrUndefined(r), {
      task_id: "t",
      key: "HA-1",
      title: "One",
      reason: "Why",
      actions: ["remind", "message"],
      remind_at: "2w",
      message: "Rebase",
      outcome: null,
    })
    const plain = Result.getOrUndefined(row({ remind_at: "2w", message: "Rebase" }))
    assert.deepStrictEqual([plain?.remind_at, plain?.message], [null, null])
    assert.isTrue(Result.isFailure(row({ reason: "x".repeat(501) })))
  })
})
