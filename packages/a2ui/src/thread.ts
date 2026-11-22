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
export type ThreadEntry = { readonly kind: "block"; readonly key: string; readonly source: string } | { readonly kind: "action"; readonly surfaceId: string }

/** What one block shows. */
export type BlockView =
  | { readonly ok: false; readonly error: string }
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
  private onAction: ((action: ActionPayload) => void) | null = null

  constructor(private readonly options: ThreadSurfacesOptions<T>) {
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
    if (!same) this.reset()
    for (const entry of entries.slice(this.applied.length)) this.applied.push({ entry, view: this.apply(entry) })
    this.notify()
    return true
  }

  private apply(entry: ThreadEntry): BlockView | null {
    if (entry.kind === "action") {
      this.answered.add(entry.surfaceId)
      this.sending.delete(entry.surfaceId)
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
      }
      return { ok: true, surfaces: [], superseded: false }
    } catch (e) {
      return { ok: false, error: errorText(e) }
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
  b !== undefined && (a.kind === "block" ? b.kind === "block" && a.key === b.key && a.source === b.source : b.kind === "action" && a.surfaceId === b.surfaceId)
