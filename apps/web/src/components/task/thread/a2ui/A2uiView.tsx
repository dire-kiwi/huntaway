import { useAtomValue } from "@effect/atom-react"
import { Exit } from "effect"
import { Atom } from "effect/reactivity"
import { clsx } from "clsx"
import { Check, CircleAlert, Loader2 } from "lucide-react"
import { memo, useLayoutEffect, useSyncExternalStore } from "react"
import { A2uiSurface, type ReactCatalogComponent } from "@a2ui/react"
import type { ActionPayload } from "@a2ui/web_core"
import { mutate } from "@huntaway/client"
import { TaskId } from "@huntaway/contracts"
import { actionMessage, clicksOf, segments } from "@huntaway/a2ui"
import { boardCatalogs, boardTransform, ThreadSurfaces, type ThreadEntry } from "@huntaway/a2ui/express"
import { runExit } from "../../../../state/mutation"
import { useThread } from "../context"
import type { Item } from "../threadModel"
import { CodeBlock } from "../tools"
import { boardCatalog } from "./catalog"

// An `<a2ui>` block of an agent's reply, drawn (HE-77, docs/plan/09-frontend.md, Interactive replies). The chunk of its
// own that A2ui.tsx loads the first time a thread has one: it holds `@a2ui/agent`'s Express parser and the renderer.
// The blocks of a thread share one `ThreadSurfaces` (packages/a2ui/src/thread.ts), so a later reply can update an
// earlier one's surface; a click sends the agent the user's message (`tasks.send`) that `actionMessage` writes.

/** The thread's surfaces, while a block of it is shown. The key is `<host>\u0000<task>`. */
const surfacesAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const [host = "", task = ""] = key.split("\u0000")
    const surfaces = new ThreadSurfaces<ReactCatalogComponent>({ render: [boardCatalog], inference: boardCatalogs(), transform: boardTransform() })
    surfaces.setOnAction((action) => void send(surfaces, host, task, action))
    get.addFinalizer(() => surfaces.dispose())
    return surfaces
  }),
)

/** Sends the user's click to the agent; the surface is locked from now until the thread shows the message. */
function send(surfaces: ThreadSurfaces<ReactCatalogComponent>, host: string, task: string, action: ActionPayload) {
  surfaces.setSending(action.surfaceId, true)
  const text = actionMessage(
    { surfaceId: action.surfaceId, name: action.name, sourceComponentId: action.sourceComponentId, context: action.context },
    labelOf(surfaces, action),
  )
  // Once it's in the thread the surface stays locked as answered; a send that failed unlocks it to try again.
  return runExit(mutate("tasks.send", host, { id: TaskId.make(task), text })).then((exit) => {
    if (Exit.isFailure(exit)) surfaces.setSending(action.surfaceId, false)
  })
}

/** The line the user's message starts with: the clicked button's text, when it has one. */
function labelOf(surfaces: ThreadSurfaces<ReactCatalogComponent>, action: ActionPayload): string | undefined {
  const components = surfaces.surface(action.surfaceId)?.componentsModel
  const button = components?.get(action.sourceComponentId)?.properties
  const child = typeof button?.["child"] === "string" ? components?.get(button["child"])?.properties : undefined
  const text = child?.["text"]
  return typeof text === "string" && text.trim() !== "" ? `Clicked “${text.trim()}”` : undefined
}

const made = new WeakMap<ReadonlyArray<Item>, ReadonlyArray<ThreadEntry>>()

/** The thread's closed blocks and the user's clicks, in order, from its rows (the same list for the same rows). */
function entriesOf(items: ReadonlyArray<Item>): ReadonlyArray<ThreadEntry> {
  const had = made.get(items)
  if (had !== undefined) return had
  const entries: Array<ThreadEntry> = []
  for (const it of items) {
    if (it.type === "text") {
      for (const s of segments(it.text)) if (s.kind === "a2ui" && s.closed) entries.push({ kind: "block", key: blockKey(it.key, s.offset), source: s.source })
    } else if (it.type === "user") {
      // Messages sent while a run was busy are joined into one: it can hold several clicks.
      for (const [i, click] of (clicksOf(it.text)?.clicks ?? []).entries())
        entries.push({ kind: "action", key: `${it.key}#${i}`, surfaceId: click.action.surfaceId })
    }
  }
  made.set(items, entries)
  return entries
}

/** A block's key: its row's and where it starts in the text. */
export const blockKey = (row: string, offset: number) => `${row}@${offset}`

/**
 * One block of a reply (a row: a finished message, whose streaming text Thread.tsx draws apart). `closed` false: the
 * reply ended without its `</a2ui>` (cut off by Stop or a limit, or the agent forgot it).
 */
export const A2uiBlock = memo(function A2uiBlock({ row, offset, source, closed }: { row: string; offset: number; source: string; closed: boolean }) {
  const host = useThread((t) => t.hostId)
  const task = useThread((t) => t.taskId)
  const items = useThread((t) => t.items)
  const more = useThread((t) => t.more)
  const loadEarlier = useThread((t) => t.loadEarlier)
  const surfaces = useAtomValue(surfacesAtom(`${host}\u0000${task}`))
  const entries = entriesOf(items)
  // Before the paint, so a block never shows its loading look once the thread has it.
  useLayoutEffect(() => void surfaces.sync(entries), [surfaces, entries])
  useSyncExternalStore(surfaces.subscribe, surfaces.getVersion)
  const key = blockKey(row, offset)
  if (!closed) return <Blocked error="The block has no closing </a2ui> line: the reply ended before it." source={source} />
  // A block that isn't one of the main conversation's (a subagent's reply): its surfaces would be nobody's to answer.
  if (!entries.some((e) => e.kind === "block" && e.key === key)) return <CodeBlock text={source} />
  const view = surfaces.block(key)
  if (view === undefined) return <Pending />
  if (!view.ok && view.missing !== undefined && more)
    return (
      <p data-a2ui-earlier className="my-1 text-xs text-faint italic">
        This changes an interactive reply from earlier in the thread.{" "}
        <button type="button" onClick={loadEarlier} className="text-muted not-italic underline hover:text-fg">
          Load earlier messages
        </button>
      </p>
    )
  if (!view.ok) return <Blocked error={view.error} source={source} />
  if (view.superseded) return <p className="my-1 text-xs text-faint italic">Interactive reply updated below</p>
  return (
    <div data-a2ui className="my-2 flex flex-col gap-2">
      {view.surfaces.map((s) => {
        const model = surfaces.surface(s.id)
        const locked = s.answered || s.sending
        return model === undefined ? null : (
          <div key={s.id} data-a2ui-surface={s.id} className="space-y-1">
            {/* `inert` locks every control in it, the board's and the browser's own. */}
            <div inert={locked} aria-busy={s.sending || undefined} className={clsx("transition-opacity", locked && "opacity-55")}>
              <A2uiSurface surface={model} />
            </div>
            {s.sending ? (
              <p className="flex items-center gap-1 text-[11.5px] text-faint">
                <Loader2 size={11} className="animate-spin" /> Sending to the agent…
              </p>
            ) : s.answered ? (
              <p className="flex items-center gap-1 text-[11.5px] text-faint">
                <Check size={11} /> Sent to the agent
              </p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
})

/** A block its thread hasn't read yet: its room, without the source. */
function Pending() {
  return <div data-a2ui-pending className="my-2 h-16 animate-pulse rounded-lg border border-line bg-panel/40" aria-label="Interactive reply loading" />
}

/** A block that doesn't draw: what's wrong, with its source behind a click. Nothing of it was drawn or run. */
function Blocked({ error, source }: { error: string; source: string }) {
  return (
    <div data-a2ui-error role="note" className="my-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.05] p-3 text-[12.5px]">
      <p className="flex items-center gap-1.5 text-fg">
        <CircleAlert size={13} className="text-amber-400" /> This interactive reply couldn't be drawn
      </p>
      <p className="mt-1 text-muted">{error}</p>
      <details className="mt-2">
        <summary className="cursor-pointer text-faint hover:text-muted">Its source</summary>
        <div className="mt-1.5">
          <CodeBlock text={source} />
        </div>
      </details>
    </div>
  )
}
