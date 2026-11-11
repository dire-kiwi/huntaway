import { useSyncExternalStore } from "react"

/**
 * A small store of this page's own state, read with a selector as zustand's `create` gave the old selection and
 * drawer stores: `useX(selector)` redraws when the selected value changes (`Object.is`), `useX.getState()` reads it
 * outside React.
 */
export interface SmallStore<T> {
  <U>(selector: (state: T) => U): U
  getState(): T
}

export function createStore<T>(init: (set: (change: Partial<T> | ((state: T) => Partial<T> | T)) => void) => T): SmallStore<T> {
  const listeners = new Set<() => void>()
  let state: T
  const set = (change: Partial<T> | ((state: T) => Partial<T> | T)): void => {
    const next = typeof change === "function" ? change(state) : change
    if (Object.is(next, state)) return
    state = { ...state, ...next }
    for (const l of listeners) l()
  }
  state = init(set)
  const subscribe = (l: () => void): (() => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }
  const use = <U>(selector: (state: T) => U): U => useSyncExternalStore(subscribe, () => selector(state))
  return Object.assign(use, { getState: () => state })
}
