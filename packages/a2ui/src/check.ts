// The check of a reply's blocks an agent can run before it sends it (`a2ui_check`, HE-77): the same `ThreadSurfaces`
// the web app draws a thread with, over A2UI's basic catalog, so what it passes is what the board draws: each block that
// names no surface gets a surface of its own, the thread's earlier blocks come first (an `update=true` of one of their
// surfaces checks, a second `surface("<id>")` of one doesn't), and the macros are lowered and checked as drawn.
import type { CatalogApi } from "@a2ui/web_core"
import { basicCatalog } from "./catalog.ts"
import { segments } from "./message.ts"
import { ThreadSurfaces } from "./thread.ts"
import type { ThreadEntry } from "./thread.ts"

/** Lowers a block's messages for the renderer (the macro expander's `transformToTransport`). */
export type Transform = (messages: ReadonlyArray<unknown>) => ReadonlyArray<unknown>

/** What checking a reply found: the surfaces its blocks draw, or the first error and which block it's in. */
export type CheckResult =
  | { readonly ok: true; readonly blocks: number; readonly surfaces: ReadonlyArray<string> }
  | { readonly ok: false; readonly block: number; readonly error: string }

/** Why a reply with `<a2ui>` in it and no block the board draws fails. */
export const NOT_A_BLOCK =
  "The <a2ui> tag isn't a block the board draws: it must start a line of its own, outside a code fence, with </a2ui> on a line of its own after the Express. As it is, the user sees it as text."

/**
 * Checks a reply's `<a2ui>` blocks as the board would draw them, in order, against `catalogs` (the inference catalogs),
 * lowering each with `transform`. `before` is the thread's earlier blocks' sources, in order. A reply with no `<a2ui>`
 * at all is checked as one block's Express.
 */
export function check(text: string, catalogs: ReadonlyArray<CatalogApi>, before: ReadonlyArray<string> = [], transform?: Transform): CheckResult {
  const blocks = text.includes("<a2ui>") ? segments(text).flatMap((s) => (s.kind === "a2ui" ? [s] : [])) : [{ source: text, closed: true }]
  if (blocks.length === 0) return { ok: false, block: 1, error: NOT_A_BLOCK }
  const unclosed = blocks.findIndex((b) => !b.closed)
  if (unclosed !== -1) return { ok: false, block: unclosed + 1, error: "The block has no closing </a2ui> line." }
  const surfaces = new ThreadSurfaces({ render: [basicCatalog()], inference: catalogs, transform })
  const entries: Array<ThreadEntry> = [
    ...before.map((source, i): ThreadEntry => ({ kind: "block", key: `earlier-${i}`, source })),
    ...blocks.map((b, i): ThreadEntry => ({ kind: "block", key: `block-${i}`, source: b.source })),
  ]
  try {
    surfaces.sync(entries)
    const drawn: Array<string> = []
    for (const i of blocks.keys()) {
      const view = surfaces.block(`block-${i}`)
      if (view === undefined) continue
      if (!view.ok) return { ok: false, block: i + 1, error: view.error }
      for (const s of view.surfaces) if (!drawn.includes(s.id)) drawn.push(s.id)
    }
    return { ok: true, blocks: blocks.length, surfaces: drawn }
  } finally {
    surfaces.dispose()
  }
}
