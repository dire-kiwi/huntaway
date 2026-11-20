import { useAtom } from "@effect/atom-react"
import { mutate, type HostTask as Task } from "@huntaway/client"
import { clsx } from "clsx"
import { Exit } from "effect"
import { Loader2 } from "lucide-react"
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react"
import { exitError, useAction } from "../../state/mutation"
import { browserUrlAtom } from "../../state/prefs"
import { after } from "../../state/timers"
import { parseJson, toJson } from "../ui"
import { BrowserBar, NoPage } from "./BrowserBar"

// HE-62: the task's browser streamed from its host's headless Chrome (docs/plan/09-frontend.md, Browser). The socket
// `/api/browser/<ticket>` (a ticket from `browser.open`, one per connection) sends the page as JPEG frames, each drawn on
// the canvas and then acknowledged (the next comes after), and JSON frames for the page's address and title, its size,
// a download of Chrome going, and the desktop app taking the page. The pane's size is the page's; the pointer, wheel,
// keys and pasted text go back as JSON.

type Conn =
  | { readonly state: "connecting" }
  | { readonly state: "open" }
  | { readonly state: "installing"; readonly received: number; readonly total: number; readonly phase: string }
  | { readonly state: "desktop" }
  | { readonly state: "error"; readonly message: string }
  /** The browser couldn't open: not tried again until the user says so. */
  | { readonly state: "failed"; readonly message: string }

interface Page {
  readonly url: string
  readonly title: string
  readonly loading: boolean
}

/** CDP's modifier bits: Alt 1, Control 2, Meta 4, Shift 8. */
const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)

const BUTTONS = ["left", "middle", "right"] as const

const field = (v: unknown, key: string): unknown => (typeof v === "object" && v !== null ? Reflect.get(v, key) : undefined)
const str = (v: unknown, key: string): string => {
  const x = field(v, key)
  return typeof x === "string" ? x : ""
}
const numOf = (v: unknown, key: string): number => {
  const x = field(v, key)
  return typeof x === "number" && Number.isFinite(x) ? x : 0
}

/**
 * The page's point under the pointer: the frame fills the canvas's box keeping its shape, as `object-contain` draws it;
 * `vp` is the page's size the frames are of.
 */
const pointIn = (cv: HTMLCanvasElement | null, vp: { readonly width: number; readonly height: number }, clientX: number, clientY: number) => {
  if (!cv || cv.width === 0 || vp.width === 0) return null
  const r = cv.getBoundingClientRect()
  const scale = Math.min(r.width / cv.width, r.height / cv.height)
  const x = (clientX - r.left - (r.width - cv.width * scale) / 2) / scale
  const y = (clientY - r.top - (r.height - cv.height * scale) / 2) / scale
  if (x < 0 || y < 0 || x > cv.width || y > cv.height) return null
  return { x: (x * vp.width) / cv.width, y: (y * vp.height) / cv.height }
}

export function BrowserStream({ task, onClose }: { task: Task; onClose: () => void }) {
  // Retry, after the browser couldn't open, is a new stream.
  const [attempt, setAttempt] = useState(0)
  return <Stream key={attempt} task={task} onClose={onClose} onRetry={() => setAttempt((n) => n + 1)} />
}

function Stream({ task, onClose, onRetry }: { task: Task; onClose: () => void; onRetry: () => void }) {
  const [saved, save] = useAtom(browserUrlAtom(`${task.host_id}:${task.id}`))
  // Where a browser the task doesn't have yet starts: the page it was last on here, else its preview.
  const start = useRef(saved ?? task.preview_url ?? "")
  const [conn, setConn] = useState<Conn>({ state: "connecting" })
  const [page, setPage] = useState<Page>({ url: "", title: "", loading: false })
  const [failure, setFailure] = useState<string | null>(null)
  const [hasFrame, setHasFrame] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const viewport = useRef({ width: 0, height: 0 })
  const sendRef = useRef<(v: unknown) => void>(() => undefined)
  const [, run] = useAction()

  useEffect(() => {
    const el = box.current
    const cv = canvas.current
    const ctx = cv?.getContext("2d")
    if (!el || !cv || !ctx) return undefined
    const at: {
      disposed: boolean
      done: boolean
      shown: boolean
      ws: WebSocket | null
      retries: number
      cancelRetry: (() => void) | undefined
      cancelResize: (() => void) | undefined
    } = { disposed: false, done: false, shown: false, ws: null, retries: 0, cancelRetry: undefined, cancelResize: undefined }
    const size = () => ({ width: Math.max(200, Math.round(el.clientWidth)), height: Math.max(150, Math.round(el.clientHeight)) })
    const send = (v: unknown) => {
      if (at.ws?.readyState === WebSocket.OPEN) at.ws.send(toJson(v))
    }
    sendRef.current = send

    // Drawn, then acknowledged: the server sends the next frame after.
    const draw = (data: ArrayBuffer) => {
      createImageBitmap(new Blob([data], { type: "image/jpeg" })).then(
        (bitmap) => {
          if (!at.disposed) {
            if (cv.width !== bitmap.width || cv.height !== bitmap.height) {
              cv.width = bitmap.width
              cv.height = bitmap.height
            }
            ctx.drawImage(bitmap, 0, 0)
            setHasFrame(true)
          }
          bitmap.close()
          send({ type: "ack" })
        },
        () => send({ type: "ack" }),
      )
    }

    const handle = (frame: unknown) => {
      switch (str(frame, "type")) {
        case "page": {
          const url = str(frame, "url")
          setPage({ url: url === "about:blank" ? "" : url, title: str(frame, "title"), loading: field(frame, "loading") === true })
          if (/^https?:/u.test(url)) save(url)
          return
        }
        case "viewport":
          viewport.current = { width: numOf(frame, "width"), height: numOf(frame, "height") }
          // The page shows: a later drop is tried again from the shortest wait.
          at.shown = true
          at.retries = 0
          setConn({ state: "open" })
          return
        case "installing":
          setConn({ state: "installing", received: numOf(frame, "received"), total: numOf(frame, "total"), phase: str(frame, "phase") })
          return
        case "desktop":
          at.done = true
          setConn({ state: "desktop" })
          return
        case "error":
          // Before the page shows, the browser couldn't open (no Chrome, its sandbox): trying again each second would
          // only do the same, so it waits for the user's Retry.
          if (!at.shown) {
            at.done = true
            setConn({ state: "failed", message: str(frame, "message") })
          } else setFailure(str(frame, "message"))
          return
        default:
      }
    }

    const retry = (why: string) => {
      at.retries += 1
      setConn({ state: "error", message: why })
      at.cancelRetry = after(Math.min(10_000, 500 * 2 ** at.retries), connect)
    }
    const connect = () => {
      if (at.disposed) return
      void run(mutate("browser.open", task.host_id, { task_id: task.id })).then((exit) => {
        if (at.disposed) return
        if (!Exit.isSuccess(exit)) {
          retry(exitError(exit) ?? "Can't reach the task's browser")
          return
        }
        const s = size()
        const q = new URLSearchParams({ width: String(s.width), height: String(s.height) })
        if (start.current !== "") q.set("url", start.current)
        const ws = new WebSocket(
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/browser/${encodeURIComponent(exit.value.ticket)}?${q.toString()}`,
        )
        ws.binaryType = "arraybuffer"
        at.ws = ws
        ws.addEventListener("open", () => {
          at.shown = false
        })
        ws.addEventListener("message", (e: MessageEvent<unknown>) => {
          if (e.data instanceof ArrayBuffer) draw(e.data)
          else if (typeof e.data === "string") handle(parseJson(e.data))
        })
        ws.addEventListener("close", () => {
          if (at.ws !== ws) return
          at.ws = null
          if (!at.disposed && !at.done) retry("The browser's connection closed: trying again…")
        })
      })
    }

    // The page takes the pane's size, a moment after it stops changing.
    const ro = new ResizeObserver(() => {
      at.cancelResize?.()
      at.cancelResize = after(150, () => send({ type: "resize", ...size() }))
    })
    ro.observe(el)
    // The wheel scrolls the page, not the panel (a passive listener couldn't stop that).
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = pointIn(cv, viewport.current, e.clientX, e.clientY)
      if (p) send({ type: "wheel", ...p, dx: e.deltaX, dy: e.deltaY, modifiers: modifiers(e) })
    }
    cv.addEventListener("wheel", wheel, { passive: false })
    connect()
    return () => {
      at.disposed = true
      at.cancelRetry?.()
      at.cancelResize?.()
      ro.disconnect()
      cv.removeEventListener("wheel", wheel)
      at.ws?.close()
    }
  }, [task.host_id, task.id, run, save])

  const mouse = (action: "down" | "up" | "move") => (e: MouseEvent<HTMLCanvasElement>) => {
    const p = pointIn(canvas.current, viewport.current, e.clientX, e.clientY)
    if (!p) return
    if (action === "down") e.currentTarget.focus()
    sendRef.current({
      type: "mouse",
      action,
      ...p,
      button: action === "move" ? "none" : (BUTTONS[e.button] ?? "none"),
      buttons: e.buttons,
      clickCount: action === "move" ? 0 : Math.max(1, e.detail),
      modifiers: modifiers(e),
    })
  }

  const key = (action: "down" | "up") => (e: KeyboardEvent<HTMLCanvasElement>) => {
    // A paste is the page's: the paste event brings its text.
    if (action === "down" && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return
    e.preventDefault()
    const typing = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
    const text = action === "down" ? (typing ? e.key : e.key === "Enter" ? "\r" : undefined) : undefined
    sendRef.current({ type: "key", action, key: e.key, code: e.code, keyCode: e.keyCode, ...(text === undefined ? {} : { text }), modifiers: modifiers(e) })
  }

  const go = (to: "back" | "forward" | "reload" | "stop") => sendRef.current({ type: "go", go: to })
  const shown = conn.state === "open" || hasFrame

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <BrowserBar
        url={page.url}
        title={page.title}
        loading={page.loading}
        canGo={conn.state === "open"}
        back={conn.state === "open"}
        forward={conn.state === "open"}
        onGo={(url) => {
          setFailure(null)
          sendRef.current({ type: "navigate", url })
        }}
        onBack={() => go("back")}
        onForward={() => go("forward")}
        onReload={() => go("reload")}
        onStop={() => go("stop")}
        onClose={onClose}
      />
      <div ref={box} className="relative min-h-0 flex-1 bg-white/[0.02]">
        <canvas
          ref={canvas}
          tabIndex={0}
          aria-label={page.title || "The task's browser"}
          className={clsx("absolute inset-0 h-full w-full object-contain outline-none", !shown && "invisible")}
          onMouseDown={mouse("down")}
          onMouseUp={mouse("up")}
          onMouseMove={mouse("move")}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={key("down")}
          onKeyUp={key("up")}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text/plain")
            if (text !== "") sendRef.current({ type: "text", text })
            e.preventDefault()
          }}
        />
        {!shown && page.url === "" && conn.state !== "desktop" && conn.state !== "installing" && conn.state !== "error" && conn.state !== "failed" && (
          <NoPage />
        )}
        {conn.state === "connecting" && !hasFrame && (
          <div className="absolute inset-x-0 top-3 flex justify-center text-[12px] text-muted">
            <Loader2 size={13} className="mr-1.5 animate-spin" /> Opening the task&apos;s browser…
          </div>
        )}
        {conn.state === "installing" && (
          <NoPage>
            <p>
              The host is getting its headless browser for the first time ({conn.phase}
              {conn.phase === "downloading" && conn.total > 0 ? `, ${Math.round(conn.received / 1e6)} of ${Math.round(conn.total / 1e6)} MB` : ""}).
            </p>
          </NoPage>
        )}
        {conn.state === "desktop" && (
          <NoPage>
            <p>This task&apos;s browser is open in the desktop app on its host, so it isn&apos;t streamed here.</p>
          </NoPage>
        )}
        {conn.state === "failed" && (
          <NoPage>
            <p className="max-w-md break-words text-red-400">{conn.message}</p>
            <button className="rounded-md border border-line px-3 py-1 text-fg hover:bg-white/5" onClick={onRetry}>
              Retry
            </button>
          </NoPage>
        )}
        {conn.state === "error" && !hasFrame && (
          <NoPage>
            <p className="max-w-md break-words text-red-400">{conn.message}</p>
          </NoPage>
        )}
        {failure !== null && (
          <div className="absolute inset-x-3 bottom-3 flex items-start gap-2 rounded bg-black/75 px-2 py-1 text-[12px] text-red-300">
            <span className="min-w-0 flex-1 break-words">{failure}</span>
            <button className="text-muted hover:text-fg" onClick={() => setFailure(null)}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
