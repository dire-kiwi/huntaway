import { useAtomValue } from "@effect/atom-react"
import { type Board, boardAtom } from "@huntaway/client"
import { registry } from "./registry"

/**
 * Reads the board, as `useStore(selector)` did: the component draws again only when what `selector` picks changes
 * (`Object.is`). The board is every host's, merged, with optimistic moves in flight.
 */
export function useBoard<T>(selector: (b: Board) => T): T {
  return useAtomValue(boardAtom, selector)
}

/** The board as it is now, outside React (event handlers, module code): what `useStore.getState()` was. */
export const board: { readonly get: () => Board } = { get: () => registry.get(boardAtom) }
