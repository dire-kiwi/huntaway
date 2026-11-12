import { useAtom } from "@effect/atom-react"
import { Schema } from "effect"
import { Atom } from "effect/reactivity"
import { useMemo } from "react"
import { stored } from "../../../state/storage"
import type { DocsHome, DocsView } from "../docs"

/** Where a host's profile's closed folders (or labels) on the Docs page are kept in this browser. */
const closedKey = (home: DocsHome, kind: DocsView) => `ia.docs.${kind === "labels" ? "closedLabels" : "closedFolders"}:${home.hostId}:${home.profileId}`

/** The folders (or labels) of a host's profile that were closed on the Docs page (all open, the first time). */
const closedAtom = Atom.family((key: string) => stored(key, Schema.Array(Schema.String), []))

/** Folders (or labels) that close and open as the user left them, kept in this browser. */
export function useClosed(home: DocsHome, kind: DocsView) {
  const [list, setList] = useAtom(closedAtom(closedKey(home, kind)))
  const closed = useMemo(() => new Set(list), [list])
  const remember = (next: ReadonlySet<string>) => setList([...next])
  const toggle = (path: string) => {
    const next = new Set(closed)
    if (!next.delete(path)) next.add(path)
    remember(next)
  }
  return { closed, remember, toggle }
}
