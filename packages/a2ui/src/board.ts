// The board's A2UI catalogs (HE-77): what agents are taught and checked against, and what the web app draws. The basic
// catalog, with the board's own macros (`boardMacros.ts`) as a sidecar catalog once they are defined: the model calls a
// macro by name, and `MacroExpander.transformToTransport` lowers it to basic components before it is drawn.
import type { CatalogApi } from "@a2ui/web_core"
import { basicCatalog } from "./catalog.ts"

/** The catalogs an agent writes against (the inference catalogs). */
export const boardCatalogs = (): ReadonlyArray<CatalogApi> => [basicCatalog()]

/** How a block's messages are lowered for the renderer: the macros expanded, when there are any. */
export const boardTransform = (): ((messages: ReadonlyArray<unknown>) => ReadonlyArray<unknown>) | undefined => undefined
