import { Cause, Effect, Exit, Option, Predicate, Schema, Stream, SubscriptionRef } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import {
  applyEvent,
  HostId,
  type ItemPage,
  type Preview,
  previewAfter,
  type Snapshot,
  TaskId,
  ThreadEvent,
  type ThreadMessage,
  type ThreadPreview,
  type ThreadSnapshot,
  type Unavailable,
  withPage,
} from "@huntaway/contracts"
import type { CallError } from "../rpc.ts"
import { HostClient } from "../session/HostClient.ts"
import { HostSession } from "../session/HostSession.ts"
import { hostRuntime } from "../session/sessions.ts"

// A task's thread as the page shows it (docs/plan/09-frontend.md, Threads): a window of its last items from
// `threads.watch`, folded with the contract's reducer, and older pages put in front of it with `threads.page`. The
// server subscribes before it reads the window, so there is nothing to hold, no gap to catch up on and no resync: the
// old itemThreads.ts's load generations are gone. A dropped connection subscribes again from the last event it had
// (`since`), and the server replays what was missed or sends a fresh window. The reply being written (`preview`) is
// kept apart, so a token changes only what shows it.

/** A task's thread on a host: task ids are unique per host only. */
export interface ThreadRef {
  readonly host_id: string
  readonly task_id: string
}

/** How many items a thread's first window has, and each older page (the old WINDOW_ITEMS and PAGE_ITEMS). */
export const WINDOW_ITEMS = 300
export const PAGE_ITEMS = 200

/** What a thread view has: what itemThreads.ts's `ItemThread` was. */
export interface ThreadView {
  /** The window, with the older pages loaded into it; null until the first snapshot has come. */
  readonly snap: Snapshot | null
  /** An older page is loading. */
  readonly loading: boolean
  /** Why the thread cannot be shown (its task is not on its host, or the host cannot be reached), or null. */
  readonly failed: string | null
  /** How many events of a type this build does not know have come (counted in the window's `seq`, otherwise ignored). */
  readonly unknown: number
}

/** A thread before its first snapshot. */
export const emptyThreadView: ThreadView = { snap: null, loading: false, failed: null, unknown: 0 }

const isKnown = Schema.is(ThreadEvent)

const isSnapshotMessage = (m: ThreadMessage): m is ThreadSnapshot => m.type === "snapshot" && "items" in m
const isPreviewMessage = (m: ThreadMessage): m is ThreadPreview => m.type === "preview" && "offset" in m

/** A snapshot message's window, without the stream's own fields. */
const windowOf = (m: ThreadSnapshot): Snapshot => ({
  thread: m.thread,
  items: m.items,
  requests: m.requests,
  seq: m.seq,
  ...(m.start === undefined ? {} : { start: m.start }),
  ...(m.context === undefined ? {} : { context: m.context }),
})

/**
 * A view after one message of `threads.watch` (pure): a snapshot replaces the window (and the pages loaded into it);
 * an event is folded into it with `applyEvent`, and one of a type this build does not know is counted. Previews do not
 * change the view (`previewAfter` folds them).
 */
export const applyThreadMessage = (view: ThreadView, message: ThreadMessage): ThreadView => {
  if (isSnapshotMessage(message)) return { ...view, snap: windowOf(message), failed: null }
  if (isPreviewMessage(message)) return view
  const unknown = isKnown(message) ? view.unknown : view.unknown + 1
  const snap = view.snap === null ? null : applyEvent(view.snap, message)
  return snap === view.snap && unknown === view.unknown ? view : { ...view, snap, unknown }
}

/**
 * The window with `page` (the items before its start) put in front of it (pure). What the window has already, its
 * context items and its requests, stays as the events have left it: the page's copies of them are older.
 */
export const withOlderPage = (snap: Snapshot, page: ItemPage): Snapshot => {
  const items = new Map(snap.items.map((i) => [i.id, i]))
  const requests = new Map(snap.requests.map((r) => [r.id, r]))
  return withPage(snap, {
    ...page,
    items: page.items.map((i) => items.get(i.id) ?? i),
    requests: page.requests.map((r) => requests.get(r.id) ?? r),
  })
}

/** Why a subscription ended, as the loop below acts on it. */
const ending = (cause: Cause.Cause<unknown>): "interrupted" | { readonly final: string } | { readonly error: string } => {
  if (Cause.hasInterruptsOnly(cause)) return "interrupted"
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (Predicate.isTagged(error, "NotFound")) return { final: "This task isn't on its host any more." }
  if (Predicate.isTagged(error, "Unauthorized") || Predicate.isTagged(error, "Forbidden")) return { final: "This board's token can't read the thread." }
  return { error: error instanceof Error ? error.message : Cause.pretty(cause) }
}

/** One thread's subscription: its view and its preview, which the watch and older pages change. */
interface Live {
  readonly view: SubscriptionRef.SubscriptionRef<ThreadView>
  readonly preview: SubscriptionRef.SubscriptionRef<Preview | null>
  /** Loads the page before the window's start and puts it in; nothing while one loads or there is none. */
  readonly older: Effect.Effect<void, CallError<"threads.page">>
}

/** One message of `threads.watch` folded into a subscription's view and preview, each changed only if it changes. */
const applyTo = (live: Live, message: ThreadMessage): Effect.Effect<void> =>
  Effect.andThen(
    SubscriptionRef.updateSome(live.view, (v) => {
      const next = applyThreadMessage(v, message)
      return next === v ? Option.none() : Option.some(next)
    }),
    SubscriptionRef.updateSome(live.preview, (p) => {
      const next = previewAfter(p, message)
      return next === p ? Option.none() : Option.some(next)
    }),
  )

/**
 * Watches `task`'s thread into `view` and `preview` until interrupted. A subscription that drops waits for the
 * connection and subscribes again from the window's `seq`. One the host refuses (no such task) ends it, failed.
 */
const watchThread = (task: TaskId, live: Live): Effect.Effect<void, never, HostClient | HostSession> =>
  Effect.gen(function* () {
    const client = yield* HostClient
    const session = yield* HostSession
    // Subscribe after the atom that runs this has been built, not while it is (as the board's stream does).
    yield* Effect.yieldNow
    while (true) {
      const { snap } = yield* SubscriptionRef.get(live.view)
      let heard = false
      const exit = yield* client("threads.watch", { task_id: task, limit: WINDOW_ITEMS, ...(snap === null ? {} : { since: snap.seq }) }).pipe(
        Stream.runForEach((message) => {
          heard = true
          return applyTo(live, message)
        }),
        Effect.exit,
      )
      if (Exit.isFailure(exit)) {
        const why = ending(exit.cause)
        if (why === "interrupted") return yield* Effect.interrupt
        if ("final" in why) return yield* SubscriptionRef.update(live.view, (v) => ({ ...v, failed: why.final }))
      }
      // Again once connected; not at once when this one never got going, so a host that keeps ending it is not asked
      // in a loop.
      yield* session.connected.await
      if (!heard) yield* Effect.sleep("1 second")
    }
  })

/** `"<host>\0<task>"`: the families below are keyed by a string, so the same thread is the same atom. */
const refKey = (ref: ThreadRef): string => `${ref.host_id}\u0000${ref.task_id}`

const parseKey = (key: string): { readonly host: HostId; readonly task: TaskId } => {
  const [host = "", task = ""] = key.split("\u0000")
  return { host: HostId.make(host), task: TaskId.make(task) }
}

/** How long a thread nobody shows stays subscribed, so going back to it soon shows it at once (the old KEEP_MS). */
const KEEP = "10 seconds"

const liveByKey = Atom.family((key: string) => {
  const { host, task } = parseKey(key)
  return hostRuntime(host)
    .atom(
      Effect.gen(function* () {
        const client = yield* HostClient
        const view = yield* SubscriptionRef.make(emptyThreadView)
        const preview = yield* SubscriptionRef.make<Preview | null>(null)
        const older = Effect.gen(function* () {
          // Taken in one step, so two calls do not both load the same page.
          const before = yield* SubscriptionRef.modify(view, (v): readonly [number | undefined, ThreadView] =>
            v.loading || v.snap?.start === undefined || v.snap.start === 0 ? [undefined, v] : [v.snap.start, { ...v, loading: true }],
          )
          if (before === undefined) return
          const page = yield* client("threads.page", { task_id: task, before, limit: PAGE_ITEMS }).pipe(
            Effect.onError(() => SubscriptionRef.update(view, (v) => ({ ...v, loading: false }))),
          )
          yield* SubscriptionRef.update(view, (v) => ({ ...v, loading: false, snap: v.snap === null ? null : withOlderPage(v.snap, page) }))
        })
        const live: Live = { view, preview, older }
        yield* Effect.forkScoped(watchThread(task, live))
        return live
      }),
    )
    .pipe(Atom.setIdleTTL(KEEP))
})

const viewByKey = Atom.family((key: string) =>
  hostRuntime(parseKey(key).host).subscriptionRef((get) => Effect.map(get.result(liveByKey(key)), (live) => live.view)),
)

const previewByKey = Atom.family((key: string) =>
  hostRuntime(parseKey(key).host).subscriptionRef((get) => Effect.map(get.result(liveByKey(key)), (live) => live.preview)),
)

/** Why a thread's host could not be reached, as the view says it. */
const failure = (cause: Cause.Cause<unknown>): string => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  return Predicate.isTagged(error, "Unavailable") && Predicate.hasProperty(error, "reason") && typeof error.reason === "string"
    ? `Its host can't be reached: ${error.reason}`
    : "Its host can't be reached."
}

const threadByKey = Atom.family((key: string) =>
  Atom.make((get): ThreadView => {
    const result = get(viewByKey(key))
    if (AsyncResult.isSuccess(result)) return result.value
    if (AsyncResult.isFailure(result)) return { ...emptyThreadView, failed: failure(result.cause) }
    return emptyThreadView
  }),
)

/**
 * A task's thread: a window of its last items, followed live, with the older pages `olderPage` has loaded. Subscribed
 * while something reads it and for ten seconds after.
 */
export const threadAtom = (ref: ThreadRef): Atom.Atom<ThreadView> => threadByKey(refKey(ref))

const threadPreviewByKey = Atom.family((key: string) =>
  Atom.make((get): Preview | null => {
    const result = get(previewByKey(key))
    return AsyncResult.isSuccess(result) ? result.value : null
  }),
)

/**
 * The reply being written in a task's thread, as streamed so far (the old deltas.ts): an atom of its own, so a token
 * changes only what shows it. Null when there is none. It comes with the thread's subscription (`threadAtom`).
 */
export const threadPreviewAtom = (ref: ThreadRef): Atom.Atom<Preview | null> => threadPreviewByKey(refKey(ref))

const olderByKey = Atom.family((key: string) => Atom.fn<void>()((_, get) => Effect.flatMap(get.result(liveByKey(key)), (live) => live.older)))

/**
 * Loads the page of a thread's items before its window's start (`threads.page`, `PAGE_ITEMS` of them) and puts it in
 * front. The view's `loading` says while it does; nothing happens when there is nothing before, or a page is loading.
 */
export const olderPage = (ref: ThreadRef): Atom.AtomResultFn<void, void, CallError<"threads.page"> | Unavailable | Cause.NoSuchElementError> =>
  olderByKey(refKey(ref))

/** Subscribes to a thread again from scratch (a failed one, when asked to try again). */
export const reloadThread = (ref: ThreadRef): Atom.Atom<unknown> => liveByKey(refKey(ref))
