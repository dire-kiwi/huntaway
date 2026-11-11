import { useState } from "react"
import { parseJson, toJson } from "../../ui"

/** A choice kept in the browser under `key`, `initial` until one is made; a kept value `is` doesn't accept is `initial`. */
export function usePersisted<T>(key: string, initial: T, is: (v: unknown) => v is T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const stored = parseJson(localStorage.getItem(key))
      return typeof stored === "object" && stored !== null && "value" in stored && is(stored.value) ? stored.value : initial
    } catch {
      return initial
    }
  })
  const set = (next: T) => {
    setV(next)
    try {
      localStorage.setItem(key, toJson({ value: next }))
    } catch {
      // Private mode: the choice just isn't remembered.
    }
  }
  return [v, set]
}
