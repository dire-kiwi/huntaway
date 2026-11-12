import { useAtomValue } from "@effect/atom-react"
import { useState } from "react"
import type { RenderedDocVersion } from "@huntaway/contracts"
import { errorText, isTagged } from "../../../state/mutation"
import { docPageAtom, type PageKey } from "./reads"

/** Why the page isn't shown: a page or a version that isn't there, which the view offers a way out of. */
export interface PageError {
  readonly text: string
  readonly missingPage?: boolean
  readonly missingVersion?: boolean
}

/** What a page's read failed with, as the view says it. */
function pageError(e: unknown, version: number | undefined, page: string): PageError {
  const missing = isTagged(e, "NotFound") && "what" in e && typeof e.what === "string" ? e.what : undefined
  // A version that isn't there isn't a page that isn't.
  if (missing === "version") return { text: `Version ${version} not found.`, missingVersion: true }
  const which = version === undefined ? "This document" : `Version ${version} of this document`
  return { text: missing !== undefined ? `${which} has no page “${page || "index"}”.` : errorText(e), missingPage: missing !== undefined && page !== "" }
}

/**
 * The version of the document that's shown, with the page of it the route names: read when either changes. The page
 * shown before stays until the next has been read (its menu and frame don't go blank in between).
 */
export function useDocPage(key: PageKey): { shown: RenderedDocVersion | null; error: PageError | null } {
  const read = useAtomValue(docPageAtom(key))
  const [last, setLast] = useState<RenderedDocVersion | null>(null)
  if (read.shown !== undefined && read.shown !== last) setLast(read.shown)
  return { shown: read.shown ?? last, error: "failure" in read ? pageError(read.failure, key.version, key.page) : null }
}
