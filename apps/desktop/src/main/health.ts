import { Effect, Predicate, Schema } from "effect"
import { HttpClient } from "effect/http"

/** Something answers on the port, but not as a Huntaway server. */
export class NotHuntaway extends Schema.TaggedError<NotHuntaway, { readonly brand: unique symbol }>()("NotHuntaway", { message: Schema.String }) {}

/**
 * Whether a failure is a refused connection: nothing listens there, as opposed to a server that is slow (still starting,
 * or busy). Looks along the chain of causes for the system error's `ECONNREFUSED`.
 */
export const refused = (error: unknown): boolean => {
  let at: unknown = error
  for (let depth = 0; depth < 8 && Predicate.isObject(at); depth++) {
    if (Predicate.hasProperty(at, "code") && at.code === "ECONNREFUSED") return true
    // An AggregateError (one per address tried) is refused when every one of them is.
    if (Predicate.hasProperty(at, "errors") && Array.isArray(at.errors) && at.errors.length > 0 && at.errors.every(refused)) return true
    at = Predicate.hasProperty(at, "cause") ? at.cause : Predicate.hasProperty(at, "reason") ? at.reason : undefined
  }
  return false
}

/** One probe: "up", "refused" (nothing listens), or "other" (no answer in time, or not a success). */
const probe = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* client.get(url).pipe(
      Effect.map((response) => (response.status >= 200 && response.status < 300 ? ("up" as const) : ("other" as const))),
      Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed("other" as const) }),
      Effect.catch((error) => Effect.succeed(refused(error) ? ("refused" as const) : ("other" as const))),
    )
  })

/**
 * Whether a Huntaway server answers at `base` (`/api/health`). Only a refused connection counts as none: one that is
 * still starting (a previous launch's, or one restarting itself) is waited for, for up to `tries` probes a second apart,
 * rather than started a second time. After that, something else has the port.
 */
export const healthy = Effect.fn("healthy")(function* (base: string, port: number, tries = 10) {
  for (let i = 0; ; i++) {
    const answer = yield* probe(`${base}/api/health`)
    if (answer === "up") return true
    if (answer === "refused") return false
    if (i + 1 >= tries)
      return yield* new NotHuntaway({ message: `Something on ${base} doesn't answer as a Huntaway server. Is another program using port ${port}?` })
    yield* Effect.sleep("1 second")
  }
})
