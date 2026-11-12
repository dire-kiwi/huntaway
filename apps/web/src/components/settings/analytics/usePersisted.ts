import { useAtom } from "@effect/atom-react"
import type { Atom } from "effect/reactivity"

/**
 * What the page keeps of a choice: `{"value": …}` under its `ia.analytics.*` key, as the old page kept it (a `stored`
 * atom of `Schema.NullOr(Schema.Struct({ value }))`); null until one is made.
 */
export type Kept<T> = { readonly value: T } | null

/** The choice kept in `atom`, `initial` until one is made, and how to make one. */
export function usePersisted<T>(atom: Atom.Writable<Kept<T>>, initial: T): [T, (v: T) => void] {
  const [kept, setKept] = useAtom(atom)
  return [kept === null ? initial : kept.value, (value: T) => setKept({ value })]
}
