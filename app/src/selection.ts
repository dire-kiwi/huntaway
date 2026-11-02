import { create } from "zustand";

/** The tasks picked on the board with the lasso, to send to Now or Later together. */
interface SelectionState {
  ids: ReadonlySet<string>;
  set: (ids: Iterable<string>) => void;
  clear: () => void;
}

const NONE: ReadonlySet<string> = new Set();

export const useSelection = create<SelectionState>((set) => ({
  ids: NONE,
  set: (ids) => set({ ids: new Set(ids) }),
  clear: () => set((s) => (s.ids.size ? { ids: NONE } : s)),
}));

/**
 * The attributes that make a card (or row, or tile) pickable with the lasso, which finds it by `data-task`,
 * and show it picked. It redraws only when its own task is picked or let go.
 */
export function useSelectable(taskId: string) {
  const selected = useSelection((s) => s.ids.has(taskId));
  return { "data-task": taskId, "data-selected": selected ? "true" : undefined };
}
