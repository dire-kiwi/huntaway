import { useEffect, useEffectEvent, useState } from "react"
import { sameJson } from "./useGitStatus"
import { errText } from "./model"

/** What a read gave for its key: its answer, or why it failed. */
export interface Loaded<T> {
  key: string
  value?: T
  error?: string
}

/**
 * What `load` gives, read again whenever `key` changes (null: nothing to read), until then what it gave for the key
 * before. An answer the same as the last is kept as it was, so what depends on it isn't drawn or fetched again.
 * (Step 1: the old components' fetch-in-an-effect with a stale guard, in one place; step 2 makes these queries.)
 */
export function useLoaded<T>(key: string | null, load: () => Promise<T>): Loaded<T> | null {
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null)
  const read = useEffectEvent(load)
  useEffect(() => {
    if (key === null) return undefined
    let stale = false
    read().then(
      (value) => {
        if (stale) return
        setLoaded((p) => {
          const before = p?.value
          return { key, value: before !== undefined && sameJson(before, value) ? before : value }
        })
      },
      (e: unknown) => {
        if (!stale) setLoaded({ key, error: errText(e) })
      },
    )
    return () => {
      stale = true
    }
  }, [key])
  return loaded
}
