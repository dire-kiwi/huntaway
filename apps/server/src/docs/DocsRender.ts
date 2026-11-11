import { Context, Effect, Layer, Schema } from "effect"
import type * as Lib from "@dire-kiwi/docs-render"

// The hosted docs app's renderer as WebAssembly (`@dire-kiwi/docs-render`, docs/plan/02-repository.md): Markdown and MDX
// to sanitized HTML, page paths and menus, the checks `publish_document` runs, the MDX components' reference and the
// hosted MCP server's tool definitions. It is the same code the hosted server runs, so pages render, and publishes are
// accepted or refused, as they are there. Loaded (about 1.7 MB of WebAssembly) the first time something needs it, not
// when the server starts.

/** The renderer's functions. */
export type RenderLib = typeof Lib

/** What the renderer refused, in its own words (it throws its messages as strings, the hosted server's). */
export class RenderError extends Schema.TaggedError<RenderError, { readonly brand: unique symbol }>()("RenderError", { message: Schema.String }) {}

/** A thrown value as the renderer's message. */
export const renderMessage = (e: unknown): string => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e))

/** One of the renderer's calls, its throw as a `RenderError`. */
export const rendered = <A>(f: () => A): Effect.Effect<A, RenderError> => Effect.try({ try: f, catch: (e) => new RenderError({ message: renderMessage(e) }) })

export interface DocsRenderShape {
  /** The renderer, loaded once. */
  readonly lib: Effect.Effect<RenderLib>
}

export class DocsRender extends Context.Service<DocsRender, DocsRenderShape>()("huntaway-server/docs/DocsRender") {
  static readonly layer = Layer.effect(
    DocsRender,
    Effect.map(Effect.cached(Effect.promise(() => import("@dire-kiwi/docs-render"))), (lib) => DocsRender.of({ lib })),
  )
}
