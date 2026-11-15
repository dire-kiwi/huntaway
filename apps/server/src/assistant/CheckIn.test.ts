import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import type { Profile, Task, TaskId } from "@huntaway/contracts"
import { fakeAgent } from "@huntaway/testing"
import { Automations } from "../automations/Automations.ts"
import { Routines } from "../automations/Routines.ts"
import { atNow, boardLayer, lastRun, nz, profile, runsOf, sqlRun, tick } from "../automations/tests/board.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { Runs } from "../runs/Runs.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"
import { Assistant } from "./Assistant.ts"
import { Brief } from "./Brief.ts"
import { NAME, PRECHECK } from "./checkInText.ts"

// HE-24: the check-in routine (the `check_ins` experiment) on the whole board, in New Zealand's time zone, its runs on
// their schedule with the test clock: one skipped because the user has just messaged the assistant, one quiet (nothing
// posted), and one that reports to the assistant's thread. A routine thread's agent is a scripted one (`fakeAgent`).

const board = <A, E, R>(effect: Effect.Effect<A, E, R>) => atNow(effect.pipe(Effect.scoped, Effect.provide(boardLayer())))

const on = Effect.flatMap(HostSettings, (s) => s.update({ experiments: ["check_ins"] })).pipe(Effect.orDie)

const assistantOf = (p: Profile) => Effect.flatMap(Assistant, (a) => a.get(p.id)).pipe(Effect.orDie)

/**
 * The routine thread's agent says `text` and ends, as the reactor hears it. It's a scripted agent's run, after the run
 * the routine's message started, whose launch gives up first (a test board has no ia-shim): a later run of a thread
 * reports for itself, so that one's end says nothing.
 */
const answer = (thread: Task, text: string) =>
  Effect.gen(function* () {
    const agent = yield* fakeAgent({ task: thread.id })
    yield* TestClock.adjust("10 seconds")
    yield* (yield* Runs).launched(thread.id)
    yield* (yield* Threads)
      .appendFromAgent(thread.id, [{ type: "item.added", item: { id: `m-${thread.id}`, type: "assistant_message", text } }])
      .pipe(Effect.orDie)
    yield* (yield* RunRepo).update(agent.run.id, { saw_result: true })
    // As the run's end does for the task.
    yield* sqlRun((sql) => sql`UPDATE tasks SET running = 0 WHERE id = ${thread.id}`)
    yield* (yield* Routines).runEnded({ _tag: "RunExited", run: agent.run.id, task: thread.id, exit: { code: 0, signal: null }, errorTail: "" })
  })

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

/** The routines' reports in the assistant's thread. */
const reports = (assistant: TaskId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly data: string }>`SELECT json_extract(data, '$.metadata') AS data FROM thread_items
      WHERE task_id = ${assistant} AND type = 'notice' AND json_extract(data, '$.code') = 'routine_report' ORDER BY pos`.pipe(Effect.orDie)
    return yield* Effect.forEach(rows, (r) => decodeReport(r.data).pipe(Effect.orDie), { concurrency: 1 })
  })

/** The clock at `local` (New Zealand), and the scheduler's tick then, its runs over. */
const at = (local: string) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(nz(local))
    yield* tick(nz(local))
    yield* (yield* Automations).idle
  })

describe("check-ins", () => {
  it.effect("the template is refused while the experiment is off, and makes a weekday routine at each time", () =>
    board(
      Effect.gen(function* () {
        const brief = yield* Brief
        const p = yield* profile("personal")
        const off = yield* Effect.flip(brief.addCheckIn(p.id, null, null, false))
        assert.strictEqual(off._tag, "Invalid")
        yield* on
        const a = yield* brief.addCheckIn(p.id, ["16:30", "9:00", "16:30"], ["fri", "mon"], false)
        assert.deepStrictEqual([a.name, a.enabled, a.project_id, a.precheck], [NAME, true, null, PRECHECK])
        assert.deepStrictEqual(a.trigger, { kind: "daily", time: "09:00, 16:30", weekdays: ["mon", "fri"] })
        // 13:00 on Thursday 1 October: Friday at 9:00 is next.
        assert.strictEqual(a.next_run_at, new Date(nz("2026-10-02 09:00")).toISOString())
        const message = a.action.kind === "message_assistant" ? a.action.message : ""
        for (const part of ["{{last_run}}", "{{quiet_runs}}", "list_tasks", "needs_attention", "in_review", "list_tracked_work", "list_automations", "NO_REPLY"]) {
          assert.include(message, part)
        }
        // No Google unless asked.
        assert.notInclude(message, "{{google}}")
        const withGoogle = yield* brief.addCheckIn(p.id, null, null, true)
        assert.include(withGoogle.action.kind === "message_assistant" ? withGoogle.action.message : "", "{{google}}")
        // By default, 11:00 and 16:30 on weekdays.
        assert.deepStrictEqual(withGoogle.trigger, { kind: "daily", time: "11:00, 16:30", weekdays: ["mon", "tue", "wed", "thu", "fri"] })
        // A bad time is refused, as it is for any routine.
        assert.strictEqual((yield* Effect.flip(brief.addCheckIn(p.id, ["11:00", "25:00"], null, false)))._tag, "Invalid")
      }),
    ),
  )

  it.effect("a check-in waits while the user's talking to the assistant, stays quiet with nothing to say, and reports what needs them", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("personal")
        yield* on
        const a = yield* (yield* Brief).addCheckIn(p.id, null, null, false)
        const assistant = yield* assistantOf(p)

        // The user messages the assistant at 16:15: the 16:30 check-in is skipped, and saying why.
        yield* TestClock.setTime(nz("2026-10-01 16:15"))
        yield* (yield* Threads).userMessage(assistant.id, "What's on tomorrow?", {}).pipe(Effect.orDie)
        // A routine's (or the board's) message to it isn't the user talking.
        yield* TestClock.setTime(nz("2026-10-01 16:25"))
        yield* (yield* Threads).userMessage(assistant.id, "From your routine", { routine: true }).pipe(Effect.orDie)
        yield* at("2026-10-01 16:30")
        let r = yield* lastRun(a)
        assert.deepStrictEqual([r.status, r.task_id], ["skipped", null])
        assert.strictEqual(r.detail, "Skipped: its precheck found nothing to do (exit 1): you messaged the assistant 15 min ago")

        // Friday at 11:00, long after: it runs, in a thread of its own, the first check-in to go ahead.
        yield* at("2026-10-02 11:00")
        r = yield* lastRun(a)
        assert.strictEqual(r.status, "ok", r.detail ?? "")
        const quiet = (yield* (yield* TaskRepo).get(r.task_id ?? "")) ?? assert.fail("no thread")
        const first = (yield* (yield* ThreadReaders).lastUserMessage(quiet.id)) ?? assert.fail("no message")
        assert.include(first.text, "Last check-in: never. Quiet check-ins in a row before this one: 0.")
        // Nothing needs the user: nothing's posted.
        yield* answer(quiet, "Nothing new since the last check-in.\n\nNO_REPLY")
        assert.strictEqual((yield* lastRun(a)).outcome, "quiet")
        assert.deepStrictEqual(yield* reports(assistant.id), [])

        // At 16:30 it's told when the last one ran and that it was quiet; this time something needs them.
        yield* at("2026-10-02 16:30")
        r = yield* lastRun(a)
        assert.strictEqual(r.status, "ok", r.detail ?? "")
        const reported = (yield* (yield* TaskRepo).get(r.task_id ?? "")) ?? assert.fail("no thread")
        const second = (yield* (yield* ThreadReaders).lastUserMessage(reported.id)) ?? assert.fail("no message")
        assert.include(second.text, "Last check-in: 2026-10-02T11:00:00+13:00. Quiet check-ins in a row before this one: 1.")
        yield* answer(reported, "WEB-4 is ready to merge and waiting on you.")
        assert.strictEqual((yield* lastRun(a)).outcome, "reported")
        const posted = yield* reports(assistant.id)
        assert.deepStrictEqual(
          posted.map((x) => [x["automation"], x["outcome"], x["text"]]),
          [[NAME, "reported", "WEB-4 is ready to merge and waiting on you."]],
        )
        assert.deepStrictEqual(
          (yield* runsOf(a)).map((x) => x.status),
          ["skipped", "ok", "ok"],
        )
      }),
    ),
  )
})
