import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Fiber, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { RunId, TaskId, Timestamp } from "@huntaway/contracts"
import type { NewAutomation, Profile, Task } from "@huntaway/contracts"
import { fakeAgent, tempDir } from "@huntaway/testing"
import { TestClock } from "effect/testing"
import { Actor } from "../platform/Changes.ts"
import { DataDir } from "../platform/DataDir.ts"
import type { ServerConfigShape } from "../platform/ServerConfig.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"
import { AutomationRepo } from "./AutomationRepo.ts"
import { Automations } from "./Automations.ts"
import { KEEP_THREAD_DAYS, Routines } from "./Routines.ts"
import { sortedJson } from "./delivery.ts"
import { Scheduler } from "./Scheduler.ts"
import { dayStart, formatLocal, isoOf, parseTime } from "./schedule.ts"
import { KEEP_RUNS } from "./model.ts"
import {
  atNow,
  boardLayer,
  create,
  DAY,
  deliver,
  get,
  HOUR,
  insertRun,
  lastRun,
  MINUTE,
  newRun,
  NOW,
  NZ,
  profile,
  project,
  ran,
  run,
  runsOf,
  setNext,
  sqlRun,
  statuses,
  tick,
} from "./tests/board.ts"

/** The whole board's services in New Zealand's time zone, at `NOW`. */
const board = <A, E, R>(effect: Effect.Effect<A, E, R>, config: Partial<ServerConfigShape> = {}) =>
  atNow(effect.pipe(Effect.scoped, Effect.provide(boardLayer(config))))

// Routines, a profile's automations that wake its assistant, and what's new for every automation (at triggers, active
// hours, prechecks and budgets): the old automations/tests/routines.test.ts on the whole board's services. The
// assistant is a thread row (`RoutineHost`'s default until 6.7 registers the assistant area). A message to a thread
// whose agent works (a scripted one, `fakeAgent`) is steered into its run; one to an idle thread starts a run whose
// launch then fails, as a test board has no ia-shim.
//
// Dropped, with why:
// - the cron and active-hours arithmetic (`cron_expressions_follow…`, `active_hours_hold_back…`,
//   `a_day_field_that_starts_with_a_star…`): schedule.test.ts;
// - `a_database_at_version_90_keeps_its_automations_and_runs`: the old database's migrations; the importer is 9.1's;
// - `deleting_the_assistant_stops_its_routine_threads_first` and `no_routine_thread_is_made_under_an_assistant_being_deleted`:
//   the assistant is never deleted on this server (`Tasks.delete` refuses it); it goes with its profile (6.7);
// - `a_routine_thread_has_its_assistants_workspace_and_memory`: the assistant's memory is 6.7's;
// - `a_routines_messages_start_routine_runs_whose_prompts_expire`'s approval rules: `ApprovalRules`' (3.6); what's
//   kept is that the thread's first message is a routine's (`routine` on it), which their expiry reads.

const routine = (p: Profile, input: NewAutomation) => Effect.flatMap(Automations, (a) => a.create({ _tag: "Profile", id: p.id }, input))
const runNow = (id: string) => Effect.flatMap(Automations, (a) => a.runNow(id, {}))
const reason = <A, E extends { readonly _tag: string }, R>(self: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.flip(self), (e) =>
    "detail" in e && typeof e.detail === "string" ? e.detail : "reason" in e && typeof e.reason === "string" ? e.reason : e._tag,
  )

const AT = Timestamp.make("2026-10-01T00:00:00.000Z")

/** The profile's assistant (`A-1`), working in its workspace. */
const assistantOf = (p: Profile) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const fs = yield* FileSystem.FileSystem
    const id = TaskId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4())
    // 6.7: its own workspace in the data folder (`Memory.checked` refuses any other), as an absolute path, as the importer writes it.
    const dir = `${(yield* DataDir).root}/assistants/${id}`
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie)
    yield* sql`INSERT INTO tasks (id, profile_id, title, status, task_type, number, work_dir, model, permission_mode, last_activity_at, created_at, updated_at)
      VALUES (${id}, ${p.id}, 'Assistant', 'todo', 'assistant', 1, ${dir}, 'opus', 'acceptEdits', ${AT}, ${AT}, ${AT})`.pipe(Effect.orDie)
    return (yield* (yield* TaskRepo).get(id)) ?? assert.fail("no assistant")
  })

/** A routine thread under `assistant`, as a fresh run makes one. */
const threadUnder = (assistant: Task, title: string) =>
  Effect.gen(function* () {
    const id = TaskId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4())
    yield* (yield* TaskRepo).insert(
      id,
      {
        family: "assistant",
        profile_id: assistant.profile_id,
        project_id: null,
        generateTitle: false,
        columns: { title, status: "in_progress", task_type: "routine", parent_id: assistant.id, work_dir: assistant.work_dir },
      },
      AT,
    )
    return (yield* (yield* TaskRepo).get(id)) ?? assert.fail("no thread")
  })

/** The agent's reply in a thread. */
const said = (task: TaskId, text: string) =>
  Effect.gen(function* () {
    const threads = yield* Threads
    yield* threads.userMessage(task, "go", {}).pipe(Effect.orDie)
    yield* threads.appendFromAgent(task, [{ type: "item.added", item: { id: `m-${text.length}-${task}`, type: "assistant_message", text } }]).pipe(Effect.orDie)
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

/** What was steered into `task`'s live run, as its rows have it. */
const steered = (task: TaskId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{
      readonly text: string
      readonly automation_run_id: string | null
    }>`SELECT text, automation_run_id FROM task_steers WHERE task_id = ${task} ORDER BY seq`.pipe(Effect.orDie)
  })

const routineThreads = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks WHERE task_type = 'routine'`.pipe(Effect.orDie),
).pipe(Effect.map((rows) => rows[0]?.n ?? 0))

describe("routines", () => {
  it.effect("an at runs once however late, then turns itself off", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("personal")
        const assistant = yield* assistantOf(p)
        yield* fakeAgent({ task: assistant.id })
        // In the past, it can't be set.
        const action = { kind: "message_assistant" as const, mode: "thread" as const, message: "Remind them to call Sam." }
        assert.include(yield* reason(routine(p, { name: "Late", trigger: { kind: "at", at: "2020-01-01 09:00" }, action })), "passed")
        let a = yield* routine(p, { name: "Remind me", trigger: { kind: "at", at: formatLocal(NZ, NOW + 2 * HOUR) }, action })
        // Stored in UTC, and due then.
        const due = parseTime(a.next_run_at) ?? assert.fail("no next run")
        assert.strictEqual(due, NOW + 2 * HOUR)
        assert.isTrue(a.trigger.kind === "at" && parseTime(a.trigger.at) === due)
        // Hours late (the server was down), it still runs, once.
        yield* tick(due + 3 * HOUR)
        yield* tick(due + 4 * HOUR)
        a = yield* get(a)
        assert.deepStrictEqual([a.enabled, a.next_run_at], [false, null])
        const r = yield* runsOf(a)
        assert.deepStrictEqual(
          r.map((x) => [x.status, x.task_id]),
          [["ok", assistant.id]],
        )
        const [message] = yield* steered(assistant.id)
        assert.isTrue(message?.text.startsWith('From your routine "Remind me", on its schedule:\n\nRemind them to call Sam.'), message?.text)
        assert.strictEqual(message?.automation_run_id, r[0]?.id)
        // Turned on again with its time gone, it says so.
        yield* sqlRun((sql) => sql`UPDATE automations SET trigger = ${`{"at":"${isoOf(NOW - MINUTE)}","kind":"at"}`} WHERE id = ${a.id}`)
        assert.include(yield* reason(Effect.flatMap(Automations, (x) => x.update(a.id, { enabled: true }))), "passed")
      }),
    ),
  )

  it.effect("a routine belongs to a profile and only messages its assistant", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("work")
        const web = yield* project(p, "web", "WEB")
        const msg = { kind: "message_assistant" as const, message: "Check the mail" }
        const every = { kind: "interval" as const, every_minutes: 60 }
        // A routine can't make tasks, nor a project's automation wake the assistant.
        assert.include(yield* reason(routine(p, { name: "x", trigger: every, action: { kind: "create_task", title: "x" } })), "only message the assistant")
        assert.include(yield* reason(create(web, { name: "x", trigger: every, action: msg })), "profile's routines")
        const a = yield* routine(p, { name: "x", trigger: every, action: msg })
        assert.deepStrictEqual([a.project_id, a.profile_id], [null, p.id])
        assert.deepStrictEqual(a.action, { kind: "message_assistant", message: "Check the mail", mode: "fresh" })
        // Listed with the profile's routines, not the project's automations.
        const automations = yield* Automations
        const listed = yield* automations.list({ _tag: "Profile", id: p.id })
        assert.deepStrictEqual(
          listed.automations.map((x) => [x.id, x.profile_id, x.cost_today_usd]),
          [[a.id, p.id, 0]],
        )
        assert.deepStrictEqual((yield* automations.list({ _tag: "Project", id: web.id })).automations, [])
        // Changing its action keeps to the same rule.
        yield* reason(automations.update(a.id, { action: { kind: "create_task", title: "x" } }))
        // It goes with its profile.
        yield* sqlRun((sql) => sql`DELETE FROM profiles WHERE id = ${p.id}`)
        assert.isNull(yield* (yield* AutomationRepo).get(a.id))
      }),
    ),
  )

  it.effect("a fresh run works in a thread of its own under the assistant", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("personal")
        const assistant = yield* assistantOf(p)
        const a = yield* routine(p, {
          name: "Inbox",
          trigger: { kind: "cron", expr: "0 8 * * *" },
          action: { kind: "message_assistant", message: "Anything new in the inbox?" },
        })
        const r = yield* runNow(a.id)
        assert.strictEqual(r.status, "ok", r.detail ?? "")
        const thread = (yield* (yield* TaskRepo).get(r.task_id ?? "")) ?? assert.fail("no thread")
        assert.deepStrictEqual([thread.task_type, thread.parent_id, thread.project_id], ["routine", assistant.id, null])
        // Keyed after the assistant, A-2, in its workspace, with its model and permission mode.
        assert.deepStrictEqual([thread.number, r.task?.key], [2, "A-2"])
        assert.deepStrictEqual([thread.work_dir, thread.model, thread.permission_mode], [assistant.work_dir, "opus", "acceptEdits"])
        assert.isTrue(thread.title.startsWith("Inbox · "), thread.title)
        // Its prompt is the routine's, with how to stay quiet, and a routine's (nobody's there to answer its prompts).
        const first = (yield* (yield* ThreadReaders).lastUserMessage(thread.id)) ?? assert.fail("no message")
        assert.isTrue(first.text.startsWith('This is a run of your routine "Inbox", by hand, from the board'), first.text)
        assert.include(first.text, "Anything new in the inbox?")
        assert.include(first.text, "NO_REPLY")
        assert.isTrue(first.routine)
        // Off the board: not among the profile's tasks.
        const listed = yield* (yield* Tasks).list({ _tag: "ByProfile", profile_id: p.id, include_assistant: true })
        assert.isFalse(listed.some((t) => t.id === thread.id))
      }),
    ),
  )

  it.effect("a fresh run that can't start leaves no thread", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("personal")
        yield* assistantOf(p)
        const a = yield* routine(p, { name: "Inbox", trigger: { kind: "interval", every_minutes: 60 }, action: { kind: "message_assistant", message: "x" } })
        // This host runs no agents.
        const r = yield* runNow(a.id)
        assert.deepStrictEqual([r.status, r.task_id], ["failed", null])
        assert.include(r.detail, "doesn't run agents")
        assert.strictEqual(yield* routineThreads, 0)
      }),
      { noAgents: true },
    ),
  )

  it.effect("a quiet run posts nothing, and a report reaches the assistant once", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("personal")
        const assistant = yield* assistantOf(p)
        const routines = yield* Routines
        const a = yield* routine(p, { name: "Inbox", trigger: { kind: "interval", every_minutes: 60 }, action: { kind: "message_assistant", message: "x" } })
        let n = 0
        const thread = (title: string) =>
          Effect.gen(function* () {
            const t = yield* threadUnder(assistant, title)
            const id = `r${n++}`
            yield* insertRun({ ...newRun(a, "schedule", "ok", NOW, id), task_id: t.id })
            yield* sqlRun((sql) => sql`UPDATE tasks SET cost_usd = 0.25 WHERE id = ${t.id}`)
            return { t: (yield* (yield* TaskRepo).get(t.id)) ?? assert.fail("gone"), id }
          })
        for (const quiet of ["NO_REPLY", "  `NO_REPLY`\n", "Checked: nothing new.\n\n**NO_REPLY**", ""]) {
          const { t, id } = yield* thread("q")
          if (quiet !== "") yield* said(t.id, quiet)
          yield* routines.finished(t, { _tag: "Ok" }, null)
          assert.deepStrictEqual(yield* reports(assistant.id), [], sortedJson(quiet))
          const r = yield* run(id)
          assert.deepStrictEqual([r.outcome, r.cost_usd], ["quiet", 0.25], sortedJson(quiet))
        }
        const reported = yield* thread("r")
        yield* said(reported.t.id, "Two new mails from the bank; one needs a reply by Friday.")
        yield* routines.finished(reported.t, { _tag: "Ok" }, null)
        const [posted] = yield* reports(assistant.id)
        assert.deepStrictEqual(
          [posted?.["text"], posted?.["automation"], posted?.["key"], posted?.["outcome"]],
          ["Two new mails from the bank; one needs a reply by Friday.", "Inbox", reported.t.key, "reported"],
        )
        assert.strictEqual((yield* run(reported.id)).outcome, "reported")
        // A failure is posted too, so the user knows.
        const failed = yield* thread("f")
        yield* routines.finished(failed.t, { _tag: "Failed", reason: "Out of usage\nmore" }, null)
        const second = (yield* reports(assistant.id))[1]
        assert.deepStrictEqual([second?.["outcome"], second?.["text"]], ["failed", "Out of usage"])
        // The assistant reads them with its next prompt, once.
        const unread = (yield* routines.unreadReports(assistant.id)) ?? assert.fail("none unread")
        assert.include(unread.text, '"Inbox" reported')
        assert.include(unread.text, "Two new mails from the bank")
        assert.include(unread.text, '"Inbox" failed')
        // A launch that fails before the agent starts reads them again next time.
        assert.lengthOf((yield* routines.unreadReports(assistant.id))?.reports ?? [], 2)
        yield* routines.markRead(assistant.id, unread.reports)
        assert.isNull(yield* routines.unreadReports(assistant.id))
      }),
    ),
  )

  it.effect("a routine thread's run ending reports, and records how it went", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("personal")
        const assistant = yield* assistantOf(p)
        const a = yield* routine(p, { name: "Inbox", trigger: { kind: "interval", every_minutes: 60 }, action: { kind: "message_assistant", message: "x" } })
        const t = yield* threadUnder(assistant, "Inbox")
        yield* insertRun({ ...newRun(a, "schedule", "ok", NOW, "r1"), task_id: t.id })
        const agent = yield* fakeAgent({ task: t.id })
        yield* said(t.id, "The deploy failed overnight.")
        yield* (yield* RunRepo).update(agent.run.id, { saw_result: true })
        // As the reactor does with the run's end.
        yield* (yield* Routines).runEnded({ _tag: "RunExited", run: agent.run.id, task: t.id, exit: { code: 0, signal: null }, errorTail: "" })
        assert.strictEqual((yield* reports(assistant.id))[0]?.["text"], "The deploy failed overnight.")
        assert.strictEqual((yield* run("r1")).outcome, "reported")
      }),
    ),
  )

  it.effect("a precheck skips a run or fills in what it found", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("work")
        const web = yield* project(p, "web", "WEB")
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(web.repo_path, { recursive: true }).pipe(Effect.orDie)
        yield* fs.writeFileString(`${web.repo_path}/feed.txt`, "New: <b>release 2.0</b>").pipe(Effect.orDie)
        const t = yield* (yield* Tasks).create({ project_id: web.id, title: "Watch" }, Actor.user).pipe(Effect.orDie)
        yield* fakeAgent({ task: t.id })
        const a = yield* create(web, {
          name: "Feed",
          trigger: { kind: "interval", every_minutes: 60 },
          precheck: "test -s feed.txt || exit 1; cat feed.txt",
          action: { kind: "send_to_task", task_id: t.id, message: "Look: {{precheck}}" },
        })
        assert.strictEqual(a.precheck, "test -s feed.txt || exit 1; cat feed.txt")
        yield* setNext(a, NOW - 1000)
        yield* tick(NOW)
        assert.strictEqual((yield* lastRun(a)).status, "ok", (yield* lastRun(a)).detail ?? "")
        const [q] = yield* steered(t.id)
        // It ran in the project's folder, and what it printed is data from outside.
        assert.include(q?.text, "Look: <untrusted-data>New: &lt;b&gt;release 2.0&lt;/b&gt;</untrusted-data>")
        assert.include(q?.text, '**Note:** parts of this come from what the precheck command of the automation "Feed" printed')
        // Exit 1: nothing new, so the run is skipped, and says what it printed.
        yield* fs.writeFileString(`${web.repo_path}/feed.txt`, "").pipe(Effect.orDie)
        let r = yield* runNow(a.id)
        assert.strictEqual(r.status, "skipped")
        assert.isTrue(r.detail?.startsWith("Skipped: its precheck found nothing to do (exit 1)"), r.detail ?? "")
        // Any other exit fails the run.
        const automations = yield* Automations
        yield* automations.update(a.id, { precheck: "echo broken >&2; exit 3" })
        r = yield* runNow(a.id)
        assert.strictEqual(r.status, "failed")
        assert.include(r.detail, "broken")
        // Blank clears it.
        assert.isNull((yield* automations.update(a.id, { precheck: "  " })).precheck)
      }),
    ),
  )

  it.effect("a routine's precheck runs in the assistant's workspace, and not through one that's become a symlink", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("personal")
        const assistant = yield* assistantOf(p)
        yield* fakeAgent({ task: assistant.id })
        const fs = yield* FileSystem.FileSystem
        const where = yield* routine(p, {
          name: "Where",
          trigger: { kind: "interval", every_minutes: 60 },
          precheck: "pwd",
          action: { kind: "message_assistant", mode: "thread", message: "{{precheck}}" },
        })
        yield* runNow(where.id)
        const ws = yield* fs.realPath(assistant.work_dir ?? "").pipe(Effect.orDie)
        assert.include((yield* steered(assistant.id))[0]?.text, `<untrusted-data>${ws}</untrusted-data>`)
        // HA-122 review: a precheck ran wherever the assistant's workspace pointed, through a symlink.
        const elsewhere = `${yield* tempDir}/elsewhere`
        yield* fs.makeDirectory(elsewhere).pipe(Effect.orDie)
        yield* fs.remove(assistant.work_dir ?? "", { recursive: true }).pipe(Effect.orDie)
        yield* fs.symlink(elsewhere, assistant.work_dir ?? "").pipe(Effect.orDie)
        const probe = yield* routine(p, {
          name: "Probe",
          trigger: { kind: "interval", every_minutes: 60 },
          precheck: "printf proof > precheck-marker; exit 1",
          action: { kind: "message_assistant", message: "x" },
        })
        const r = yield* runNow(probe.id)
        assert.strictEqual(r.status, "failed")
        assert.include(r.detail, "the assistant's workspace")
        assert.isFalse(yield* fs.exists(`${elsewhere}/precheck-marker`).pipe(Effect.orDie))
      }),
    ),
  )

  // HA-241: a routine kept waking the assistant left on this host after its profile's assistant moved to another.
  it.effect("a routine doesn't wake an assistant that has moved to another host", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("personal")
        const assistant = yield* assistantOf(p)
        const marker = `${yield* tempDir}/prechecked`
        const fresh = yield* routine(p, {
          name: "Inbox",
          trigger: { kind: "interval", every_minutes: 60 },
          precheck: `touch ${marker}`,
          action: { kind: "message_assistant", message: "x" },
        })
        const thread = yield* routine(p, {
          name: "Nudge",
          trigger: { kind: "interval", every_minutes: 60 },
          action: { kind: "message_assistant", mode: "thread", message: "y" },
        })
        yield* sqlRun((sql) => sql`UPDATE profiles SET assistant_host = 'laptop-id' WHERE id = ${p.id}`)
        // By hand, or on their schedule: failed, saying why, before their precheck runs or a thread's made or messaged.
        for (const a of [fresh, thread]) {
          const r = yield* runNow(a.id)
          assert.strictEqual(r.status, "failed")
          assert.isTrue(r.detail?.startsWith("personal's assistant runs on laptop-id, so routines on "), r.detail ?? "")
          assert.isNull(r.task_id)
        }
        yield* setNext(fresh, NOW - MINUTE)
        yield* tick(NOW)
        assert.deepStrictEqual(yield* statuses(fresh), ["failed", "failed"])
        assert.isFalse(yield* (yield* FileSystem.FileSystem).exists(marker).pipe(Effect.orDie))
        assert.strictEqual(yield* routineThreads, 0)
        assert.lengthOf(yield* steered(assistant.id), 0)
        // Nor is one made here.
        assert.include(
          yield* reason(routine(p, { name: "New", trigger: { kind: "cron", expr: "0 8 * * *" }, action: { kind: "message_assistant", message: "z" } })),
          "personal's assistant runs on laptop-id",
        )
        // Back on this host, they run again.
        yield* sqlRun((sql) => sql`UPDATE profiles SET assistant_host = NULL WHERE id = ${p.id}`)
        yield* fakeAgent({ task: assistant.id })
        assert.strictEqual((yield* runNow(thread.id)).status, "ok")
        assert.include((yield* steered(assistant.id))[0]?.text, "y")
      }),
    ),
  )

  it.effect("a routine over its budget today is skipped, ended runs and working ones counted", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("personal")
        const assistant = yield* assistantOf(p)
        yield* fakeAgent({ task: assistant.id })
        const a = yield* routine(p, {
          name: "Pricey",
          trigger: { kind: "interval", every_minutes: 60 },
          budget_usd: 1.0,
          action: { kind: "message_assistant", mode: "thread", message: "x" },
        })
        assert.strictEqual(a.budget_usd, 1.0)
        const routines = yield* Routines
        // Yesterday's runs don't count; today's do, ended or still working.
        yield* insertRun({ ...newRun(a, "schedule", "ok", dayStart(NZ, NOW) - MINUTE, "old"), cost_usd: 5.0 })
        yield* insertRun({ ...newRun(a, "schedule", "ok", NOW, "ended"), cost_usd: 0.6 })
        assert.closeTo(yield* routines.spentToday(a.id, NOW), 0.6, 1e-9)
        yield* setNext(a, NOW - 1000)
        yield* tick(NOW)
        assert.strictEqual((yield* lastRun(a)).status, "ok")

        const working = yield* threadUnder(assistant, "w")
        yield* sqlRun((sql) => sql`UPDATE tasks SET cost_usd = 0.5 WHERE id = ${working.id}`)
        yield* insertRun({ ...newRun(a, "schedule", "ok", NOW + 1, "working"), task_id: working.id })
        yield* setNext(a, NOW + 1000)
        yield* tick(NOW + 2000)
        const r = yield* lastRun(a)
        assert.strictEqual(r.status, "skipped")
        assert.isTrue(r.detail?.startsWith("Skipped: over budget (its runs today cost $1.10, and its budget is $1.00 a day)"), r.detail ?? "")
        // Run now isn't held to it.
        assert.strictEqual((yield* runNow(a.id)).status, "ok")
      }),
    ),
  )

  it.effect("deliveries outside active hours are skipped, and a thread still running holds the next run", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("personal")
        const assistant = yield* assistantOf(p)
        // 13:00 in New Zealand: hours from 16:00 to 18:00 aren't now.
        const a = yield* routine(p, {
          name: "Hook",
          trigger: { kind: "webhook" },
          active_hours: { start: "16:00", end: "18:00" },
          action: { kind: "message_assistant", message: "{{body.x}}" },
        })
        let r = yield* ran(yield* deliver(a, {}, `{"x": 1}`))
        assert.strictEqual(r.status, "skipped")
        assert.isTrue(r.detail?.startsWith("Skipped: outside its active hours"), r.detail ?? "")
        // In them, a fresh run makes a thread; while it's still working, the next is skipped.
        yield* (yield* Automations).update(a.id, { active_hours: null })
        const t = yield* threadUnder(assistant, "w")
        yield* sqlRun((sql) => sql`UPDATE tasks SET running = 1 WHERE id = ${t.id}`)
        yield* insertRun({ ...newRun(a, "webhook", "ok", NOW, "w"), task_id: t.id })
        r = yield* ran(yield* deliver(a, {}, `{"x": 2}`))
        assert.deepStrictEqual([r.status, r.detail], ["skipped", `Skipped: its last run (A-${t.number}) is still going`])
        // Or waiting for its usage limit to reset.
        yield* sqlRun((sql) => sql`UPDATE tasks SET running = 0, waiting = 1 WHERE id = ${t.id}`)
        r = yield* ran(yield* deliver(a, {}, `{"x": 3}`))
        assert.strictEqual(r.status, "skipped")
      }),
    ),
  )

  it.effect("old routine threads are pruned whatever their status, and the workspace stays", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("personal")
        const assistant = yield* assistantOf(p)
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${assistant.work_dir ?? ""}/MEMORY.md`, "remember").pipe(Effect.orDie)
        const thread = (status: string, reason_: string | null) =>
          Effect.gen(function* () {
            const t = yield* threadUnder(assistant, status)
            yield* sqlRun((sql) => sql`UPDATE tasks SET status = ${status}, attention_reason = ${reason_} WHERE id = ${t.id}`)
            return t
          })
        const done = yield* thread("done", null)
        // A run that failed (out of usage, say), one stopped, and one that asked: all left in Needs attention.
        const failed = yield* thread("needs_attention", "Run failed: boom")
        const stopped = yield* thread("needs_attention", "Stopped by user")
        const asked = yield* thread("needs_attention", "Which inbox?")
        const recent = yield* thread("needs_attention", "Run failed: boom")
        const working = yield* thread("in_progress", null)
        const waiting = yield* thread("in_progress", null)
        const longAgo = isoOf(NOW - (KEEP_THREAD_DAYS + 1) * DAY)
        for (const t of [done, failed, stopped, asked, working, waiting])
          yield* sqlRun((sql) => sql`UPDATE tasks SET last_activity_at = ${longAgo} WHERE id = ${t.id}`)
        yield* sqlRun((sql) => sql`UPDATE tasks SET last_activity_at = ${isoOf(NOW)} WHERE id = ${recent.id}`)
        yield* sqlRun((sql) => sql`UPDATE tasks SET running = 1 WHERE id = ${working.id}`)
        yield* sqlRun((sql) => sql`UPDATE tasks SET waiting = 1 WHERE id = ${waiting.id}`)
        yield* (yield* Routines).pruneThreads(NOW)
        const repo = yield* TaskRepo
        const left = (t: Task) => Effect.map(repo.get(t.id), (x) => x !== null)
        for (const t of [done, failed, stopped, asked]) assert.isFalse(yield* left(t), t.title)
        // Recent ones stay, as do ones still going or waiting.
        for (const t of [recent, working, waiting, assistant]) assert.isTrue(yield* left(t), t.title)
        assert.strictEqual(yield* fs.readFileString(`${assistant.work_dir ?? ""}/MEMORY.md`).pipe(Effect.orDie), "remember")
      }),
    ),
  )

  it.effect("an assistant run that took several routines' messages splits its cost between them", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("personal")
        const assistant = yield* assistantOf(p)
        const a = yield* routine(p, {
          name: "Ping",
          trigger: { kind: "interval", every_minutes: 60 },
          action: { kind: "message_assistant", mode: "thread", message: "p" },
        })
        const runs = yield* RunRepo
        const agentRun = yield* runs.insert({ id: RunId.make("agent-run"), task_id: assistant.id, kind: "prompt", created_at: AT })
        for (const id of ["one", "two"]) yield* insertRun(newRun(a, "schedule", "ok", NOW, id))
        yield* runs.chargeAutomationRuns(agentRun.id, ["one", "two"])
        yield* sqlRun((sql) => sql`UPDATE runs SET cost_usd = 3 WHERE id = ${agentRun.id}`)
        // While it works, and once it's ended.
        assert.closeTo(yield* (yield* AutomationRepo).spent(a.id, null), 3.0, 1e-9)
        assert.strictEqual((yield* (yield* Automations).runs(a.id)).runs[0]?.cost_usd, 1.5)
        yield* (yield* Routines).runEnded({ _tag: "RunExited", run: agentRun.id, task: assistant.id, exit: { code: 0, signal: null }, errorTail: "" })
        for (const id of ["one", "two"]) assert.strictEqual((yield* run(id)).cost_usd, 1.5)
      }),
    ),
  )

  // HA-122 review: pruning kept only the latest 1000 runs, so a busy routine's skipped deliveries pushed out today's paid
  // runs, and its budget was forgotten.
  it.effect("pruning keeps the runs that count toward today's budget", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("personal")
        const assistant = yield* assistantOf(p)
        yield* fakeAgent({ task: assistant.id })
        const a = yield* routine(p, {
          name: "Busy",
          trigger: { kind: "interval", every_minutes: 60 },
          budget_usd: 1.0,
          action: { kind: "message_assistant", mode: "thread", message: "x" },
        })
        // A paid run, then one whose agent is still at work (no cost recorded yet, but its thread's counts).
        yield* insertRun({ ...newRun(a, "schedule", "ok", NOW - 30 * MINUTE, "paid"), cost_usd: 2.0, task_id: assistant.id })
        const working = yield* threadUnder(assistant, "w")
        yield* insertRun({ ...newRun(a, "schedule", "ok", NOW - 29 * MINUTE, "going"), task_id: working.id })
        // Then more than KEEP_RUNS deliveries skipped, today.
        for (let i = 0; i < KEEP_RUNS + 5; i++) yield* insertRun(newRun(a, "webhook", "skipped", NOW - 28 * MINUTE + i, `s${i}`))
        const scheduler = yield* Scheduler
        yield* scheduler.prune(NOW)
        yield* run("paid")
        yield* run("going")
        assert.isAtMost((yield* runsOf(a)).length, KEEP_RUNS + 2)
        assert.closeTo(yield* (yield* Routines).spentToday(a.id, NOW), 2.0, 1e-9)
        yield* setNext(a, NOW - 1000)
        yield* tick(NOW)
        assert.isTrue((yield* lastRun(a)).detail?.startsWith("Skipped: over budget"))
        // Two days on, they go as any other would.
        yield* scheduler.prune(NOW + 3 * DAY)
        assert.isNull(yield* (yield* AutomationRepo).getRun("paid"))
      }),
    ),
  )

  // HA-341: two runs of a fresh-thread routine at once both found no thread of its running while their prechecks ran.
  it.effect("a routine's run that comes while another is starting is skipped", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("personal")
        yield* assistantOf(p)
        const a = yield* routine(p, {
          name: "Inbox",
          trigger: { kind: "interval", every_minutes: 60 },
          precheck: "sleep 0.3; echo new mail",
          action: { kind: "message_assistant", message: "{{precheck}}" },
        })
        const automations = yield* Automations
        const stored = yield* get(a)
        const start = (id: string) => Effect.andThen(insertRun(newRun(a, "webhook", "running", NOW, id)), automations.runAction(stored, id, "webhook", null, 1))
        const [first, second] = yield* Effect.all([start("one"), start("two")], { concurrency: "unbounded" })
        const skipped = [first, second].filter((r) => r?.status === "skipped")
        assert.lengthOf(skipped, 1)
        assert.strictEqual(skipped[0]?.detail, "Skipped: its last run is still starting")
      }),
    ),
  )

  // HA-161: the scheduler ran due automations one after another, so one's slow precheck held up every other's.
  it.effect("a slow precheck doesn't hold up another automation's run, and a run due again waits for it", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("work")
        const web = yield* project(p, "web", "WEB")
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(web.repo_path, { recursive: true }).pipe(Effect.orDie)
        const t = yield* (yield* Tasks).create({ project_id: web.id, title: "Watch" }, Actor.user).pipe(Effect.orDie)
        yield* fakeAgent({ task: t.id })
        const go = `${web.repo_path}/go`
        const everyHour = (name: string, precheck: string | null) =>
          create(web, { name, trigger: { kind: "interval", every_minutes: 60 }, precheck, action: { kind: "send_to_task", task_id: t.id, message: name } })
        // Its precheck takes until the test lets it finish (or 20 seconds, so that a failed test leaves no shell behind).
        const slow = yield* everyHour("Slow", `for i in $(seq 1000); do [ -e '${go}' ] && break; sleep 0.02; done`)
        // Made after it, so the scheduler claims it second.
        yield* TestClock.adjust(1)
        const quick = yield* everyHour("Quick", null)
        for (const a of [slow, quick]) yield* setNext(a, NOW - 1000)
        const scheduler = yield* Scheduler
        const started = yield* scheduler.startDue(NOW)
        assert.lengthOf(started, 2)
        // The quick one's run is over while the slow one's precheck still goes.
        yield* Fiber.join(started[1] ?? assert.fail("no second run"))
        assert.strictEqual((yield* lastRun(quick)).status, "ok")
        assert.strictEqual((yield* lastRun(slow)).status, "running", "its precheck isn't done")
        // Due again before its run is over, it isn't started again: it waits, still due.
        yield* setNext(slow, NOW)
        assert.lengthOf(yield* scheduler.startDue(NOW + 1000), 0)
        assert.lengthOf(yield* runsOf(slow), 1)
        yield* fs.writeFileString(go, "").pipe(Effect.orDie)
        yield* Fiber.joinAll(started)
        assert.strictEqual((yield* lastRun(slow)).status, "ok")
        // Once it's over, it runs.
        yield* tick(NOW + 1000)
        assert.deepStrictEqual(yield* statuses(slow), ["ok", "ok"])
      }),
    ),
  )

  // HA-122 review: a sender that hung up during a slow precheck dropped the handler's future; HA-161: one that waited past
  // its timeout counted the delivery as failed, though it ran. A delivery is answered as soon as its run is recorded.
  it.effect("a delivery is answered at once, and its slow precheck carries on", () =>
    board(
      Effect.gen(function* () {
        const p = yield* profile("personal")
        const assistant = yield* assistantOf(p)
        yield* fakeAgent({ task: assistant.id })
        const go = `${yield* tempDir}/go`
        const a = yield* routine(p, {
          name: "Hook",
          trigger: { kind: "webhook" },
          precheck: `for i in $(seq 1000); do [ -e '${go}' ] && break; sleep 0.02; done; echo found it`,
          action: { kind: "message_assistant", mode: "thread", message: "{{precheck}}" },
        })
        const answer = yield* deliver(a, {}, "{}")
        assert.deepStrictEqual([answer.status, answer.body["status"]], [202, "running"])
        assert.lengthOf(yield* steered(assistant.id), 0)
        yield* (yield* FileSystem.FileSystem).writeFileString(go, "").pipe(Effect.orDie)
        const r = yield* ran(answer)
        assert.deepStrictEqual([r.status, r.task_id], ["ok", assistant.id])
        assert.include((yield* steered(assistant.id))[0]?.text, "found it")
      }),
    ),
  )
})
