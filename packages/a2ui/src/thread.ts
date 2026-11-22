// A thread's A2UI surfaces (HE-77, docs/plan/09-frontend.md, Interactive replies): one renderer state for the whole
// thread, so a later reply can change a surface an earlier one drew (`surface("<id>", update=true)`). It is derived
// from the thread's replies and the user's action messages, in order: each closed block is parsed against the
// inference catalogs (the board's, with its macros), lowered by `transform` (the macro expander) and applied to the
// renderer's processor. When the thread's start changes (an older page loaded, a rewind), it is rebuilt from scratch.
//
// What each block shows: the surfaces it was the last to draw (an earlier copy says it was updated below), or why it
// drew nothing. A surface is answered when the user's action message for it comes after the last block that drew it:
// it stays drawn, locked, until the agent draws it again.
import { ExpressFormat, RendererState } from "@a2ui/agent"
import type { ActionPayload, Catalog, CatalogApi, ComponentApi, SurfaceModel } from "@a2ui/web_core"
import { MessageProcessor } from "@a2ui/web_core"
import { errorText, surfaceIdsOf } from "./rules.ts"

/** What the thread says, in order: a closed `<a2ui>` block of a reply (its key: the item and the offset), or a click. */
export type ThreadEntry =
  | { readonly kind: "block"; readonly key: string; readonly source: string }
  | { readonly kind: "action"; readonly key: string; readonly surfaceId: string }

/** What one block shows. */
export type BlockView =
  | {
      readonly ok: false
      readonly error: string
      /**
       * The surface it updates that the thread hasn't drawn, when that's why: one drawn before the part of the thread
       * that's loaded, if there's more before it.
       */
      readonly missing?: string | undefined
    }
  | { readonly ok: true; readonly surfaces: ReadonlyArray<SurfaceView>; readonly superseded: boolean }

/** A surface a block drew, and where it stands. */
export interface SurfaceView {
  readonly id: string
  /** The user's click on it went to the agent since it was drawn: it is locked until the agent draws it again. */
  readonly answered: boolean
  /** A click on it is on its way. */
  readonly sending: boolean
}

export interface ThreadSurfacesOptions<T extends ComponentApi> {
  /** The catalogs the surfaces are drawn with (the renderer's). */
  readonly render: ReadonlyArray<Catalog<T>>
  /** The catalogs a block is written against (with the macros' sidecar catalog, when there are macros). */
  readonly inference: ReadonlyArray<CatalogApi>
  /** Lowers a block's messages for the renderer (`MacroExpander.transformToTransport`); by default as they are. */
  readonly transform?: ((messages: ReadonlyArray<unknown>) => ReadonlyArray<unknown>) | undefined
}

type Applied = { readonly entry: ThreadEntry; readonly view: BlockView | null }

export class ThreadSurfaces<T extends ComponentApi> {
  private processor!: MessageProcessor<T>
  private state!: RendererState
  private applied: Array<Applied> = []
  /** The last block to draw each surface, and the user's clicks since. */
  private readonly owner = new Map<string, string>()
  private readonly answered = new Set<string>()
  private readonly sending = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  /**
   * The entries applied so far, kept over a rebuild: only one that comes in new (the agent drawing a surface again, the
   * thread showing a click) ends a click on its way, not one replayed when an older page comes in.
   */
  private readonly seen = new Set<string>()
  private onAction: ((action: ActionPayload) => void) | null = null

  private readonly options: ThreadSurfacesOptions<T>

  constructor(options: ThreadSurfacesOptions<T>) {
    this.options = options
    this.reset()
  }

  private reset() {
    this.processor?.dispose()
    this.processor = new MessageProcessor<T>([...this.options.render], (action) => this.onAction?.(action))
    this.state = new RendererState([...this.options.inference])
    this.applied = []
    this.owner.clear()
    this.answered.clear()
  }

  /** Where the surfaces' clicks go. */
  setOnAction(onAction: ((action: ActionPayload) => void) | null) {
    this.onAction = onAction
  }

  /**
   * Brings the surfaces up to the thread's `entries`. What was applied already is kept; anything else (an entry before
   * the end changed or went) rebuilds them. Whether anything changed; listeners are told.
   */
  sync(entries: ReadonlyArray<ThreadEntry>): boolean {
    const same = this.applied.length <= entries.length && this.applied.every((a, i) => sameEntry(a.entry, entries[i]))
    if (same && this.applied.length === entries.length) return false
    const kept = same ? null : this.surfaceData()
    if (!same) this.reset()
    for (const entry of entries.slice(this.applied.length)) {
      this.applied.push({ entry, view: this.apply(entry) })
      this.seen.add(entryKey(entry))
    }
    if (kept !== null) this.restore(kept)
    this.notify()
    return true
  }

  /**
   * Each surface's data now (what the user typed or picked, not yet sent), with the block that drew it last. The object
   * itself: the processor it's from is about to go, so nothing changes it after.
   */
  private surfaceData(): ReadonlyArray<{ readonly id: string; readonly owner: string; readonly source: string; readonly data: unknown }> {
    return [...this.owner].flatMap(([id, owner]) => {
      const at = this.applied.find((a) => a.entry.kind === "block" && a.entry.key === owner)
      const model = this.surface(id)?.dataModel
      if (at?.entry.kind !== "block" || model === undefined) return []
      return [{ id, owner, source: at.entry.source, data: model.get("/") }]
    })
  }

  /** Puts a rebuild's surfaces' data back where the same block (same key and source) drew the surface last. */
  private restore(kept: ReturnType<ThreadSurfaces<T>["surfaceData"]>) {
    for (const k of kept) {
      if (this.owner.get(k.id) !== k.owner) continue
      const at = this.applied.find((a) => a.entry.kind === "block" && a.entry.key === k.owner)
      if (at?.entry.kind !== "block" || at.entry.source !== k.source) continue
      this.surface(k.id)?.dataModel.set("/", k.data)
    }
  }

  private apply(entry: ThreadEntry): BlockView | null {
    const fresh = !this.seen.has(entryKey(entry))
    if (entry.kind === "action") {
      this.answered.add(entry.surfaceId)
      if (fresh) this.sending.delete(entry.surfaceId)
      return null
    }
    // A block that names no surface gets its own, so two such blocks never collide.
    const parser = new ExpressFormat([...this.options.inference], { surfaceId: `reply-${entry.key}` }).createParser()
    const transform = this.options.transform ?? ((m: ReadonlyArray<unknown>) => m)
    try {
      const ids: Array<string> = []
      for (const part of parser.parseResponse(entry.source, { state: this.state, wrapped: false })) {
        if (part.type !== "a2ui") continue
        const errors = this.processor.processMessagesWithErrors([...transform(part.a2ui)])
        const first = errors[0]
        if (first !== undefined) return { ok: false, error: errorText(first.error?.message ?? "The block didn't draw.") }
        for (const id of surfaceIdsOf(part.a2ui)) if (!ids.includes(id)) ids.push(id)
      }
      if (ids.length === 0) return { ok: false, error: "The block draws no surface." }
      for (const id of ids) {
        this.owner.set(id, entry.key)
        this.answered.delete(id)
        // The agent drew it again: a click still marked as on its way (one that never reached the thread) is moot.
        if (fresh) this.sending.delete(id)
      }
      return { ok: true, surfaces: [], superseded: false }
    } catch (e) {
      const missing = updatedIds(entry.source).find((id) => !this.processor.model.surfacesMap.has(id))
      return { ok: false, error: errorText(e), missing }
    }
  }

  /** What the block `key` shows, or undefined for a block not (yet) in the thread's entries. */
  block(key: string): BlockView | undefined {
    const at = this.applied.find((a) => a.entry.kind === "block" && a.entry.key === key)
    if (at?.view === undefined || at.view === null) return undefined
    if (!at.view.ok) return at.view
    const ids = [...this.owner].flatMap(([id, owner]) => (owner === key && this.processor.model.surfacesMap.has(id) ? [id] : []))
    return {
      ok: true,
      surfaces: ids.map((id) => ({ id, answered: this.answered.has(id), sending: this.sending.has(id) })),
      superseded: ids.length === 0,
    }
  }

  /** A surface's model, to draw. */
  surface(id: string): SurfaceModel<T> | undefined {
    return this.processor.model.surfacesMap.get(id)
  }

  /** Marks a click on `id` as on its way (true) or failed (false), until the thread shows it. */
  setSending(id: string, sending: boolean) {
    if (sending) this.sending.add(id)
    else this.sending.delete(id)
    this.notify()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** Changes each time what the blocks show may have. */
  getVersion = (): number => this.version

  private notify() {
    this.version += 1
    for (const l of this.listeners) l()
  }

  dispose() {
    this.processor.dispose()
    this.listeners.clear()
  }
}

const sameEntry = (a: ThreadEntry, b: ThreadEntry | undefined): boolean =>
  b !== undefined && a.key === b.key && (a.kind === "block" ? b.kind === "block" && a.source === b.source : b.kind === "action" && a.surfaceId === b.surfaceId)

/** An entry as `seen` keeps it: a block's key and source (an edited block is new), a click's key. */
const entryKey = (e: ThreadEntry): string => (e.kind === "block" ? `block\u0000${e.key}\u0000${e.source}` : `action\u0000${e.key}`)

/** The surfaces a block's `surface("<id>", update=true)` lines name. */
const updatedIds = (source: string): ReadonlyArray<string> =>
  [...source.matchAll(/surface\(\s*"([^"\\]+)"\s*,\s*update\s*=\s*true\s*\)/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]))
