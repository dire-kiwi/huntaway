import { useAtomValue } from "@effect/atom-react"
import { Atom } from "effect/reactivity"

// Whether the page is shown (`document.visibilityState`): what polls only while someone can see it asks with this.

const visibleNow = (): boolean => typeof document === "undefined" || document.visibilityState === "visible"

/** Whether the page is shown now, following the browser's `visibilitychange`. */
export const visibleAtom: Atom.Atom<boolean> = Atom.make((get) => {
  if (typeof document === "undefined") return true
  const changed = (): void => get.setSelf(visibleNow())
  document.addEventListener("visibilitychange", changed)
  get.addFinalizer(() => document.removeEventListener("visibilitychange", changed))
  return visibleNow()
})

/** Whether the page is shown: a component that polls passes its `refresh` only while it is. */
export const useVisible = (): boolean => useAtomValue(visibleAtom)
