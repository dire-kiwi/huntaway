import { Cause, Effect, Exit, Option, Predicate, Queue, Schema, Stream, SubscriptionRef } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { type HostId, PROTOCOL, type Unavailable } from "@huntaway/contracts"
import { HostClient } from "../session/HostClient.ts"
import { HostSession, setOffline, setState } from "../session/HostSession.ts"
import { hostRuntime } from "../session/sessions.ts"
import { applyBoardEvent, emptyHostBoard, type HostBoard } from "./hostBoard.ts"
import { liveTaskChanged } from "./live.ts"

/** The host speaks another protocol: the session stops until the page is reloaded (or the host updated). */
class NeedsUpdate extends Schema.TaggedError<NeedsUpdate, { readonly brand: unique symbol }>()("NeedsUpdate", { protocol: Schema.Int }) {}

/** Why a subscription ended, as the loop below acts on it. */
const ending = (cause: Cause.Cause<unknown>): "interrupted" | "unauthorized" | { readonly protocol: number } | { readonly error: string } => {
  if (Cause.hasInterruptsOnly(cause)) return "interrupted"
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (Predicate.isTagged(error, "NeedsUpdate") && Predicate.hasProperty(error, "protocol") && typeof error.protocol === "number")
    return { protocol: error.protocol }
  if (Predicate.isTagged(error, "Unauthorized")) return "unauthorized"
  return { error: error instanceof Error ? error.message : Cause.pretty(cause) }
}

/**
 * One host's board as a stream: `board.watch` folded with `applyBoardEvent`, from `initial` (what it showed before, if
 * anything). A subscription that drops waits for the connection and subscribes again with the last `{ boot, seq }`, so
 * the host replays what it missed or sends a fresh snapshot; after `resync` it subscribes without `since`. While it is
 * offline the board stays as it was. The session's state follows: live on `hello`, offline when the stream drops,
 * unauthorized (and stopped) when the host turns the token down.
 */
export const watchBoard = (host: HostId, initial: HostBoard | undefined): Stream.Stream<HostBoard, never, HostClient | HostSession> =>
  Stream.callback<HostBoard, never, HostClient | HostSession>(
    (queue) =>
      Effect.gen(function* () {
        const client = yield* HostClient
        const session = yield* HostSession
        let board = initial ?? emptyHostBoard(host)
        let loaded = initial !== undefined
        let fresh = false
        // The number `hello` continues from: events after it are live, those up to it a replay (6.8).
        let liveFrom = Number.POSITIVE_INFINITY
        // What the host says of itself, on every connection: its name and capabilities may have changed.
        const greet = Effect.fn("watchBoard.greet")(function* () {
          const info = yield* client("host.info", undefined)
          if (info.protocol !== PROTOCOL) return yield* new NeedsUpdate({ protocol: info.protocol })
          return yield* SubscriptionRef.set(session.view, { state: { _tag: "live" }, info })
        })
        const apply = Effect.fn("watchBoard.apply")(function* (message: Parameters<typeof applyBoardEvent>[1]) {
          if (message.type === "hello") {
            liveFrom = message.seq
            yield* greet()
          }
          if (message.type === "resync") fresh = true
          if (message.type === "snapshot") loaded = true
          const next = applyBoardEvent(board, message)
          if (next !== board || message.type === "snapshot") {
            const prev = board
            board = next
            if (loaded) yield* Queue.offer(queue, board)
            if (message.type === "task" && loaded && message.seq > liveFrom) {
              const was = prev.tasks.get(message.task.id)
              const now = next.tasks.get(message.task.id)
              if (now !== undefined && now !== was) liveTaskChanged(was, now)
            }
          }
        })
        // Subscribe after the atom that runs this has been built, not while it is: an answer that comes at once
        // would change the atoms that read it while they are being built, and they would subscribe again.
        yield* Effect.yieldNow
        while (true) {
          let heard = false
          const since = loaded && !fresh ? { since: { boot: board.boot, seq: board.seq } } : {}
          fresh = false
          const exit = yield* client("board.watch", since).pipe(
            Stream.runForEach((message) => {
              if (message.type === "hello") heard = true
              return apply(message)
            }),
            Effect.exit,
          )
          if (Exit.isFailure(exit)) {
            const why = ending(exit.cause)
            if (why === "interrupted") return yield* Effect.interrupt
            if (why === "unauthorized") return yield* setState(session, { _tag: "unauthorized" })
            if ("protocol" in why) return yield* setState(session, { _tag: "needs_update", protocol: why.protocol })
            yield* setOffline(session, why.error)
          }
          // Subscribe again once connected; not at once when this one never got going, so a host that keeps ending
          // the stream is not asked in a loop.
          yield* session.connected.await
          if (!heard) yield* Effect.sleep("1 second")
        }
      }),
    { bufferSize: 1, strategy: "sliding" },
  )

/**
 * Everything one host's board stream has said so far, kept for the whole page. On a reconnect, or when its runtime is
 * rebuilt (a new token), it continues from what it had.
 */
export const hostBoardAtom: (host: HostId) => Atom.Atom<AsyncResult.AsyncResult<HostBoard, Unavailable | Cause.NoSuchElementError>> = Atom.family(
  (host: HostId) =>
    hostRuntime(host)
      .atom((get) => watchBoard(host, Option.getOrUndefined(Option.flatMap(get.self<AsyncResult.AsyncResult<HostBoard, unknown>>(), AsyncResult.value))))
      .pipe(Atom.keepAlive),
)
