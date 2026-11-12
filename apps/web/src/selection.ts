import { useAtomValue } from "@effect/atom-react"
import { Atom } from "effect/reactivity"
import { registry } from "./state/registry"

/** The tasks picked on the board with the lasso, to send to Now or Later together. */
interface SelectionState {
  readonly ids: ReadonlySet<string>
  readonly set: (ids: Iterable<string>) => void
  readonly clear: () => void
}

const NONE: ReadonlySet<string> = new Set()

/** The ids of the tasks picked with the lasso (the page's own state, kept while the page is open). */
export const selectionAtom: Atom.Writable<ReadonlySet<string>> = Atom.make(NONE).pipe(Atom.keepAlive)

const state = (ids: ReadonlySet<string>): SelectionState => ({
  ids,
  set: (next) => registry.set(selectionAtom, new Set(next)),
  clear: () => {
    if (registry.get(selectionAtom).size) registry.set(selectionAtom, NONE)
  },
})

function useSelectionOf<U>(selector: (s: SelectionState) => U): U {
  return useAtomValue(selectionAtom, (ids) => selector(state(ids)))
}

/**
 * The selection, read with a selector as the old store's was: `useSelection((s) => s.ids)` redraws when what it picks
 * changes (`Object.is`), and `useSelection.getState()` reads it (and sets or clears it) outside React.
 */
export const useSelection: { <U>(selector: (s: SelectionState) => U): U; getState: () => SelectionState } = Object.assign(useSelectionOf, {
  getState: () => state(registry.get(selectionAtom)),
})

/**
 * The attributes that make a card (or row, or tile) pickable with the lasso, which finds it by `data-task`,
 * and show it picked. It redraws only when its own task is picked or let go.
 */
export function useSelectable(taskId: string): { "data-task": string; "data-selected": "true" | undefined } {
  const selected = useAtomValue(selectionAtom, (ids) => ids.has(taskId))
  return { "data-task": taskId, "data-selected": selected ? "true" : undefined }
}
