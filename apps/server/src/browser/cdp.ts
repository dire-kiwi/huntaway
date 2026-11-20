import { Deferred, Duration, Effect, Option, Predicate, PubSub, Ref, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { toJson } from "../platform/columns.ts"

// The Chrome DevTools Protocol over any carrier of whole JSON messages (HE-62): Chrome's own pipe (`chrome.ts`), or the
// desktop app's relay to its browser pane's <webview> (`Browser.attachDesktop`). Commands are `{id, method, params,
// sessionId?}`; answers `{id, result}` or `{id, error}`; events `{method, params, sessionId?}`. The connection lives as
// long as the scope it is made in, and is gone once its messages end: whatever still waits then fails.

/** A command failed: Chrome said why, it didn't answer in time, or the connection is gone. */
export class CdpError extends Schema.TaggedError<CdpError, { readonly brand: unique symbol }>()("CdpError", {
  reason: Schema.String,
}) {}

/** An event, with the session it came from (none for the browser itself, or a page reached directly). */
export interface CdpEvent {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
  readonly sessionId: string | undefined
}

export type CdpResult = Readonly<Record<string, unknown>>

export interface Cdp {
  /** Send `method` (to `sessionId`'s target, when given) and wait at most `timeout` (30 seconds by default) for its answer. */
  readonly send: (
    method: string,
    params?: Readonly<Record<string, unknown>>,
    sessionId?: string,
    timeout?: Duration.Input,
  ) => Effect.Effect<CdpResult, CdpError>
  /** Its events from now on, for as long as the scope lasts. */
  readonly subscribe: Effect.Effect<PubSub.Subscription<CdpEvent>, never, Scope.Scope>
  /** Waits until the connection is gone, and says why. */
  readonly closed: Effect.Effect<string>
  /** Why it is gone, once it is; null before. */
  readonly status: Effect.Effect<string | null>
}

const Json = Schema.fromJsonString(Schema.Unknown)
const parse = Schema.decodeUnknownOption(Json)
const encodePretty = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
const encodeCompact = Schema.encodeOption(Json)

/** `v` as JSON (indented when `pretty`), or its string form when it isn't JSON. */
export const jsonText = (v: unknown, pretty = false): string => Option.getOrElse((pretty ? encodePretty : encodeCompact)(v), () => String(v))

export const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => Predicate.isObject(v) && !Array.isArray(v)

/** A string field of a record, or "". */
export const str = (r: Readonly<Record<string, unknown>> | undefined, key: string): string => {
  const v = r?.[key]
  return typeof v === "string" ? v : ""
}

/** A finite number field of a record, or `fallback`. */
export const num = (r: Readonly<Record<string, unknown>> | undefined, key: string, fallback = 0): number => {
  const v = r?.[key]
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

/**
 * A CDP connection that sends with `write` (one JSON message) and reads `messages` (one JSON message each) until they
 * end, when it is gone with `ended`'s reason.
 */
export const makeCdp = Effect.fnUntraced(function* <E>(
  write: (message: string) => Effect.Effect<void>,
  messages: Stream.Stream<string, E>,
  ended: Effect.Effect<string> = Effect.succeed("the browser closed"),
): Effect.fn.Return<Cdp, never, Scope.Scope> {
  const pending = yield* Ref.make<ReadonlyMap<number, Deferred.Deferred<CdpResult, CdpError>>>(new Map())
  const nextId = yield* Ref.make(1)
  const status = yield* Ref.make<string | null>(null)
  const gone = yield* Deferred.make<string>()
  const events = yield* PubSub.unbounded<CdpEvent>()

  const close = (why: string) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(status)) !== null) return
      yield* Ref.set(status, why)
      for (const p of (yield* Ref.getAndSet(pending, new Map())).values()) yield* Deferred.fail(p, new CdpError({ reason: why }))
      yield* Deferred.succeed(gone, why)
    })

  const onMessage = Effect.fnUntraced(function* (text: string) {
    const v = Option.getOrUndefined(parse(text))
    if (!isRecord(v)) return
    const sessionId = typeof v["sessionId"] === "string" ? v["sessionId"] : undefined
    const id = v["id"]
    if (typeof id !== "number") {
      const method = v["method"]
      if (typeof method === "string") yield* PubSub.publish(events, { method, params: isRecord(v["params"]) ? v["params"] : {}, sessionId })
      return
    }
    const p = (yield* Ref.get(pending)).get(id)
    if (p === undefined) return
    yield* Ref.update(pending, (m) => new Map([...m].filter(([k]) => k !== id)))
    const error = v["error"]
    if (isRecord(error)) yield* Deferred.fail(p, new CdpError({ reason: str(error, "message") || "the browser refused the command" }))
    else yield* Deferred.succeed(p, isRecord(v["result"]) ? v["result"] : {})
  })

  yield* messages.pipe(Stream.runForEach(onMessage), Effect.ignore, Effect.andThen(Effect.flatMap(ended, close)), Effect.forkScoped)
  yield* Effect.addFinalizer(() => close("the browser was closed"))

  const send: Cdp["send"] = (method, params = {}, sessionId, timeout = "30 seconds") =>
    Effect.gen(function* () {
      const why = yield* Ref.get(status)
      if (why !== null) return yield* new CdpError({ reason: why })
      const done = yield* Deferred.make<CdpResult, CdpError>()
      const id = yield* Ref.getAndUpdate(nextId, (n) => n + 1)
      yield* Ref.update(pending, (m) => new Map([...m, [id, done]]))
      yield* write(yield* toJson(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }))
      return yield* Deferred.await(done).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Ref.update(pending, (m) => new Map([...m].filter(([k]) => k !== id))).pipe(
              Effect.andThen(Effect.fail(new CdpError({ reason: `the browser didn't answer ${method} within ${Math.round(Duration.toSeconds(timeout))}s` }))),
            ),
        }),
      )
    })

  return {
    send,
    subscribe: PubSub.subscribe(events),
    closed: Deferred.await(gone),
    status: Ref.get(status),
  }
})

/** One page of a connection: its session's commands and events (`sessionId` undefined for a page reached directly). */
export interface CdpPage {
  readonly send: (method: string, params?: Readonly<Record<string, unknown>>, timeout?: Duration.Input) => Effect.Effect<CdpResult, CdpError>
  /** The page's events from now on, while the scope lasts. */
  readonly subscribe: Effect.Effect<PubSub.Subscription<CdpEvent>, never, Scope.Scope>
  readonly sessionId: string | undefined
}

export const pageOf = (cdp: Cdp, sessionId: string | undefined): CdpPage => ({
  send: (method, params, timeout) => cdp.send(method, params, sessionId, timeout),
  subscribe: cdp.subscribe,
  sessionId,
})

/** The page's next event `match` picks, from subscription `sub`, within `timeout`; none when it doesn't come. */
export const nextEvent = (
  page: CdpPage,
  sub: PubSub.Subscription<CdpEvent>,
  match: (e: CdpEvent) => boolean,
  timeout: Duration.Input,
): Effect.Effect<Option.Option<CdpEvent>> =>
  PubSub.take(sub).pipe(Effect.repeat({ until: (e) => e.sessionId === page.sessionId && match(e) }), Effect.timeoutOption(timeout))
