import { type Cause, Effect, Latch, Layer, Predicate, Queue, Stream, SubscriptionRef } from "effect"
import { RpcClientError } from "effect/rpc"
import { Socket } from "effect/socket"
import { type BoardEvent, type BoardMessage, type BoardSnapshot, type Health, HostId, PROTOCOL, Unauthorized } from "@huntaway/contracts"
import { connecting, HostClient, HostSession } from "../src/index.ts"
import { info, snapshot } from "./fixtures.ts"

// An in-memory host for the client's tests: a flat client that answers `board.watch` from a snapshot and a log of
// events, the way the server does (replay after `since` from the same boot, else a snapshot), and lets a test drop the
// connection, bring it back, or turn the token down. Other methods answer from `on`.

/** An answer: an effect, or a stream for a streaming method (`threads.watch`). */
type Handler = (payload: unknown) => Effect.Effect<unknown, { readonly _tag: string }> | Stream.Stream<unknown, unknown>

export interface FakeHost {
  readonly id: HostId
  readonly layer: Layer.Layer<HostClient | HostSession>
  /** The `since` of each subscription, oldest first. */
  readonly subscriptions: Array<{ readonly boot: string; readonly seq: number } | undefined>
  /** Every call but `board.watch`: method and payload. */
  readonly calls: Array<readonly [string, unknown]>
  /** How many times its session's layer was built (one connection each). */
  readonly builds: () => number
  /** The snapshot a fresh subscription gets (its `seq` is set to the log's head). */
  snapshot: BoardSnapshot
  boot: string
  on(method: string, handler: Handler): FakeHost
  /** Numbers an event after the log's head, keeps it, and sends it to the subscription open now. */
  emit(event: BoardEvent extends infer E ? (E extends { readonly seq: number } ? Omit<E, "seq"> : never) : never): Effect.Effect<void>
  /** Sends `resync` and ends the open subscription. */
  resync: Effect.Effect<void>
  /** Drops the connection: the open subscription fails as a socket's does, and the session waits. */
  drop: Effect.Effect<void>
  /** Brings the connection back. */
  reconnect: Effect.Effect<void>
  /** Turns the token down: the open subscription fails with `Unauthorized`. */
  refuse: Effect.Effect<void>
}

/** `message` with its number. */
const numbered = (message: object, seq: number): Effect.Effect<BoardMessage & { readonly seq: number }> => {
  const out = { ...message, seq }
  return isNumbered(out) ? Effect.succeed(out) : Effect.die(new Error("not a board message"))
}

const isNumbered = (u: unknown): u is BoardMessage & { readonly seq: number } => Predicate.hasProperty(u, "type") && Predicate.hasProperty(u, "seq")

const isSince = (u: unknown): u is { readonly boot: string; readonly seq: number } =>
  Predicate.hasProperty(u, "boot") && typeof u.boot === "string" && Predicate.hasProperty(u, "seq") && typeof u.seq === "number"

/** The flat client's type is a union over every method; this one answers any of them at run time. */
const isFlat = (f: unknown): f is HostClient["Service"] => typeof f === "function"

const dropped = new RpcClientError.RpcClientError({ reason: new Socket.SocketReadError({ cause: new Error("connection dropped") }) })

export const fakeHost = (id: string): Effect.Effect<FakeHost> =>
  Effect.gen(function* () {
    const connected = yield* Latch.make(true)
    const view = yield* SubscriptionRef.make(connecting)
    const log: Array<BoardMessage & { readonly seq: number }> = []
    const handlers = new Map<string, Handler>()
    let builds = 0
    let open: Queue.Queue<BoardMessage, Unauthorized | RpcClientError.RpcClientError | Cause.Done> | undefined
    const head = () => log.at(-1)?.seq ?? fake.snapshot.seq

    const watch = (since: { readonly boot: string; readonly seq: number } | undefined) =>
      Stream.unwrap(
        Effect.gen(function* () {
          fake.subscriptions.push(since)
          const queue = yield* Queue.unbounded<BoardMessage, Unauthorized | RpcClientError.RpcClientError | Cause.Done>()
          open = queue
          yield* Queue.offer(queue, { type: "hello", host_id: fake.id, boot: fake.boot, seq: head() })
          const replay = since && since.boot === fake.boot && since.seq >= fake.snapshot.seq
          if (replay)
            yield* Queue.offerAll(
              queue,
              log.filter((e) => e.seq > since.seq),
            )
          else yield* Queue.offer(queue, yield* numbered(fake.snapshot, head()))
          return Stream.fromQueue(queue)
        }),
      )

    const flat = (method: string, payload: unknown): unknown => {
      if (method === "board.watch") {
        const since = Predicate.hasProperty(payload, "since") ? payload.since : undefined
        return watch(isSince(since) ? since : undefined)
      }
      fake.calls.push([method, payload])
      const handler = handlers.get(method)
      if (handler) return handler(payload)
      return Effect.die(new Error(`the fake host has no handler for ${method}`))
    }

    const fake: FakeHost = {
      id: HostId.make(id),
      subscriptions: [],
      calls: [],
      builds: () => builds,
      snapshot: snapshot(),
      boot: "boot-1",
      layer: Layer.mergeAll(
        Layer.effect(
          HostClient,
          Effect.suspend(() => {
            builds++
            return isFlat(flat) ? Effect.succeed(flat) : Effect.die(new Error("not a client"))
          }),
        ),
        Layer.succeed(HostSession, { view, connected }),
      ),
      on(method, handler) {
        handlers.set(method, handler)
        return fake
      },
      emit: (event) =>
        Effect.gen(function* () {
          const message = yield* numbered(event, head() + 1)
          log.push(message)
          if (open) yield* Queue.offer(open, message)
        }),
      resync: Effect.suspend(() => (open ? Effect.andThen(Queue.offer(open, { type: "resync", seq: head() }), Queue.end(open)) : Effect.void)),
      drop: Effect.suspend(() => Effect.andThen(connected.close, open ? Queue.fail(open, dropped) : Effect.void)),
      reconnect: Effect.asVoid(connected.open),
      refuse: Effect.suspend(() => (open ? Effect.asVoid(Queue.fail(open, new Unauthorized())) : Effect.void)),
    }
    const health: Health = { ok: true, host_id: fake.id, version: "0.0.0-test", protocol: PROTOCOL, capabilities: [], commit: null }
    fake.on("public.health", () => Effect.succeed(health))
    fake.on("host.info", () => Effect.succeed(info(id)))
    return fake
  })
