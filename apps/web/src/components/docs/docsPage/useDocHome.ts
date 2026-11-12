import { useAtomValue } from "@effect/atom-react"
import type { DocsHome } from "../docs"
import { docHomeAtom, type Found } from "./reads"

/** The document's host, of those the route's profile stands for: the first that has it. */
export function useDocHome(homes: ReadonlyArray<DocsHome>, slug: string): Found {
  return useAtomValue(docHomeAtom({ homes, slug }))
}
