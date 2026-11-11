import { createStore } from "./smallStore"

/** The tasks picked on the board with the lasso, to send to Now or Later together. */
interface SelectionState {
  readonly ids: ReadonlySet<string>
  readonly set: (ids: Iterable<string>) => void
  readonly clear: () => void
}

const NONE: ReadonlySet<string> = new Set()

export const useSelection = createStore<SelectionState>((set) => ({
  ids: NONE,
  set: (ids) => set({ ids: new Set(ids) }),
  clear: () => set((s) => (s.ids.size ? { ids: NONE } : s)),
}))

/**
 * The attributes that make a card (or row, or tile) pickable with the lasso, which finds it by `data-task`,
 * and show it picked. It redraws only when its own task is picked or let go.
 */
export function useSelectable(taskId: string): { "data-task": string; "data-selected": "true" | undefined } {
  const selected = useSelection((s) => s.ids.has(taskId))
  return { "data-task": taskId, "data-selected": selected ? "true" : undefined }
}
