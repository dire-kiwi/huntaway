// HE-79: where the Code tab of a task is, kept for the page's life (the tab is left and come back to, another task
// opened): the file and line shown, the places gone back from, the folders open, and the symbol looked up.
import { Atom } from "effect/reactivity"
import { ancestors } from "./tree"

/** A file, and a line of it (from 1) to show. */
export interface Place {
  readonly path: string
  readonly line: number | null
}

/** A symbol looked up: its name, and the file it was clicked in (whose hits come first). */
export interface Looked {
  readonly name: string
  readonly from: string
}

export interface CodeState {
  readonly at: Place | null
  /** Where the back button goes: the places before, the last most recent. */
  readonly back: ReadonlyArray<Place>
  readonly open: ReadonlySet<string>
  readonly symbol: Looked | null
  /** The side panel's outline of the file, when no symbol is looked up. */
  readonly outline: boolean
}

const START: CodeState = { at: null, back: [], open: new Set(), symbol: null, outline: false }

/** The tab's state, by host and task. */
export const codeState = Atom.family((_key: string) => Atom.make(START).pipe(Atom.keepAlive))

const MAX_BACK = 50

/** Goes to `place` (opening the folders it's in), the place it was at kept to go back to. */
export function goTo(s: CodeState, place: Place): CodeState {
  const same = s.at?.path === place.path && s.at.line === place.line
  if (same) return s
  const open = new Set(s.open)
  for (const a of ancestors(place.path)) open.add(a)
  const back = s.at ? [...s.back, s.at].slice(-MAX_BACK) : s.back
  return { ...s, at: place, back, open }
}

/** Goes back to the place before. */
export function goBack(s: CodeState): CodeState {
  const at = s.back.at(-1)
  if (!at) return s
  const open = new Set(s.open)
  for (const a of ancestors(at.path)) open.add(a)
  return { ...s, at, back: s.back.slice(0, -1), open }
}

export function toggleFolder(s: CodeState, path: string): CodeState {
  const open = new Set(s.open)
  if (!open.delete(path)) open.add(path)
  return { ...s, open }
}
