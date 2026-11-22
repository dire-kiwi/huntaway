// HE-79: a file of the Code tab, highlighted as the Changes tab's diffs are (Shiki, in its worker), with its lines
// numbered. A click on a name looks it up (the symbol panel, and its uses in the file marked); a click on a line's
// number picks the line. Long files show only the lines in view (and some around them).
import { wordAt } from "@huntaway/shared"
import { clsx } from "clsx"
import { memo, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react"
import { runStyle, useTextHighlight, type Run } from "../changes/highlight"
import { pieces, splitLines } from "./lines"

const LINE_H = 20
/** Files with more lines than this show only those in view, and this many on each side. */
const ALL_UP_TO = 3000
const OVERSCAN = 80

export function CodeLines({
  path,
  text,
  line,
  mark,
  onLook,
  onLine,
}: {
  path: string
  text: string
  /** The line to show (from 1), picked. */
  line: number | null
  /** The symbol whose uses are marked. */
  mark: string | null
  onLook: (name: string) => void
  onLine: (line: number) => void
}) {
  const lines = useMemo(() => splitLines(text), [text])
  const runs = useTextHighlight(path, text, lines.length)
  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, height: 1000 })
  const windowed = lines.length > ALL_UP_TO
  const first = windowed ? Math.max(0, Math.floor(view.top / LINE_H) - OVERSCAN) : 0
  const last = windowed ? Math.min(lines.length, Math.ceil((view.top + view.height) / LINE_H) + OVERSCAN) : lines.length
  const digits = String(lines.length).length
  // How wide the longest line is (a tab as four), so the lines in view don't change how far it scrolls sideways.
  const columns = useMemo(() => (windowed ? lines.reduce((m, l) => Math.max(m, l.length + 3 * (l.split("\t").length - 1)), 0) : 0), [lines, windowed])

  // The line asked for, a third of the way down, unless it's in view already.
  useLayoutEffect(() => {
    const el = box.current
    if (!el || line === null) return
    const y = (line - 1) * LINE_H
    if (y < el.scrollTop || y > el.scrollTop + el.clientHeight - 2 * LINE_H) el.scrollTop = Math.max(0, y - el.clientHeight / 3)
  }, [line])

  // A click (not a selection) on a name looks it up.
  const onClick = (e: ReactMouseEvent) => {
    const sel = globalThis.getSelection()
    if (!sel || !sel.isCollapsed || !sel.anchorNode || e.button !== 0) return
    const code = e.target instanceof Element ? e.target.closest("[data-code]") : null
    const row = code?.closest("[data-n]")
    if (!code || !row || !code.contains(sel.anchorNode)) return
    const range = document.createRange()
    range.setStart(code, 0)
    range.setEnd(sel.anchorNode, sel.anchorOffset)
    const n = Number(row.getAttribute("data-n"))
    const word = wordAt(lines[n] ?? "", range.toString().length)
    if (word) onLook(word.name)
  }

  return (
    <div
      ref={box}
      onScroll={windowed ? (e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight }) : undefined}
      onClick={onClick}
      className="h-full overflow-auto py-1 font-mono text-[12.5px] leading-5"
      style={runs ? runStyle(0) : undefined}
      data-testid="code-lines"
    >
      <div
        className="w-max min-w-full"
        style={windowed ? { height: lines.length * LINE_H, minWidth: `calc(${columns + digits + 7}ch)`, paddingTop: first * LINE_H } : undefined}
      >
        {Array.from({ length: last - first }, (_, k) => first + k).map((n) => (
          <Line key={n} n={n} text={lines[n] ?? ""} runs={runs?.[n]} mark={mark} on={line === n + 1} digits={digits} onLine={onLine} />
        ))}
      </div>
    </div>
  )
}

const MARK = "rounded-[2px] bg-amber-400/20 outline outline-1 outline-amber-400/40"

const Line = memo(function Line({
  n,
  text,
  runs,
  mark,
  on,
  digits,
  onLine,
}: {
  n: number
  text: string
  runs: Run[] | undefined
  mark: string | null
  on: boolean
  digits: number
  onLine: (line: number) => void
}) {
  return (
    <div data-n={n} className={clsx("flex h-5 whitespace-pre", on && "bg-accent/15")}>
      <span
        onClick={() => onLine(n + 1)}
        className={clsx(
          "sticky left-0 shrink-0 cursor-pointer pr-[2ch] text-right select-none hover:text-muted",
          on ? "bg-[#1a1a2e] text-muted" : "bg-bg text-faint/70",
        )}
        style={{ width: `${digits + 3}ch` }}
      >
        {n + 1}
      </span>
      <span data-code className="pr-6 [tab-size:4]">
        {text
          ? pieces(text, runs, mark).map((p) => (
              <span key={p.at} style={p.style ? runStyle(p.style) : undefined} className={p.mark ? MARK : undefined}>
                {p.text}
              </span>
            ))
          : " "}
      </span>
    </div>
  )
})
