import { useAtomValue } from "@effect/atom-react"
import { Effect } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { MousePointerClick } from "lucide-react"
import { memo, useMemo, useState, type ReactNode } from "react"
import { segments, type Click } from "@huntaway/a2ui"
import { toJson } from "../../../ui"
import { Markdown } from "../Markdown"
import { CodeBlock } from "../tools"

// Interactive replies in the thread (HE-77, docs/plan/09-frontend.md, Interactive replies). An agent's reply with an
// `<a2ui>` block is its Markdown and its blocks, each drawn by A2uiView.tsx: a chunk of its own (the Express parser
// and the renderer are some hundreds of KB), loaded the first time a thread shows a block. The user's message a click
// sends is shown as the click, with what it sent behind it.

/** The block renderer, loaded when the first block is shown. */
const a2uiViewAtom = Atom.make(Effect.promise(() => import("./A2uiView"))).pipe(Atom.keepAlive)

/** An agent's reply that may have `<a2ui>` blocks (`row` is its row's key). */
export const Reply = memo(function Reply({ row, text }: { row: string; text: string }) {
  const parts = useMemo(() => segments(text), [text])
  if (parts.length === 1 && parts[0]?.kind === "markdown") return <Markdown text={text} />
  return (
    <div className="min-w-0">
      {parts.map((p) =>
        p.kind === "markdown" ? (
          <Markdown key={`md@${p.offset}`} text={p.text} />
        ) : (
          <Block key={`a2ui@${p.offset}`} row={row} offset={p.offset} source={p.source} closed={p.closed} />
        ),
      )}
    </div>
  )
})

function Block(props: { row: string; offset: number; source: string; closed: boolean }) {
  const view = useAtomValue(a2uiViewAtom)
  if (AsyncResult.isSuccess(view)) return <view.value.A2uiBlock {...props} />
  // A renderer that failed to load (the network, or a build that changed under this tab) leaves the block's source.
  if (AsyncResult.isFailure(view)) return <CodeBlock text={props.source} />
  return <div className="my-2 h-16 rounded-lg border border-line bg-panel/40" aria-hidden />
}

/**
 * The clicks on surfaces in a user's message (`clicksOf`), each with what it sent when opened, then `children`: the
 * message's other text, if it has any (messages sent while a run was busy are joined into one).
 */
export function ActionText({ clicks, children }: { clicks: ReadonlyArray<Click>; children?: ReactNode }) {
  return (
    <div className="space-y-1.5">
      {clicks.map((c) => (
        <ClickLine key={`${c.action.surfaceId}:${c.action.sourceComponentId}:${c.action.name}:${toJson(c.action.context)}`} click={c} />
      ))}
      {children}
    </div>
  )
}

function ClickLine({ click }: { click: Click }) {
  const [open, setOpen] = useState(false)
  const context = Object.entries(click.action.context)
  return (
    <div data-a2ui-action={click.action.surfaceId}>
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-left" title="What it sent the agent">
        <MousePointerClick size={13} className="shrink-0 text-faint" />
        {click.label || click.action.name}
      </button>
      {open && (
        <div className="mt-1.5 text-[12px] text-muted">
          {context.length === 0 ? (
            <span className="font-mono">{click.action.name}</span>
          ) : (
            <CodeBlock text={context.map(([k, v]) => `${k}: ${typeof v === "string" ? v : toJson(v)}`).join("\n")} />
          )}
        </div>
      )}
    </div>
  )
}
