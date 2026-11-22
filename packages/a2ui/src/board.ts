// The board's A2UI catalogs (HE-77): what agents are taught and checked against, and what the web app draws. A2UI's
// basic catalog, and the board's macros (`boardMacros.ts`) as a sidecar catalog: the model calls a macro by name, and
// `MacroExpander.transformToTransport` lowers it to basic components before it's drawn, so the renderer only knows the
// basic catalog.
import type { CatalogApi } from "@a2ui/web_core"
import { BOARD_MACROS } from "./boardMacros.ts"
import { basicCatalog } from "./catalog.ts"
import { MacroExpander } from "./macros/index.ts"
import type { MessageLike } from "./macros/index.ts"

/**
 * An expander for the board's macros. The envelope keys are written bare (`catalogId`), as the published
 * `@a2ui/web_core` 0.15 reads them (A2UI's main has moved to `@catalogId`); a macro call that doesn't lower is an error,
 * shown on its block, rather than a component the renderer doesn't know.
 */
export const boardExpander = (): MacroExpander => new MacroExpander(BOARD_MACROS, { envelopeKeys: "bare", onError: "raise" })

/** The catalogs an agent writes against (the inference catalogs): the basic one and the macros'. */
export const boardCatalogs = (): ReadonlyArray<CatalogApi> => boardExpander().transformCatalogs([basicCatalog()])

/** How a block's messages are lowered for the renderer: the macros expanded. One per thread (it tracks the surfaces). */
export const boardTransform = (): ((messages: ReadonlyArray<unknown>) => ReadonlyArray<unknown>) => {
  const expander = boardExpander()
  expander.transformCatalogs([basicCatalog()])
  return (messages) => expander.transformToTransport(messages.filter(isMessage))
}

const isMessage = (m: unknown): m is MessageLike => typeof m === "object" && m !== null
