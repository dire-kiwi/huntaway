import { BrowserKeyValueStore } from "@effect/platform-browser"
import { Schema } from "effect"
import { Atom } from "effect/reactivity"

// Browser storage for the page's own state (docs/plan/09-frontend.md): a schema per key, read leniently (a value an
// older build wrote that does not decode is the default), under the old `ia.*` keys so preferences and drafts survive
// the switch, and in the old format, which the step-1 components still read and write directly.
//
// - A key the old build kept as JSON (lists, records, drafts) is an `Atom.kvs` over `localStorage`, which keeps JSON.
// - A key it kept as a bare string (`ia.boardView` is `board`, not `"board"`) is `storedBare`: `Atom.kvs` would write
//   `"board"`, which the components that read the key themselves would not understand.

/** The runtime the JSON keys are read and written through. */
export const storageRuntime = Atom.runtime(BrowserKeyValueStore.layerLocalStorage)

/** An atom kept as JSON under `key`, decoded with `schema`; `fallback` when missing or unreadable. */
export const stored = <S extends Schema.ConstraintCodec<unknown, unknown>>(key: string, schema: S, fallback: S["Type"]): Atom.Writable<S["Type"]> =>
  Atom.kvs({ runtime: storageRuntime, key, schema, defaultValue: () => fallback })

// Storage may throw (a browser that blocks it): then nothing is kept, and the atom holds the value for this page.
function load(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function save(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Kept for this page only.
  }
}

/** An atom kept as a bare string under `key` (null removes it), one `schema` accepts; `fallback` when missing or not. */
export function storedBare<A extends string, F extends A | null>(key: string, schema: Schema.Schema<A>, fallback: F): Atom.Writable<A | F> {
  const valid = Schema.is(schema)
  return Atom.writable(
    () => {
      const raw = load(key)
      return raw !== null && valid(raw) ? raw : fallback
    },
    (ctx, value: A | F) => {
      save(key, value)
      ctx.setSelf(value)
    },
  )
}
