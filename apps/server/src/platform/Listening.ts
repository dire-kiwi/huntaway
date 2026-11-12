import { Context, Effect, Layer, Ref } from "effect"
import { ServerConfig } from "./ServerConfig.ts"

/**
 * The port the server listens on, for what tells another process where to reach it (a run's MCP servers' URL). It is
 * `--port` until the listener binds, and the port the listener got after: `--port 0` (test servers) asks for a free one,
 * which only the bound listener knows. The entry (`bin.ts`) records it once the listener is up.
 */
export class Listening extends Context.Service<
  Listening,
  {
    /** The port to reach the server on, from this host. */
    readonly port: Effect.Effect<number>
    /** The listener bound `port`. */
    readonly bound: (port: number) => Effect.Effect<void>
  }
>()("huntaway-server/platform/Listening") {
  static readonly layer = Layer.effect(
    Listening,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const port = yield* Ref.make(config.port)
      return Listening.of({ port: Ref.get(port), bound: (p) => Ref.set(port, p) })
    }),
  )
}
