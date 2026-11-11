import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { ProfileId, Timestamp } from "@huntaway/contracts"
import type { Status, TaskId, TaskPatch } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { Actor } from "../platform/Changes.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { SideCalls } from "./SideCalls.ts"
import { TitleModel, TitleScript } from "./TitleModel.ts"
import { Titles } from "./Titles.ts"
import { spentFromClaude } from "./tokens/calls.ts"

// The old title.test.ts's cases that call the model, against a scripted model (`TitleModel.layerScripted`) on the whole
// board's services. Dropped: the direct `replace_title` call (the save is internal now; a rename while a title is
// written is the "last word" case's last part) and a `title_pinned: "no"` update (the contract's schema refuses it).
// An unpinned title catching up at once is the reactor's call to `refresh` (not wired yet): here the test makes it.

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")

const TitlesTest = Titles.layer.pipe(Layer.provideMerge(Layer.mergeAll(TitleModel.layerScripted, SideCalls.layer)), Layer.provideMerge(TestBoard()))

const run = <A, E>(effect: Effect.Effect<A, E, Titles | TitleScript | Tasks | Threads | SqlClient.SqlClient>) => effect.pipe(Effect.provide(TitlesTest))

const newTask = (title: string, description: string, status: Status) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const tasks = yield* Tasks
    yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('p', 'p', ${AT})`.pipe(Effect.orDie)
    return (yield* tasks.create({ profile_id: ProfileId.make("p"), title, description, status }, Actor.user).pipe(Effect.orDie)).id
  })

const titleOf = (id: TaskId) =>
  Effect.gen(function* () {
    return (yield* (yield* Tasks).get(id)).title
  })
const says = (id: TaskId, text: string) =>
  Effect.gen(function* () {
    yield* (yield* Threads).userMessage(id, text, {})
  })
const update = (id: TaskId, patch: TaskPatch) =>
  Effect.gen(function* () {
    return yield* (yield* Tasks).update(id, patch, Actor.user)
  })

describe("Titles", () => {
  it.effect("a_codex_sentence_saying_to_keep_the_title_doesnt_retitle_the_task", () =>
    run(
      Effect.gen(function* () {
        const titles = yield* Titles
        const script = yield* TitleScript
        const task = yield* newTask("Say hello", "Say hello", "in_review")
        yield* says(task, "Say it again")
        yield* script.setReply("Keep the task title “Say hello”.")
        yield* titles.refresh(task)
        // Taken for KEEP the first time, so it isn't asked again either.
        assert.deepStrictEqual([yield* titleOf(task), (yield* script.asked).length], ["Say hello", 1])
      }),
    ),
  )

  it.effect("a_message_sent_while_the_first_title_is_written_has_the_last_word", () =>
    run(
      Effect.gen(function* () {
        const titles = yield* Titles
        const script = yield* TitleScript
        // Each way round: the first title is written, then the refresh for a message sent meanwhile ends, or the other
        // way about. The refresh's title wins either way, and its KEEP keeps the first.
        for (const [firstEndsFirst, refreshed, expected] of [
          [true, "Add an export button", "Add an export button"],
          [false, "Add an export button", "Add an export button"],
          [true, "KEEP", "Fix the original issue"],
        ] as const) {
          const task = yield* newTask("Investigate the original issue", "Investigate the original issue", "todo")
          const [generating, refreshing, tookFirst, tookSecond] = [
            yield* Deferred.make<void>(),
            yield* Deferred.make<void>(),
            yield* Deferred.make<void>(),
            yield* Deferred.make<void>(),
          ]
          yield* script.push("Fix the original issue", { gate: generating, took: tookFirst })
          yield* script.push(refreshed, { gate: refreshing, took: tookSecond })
          const generate = yield* Effect.forkChild(titles.generate(task))
          yield* Deferred.await(tookFirst)
          yield* says(task, "Instead, add an export button")
          const refresh = yield* Effect.forkChild(titles.refresh(task))
          yield* Deferred.await(tookSecond)
          const order: ReadonlyArray<readonly [Deferred.Deferred<void>, Fiber.Fiber<void>]> = firstEndsFirst
            ? [
                [generating, generate],
                [refreshing, refresh],
              ]
            : [
                [refreshing, refresh],
                [generating, generate],
              ]
          for (const [gate, fiber] of order) {
            yield* Deferred.succeed(gate, undefined)
            yield* Fiber.join(fiber)
          }
          assert.strictEqual(yield* titleOf(task), expected, `first title ends first: ${firstEndsFirst}, refresh replies ${refreshed}`)
        }
        // A rename by hand still wins over both.
        const task = yield* newTask("Investigate the original issue", "Investigate the original issue", "todo")
        const [refreshing, took] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
        yield* script.push("Add an export button", { gate: refreshing, took })
        yield* says(task, "Instead, add an export button")
        const refresh = yield* Effect.forkChild(titles.refresh(task))
        yield* Deferred.await(took)
        yield* update(task, { title: "Mine" })
        yield* Deferred.succeed(refreshing, undefined)
        yield* Fiber.join(refresh)
        assert.strictEqual(yield* titleOf(task), "Mine")
      }),
    ),
  )

  it.effect("other_agents_queued_messages_dont_retitle_a_task", () =>
    run(
      Effect.gen(function* () {
        const titles = yield* Titles
        const script = yield* TitleScript
        const sql = yield* SqlClient.SqlClient
        const task = yield* newTask("Add search", "", "in_progress")
        const queue = (text: string, source: string) =>
          sql`INSERT INTO task_queue (task_id, text, source, created_at) VALUES (${task}, ${text}, ${source}, ${AT})`.pipe(Effect.orDie)
        yield* queue("Build a payment gateway", "agent")
        yield* script.setReply("Build a payment gateway")
        yield* titles.refresh(task)
        // Nothing of the user's to go on, so it isn't asked.
        assert.deepStrictEqual(yield* script.asked, [])
        yield* queue("and cache the results", "user")
        yield* titles.refresh(task)
        const asked = yield* script.asked
        assert.isTrue(asked.length === 1 && (asked[0] ?? "").includes("and cache the results") && !(asked[0] ?? "").includes("payment"), String(asked))
      }),
    ),
  )

  it.effect("prompts_retitle_a_task_unless_its_title_is_pinned", () =>
    run(
      Effect.gen(function* () {
        const titles = yield* Titles
        const script = yield* TitleScript
        const task = yield* newTask("Fix login", "The login page 500s", "in_review")
        yield* says(task, "Now add a logout button")
        yield* script.setReply('"Add a logout button."')
        yield* titles.refresh(task)
        assert.strictEqual(yield* titleOf(task), "Add a logout button")
        const first = (yield* script.asked)[0] ?? ""
        assert.isTrue(first.includes("<title>Fix login</title>") && first.includes("Now add a logout button"), first)

        // Renamed by hand, it keeps its name.
        let t = yield* update(task, { title: "Logout" })
        assert.isTrue(t.title_pinned)
        yield* script.setReply("Something else")
        yield* titles.refresh(task)
        assert.deepStrictEqual([yield* titleOf(task), (yield* script.asked).length], ["Logout", 1])
        // Saving it unchanged leaves it pinned.
        t = yield* update(task, { title: "Logout", status: "in_progress" })
        assert.isTrue(t.title_pinned)

        // Unpinned, it catches up (the reactor's refresh on an unpin).
        t = yield* update(task, { title_pinned: false })
        assert.isFalse(t.title_pinned)
        yield* titles.refresh(task)
        assert.deepStrictEqual([yield* titleOf(task), (yield* script.asked).length], ["Something else", 2])

        // A reply that it still fits keeps it.
        yield* script.setReply("KEEP")
        yield* titles.refresh(task)
        assert.strictEqual(yield* titleOf(task), "Something else")
        // A reply that's no title is asked again, once.
        const before = (yield* script.asked).length
        yield* script.setReply("The latest message asks for a manual button in project settings, which is a new goal, so the title should change")
        yield* titles.refresh(task)
        assert.deepStrictEqual([yield* titleOf(task), (yield* script.asked).length], ["Something else", before + 2])
        // A failed call leaves the title alone.
        yield* script.setReply(null)
        yield* titles.refresh(task)
        assert.strictEqual(yield* titleOf(task), "Something else")
      }),
    ),
  )

  it.effect("each_title_call_keeps_its_tokens_for_the_task_failed_or_not", () =>
    run(
      Effect.gen(function* () {
        const titles = yield* Titles
        const script = yield* TitleScript
        const sql = yield* SqlClient.SqlClient
        const task = yield* newTask("Fix login", "The login page 500s", "in_review")
        yield* script.setSpent(
          spentFromClaude({
            type: "result",
            modelUsage: { "claude-haiku-5-5": { inputTokens: 2, outputTokens: 7, cacheCreationInputTokens: 600, costUSD: 0.0002 } },
          }),
        )
        yield* says(task, "Now add a logout button")
        yield* script.setReply("Add a logout button")
        yield* titles.refresh(task)
        // A failed one too: the tokens were spent.
        yield* script.setReply(null)
        yield* says(task, "And a sign-up page")
        yield* titles.refresh(task)
        const kept = yield* sql<{
          readonly purpose: string
          readonly task_id: string
          readonly model: string
          readonly output_tokens: number
          readonly cost_usd: number
        }>`SELECT purpose, task_id, model, output_tokens, cost_usd FROM call_usage ORDER BY id`.pipe(Effect.orDie)
        const row = ["title", task, "claude-haiku-5-5", 7, 0.0002]
        assert.deepStrictEqual(
          kept.map((r) => [r.purpose, r.task_id, r.model, r.output_tokens, r.cost_usd]),
          [row, row],
        )
      }),
    ),
  )

  it.effect("a new task's title is written from its description, then its start goes", () =>
    run(
      Effect.gen(function* () {
        const titles = yield* Titles
        const script = yield* TitleScript
        const task = yield* newTask("", "the login page 500s when the password has a quote in it", "todo")
        assert.strictEqual(yield* titleOf(task), "the login page 500s when the password has a quote in it")
        yield* script.setReply("Fix login with quotes in passwords")
        const tasks = yield* Tasks
        const started = yield* Deferred.make<string>()
        const start = tasks.get(task).pipe(
          Effect.flatMap((t) => Deferred.succeed(started, t.title)),
          Effect.orDie,
          Effect.asVoid,
        )
        yield* titles.generateLater(task, start)
        // The start goes once the title is written, which names its branch.
        assert.strictEqual(yield* Deferred.await(started), "Fix login with quotes in passwords")
        assert.deepStrictEqual(yield* script.asked, ["<task>\nthe login page 500s when the password has a quote in it\n</task>"])
      }),
    ),
  )
})
