import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal as XTerm, type ITheme } from "@xterm/xterm"
import { Loader2, RotateCcw, Square, SquareTerminal, TerminalSquare, X } from "lucide-react"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Exit } from "effect"
import { useEffect, useRef, useState } from "react"
import { mutate, query, type HostTask as Task } from "@huntaway/client"
import type { TerminalStatus, TerminalTool } from "@huntaway/contracts"
import { exitError, useAction } from "../../state/mutation"
import { after } from "../../state/timers"
import { Button, copyText, parseJson, resultError, resultValue, toJson } from "../ui"

/**
 * A task's tmux session on its host, in xterm.js. The session lives on the host, so leaving
 * the page (or restarting the server) doesn't end it; reconnecting picks it up again.
 * With `tool`, the session runs one of the host's terminal tools instead of a shell; it lasts
 * while the board keeps it open (see terminalTools.ts) and `onClose` ends it.
 *
 * Wire format: binary frames carry terminal output and input; JSON text frames carry
 * `ready` and `ping` (server), `resize`, `ack` and `pong` (client). We acknowledge output once xterm has
 * processed it, and the server pauses while too much is unacknowledged.
 *
 * Step 1 (docs/plan/09-frontend.md): the socket is `/api/terminal/<ticket>` on the page's own server, with a ticket from
 * `terminal.open` asked for each connection (docs/plan/05-protocol.md). A task on another host reaches its terminal
 * through the hub's relay, which comes with the hosts (M7).
 */

/** The terminal's socket on the page's own server (vite proxies `/api` in development). */
const terminalUrl = (ticket: string, cols: number, rows: number) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal/${encodeURIComponent(ticket)}?cols=${cols}&rows=${rows}`

const THEME: ITheme = {
  background: "#0b0b0e",
  foreground: "#e6e6ec",
  cursor: "#c4c4f8",
  cursorAccent: "#0b0b0e",
  selectionBackground: "#7c7cf866",
  black: "#1c1c25",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#d4d4dc",
  brightBlack: "#6b6b7b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f4f4f8",
}

const FONT_FAMILY = '"JetBrains Mono Variable", "Symbols Nerd Font Mono", monospace'

/** Wait for the bundled font before xterm measures its cells. */
const terminalFont: Promise<unknown> = document.fonts?.load('13px "JetBrains Mono Variable"').catch(() => {}) ?? Promise.resolve()

type Conn = { state: "connecting" } | { state: "open" } | { state: "ended" } | { state: "error"; message: string }

type Props = { task: Task; active: boolean; tool?: TerminalTool; onClose?: () => void }

/** Starting over (Restart, Reconnect) is a fresh pane: a new terminal on a new connection. */
export function TerminalPane(props: Props) {
  const [attempt, setAttempt] = useState(0)
  return <Pane key={attempt} {...props} again={() => setAttempt((n) => n + 1)} />
}

function Pane({ task, active, tool, onClose, again }: Props & { again: () => void }) {
  const toolId = tool?.id
  const statusAtom = query("terminal.status", task.host_id, { task_id: task.id, tool: toolId ?? null })
  const read = useAtomValue(statusAtom)
  // Read again as the connection changes (it runs once attached, and may have ended).
  const loadStatus = useAtomRefresh(statusAtom)
  const failed = resultError(read)
  // Unreachable for a moment (e.g. restarting): keep what we knew and let the socket retry.
  const status: TerminalStatus | null =
    resultValue(read) ?? (failed === null ? null : { available: false, running: false, cwd: null, reason: failed, tool: null })
  const [conn, setConn] = useState<Conn>({ state: "connecting" })
  const box = useRef<HTMLDivElement>(null)
  const view = useRef<{ term: XTerm; fit: FitAddon } | null>(null)
  const available = status?.available
  // The ticket for each connection, and ending the session.
  const [, run] = useAction()

  useEffect(() => {
    const el = box.current
    if (!available || !el) return undefined
    // What the connection keeps between its callbacks.
    const at: {
      disposed: boolean
      ws: WebSocket | null
      retries: number
      cancelRetry: (() => void) | undefined
      unacked: number
      cancelAck: (() => void) | undefined
      frame: number
    } = { disposed: false, ws: null, retries: 0, cancelRetry: undefined, unacked: 0, cancelAck: undefined, frame: 0 }
    const changed = (c: Conn) => {
      setConn(c)
      loadStatus()
    }
    const encoder = new TextEncoder()
    const cleanups: (() => void)[] = []

    const send = (data: string | Uint8Array<ArrayBuffer>) => {
      if (at.ws?.readyState === WebSocket.OPEN) at.ws.send(data)
    }
    const flushAck = () => {
      at.cancelAck?.()
      at.cancelAck = undefined
      if (at.unacked > 0) send(toJson({ type: "ack", bytes: at.unacked }))
      at.unacked = 0
    }
    const ack = (n: number) => {
      at.unacked += n
      if (at.unacked >= 32 << 10) flushAck()
      else at.cancelAck ??= after(5, flushAck)
    }

    // Created once the font is in, since xterm measures it only once, and a frame later:
    // StrictMode's mount/unmount/mount shouldn't start xterm's timers on a terminal that is
    // disposed straight away.
    void terminalFont.then(() => {
      if (at.disposed) return
      at.frame = requestAnimationFrame(() => {
        if (at.disposed) return
        const term = new XTerm({
          cursorBlink: true,
          // Same text setup as kiwi-code: the bundled variable JetBrains Mono, with Nerd Font
          // symbols as a fallback.
          fontFamily: FONT_FAMILY,
          fontSize: 13,
          fontWeight: "400",
          fontWeightBold: 650,
          letterSpacing: 0,
          lineHeight: 1.28,
          macOptionIsMeta: true,
          // Keep explicit colours (e.g. RGB black) readable on the background.
          minimumContrastRatio: 4.5,
          overviewRulerWidth: 0,
          rightClickSelectsWord: true,
          // tmux keeps the history.
          scrollback: 1000,
          theme: THEME,
        })
        const fit = new FitAddon()
        term.loadAddon(fit)
        term.loadAddon(new WebLinksAddon())
        term.open(el)
        // Use xterm's DOM renderer: canvas allocation failures abort startup, and the
        // canvas addon has no recovery for a lost rendering context.
        view.current = { term, fit }
        cleanups.push(() => {
          view.current = null
          term.dispose()
        })

        // Copying in tmux (mouse selection, copy mode) arrives as OSC 52.
        term.parser.registerOscHandler(52, (data) => {
          const b64 = data.slice(data.indexOf(";") + 1)
          if (b64 && b64 !== "?") {
            try {
              copyText(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))))
            } catch {
              /* not base64 */
            }
          }
          return true
        })
        term.attachCustomKeyEventHandler((e) => {
          if (e.type !== "keydown") return true
          const mod = e.ctrlKey || e.metaKey
          const key = e.key.toLowerCase()
          // Ctrl+C copies when there is a selection, and is ^C otherwise.
          if (mod && key === "c" && term.hasSelection()) {
            copyText(term.getSelection())
            term.clearSelection()
            return false
          }
          // Let the browser's paste event reach xterm instead of sending ^V.
          if ((mod && key === "v") || (e.shiftKey && key === "insert")) return false
          return true
        })

        term.onData((d) => send(encoder.encode(d)))
        term.onBinary((d) => send(Uint8Array.from(d, (c) => c.charCodeAt(0))))
        term.onResize(({ cols, rows }) => send(toJson({ type: "resize", cols, rows })))
        const refit = () => {
          if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit()
        }
        const ro = new ResizeObserver(() => requestAnimationFrame(() => !at.disposed && refit()))
        ro.observe(el)
        cleanups.push(() => ro.disconnect())
        void document.fonts?.ready.then(() => !at.disposed && refit())

        // Dropped (network, server restart): tmux repaints the screen when we re-attach, to a terminal reset first.
        const retry = (message: string) => {
          if (at.retries >= 6) return changed({ state: "error", message })
          at.retries++
          setConn({ state: "connecting" })
          at.cancelRetry = after(Math.min(250 * 2 ** at.retries, 2000), () => {
            term.reset()
            connect()
          })
          return undefined
        }
        const attach = (ticket: string) => {
          const sock = new WebSocket(terminalUrl(ticket, term.cols, term.rows))
          sock.binaryType = "arraybuffer"
          at.ws = sock
          let unstable: (() => void) | undefined
          sock.addEventListener("open", () => {
            // Attached for a while: a drop after that starts its retries over.
            unstable = after("5 seconds", () => (at.retries = 0))
            send(toJson({ type: "resize", cols: term.cols, rows: term.rows }))
          })
          sock.addEventListener("message", (e: MessageEvent<unknown>) => {
            if (typeof e.data === "string") {
              const m = parseJson(e.data)
              const type = typeof m === "object" && m !== null && "type" in m ? m.type : undefined
              if (type === "ready") {
                changed({ state: "open" })
                term.focus()
              } else if (type === "ping") send(toJson({ type: "pong" }))
              return
            }
            if (!(e.data instanceof ArrayBuffer)) return
            const bytes = new Uint8Array(e.data)
            term.write(bytes, () => ack(bytes.length))
          })
          sock.addEventListener("close", (e) => {
            unstable?.()
            if (at.disposed || at.ws !== sock) return
            at.ws = null
            at.unacked = 0
            if (e.code === 1000) changed({ state: "ended" })
            else if (e.code === 1011) changed({ state: "error", message: e.reason || "Can't reach the terminal" })
            else retry(e.reason || "Can't reach the terminal")
          })
        }
        // A ticket for each connection (it opens one socket, once).
        const connect = () => {
          refit()
          setConn({ state: "connecting" })
          void run(mutate("terminal.open", task.host_id, { task_id: task.id, tool: toolId ?? null })).then((exit) => {
            if (at.disposed) return
            if (Exit.isSuccess(exit)) attach(exit.value.ticket)
            else retry(exitError(exit) ?? "Can't reach the terminal")
          })
        }
        connect()
      })
    })

    return () => {
      at.disposed = true
      cancelAnimationFrame(at.frame)
      at.cancelRetry?.()
      at.cancelAck?.()
      at.ws?.close()
      cleanups.forEach((f) => f())
    }
  }, [available, task.host_id, task.id, toolId, loadStatus, run])

  // Coming back to the tab, or once attached: the size may have changed while it was hidden.
  const attached = conn.state === "open"
  useEffect(() => {
    if (!active || !attached) return undefined
    const frame = requestAnimationFrame(() => {
      const v = view.current
      if (!v || !box.current?.clientWidth) return
      v.fit.fit()
      v.term.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active, attached])

  const kill = () => run(mutate("terminal.kill", task.host_id, { task_id: task.id, tool: toolId ?? null }))
  const restart = () => void kill().then(again)

  if (status && !status.available)
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-[13px] text-muted">
        Terminal unavailable: {status.reason ?? "unknown reason"}
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px]">
        {tool ? <SquareTerminal size={13} className="text-faint" /> : <TerminalSquare size={13} className="text-faint" />}
        {tool && (
          <span className="shrink-0 font-mono text-muted" title={tool.command}>
            {tool.command}
          </span>
        )}
        <span className="min-w-0 truncate font-mono text-faint" title={status?.cwd ?? undefined}>
          {tool && status?.cwd ? "in " : ""}
          {status?.cwd ?? ""}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-faint">
          {conn.state === "connecting" && (
            <>
              <Loader2 size={12} className="animate-spin" /> Connecting…
            </>
          )}
          {conn.state === "open" && "tmux"}
        </span>
        <Button size="sm" variant="ghost" onClick={restart} title={tool ? `End ${tool.name} and start it again` : "End the session and start a new shell"}>
          <RotateCcw size={12} /> Restart
        </Button>
        {onClose ? (
          <Button size="sm" variant="ghost" onClick={onClose} title={`End ${tool?.name ?? "the session"} and close it`}>
            <X size={12} /> Close
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={conn.state !== "open"} onClick={() => void kill()} title="End the tmux session">
            <Square size={11} /> End
          </Button>
        )}
      </div>
      <div className="relative min-h-0 flex-1 bg-bg">
        <div ref={box} className="absolute inset-0 py-1 pl-2" />
        {(conn.state === "ended" || conn.state === "error") && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg/85 text-[13px] text-muted">
            <div>{conn.state === "ended" ? (tool ? `${tool.name} exited.` : "Session ended.") : `Terminal disconnected: ${conn.message}`}</div>
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={again}>
                {conn.state !== "ended" ? "Reconnect" : tool ? `Start ${tool.name} again` : "Start a new session"}
              </Button>
              {onClose && conn.state === "ended" && (
                <Button size="sm" variant="ghost" onClick={onClose}>
                  Close
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
