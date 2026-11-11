import { Clock, Context, Effect, FiberMap, FiberSet, Layer, Schema, Stream, SubscriptionRef, Ref } from "effect"
import { SecureRandom } from "effect/crypto"
import { Invalid, PushSubscriptionId } from "@huntaway/contracts"
import type { BoardEvent, PushDevice, PushEventsPatch, PushInfo, PushKeys, RequestId, Status, Task, TaskId } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { Identity } from "../platform/Identity.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { PermissionRepo } from "../permissions/PermissionRepo.ts"
import type { PromptRow } from "../permissions/PermissionRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { PushRepo, shown } from "./PushRepo.ts"
import type { Subscription } from "./PushRepo.ts"
import {
  DEFAULT_EVENTS,
  eventStatus,
  mergedEvents,
  notificationText,
  endpointProblem,
  promptText,
  readyToCheck,
  reportText,
  taskEvent,
  wants,
  wantsPrompt,
} from "./rules.ts"
import type { PushEvent } from "./rules.ts"
import { WebPush } from "./WebPush.ts"
import type { Message, Undelivered } from "./WebPush.ts"

// Push (docs/plan/06-server.md, Push; the old integrations/push.ts and push/*): devices' subscriptions, and watching the
// board's events to push each device what it wants, by Web Push. The board's notifications are the web client's (a task
// needs attention, is ready to review, for merge, done), with permission prompts, the assistant's replies
// (`assistant_reply`, emitted by `Assistant`) and its routines' reports (`routine_report`, emitted by `Routines`).
// The phone app's Expo push and answering a prompt from a notification wait for the app (14-dropped-and-open.md).

export class SubscriptionNotFound extends Schema.TaggedError<SubscriptionNotFound, { readonly brand: unique symbol }>()("SubscriptionNotFound", {
  id: Schema.String,
}) {}
/** A test push its push service didn't take, and why. */
export class PushFailed extends Schema.TaggedError<PushFailed, { readonly brand: unique symbol }>()("PushFailed", { reason: Schema.String }) {}

/** How long a task that's ready to review has to stay so before it notifies: a review starts a moment after the run ends, and a run can carry on. */
export const REVIEW_GRACE = "5 seconds"
/** How long a move the user made keeps its notification away (the web client's `MOVE_MS`). */
export const MOVE_GRACE_MS = 15_000

export interface PushShape {
  /** The board's key to subscribe with, and the devices that have. */
  readonly info: Effect.Effect<PushInfo>
  /** Adds a browser's subscription, or updates the one with its endpoint (its events only where given, over what it had). */
  readonly subscribe: (input: {
    readonly endpoint: string
    readonly keys: PushKeys
    readonly name?: string | undefined
    readonly events?: PushEventsPatch | undefined
  }) => Effect.Effect<PushDevice, Invalid>
  /** A device's name, or some of its events. */
  readonly update: (
    id: PushSubscriptionId,
    change: { readonly name?: string | undefined; readonly events?: PushEventsPatch | undefined },
  ) => Effect.Effect<PushDevice, SubscriptionNotFound>
  readonly unsubscribe: (id: PushSubscriptionId) => Effect.Effect<void, SubscriptionNotFound>
  /** Pushes a test notification to a device, failing with why its push service didn't take it. */
  readonly test: (id: PushSubscriptionId) => Effect.Effect<void, SubscriptionNotFound | PushFailed>
  /** The user moved task `id` to `status` themselves (through the board's RPC): for a while, that doesn't notify them. */
  readonly noteMove: (id: TaskId, status: Status) => Effect.Effect<void>
  /** Watches the board's events and pushes what devices want, until interrupted: `Push.watcher` forks it. */
  readonly watch: Effect.Effect<never>
  /** For tests: waits until every event emitted so far has been handled and the pushes it started have ended. */
  readonly idle: Effect.Effect<void>
}

/** A name as kept: trimmed, at most 100 characters. */
const nameOf = (name: string | undefined) =>
  Array.from((name ?? "").trim())
    .slice(0, 100)
    .join("")

export class Push extends Context.Service<Push, PushShape>()("huntaway-server/push/Push") {
  static readonly layer = Layer.effect(
    Push,
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* PushRepo
      const webPush = yield* WebPush
      const events = yield* Events
      const identity = yield* Identity
      const taskRepo = yield* TaskRepo
      const prompts = yield* PermissionRepo
      const random = yield* SecureRandom.SecureRandom
      const host = identity.hostId

      /** Every task as last seen, to tell what changed: a task first seen notifies of nothing. */
      const known = yield* Ref.make<ReadonlyMap<TaskId, Task>>(new Map())
      /** Prompts pushed (or pending when watching began), never pushed again. */
      const seen = yield* Ref.make<ReadonlySet<RequestId>>(new Set())
      /** The prompts pushed while watching that are still pending, by task: their devices aren't told the task needs attention too. */
      const prompted = yield* Ref.make<ReadonlyMap<TaskId, ReadonlySet<RequestId>>>(new Map())
      /** The columns the user moved tasks to lately, and when. */
      const moves = yield* Ref.make<ReadonlyMap<TaskId, { readonly status: Status; readonly at: number }>>(new Map())
      /** The number of the last event handled. */
      const handled = yield* SubscriptionRef.make(0)
      /** Tasks whose "ready to review" waits out its grace. */
      const graces = yield* FiberMap.make<TaskId>()
      const sends = yield* FiberSet.make()

      // ---- sending ----

      /** Notes how a push to `sub` went (`null`: delivered), only while it still has the endpoint the push went to. */
      const noted = (sub: Subscription, result: Undelivered | null) =>
        result === null
          ? Effect.flatMap(nowTimestamp, (at) => repo.sent(sub.id, sub.endpoint, at))
          : result.gone
            ? Effect.flatMap(repo.gone(sub.id, sub.endpoint), (deleted) =>
                deleted ? Effect.logInfo(`push subscription ${sub.id} (${sub.name}) is gone; deleted it`) : Effect.void,
              )
            : repo.failed(sub.id, sub.endpoint, result.error).pipe(Effect.andThen(Effect.logWarning(`push to ${sub.id} (${sub.name}) failed: ${result.error}`)))

      const send = Effect.fnUntraced(function* (sub: Subscription, message: Message, urgent: boolean) {
        const result = yield* webPush.deliver(sub, message, urgent)
        yield* noted(sub, result)
        return result
      })

      /** Sends `message` to each of `subs`, one by one, whatever happens to the others; in the background. */
      const sendAll = (subs: ReadonlyArray<Subscription>, message: Message, urgent: boolean) =>
        subs.length === 0
          ? Effect.void
          : FiberSet.run(
              sends,
              Effect.forEach(subs, (sub) => send(sub, message, urgent), { concurrency: 1, discard: true }),
            ).pipe(Effect.asVoid)

      /** The browsers' subscriptions that `keep` (the phone app's wait for Expo push). */
      const subscribers = (keep: (sub: Subscription) => boolean) => Effect.map(repo.list, (all) => all.filter((s) => s.kind === "web" && keep(s)))

      // ---- what notifies ----

      const moved = Effect.fnUntraced(function* (id: TaskId, e: PushEvent) {
        const m = (yield* Ref.get(moves)).get(id)
        return m !== undefined && m.status === eventStatus(e) && (yield* Clock.currentTimeMillis) - m.at < MOVE_GRACE_MS
      })

      /** Pushes event `e` of task `t` to the devices that want it. */
      const notify = Effect.fnUntraced(function* (t: Task, e: Exclude<PushEvent, "prompt" | "reply" | "report">) {
        // Waiting on a prompt the devices that want it were pushed already.
        const waiting = e === "attention" && ((yield* Ref.get(prompted)).get(t.id)?.size ?? 0) > 0
        const subs = yield* subscribers((s) => wants(s.events, e) && !(waiting && wantsPrompt(s.events, t)))
        const { title, body } = notificationText(e, t)
        yield* sendAll(subs, { title, body, url: `/t/${t.id}`, tag: `${host}:${t.id}`, task_id: t.id, event: e }, e === "attention")
      })

      /** Pushes prompt `row` of task `t` to the devices that want the task's prompts. */
      const notifyPrompt = Effect.fnUntraced(function* (t: Task, row: PromptRow) {
        const subs = yield* subscribers((s) => wantsPrompt(s.events, t))
        const input = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(row.input).pipe(Effect.orElseSucceed(() => null))
        yield* sendAll(
          subs,
          {
            title: `${t.key} ${t.title}`,
            body: promptText({ kind: row.kind, tool_name: row.tool_name, input }),
            url: `/t/${t.id}`,
            // Each prompt its own, so two at once each show.
            tag: `${host}:${t.id}:${row.id}`,
            task_id: t.id,
            event: "prompt",
            request_id: row.id,
          },
          true,
        )
      })

      /** A task needing attention: its prompts raised since it was last seen are pushed, and those settled are let go. */
      const promptsOf = Effect.fnUntraced(function* (t: Task) {
        const pending = yield* prompts.pending({ task: t.id })
        const before = yield* Ref.get(seen)
        const fresh = pending.filter((p) => !before.has(p.id))
        if (fresh.length > 0) yield* Ref.set(seen, new Set([...before, ...fresh.map((p) => p.id)]))
        const ids = new Set(pending.map((p) => p.id))
        yield* Ref.update(prompted, (all) => {
          const next = new Map(all)
          const kept = [...(all.get(t.id) ?? [])].filter((id) => ids.has(id))
          const now = new Set([...kept, ...fresh.map((p) => p.id)])
          if (now.size === 0) next.delete(t.id)
          else next.set(t.id, now)
          return next
        })
        yield* Effect.forEach(fresh, (row) => notifyPrompt(t, row), { concurrency: 1, discard: true })
      })

      /** A task as it is now: notifies of what changed since it was last seen. */
      const observe = Effect.fnUntraced(function* (t: Task) {
        // Its prompts end with its run, if the board missed hearing so.
        if (!t.running) yield* Ref.update(prompted, (all) => (all.has(t.id) ? new Map([...all].filter(([id]) => id !== t.id)) : all))
        if (t.kind === "task" && t.status === "needs_attention") yield* promptsOf(t)
        const prev = (yield* Ref.get(known)).get(t.id)
        yield* Ref.update(known, (all) => new Map(all).set(t.id, t))
        if (prev === undefined) return
        const e = taskEvent(prev, t)
        if (e === null || (yield* moved(t.id, e))) return
        if (e !== "review") {
          yield* notify(t, e)
          return
        }
        // Ready to review only once it has stayed so for a few seconds.
        yield* FiberMap.run(
          graces,
          t.id,
          Effect.gen(function* () {
            yield* Effect.sleep(REVIEW_GRACE)
            const now = (yield* Ref.get(known)).get(t.id)
            if (now !== undefined && readyToCheck(now)) yield* notify(now, "review")
          }),
          { onlyIfMissing: true },
        )
      })

      /** The assistant (task `id`) finished a reply: "Replied", not what it said, which is read in the thread. */
      const replied = Effect.fnUntraced(function* (id: TaskId) {
        const subs = yield* subscribers((s) => wants(s.events, "reply"))
        if (subs.length === 0) return
        const t = (yield* Ref.get(known)).get(id) ?? (yield* taskRepo.get(id))
        if (t === null || t.task_type !== "assistant") return
        const { title, body } = notificationText("reply", t)
        // Its own tag, so a reply doesn't take the place of an attention notification.
        yield* sendAll(subs, { title, body, url: `/t/${id}`, tag: `${host}:${id}:reply`, task_id: id, event: "reply" }, false)
      })

      /** A routine's report: its routine, and its first line (or why it failed), opening the routine's thread. */
      const reported = Effect.fnUntraced(function* (ev: Extract<BoardEvent, { readonly type: "routine_report" }>) {
        const text = reportText(ev)
        if (text === null) return
        const subs = yield* subscribers((s) => wants(s.events, "report"))
        yield* sendAll(subs, { ...text, url: `/t/${ev.task_id}`, tag: `${host}:${ev.task_id}:report:${ev.id}`, task_id: ev.task_id, event: "report" }, false)
      })

      const handle = (ev: BoardEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (ev.type === "task") yield* observe(ev.task)
          else if (ev.type === "task_deleted") {
            yield* Ref.update(known, (all) => new Map([...all].filter(([id]) => id !== ev.id)))
            yield* Ref.update(prompted, (all) => new Map([...all].filter(([id]) => id !== ev.id)))
          } else if (ev.type === "assistant_reply") yield* replied(ev.task_id)
          else if (ev.type === "routine_report") yield* reported(ev)
        }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("push: handling an event failed", cause)),
          Effect.andThen(SubscriptionRef.set(handled, ev.seq)),
        )

      /**
       * Takes the board's tasks (and its pending prompts) as they are, without notifying of them: they were so before
       * anything here could tell. Then every event, one at a time, in order; again from a fresh baseline after `resync`.
       */
      const watch = Effect.scoped(
        Effect.gen(function* () {
          const w = yield* events.watch(undefined)
          const tasks = yield* taskRepo.all
          const pending = yield* prompts.pending({})
          yield* Ref.set(known, new Map(tasks.map((t) => [t.id, t])))
          yield* Ref.update(seen, (s) => new Set([...s, ...pending.map((p) => p.id)]))
          yield* Ref.set(prompted, new Map())
          yield* SubscriptionRef.set(handled, w.seq)
          yield* Stream.runForEach(w.live, handle)
        }),
      ).pipe(Effect.forever, Effect.annotateLogs({ module: "push" }))

      const idle = Effect.gen(function* () {
        const seq = yield* events.seq
        yield* SubscriptionRef.changes(handled).pipe(
          Stream.filter((n) => n >= seq),
          Stream.take(1),
          Stream.runDrain,
        )
        yield* FiberSet.awaitEmpty(sends)
      })

      // ---- the devices ----

      const found = Effect.fnUntraced(function* (id: string) {
        const sub = yield* repo.get(id)
        if (sub === null) return yield* new SubscriptionNotFound({ id })
        return sub
      })

      const info = Effect.gen(function* () {
        return { public_key: yield* webPush.publicKey, subscriptions: (yield* repo.list).map(shown) }
      })

      const subscribe = Effect.fn("Push.subscribe")(function* (input: {
        readonly endpoint: string
        readonly keys: PushKeys
        readonly name?: string | undefined
        readonly events?: PushEventsPatch | undefined
      }) {
        const problem = endpointProblem(input.endpoint)
        if (problem !== null) return yield* new Invalid({ field: "endpoint", reason: problem })
        const keys = yield* webPush.checkKeys(input.keys)
        if (keys === null) return yield* new Invalid({ field: "keys", reason: "keys must have the subscription's p256dh public key and 16-byte auth secret" })
        const name = nameOf(input.name)
        const newId = PushSubscriptionId.make(yield* random.uuidV4().pipe(Effect.orDie))
        const at = yield* nowTimestamp
        const id = yield* db.tx(
          Effect.gen(function* () {
            const old = yield* repo.byEndpoint(input.endpoint)
            if (old === null) {
              const chosen = mergedEvents(DEFAULT_EVENTS, input.events ?? {})
              yield* repo.insert({ id: newId, endpoint: input.endpoint, kind: "web", ...keys, name, device_id: null, events: chosen, created_at: at })
              return newId
            }
            // The same browser subscribing again: its events over what it had.
            if (old.kind !== "web") return yield* new Invalid({ field: "endpoint", reason: "that endpoint is subscribed as another kind" })
            yield* repo.resubscribe(old.id, keys, name, input.events === undefined ? null : mergedEvents(old.events, input.events))
            return old.id
          }),
        )
        return shown(yield* found(id).pipe(Effect.orDie))
      })

      const update = Effect.fn("Push.update")(function* (
        id: PushSubscriptionId,
        change: { readonly name?: string | undefined; readonly events?: PushEventsPatch | undefined },
      ) {
        yield* db.tx(
          Effect.gen(function* () {
            const sub = yield* found(id)
            if (change.name !== undefined) yield* repo.setName(id, nameOf(change.name))
            if (change.events !== undefined) yield* repo.setEvents(id, mergedEvents(sub.events, change.events))
          }),
        )
        return shown(yield* found(id))
      })

      const unsubscribe = Effect.fn("Push.unsubscribe")(function* (id: PushSubscriptionId) {
        const deleted = yield* repo.delete(id)
        if (!deleted) return yield* new SubscriptionNotFound({ id })
        return undefined
      })

      const test = Effect.fn("Push.test")(function* (id: PushSubscriptionId) {
        const sub = yield* found(id)
        if (sub.kind !== "web") return yield* new PushFailed({ reason: "pushing to the phone app isn't on this server yet" })
        const result = yield* send(
          sub,
          { title: "Huntaway", body: "Push notifications work on this device.", url: "/settings/notifications", tag: "test" },
          true,
        )
        if (result !== null) return yield* new PushFailed({ reason: result.error })
        return undefined
      })

      const noteMove = (id: TaskId, status: Status) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Ref.update(moves, (all) => {
            const next = new Map([...all].filter(([, m]) => now - m.at < MOVE_GRACE_MS))
            return next.set(id, { status, at: now })
          }),
        )

      return Push.of({ info, subscribe, update, unsubscribe, test, noteMove, watch, idle })
    }),
  )

  /** The watcher: Push's loop over the board's events, for as long as the server runs. */
  static readonly watcher = Layer.effectDiscard(
    Effect.gen(function* () {
      const push = yield* Push
      yield* Effect.forkScoped(push.watch)
    }),
  )
}
