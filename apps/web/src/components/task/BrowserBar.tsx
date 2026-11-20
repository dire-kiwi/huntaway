import { useAtom } from "@effect/atom-react"
import { browserUrl } from "@huntaway/shared"
import { clsx } from "clsx"
import { ArrowLeft, ArrowRight, Globe, RotateCw, X } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { browserShareAtom } from "../../state/prefs"
import { IconButton } from "../ui"

// HE-62: what both of the task's browsers (BrowserStream, BrowserWebview) show around their page: the address bar, the
// empty pane, and the splitter beside the thread.

/** What the address bar shows and does. */
export interface AddressBar {
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly canGo: boolean
  readonly back: boolean
  readonly forward: boolean
  readonly onGo: (url: string) => void
  readonly onBack: () => void
  readonly onForward: () => void
  readonly onReload: () => void
  readonly onStop: () => void
  readonly onClose: () => void
  /** More buttons, before Close. */
  readonly extra?: ReactNode
}

/** Back, forward, reload, the address (typed and Enter to go; Escape puts the page's back), the extra buttons, close. */
export function BrowserBar(bar: AddressBar) {
  const [input, setInput] = useState(bar.url)
  const [bad, setBad] = useState(false)
  const editing = useRef(false)
  const ref = useRef<HTMLInputElement>(null)
  // The page's address shows unless the user has typed into the field (focusing it alone doesn't count).
  useEffect(() => {
    if (!editing.current) setInput(bar.url)
  }, [bar.url])
  useEffect(() => {
    if (bar.url === "") ref.current?.focus()
  }, [bar.url])

  const submit = () => {
    const to = browserUrl(input)
    setBad(to === null)
    if (to === null) return
    editing.current = false
    ref.current?.blur()
    bar.onGo(to)
  }

  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
      <IconButton title="Back" disabled={!bar.back} onClick={bar.onBack}>
        <ArrowLeft size={14} />
      </IconButton>
      <IconButton title="Forward" disabled={!bar.forward} onClick={bar.onForward}>
        <ArrowRight size={14} />
      </IconButton>
      <IconButton title={bar.loading ? "Stop loading" : "Reload"} disabled={!bar.canGo} onClick={bar.loading ? bar.onStop : bar.onReload}>
        {bar.loading ? <X size={14} /> : <RotateCw size={13} />}
      </IconButton>
      <form
        className="mx-1 min-w-0 flex-1"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input
          ref={ref}
          value={input}
          aria-label="Address"
          onChange={(e) => {
            editing.current = true
            setInput(e.target.value)
            setBad(false)
          }}
          onFocus={(e) => e.target.select()}
          onBlur={() => {
            editing.current = false
          }}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return
            e.preventDefault()
            setInput(bar.url)
            setBad(false)
            e.currentTarget.blur()
          }}
          spellCheck={false}
          placeholder="Address, or a port on localhost"
          title={bad ? "Not a web address: only http: and https: pages open here" : bar.title || undefined}
          aria-invalid={bad}
          className={clsx(
            "h-7 w-full rounded-md border bg-panel px-2.5 font-mono text-[12px] text-fg outline-none placeholder:font-sans placeholder:text-faint",
            bad ? "border-red-500/70" : "border-line focus:border-accent/60",
          )}
        />
      </form>
      {bar.extra}
      <IconButton title="Close the browser" onClick={bar.onClose}>
        <X size={15} />
      </IconButton>
    </div>
  )
}

/** What the pane shows with no page yet. */
export function NoPage({ children }: { children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-muted">
      <Globe size={22} className="text-faint" />
      {children ?? (
        <p>
          Type an address above: a port like <span className="font-mono text-fg">5173</span> opens localhost on the task&apos;s host. The agent uses this
          browser too.
        </p>
      )}
    </div>
  )
}

const clampShare = (n: number) => Math.min(0.8, Math.max(0.2, n))

/**
 * How much of the task's width the browser pane takes beside the thread (half at first, kept for every task), and the
 * bar between them that's dragged to change it. While it's dragged a cover over the window keeps the pointer's moves
 * from the page in the pane, which would otherwise take them.
 */
export function useBrowserShare() {
  const [saved, save] = useAtom(browserShareAtom)
  const [share, setShare] = useState(() => clampShare(Number(saved) || 0.5))
  const [dragging, setDragging] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  // Measured once a drag starts; the share only moves during it.
  useEffect(() => {
    if (!dragging) return undefined
    const box = bar.current?.parentElement?.getBoundingClientRect()
    if (!box) return undefined
    const latest = { share: null as number | null }
    const move = (e: PointerEvent) => {
      latest.share = clampShare((box.right - e.clientX) / box.width)
      setShare(latest.share)
    }
    const up = () => {
      setDragging(false)
      if (latest.share !== null) save(String(latest.share))
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
  }, [dragging, save])
  const splitter = (
    <div
      ref={bar}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize the browser"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        setDragging(true)
      }}
      onDoubleClick={() => {
        setShare(0.5)
        save("0.5")
      }}
      className={clsx("w-1 shrink-0 cursor-col-resize border-l border-line hover:bg-accent/40", dragging && "bg-accent/40")}
    >
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </div>
  )
  return [share, splitter] as const
}
