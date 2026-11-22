// The board's A2UI catalogs (HE-77): what agents are taught and checked against, and what the web app draws. A2UI's
// basic catalog, and the board's macros (`boardMacros.ts`) as a sidecar catalog: the model calls a macro by name, and
// `MacroExpander.transformToTransport` lowers it to basic components before it's drawn, so the renderer only knows the
// basic catalog.
import type { CatalogApi } from "@a2ui/web_core"
import { BOARD_MACROS } from "./boardMacros.ts"
import { basicCatalog, PROTOCOL_VERSION } from "./catalog.ts"
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

/**
 * How a block's messages are lowered for the renderer: the macros expanded. One per thread (it tracks the surfaces).
 *
 * A block that draws a `Choice` on a surface already there (`update=true`) first clears the surface's picks
 * (`/choice`): the update replaces the components and keeps the data, and the new `Choice` usually has the old one's id
 * (`root`), so it would start with the answer to the earlier question, and its button would send that. Cleared before
 * the block's own messages, so a value it sets itself still holds.
 */
export const boardTransform = (): ((messages: ReadonlyArray<unknown>) => ReadonlyArray<unknown>) => {
  const expander = boardExpander()
  expander.transformCatalogs([basicCatalog()])
  return (messages) => {
    const fresh = choicesRedrawn(messages).map((surfaceId) => ({ version: PROTOCOL_VERSION, updateDataModel: { surfaceId, path: CHOICE_PATH } }))
    return [...fresh, ...expander.transformToTransport(messages.filter(isMessage))]
  }
}

/** Where the board's `Choice` keeps its picks (`boardMacros.ts`). */
const CHOICE_PATH = "/choice"

/** The surfaces a block's `updateComponents` draws a `Choice` on (an update: a new surface has no picks yet). */
function choicesRedrawn(messages: ReadonlyArray<unknown>): ReadonlyArray<string> {
  const ids: Array<string> = []
  for (const m of messages) {
    const body = isRecord(m) ? m["updateComponents"] : undefined
    if (!isRecord(body) || typeof body["surfaceId"] !== "string" || !Array.isArray(body["components"])) continue
    if (body["components"].some((c) => isRecord(c) && c["component"] === "Choice") && !ids.includes(body["surfaceId"])) ids.push(body["surfaceId"])
  }
  return ids
}

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null && !Array.isArray(v)

const isMessage = (m: unknown): m is MessageLike => typeof m === "object" && m !== null
