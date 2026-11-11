import { useState } from "react"
import { closedFolders, saveClosedFolders, type DocsHome, type DocsView } from "../docs"

/** Folders (or labels) that close and open as the user left them, kept in this browser. */
export function useClosed(home: DocsHome, kind: DocsView) {
  const [closed, setClosed] = useState(() => closedFolders(home, kind))
  const remember = (next: Set<string>) => {
    setClosed(next)
    saveClosedFolders(home, next, kind)
  }
  const toggle = (path: string) => {
    const next = new Set(closed)
    if (!next.delete(path)) next.add(path)
    remember(next)
  }
  return { closed, remember, toggle }
}
