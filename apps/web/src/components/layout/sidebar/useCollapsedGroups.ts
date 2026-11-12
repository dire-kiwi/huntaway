import { useAtom } from "@effect/atom-react"
import { useMemo } from "react"
import { collapsedGroupsAtom } from "../../../state/prefs"

/** The groups whose projects are left out (by `groupKey`), saved in this browser. */
export function useCollapsedGroups() {
  const [keys, setKeys] = useAtom(collapsedGroupsAtom)
  const collapsed = useMemo(() => new Set(keys), [keys])

  const setCollapsedGroup = (key: string, on: boolean) =>
    setKeys((old) => {
      const next = new Set(old)
      if (on) next.add(key)
      else next.delete(key)
      return [...next]
    })

  return { collapsed, setCollapsedGroup }
}
