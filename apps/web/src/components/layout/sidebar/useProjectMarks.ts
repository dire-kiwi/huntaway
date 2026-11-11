import { useState } from "react"
import type { HostProject as Project } from "@huntaway/client"
import {
  hiddenKey,
  loadFavoriteProjects,
  loadHiddenProjects,
  loadPinnedProjects,
  saveFavoriteProjects,
  saveHiddenProjects,
  savePinnedProjects,
} from "../../../projectGroups"

/** Which projects are hidden, pinned and favorites, saved in this browser, and which hosts show their hidden ones. */
export function useProjectMarks() {
  const [hidden, setHidden] = useState(loadHiddenProjects)
  const [pinned, setPinned] = useState(loadPinnedProjects)
  const [favorites, setFavorites] = useState(loadFavoriteProjects)
  /** Hosts whose hidden projects are shown, under their other projects (for this session). */
  const [showHidden, setShowHidden] = useState<Set<string>>(new Set())

  const isPinned = (p: Project) => pinned.has(hiddenKey(p))
  // Favorites are listed above the others, in a section of their own, unless they're hidden.
  const isFavorite = (p: Project) => favorites.has(hiddenKey(p)) && !hidden.has(hiddenKey(p))

  /** Hides `list` from the sidebar, or shows them again. */
  const setProjectsHidden = (list: ReadonlyArray<Project>, on: boolean) =>
    setHidden((old) => {
      const next = new Set(old)
      for (const p of list) {
        if (on) next.add(hiddenKey(p))
        else next.delete(hiddenKey(p))
      }
      saveHiddenProjects(next)
      return next
    })

  /** Pins `list` to the sidebar of every profile, or unpins them. */
  const setProjectsPinned = (list: ReadonlyArray<Project>, on: boolean) =>
    setPinned((old) => {
      const next = new Set(old)
      for (const p of list) {
        if (on) next.add(hiddenKey(p))
        else next.delete(hiddenKey(p))
      }
      savePinnedProjects(next)
      return next
    })

  /** Lists `list` under *Favorites*, above the other projects, or takes them out. A hidden project made a favorite is shown again. */
  const setProjectsFavorite = (list: ReadonlyArray<Project>, on: boolean) => {
    setFavorites((old) => {
      const next = new Set(old)
      for (const p of list) {
        if (on) next.add(hiddenKey(p))
        else next.delete(hiddenKey(p))
      }
      saveFavoriteProjects(next)
      return next
    })
    if (on) setProjectsHidden(list, false)
  }

  return { hidden, pinned, favorites, showHidden, setShowHidden, isPinned, isFavorite, setProjectsHidden, setProjectsPinned, setProjectsFavorite }
}

export type ProjectMarks = ReturnType<typeof useProjectMarks>
