import { Effect, Schema } from "effect"
import type { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { PluginSession } from "./context.ts"
import { PluginError } from "./errors.ts"

// What a plugin's pages call (docs/plan/15-plugins.md, Calls): `huntaway.call(method, payload)` in a frame goes over
// the board's RPC (`plugins.call`) to the host the page came from, as the session the board has, and is refused when
// that session lacks the method's scope. And its HTTP routes, for what isn't a page: `/plugins/<id>/<path>`.

/** The scope a call needs, as the board's own RPCs state theirs. */
export type CallScope = "read" | "operate" | "settings"

export interface PluginCall {
  readonly scope: CallScope
  /** Given the payload as JSON; gives JSON. Made with `pluginCall`. */
  readonly run: (payload: unknown, session: PluginSession) => Effect.Effect<unknown, PluginError>
}

/** A call whose payload decodes with `payload` (else `invalid`) and whose result encodes with `success`. */
export const pluginCall = <P extends Schema.Top & { readonly DecodingServices: never }, S extends Schema.Top & { readonly EncodingServices: never }>(options: {
  readonly scope: CallScope
  readonly payload: P
  readonly success: S
  readonly handle: (payload: P["Type"], session: PluginSession) => Effect.Effect<S["Type"], PluginError>
}): PluginCall => {
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(options.payload))
  const encode = Schema.encodeEffect(Schema.toCodecJson(options.success))
  return {
    scope: options.scope,
    run: (payload, session) =>
      decode(payload).pipe(
        Effect.mapError((e) => PluginError.invalid(e.message)),
        Effect.flatMap((p) => options.handle(p, session)),
        Effect.flatMap((result) => Effect.orDie(encode(result))),
      ),
  }
}

/**
 * An HTTP route at `/plugins/<plugin id><path>` (`path` starts with `/`; `:name` segments are `HttpRouter.params`).
 * `board` (the default) answers only a request with the board token as its bearer token; a `public` route answers
 * anyone who reaches the board, so it checks what it needs itself (a webhook's signature).
 */
export interface PluginRoute {
  readonly method: "*" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  readonly path: `/${string}`
  readonly auth?: "board" | "public" | undefined
  readonly handle: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpRouter.RouteContext | HttpServerRequest.ParsedSearchParams>
}
