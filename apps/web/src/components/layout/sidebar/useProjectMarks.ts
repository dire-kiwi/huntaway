import { useAtom } from "@effect/atom-react"
import { useMemo, useState } from "react"
import type { HostProject as Project } from "@huntaway/client"
import { hiddenKey } from "../../../projectGroups"
import { favoriteProjectsAtom, hiddenProjectsAtom, pinnedProjectsAtom } from "../../../state/prefs"

/** `keys` with `list`'s keys added (`on`) or taken out. */
const marked = (keys: ReadonlyArray<string>, list: ReadonlyArray<Project>, on: boolean): ReadonlyArray<string> => {
  const next = new Set(keys)
  for (const p of list) {
    if (on) next.add(hiddenKey(p))
    else next.delete(hiddenKey(p))
  }
  return [...next]
}

/** Which projects are hidden, pinned and favorites, saved in this browser, and which hosts show their hidden ones. */
export function useProjectMarks() {
  const [hiddenKeys, setHidden] = useAtom(hiddenProjectsAtom)
  const [pinnedKeys, setPinned] = useAtom(pinnedProjectsAtom)
  const [favoriteKeys, setFavorites] = useAtom(favoriteProjectsAtom)
  const hidden = useMemo(() => new Set(hiddenKeys), [hiddenKeys])
  const pinned = useMemo(() => new Set(pinnedKeys), [pinnedKeys])
  const favorites = useMemo(() => new Set(favoriteKeys), [favoriteKeys])
  /** Hosts whose hidden projects are shown, under their other projects (for this session). */
  const [showHidden, setShowHidden] = useState<Set<string>>(new Set())

  const isPinned = (p: Project) => pinned.has(hiddenKey(p))
  // Favorites are listed above the others, in a section of their own, unless they're hidden.
  const isFavorite = (p: Project) => favorites.has(hiddenKey(p)) && !hidden.has(hiddenKey(p))

  /** Hides `list` from the sidebar, or shows them again. */
  const setProjectsHidden = (list: ReadonlyArray<Project>, on: boolean) => setHidden((old) => marked(old, list, on))

  /** Pins `list` to the sidebar of every profile, or unpins them. */
  const setProjectsPinned = (list: ReadonlyArray<Project>, on: boolean) => setPinned((old) => marked(old, list, on))

  /** Lists `list` under *Favorites*, above the other projects, or takes them out. A hidden project made a favorite is shown again. */
  const setProjectsFavorite = (list: ReadonlyArray<Project>, on: boolean) => {
    setFavorites((old) => marked(old, list, on))
    if (on) setProjectsHidden(list, false)
  }

  return { hidden, pinned, favorites, showHidden, setShowHidden, isPinned, isFavorite, setProjectsHidden, setProjectsPinned, setProjectsFavorite }
}

export type ProjectMarks = ReturnType<typeof useProjectMarks>
