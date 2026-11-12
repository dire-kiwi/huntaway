import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import type { FileSystem } from "effect"
import type { Scope } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { PushSubscriptionId, RequestId, TaskId, Timestamp } from "@huntaway/contracts"
import type { PushEventsPatch, Task } from "@huntaway/contracts"
import { fakePushService, pushDevice, tempDir, TestBoard } from "@huntaway/testing"
import type { FakePushService, PushDeviceKeys } from "@huntaway/testing"
import { PermissionRepo } from "../permissions/PermissionRepo.ts"
import { Actor } from "../platform/Changes.ts"
import { Events } from "../platform/Events.ts"
import { Identity } from "../platform/Identity.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Push } from "./Push.ts"

// The old push/tests.test.ts against a push service on this machine (packages/testing's), its pushes read with the
// device's keys. Task changes are the board's events as the watcher gets them (the old tests' `emit`).
//
// Not ported: a_link_is_connected_only_after_its_initial_push_snapshot and a_prompt_on_a_linked_host_is_answered_through
// the_link (hosts are M7); a_prompt_is_pushed_with_a_token_that_answers_it_once's answering, and the tokens' cases
// (a_token_stops_working…, an_answer_the_board_missed…, an_answer_cut_off_part_way…, a_notification_cant_answer…,
// a_token_answers_only_its_own_prompt…): answering from a notification waits for the phone app (14-dropped-and-open.md);
// expo_tests.test.ts likewise. a_move_the_user_makes_through_the_board_is_noted is the RPC's (tests/ui/push.test.mjs).

type Env = Push | Events | Identity | Profiles | Projects | Tasks | TaskRepo | PermissionRepo | SqlClient.SqlClient | FileSystem.FileSystem | Scope.Scope
const run = <A, E>(effect: Effect.Effect<A, E, Env>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

/** A review in `state`, as a task carries it. */
const review = (state: "running" | "passed"): Task["review"] => ({
  thread_id: TaskId.make("review"),
  state,
  head: null,
  summary: null,
  issues: [],
  fixes: 0,
  extra_rounds: 0,
  updated_at: AT,
  reviewers: [],
})
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url")
const AT = Timestamp.make("2026-11-12T00:00:00.000Z")
const ALL_OFF: PushEventsPatch = { attention: false, review: false, merge: false, done: false, reports: false }

/** Subscribes a new device at `service`'s endpoint `name`, with `events`: its keys, to read what it's sent. */
const device = (service: FakePushService, name: string, events?: PushEventsPatch) =>
  Effect.gen(function* () {
    const keys = pushDevice()
    const sub = yield* (yield* Push).subscribe({ endpoint: service.endpoint(name), keys: keys.keys, name, events })
    return { ...keys, id: sub.id }
  })

/** The next push the service got, read by `d`. */
const next = (service: FakePushService, d: PushDeviceKeys) => Effect.map(service.next, (got) => ({ ...got, message: d.read(got.body) }))

/** A project WEB's task "Fix the login", as the board has it. */
const projectTask = Effect.gen(function* () {
  const profile = yield* (yield* Profiles).create({ name: "work" })
  const web = yield* (yield* Projects).create({ profile_id: profile.id, name: "Web", key: "WEB", repo_path: `${yield* tempDir}/web` })
  return yield* (yield* Tasks).create({ project_id: web.id, title: "Fix the login", status: "in_progress" }, Actor.user)
})

/** `t` with `fields` changed. */
const withf = (t: Task, fields: Partial<Task> = {}): Task => Object.assign({}, t, fields)
/** The board's event for task `t` (with `fields` changed), as it is now. */
const emit = (t: Task, fields: Partial<Task> = {}) => Effect.flatMap(Events, (events) => events.emit({ type: "task", task: withf(t, fields) }))

/** Profile `t`'s assistant's thread (a task in no project of `task_type` assistant), as the board has it. */
const assistantOf = (t: Task) =>
  Effect.gen(function* () {
    const made = yield* (yield* Tasks).create({ profile_id: t.profile_id, title: "Assistant" }, Actor.user)
    const repo = yield* TaskRepo
    yield* repo.write(made.id, { task_type: "assistant" }, AT)
    const mine = yield* repo.get(made.id)
    if (mine === null) return yield* Effect.die("the assistant is gone")
    // Its event, as the board would have sent it.
    yield* emit(mine)
    return mine
  })

/** Waits until every event so far is handled and its pushes are done. */
const idle = Effect.flatMap(Push, (push) => push.idle)

/** A pending prompt of task `t` for `tool`, as `Permissions` raises it (its row; the task's event follows). */
const prompt = (t: Task, id: string, tool: string, input: unknown = {}) =>
  Effect.gen(function* () {
    yield* (yield* PermissionRepo).insert({
      id: RequestId.make(id),
      task_id: t.id,
      write_no: 0,
      tool_name: tool,
      input: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(input).pipe(Effect.orDie),
      kind: "tool",
      call_id: `call-${id}`,
      expires_at: null,
      rule: null,
      created_at: AT,
      run_id: null,
      control_id: null,
    })
    return RequestId.make(id)
  })

describe("Push", () => {
  it.effect("devices subscribe, change their events and unsubscribe", () =>
    run(
      Effect.gen(function* () {
        const push = yield* Push
        const info = yield* push.info
        assert.strictEqual(Buffer.from(info.public_key, "base64url").length, 65)
        assert.deepStrictEqual(info.subscriptions, [])
        // The key is made once.
        assert.strictEqual((yield* push.info).public_key, info.public_key)

        const keys = pushDevice().keys
        const endpoint = "https://push.example.com/send/abc"
        const sub = yield* push.subscribe({ endpoint, keys, name: "Pixel" })
        assert.deepStrictEqual(sub.events, { attention: true, review: true, merge: false, done: false, prompts: "assistant", replies: false, reports: true })
        assert.strictEqual(sub.name, "Pixel")
        assert.isFalse("auth" in sub || "p256dh" in sub)

        // The same endpoint again (a browser that subscribed again) is the same device, keeping its events.
        assert.isTrue((yield* push.update(sub.id, { events: { attention: true, review: false, merge: true, done: false } })).events.merge)
        const again = yield* push.subscribe({ endpoint, keys, name: "Pixel 8" })
        assert.deepStrictEqual([again.id, again.name, again.events.merge], [sub.id, "Pixel 8", true])
        assert.strictEqual((yield* push.info).subscriptions.length, 1)

        // Endpoints are HTTPS (HTTP only on this machine), and keys have to be real.
        const refused: ReadonlyArray<readonly [Parameters<typeof push.subscribe>[0], string]> = [
          [{ endpoint: "http://push.example.com/x", keys }, "https"],
          [{ endpoint: "not a url", keys }, "URL"],
          [{ endpoint, keys: { p256dh: b64(new Uint8Array(65).fill(4)), auth: b64(new Uint8Array(16).fill(1)) } }, "p256dh"],
          [{ endpoint, keys: { p256dh: keys.p256dh, auth: b64(new Uint8Array(8).fill(1)) } }, "auth"],
        ]
        for (const [input, why] of refused) {
          const e = yield* Effect.flip(push.subscribe(input))
          assert.include(e.reason, why)
        }

        yield* push.unsubscribe(sub.id)
        assert.strictEqual((yield* Effect.flip(push.unsubscribe(sub.id)))._tag, "SubscriptionNotFound")
        assert.strictEqual((yield* Effect.flip(push.update(PushSubscriptionId.make("nope"), { name: "x" })))._tag, "SubscriptionNotFound")
        assert.deepStrictEqual((yield* push.info).subscriptions, [])
      }),
    ),
  )

  it.effect("events left out keep what they were, and one stored before reports reads as without them", () =>
    run(
      Effect.gen(function* () {
        const push = yield* Push
        const keys = pushDevice().keys
        const endpoint = "https://push.example.com/a"
        const sub = yield* push.subscribe({ endpoint, keys, events: { merge: true } })
        assert.deepStrictEqual(sub.events, { attention: true, review: true, merge: true, done: false, prompts: "assistant", replies: false, reports: true })
        const on = yield* push.update(sub.id, { events: { replies: true, reports: false } })
        assert.deepStrictEqual([on.events.replies, on.events.reports, on.events.merge], [true, false, true])
        const kept = yield* push.update(sub.id, { events: { attention: false, review: true, merge: false, done: false } })
        assert.deepStrictEqual(kept.events, { attention: false, review: true, merge: false, done: false, prompts: "assistant", replies: true, reports: false })
        // Subscribed again (the same endpoint) without events, it keeps them.
        assert.deepStrictEqual((yield* push.subscribe({ endpoint, keys })).events, kept.events)
        // One stored before (with the board's four events only) gets neither replies nor reports.
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE push_subscriptions SET events = '{"attention":true,"review":true,"merge":false,"done":false}' WHERE id = ${sub.id}`.pipe(Effect.orDie)
        const [stored] = (yield* push.info).subscriptions
        assert.deepStrictEqual(stored?.events, {
          attention: true,
          review: true,
          merge: false,
          done: false,
          prompts: "assistant",
          replies: false,
          reports: false,
        })
      }),
    ),
  )

  it.effect("task events are pushed encrypted to the devices that want them", () =>
    run(
      Effect.gen(function* () {
        const push = yield* Push
        const service = yield* fakePushService
        const phone = yield* device(service, "phone", { attention: true, review: false, merge: true, done: true })
        // A device that only wants reviews gets none of these.
        yield* device(service, "other", Object.assign({}, ALL_OFF, { review: true }))
        yield* idle
        const t = yield* projectTask
        const host = (yield* Identity).hostId

        yield* emit(t, { status: "needs_attention", attention_reason: "Approve Bash?", running: true })
        const got = yield* next(service, phone)
        assert.deepStrictEqual(got.message, {
          title: `WEB-${t.number} Fix the login`,
          body: "Needs attention: Approve Bash?",
          url: `/t/${t.id}`,
          tag: `${host}:${t.id}`,
          task_id: t.id,
          event: "attention",
        })
        assert.strictEqual(got.path, "/push/phone")
        const h = (k: string) => String(got.headers[k])
        assert.deepStrictEqual([h("content-encoding"), h("ttl"), h("urgency")], ["aes128gcm", "86400", "high"])
        const info = yield* push.info
        assert.isTrue(h("authorization").startsWith("vapid t=") && h("authorization").endsWith(`, k=${info.public_key}`))
        assert.strictEqual(h("topic").length, 32)
        // Noted once the push service has answered.
        yield* idle
        assert.isNotNull((yield* push.info).subscriptions.find((s) => s.id === phone.id)?.last_sent_at)

        // A move the user made doesn't notify them; the agent's next one does.
        yield* push.noteMove(t.id, "ready_for_merge")
        yield* emit(t, { status: "ready_for_merge" })
        yield* emit(t, { status: "done", resolution: "done" })
        const done = yield* next(service, phone)
        assert.deepStrictEqual([done.message.body, done.message.event, done.headers["urgency"]], ["Done", "done", "normal"])
        yield* idle
        assert.deepStrictEqual(yield* service.waiting, [], "the device that only wants reviews got one")

        // The move's grace is 15 seconds.
        yield* push.noteMove(t.id, "ready_for_merge")
        yield* TestClock.adjust("16 seconds")
        yield* emit(t, { status: "ready_for_merge" })
        assert.strictEqual((yield* next(service, phone)).message.body, "Ready for merge")
      }),
    ),
  )

  it.effect("ready to review waits to see that it stays so", () =>
    run(
      Effect.gen(function* () {
        const service = yield* fakePushService
        const phone = yield* device(service, "phone")
        yield* idle
        const t = yield* projectTask
        const working = withf(t, { running: true })
        yield* emit(working)
        // Its review starts straight after: nothing.
        yield* emit(working, { status: "in_review", running: false })
        yield* emit(working, { status: "in_review", running: false, review: review("running") })
        // Then it passes, and stays passed.
        yield* emit(working, { status: "in_review", running: false, review: review("passed") })
        yield* idle
        yield* TestClock.adjust("4 seconds")
        yield* idle
        assert.deepStrictEqual(yield* service.waiting, [])
        yield* TestClock.adjust("1 second")
        assert.strictEqual((yield* next(service, phone)).message.body, "Ready to review: its review passed")
        yield* idle
        assert.deepStrictEqual(yield* service.waiting, [])
      }),
    ),
  )

  it.effect("a subscription its push service has dropped is deleted", () =>
    run(
      Effect.gen(function* () {
        const push = yield* Push
        const service = yield* fakePushService
        yield* service.answer(500)
        const phone = yield* device(service, "phone")
        const failed = yield* Effect.flip(push.test(phone.id))
        assert.strictEqual(failed._tag, "PushFailed")
        assert.include(failed._tag === "PushFailed" ? failed.reason : "", "500")
        yield* service.next
        assert.include((yield* push.info).subscriptions[0]?.last_error ?? "", "500")

        yield* service.answer(410)
        assert.strictEqual((yield* Effect.flip(push.test(phone.id)))._tag, "PushFailed")
        yield* service.next
        assert.deepStrictEqual((yield* push.info).subscriptions, [])

        // A test that works says what the old one did.
        yield* service.answer(201)
        const again = yield* device(service, "again")
        yield* push.test(again.id)
        assert.deepStrictEqual((yield* next(service, again)).message, {
          title: "Huntaway",
          body: "Push notifications work on this device.",
          url: "/settings/notifications",
          tag: "test",
        })
      }),
    ),
  )

  it.effect("a routine's report is pushed once to the devices that want reports", () =>
    run(
      Effect.gen(function* () {
        const service = yield* fakePushService
        // Reports are on unless a device turns them off.
        const phone = yield* device(service, "phone", { attention: false, review: false, merge: false, done: false })
        yield* device(service, "quiet", ALL_OFF)
        const events = yield* Events
        const host = (yield* Identity).hostId
        const report = (id: string, outcome: "reported" | "failed" | "asked", text: string) =>
          events.emit({ type: "routine_report", id, task_id: TaskId.make("routine-run"), automation: "Morning brief", outcome, text })
        yield* report("m1", "reported", "## Today\n\n**Dentist at 9:30**; two mails need you.\nMore lines")
        const got = (yield* next(service, phone)).message
        // Tapping it opens the routine's thread.
        assert.deepStrictEqual(got, {
          title: "Morning brief",
          body: "Today",
          url: "/t/routine-run",
          tag: `${host}:routine-run:report:m1`,
          task_id: "routine-run",
          event: "report",
        })
        yield* report("m2", "failed", "Out of usage")
        assert.strictEqual((yield* next(service, phone)).message.body, "Failed: Out of usage")
        // One waiting on the user is pushed as its attention, not here.
        yield* report("m3", "asked", "Which calendar?")
        yield* idle
        assert.deepStrictEqual(yield* service.waiting, [], "pushed what it shouldn't have")
      }),
    ),
  )

  it.effect("the assistant's replies are pushed to the devices that want them", () =>
    run(
      Effect.gen(function* () {
        const service = yield* fakePushService
        const phone = yield* device(service, "phone", Object.assign({}, ALL_OFF, { replies: true }))
        // A device that never chose replies isn't sent them.
        yield* device(service, "quiet", ALL_OFF)
        yield* idle
        const mine = yield* assistantOf(yield* projectTask)
        const events = yield* Events
        const host = (yield* Identity).hostId
        yield* events.emit({ type: "assistant_reply", task_id: mine.id, profile_id: mine.profile_id })
        assert.deepStrictEqual((yield* next(service, phone)).message, {
          title: `${mine.key} Assistant`,
          body: "Replied",
          url: `/t/${mine.id}`,
          tag: `${host}:${mine.id}:reply`,
          task_id: mine.id,
          event: "reply",
        })
        // Not for a task that isn't the assistant.
        yield* emit(mine, { id: TaskId.make("routine"), task_type: "routine" })
        yield* events.emit({ type: "assistant_reply", task_id: TaskId.make("routine"), profile_id: mine.profile_id })
        yield* events.emit({ type: "assistant_reply", task_id: TaskId.make("nope"), profile_id: mine.profile_id })
        yield* idle
        assert.deepStrictEqual(yield* service.waiting, [], "pushed what it shouldn't have")
      }),
    ),
  )

  it.effect("a prompt is pushed to the devices that want it, and they aren't told its task needs attention too", () =>
    run(
      Effect.gen(function* () {
        const service = yield* fakePushService
        const phone = yield* device(service, "phone", { attention: true, review: true, prompts: "all" })
        // Another device wants needs-attention, but no prompts: it's told of the task as before.
        const other = yield* device(service, "other", { attention: true, prompts: "off" })
        yield* idle
        const t = yield* projectTask
        const host = (yield* Identity).hostId
        yield* emit(t, { running: true })
        const request = yield* prompt(t, "r1", "Bash", { command: "rm -rf /tmp/secret-stuff" })
        yield* emit(t, { running: true, status: "needs_attention", attention_reason: "Approve Bash?" })
        yield* idle
        const pushes = yield* service.waiting
        const read = (path: string, d: PushDeviceKeys) => pushes.filter((g) => g.path === path).map((g) => d.read(g.body))
        assert.deepStrictEqual(read("/push/phone", phone), [
          {
            title: `WEB-${t.number} Fix the login`,
            body: "Approve Bash?",
            url: `/t/${t.id}`,
            tag: `${host}:${t.id}:${request}`,
            task_id: t.id,
            event: "prompt",
            request_id: request,
          },
        ])
        assert.deepStrictEqual(
          read("/push/other", other).map((m) => m.event),
          ["attention"],
        )
        // No push carries a tool's input.
        assert.isFalse(pushes.some((g) => (g.path === "/push/phone" ? phone : other).decrypt(g.body).includes("secret-stuff")))

        // A prompt the board missed the end of (its run ended) doesn't keep its task from notifying.
        yield* emit(t, { running: false, status: "in_progress", attention_reason: null })
        yield* emit(t, { running: false, status: "needs_attention", attention_reason: "The run failed" })
        yield* idle
        const later = (yield* service.waiting).filter((g) => g.path === "/push/phone").map((g) => phone.read(g.body))
        assert.deepStrictEqual(
          later.map((m) => [m.event, m.body]),
          [["attention", "Needs attention: The run failed"]],
        )
      }),
    ),
  )

  it.effect("questions and plans are pushed without what they ask, and only the assistant's by default", () =>
    run(
      Effect.gen(function* () {
        const service = yield* fakePushService
        // Its events as a browser that subscribed before prompts sends them.
        const phone = yield* device(service, "phone", { attention: false, review: false, merge: false, done: false })
        yield* idle
        const t = yield* projectTask
        yield* emit(t, { running: true })
        yield* prompt(t, "c0", "Bash")
        yield* emit(t, { running: true, status: "needs_attention" })
        const mine = yield* assistantOf(t)
        yield* emit(mine, { running: true })
        yield* prompt(mine, "c1", "AskUserQuestion", { questions: [{ question: "Which account?" }] })
        yield* emit(mine, { running: true, status: "needs_attention" })
        let msg = (yield* next(service, phone)).message
        assert.deepStrictEqual([msg.task_id, msg.body], [mine.id, "The agent has questions for you"])
        yield* prompt(mine, "c2", "ExitPlanMode", { plan: "# Plan: send it" })
        yield* emit(mine, { running: true, status: "needs_attention", attention_reason: "Plan ready" })
        assert.strictEqual((yield* next(service, phone)).message.body, "Plan ready for approval")
        yield* prompt(mine, "c3", "mcp__gmail__send", { to: "someone@example.com" })
        yield* emit(mine, { running: true, status: "needs_attention", attention_reason: "Approve mcp__gmail__send?" })
        const got = yield* service.next
        msg = phone.read(got.body)
        assert.strictEqual(msg.body, "Approve mcp__gmail__send?")
        assert.notInclude(phone.decrypt(got.body), "example.com")
        // Nothing of the project task's, and each prompt once.
        yield* emit(mine, { running: true, status: "needs_attention", attention_reason: "Still waiting" })
        yield* idle
        assert.deepStrictEqual(yield* service.waiting, [])
      }),
    ),
  )
})
