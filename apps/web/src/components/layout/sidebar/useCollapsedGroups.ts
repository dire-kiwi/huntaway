import { useState } from "react"
import { loadCollapsedGroups, saveCollapsedGroups } from "../../../projectGroups"

/** The groups whose projects are left out (by `groupKey`), saved in this browser. */
export function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState(loadCollapsedGroups)

  const setCollapsedGroup = (key: string, on: boolean) =>
    setCollapsed((old) => {
      const next = new Set(old)
      if (on) next.add(key)
      else next.delete(key)
      saveCollapsedGroups(next)
      return next
    })

  return { collapsed, setCollapsedGroup }
}
