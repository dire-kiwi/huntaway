import { useAtom, useAtomValue } from "@effect/atom-react"
import { mutate, query, type HostTask as Task } from "@huntaway/client"
import { clsx } from "clsx"
import { Exit } from "effect"
import { Bug, ExternalLink } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useAction } from "../../state/mutation"
import { browserUrlAtom } from "../../state/prefs"
import { after } from "../../state/timers"
import { IconButton, parseJson, resultValue, toJson } from "../ui"
import { BrowserBar, NoPage } from "./BrowserBar"

// HE-62: the task's browser in the desktop app, for a task on the app's own host: the app's <webview> (HA-275), which it
// hands to the server to drive for the agent (docs/plan/09-frontend.md, Browser). The preload's `paneDebugger` takes the
// webview's debugger; the socket `/api/browser/<ticket>` (role `desktop`) brings the server's DevTools protocol
// commands, which go to the debugger, and takes back its answers and events. While it's attached the agent's browser
// tools act on this page; when the pane goes they open a headless one where it was.

/** The desktop app's <webview> (Electron's WebviewTag), as much of it as the pane uses. */
interface WebviewElement extends HTMLWebViewElement {
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  reload(): void
  stop(): void
  openDevTools(): void
  getWebContentsId(): number
}

/** The preload's bridge to the pane's debugger (preload.ts). */
interface PaneDebugger {
  readonly attach: (id: number) => Promise<unknown>
  readonly send: (id: number, method: string, params: unknown) => Promise<unknown>
  readonly detach: (id: number) => void
  readonly onEvent: (listener: (id: unknown, method: unknown, params: unknown) => void) => () => void
  readonly onDetached: (listener: (id: unknown) => void) => () => void
}

const isFn = (v: unknown): v is (...args: Array<never>) => unknown => typeof v === "function"

/** An unsubscribe function the bridge gave. */
const unsubscriber = (v: unknown) => () => {
  if (typeof v === "function") Reflect.apply(v, undefined, [])
}

/** The desktop app's bridge to the pane's debugger, or null outside the app (or in an app too old to have it). */
export function paneDebugger(): PaneDebugger | null {
  const bridge: unknown = Reflect.get(window, "huntawayDesktop")
  const d: unknown = typeof bridge === "object" && bridge !== null ? Reflect.get(bridge, "paneDebugger") : undefined
  if (typeof d !== "object" || d === null) return null
  const [attach, send, detach, onEvent, onDetached]: Array<unknown> = ["attach", "send", "detach", "onEvent", "onDetached"].map((k) => Reflect.get(d, k))
  if (!isFn(attach) || !isFn(send) || !isFn(detach) || !isFn(onEvent) || !isFn(onDetached)) return null
  const call = (f: (...args: Array<never>) => unknown, args: ReadonlyArray<unknown>): unknown => Reflect.apply(f, d, args)
  return {
    attach: (id) => Promise.resolve(call(attach, [id])),
    send: (id, method, params) => Promise.resolve(call(send, [id, method, params])),
    detach: (id) => void call(detach, [id]),
    onEvent: (listener) => unsubscriber(call(onEvent, [listener])),
    onDetached: (listener) => unsubscriber(call(onDetached, [listener])),
  }
}

// React has no `allowpopups` (its types say boolean, and it drops `true` for an attribute it doesn't know): Electron
// looks for the attribute, whatever its value. Popups open in the pane (the main process's window-open handler).
const ALLOW_POPUPS = { allowpopups: "true" } as object

/** The pages' own session (the main process gives every pane it, whatever the page asks). */
const PARTITION = "persist:huntaway-browser"

/** A web page's address: the only kind the pane starts from (the main process refuses any other). */
const isWeb = (url: string) => /^https?:/u.test(url)

const field = (v: unknown, key: string): unknown => (typeof v === "object" && v !== null ? Reflect.get(v, key) : undefined)
const text = (v: unknown, key: string): string => {
  const x = field(v, key)
  return typeof x === "string" ? x : typeof x === "number" ? String(x) : ""
}

export function BrowserWebview({ task, onClose }: { task: Task; onClose: () => void }) {
  const [saved, save] = useAtom(browserUrlAtom(`${task.host_id}:${task.id}`))
  // A page the agent has open headless, which the pane takes over.
  const status = resultValue(useAtomValue(query("browser.status", task.host_id, { task_id: task.id })))
  const agentUrl = status !== undefined && status !== null && isWeb(status.url) ? status.url : null
  // Where it starts: the first web address it learns of (the one saved, the task's preview, the agent's page; the saved
  // one comes from storage a moment after the first render), kept from then on (later pages are loaded into the
  // webview, so that it isn't made again).
  const first = [saved ?? "", task.preview_url ?? "", agentUrl ?? ""].find(isWeb) ?? ""
  const [src, setSrc] = useState(first)
  if (src === "" && first !== "") setSrc(first)
  const [went, setWent] = useState("")
  const url = went !== "" ? went : src
  const [title, setTitle] = useState("")
  const [loading, setLoading] = useState(false)
  const [nav, setNav] = useState({ back: false, forward: false })
  const [error, setError] = useState<string | null>(null)
  // Whether the agent is connected to this page, and what's wrong when it can't be.
  const [relay, setRelay] = useState<{ readonly on: boolean; readonly problem: string | null }>({ on: false, problem: null })
  const ref = useRef<WebviewElement>(null)
  const [, run] = useAction()

  // The webview's events: its address, title, loading, and the pages it couldn't load.
  useEffect(() => {
    const wv = ref.current
    if (!wv || src === "") return undefined
    const navState = () => {
      try {
        setNav({ back: wv.canGoBack(), forward: wv.canGoForward() })
      } catch {
        // Not attached yet.
      }
    }
    const navigated = (e: Event) => {
      if (field(e, "isMainFrame") === false) return
      const to = text(e, "url")
      setWent(to)
      // Only a web page's address is kept (not an error page's): the pane starts from it next time.
      if (isWeb(to)) save(to)
      navState()
    }
    const on: Record<string, (e: Event) => void> = {
      "did-start-loading": () => {
        setLoading(true)
        setError(null)
      },
      "did-stop-loading": () => {
        setLoading(false)
        navState()
      },
      "did-navigate": navigated,
      "did-navigate-in-page": navigated,
      "did-fail-load": (e) => {
        const code = Number(field(e, "errorCode"))
        // -3 is ERR_ABORTED: a navigation that another replaced.
        if (field(e, "isMainFrame") === true && code !== -3) {
          setError(`Couldn't load ${text(e, "validatedURL")}: ${text(e, "errorDescription") || `error ${code}`}`)
        }
      },
      "page-title-updated": (e) => setTitle(text(e, "title")),
      "dom-ready": navState,
    }
    for (const [type, f] of Object.entries(on)) wv.addEventListener(type, f)
    return () => {
      for (const [type, f] of Object.entries(on)) wv.removeEventListener(type, f)
    }
  }, [src, save])

  // The webview given to the server to drive, once it's ready, for as long as the pane is here.
  useEffect(() => {
    const wv = ref.current
    const bridge = paneDebugger()
    if (!wv || !bridge || src === "") return undefined
    const at: {
      disposed: boolean
      id: number | null
      ws: WebSocket | null
      retries: number
      cancelRetry: (() => void) | undefined
      unsubscribe: Array<() => void>
    } = {
      disposed: false,
      id: null,
      ws: null,
      retries: 0,
      cancelRetry: undefined,
      unsubscribe: [],
    }
    const send = (v: unknown) => {
      if (at.ws?.readyState === WebSocket.OPEN) at.ws.send(toJson(v))
    }
    const retry = (why: string) => {
      setRelay({ on: false, problem: why })
      at.retries += 1
      at.cancelRetry = after(Math.min(10_000, 500 * 2 ** at.retries), connect)
    }
    const connect = () => {
      const id = at.id
      if (at.disposed || id === null) return
      void run(mutate("browser.pane", task.host_id, { task_id: task.id })).then((exit) => {
        if (at.disposed) return
        if (!Exit.isSuccess(exit)) {
          retry("The agent can't reach this browser: trying again…")
          return
        }
        const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/browser/${encodeURIComponent(exit.value.ticket)}`)
        at.ws = ws
        ws.addEventListener("open", () => {
          at.retries = 0
          setRelay({ on: true, problem: null })
        })
        // A command of the server's goes to the webview's debugger; its answer comes back with the command's id.
        ws.addEventListener("message", (e: MessageEvent<unknown>) => {
          const m = typeof e.data === "string" ? parseJson(e.data) : undefined
          const cmd = field(m, "id")
          const method = field(m, "method")
          if (typeof cmd !== "number" || typeof method !== "string") return
          void bridge.send(id, method, field(m, "params") ?? {}).then(
            (answer) => {
              const failed = field(answer, "error")
              send(typeof failed === "string" ? { id: cmd, error: { message: failed } } : { id: cmd, result: field(answer, "result") ?? {} })
            },
            (cause: unknown) => send({ id: cmd, error: { message: cause instanceof Error ? cause.message : "the pane didn't answer" } }),
          )
        })
        ws.addEventListener("close", () => {
          if (at.ws !== ws) return
          at.ws = null
          setRelay({ on: false, problem: null })
          if (!at.disposed) retry("The agent's connection to this browser closed: trying again…")
        })
      })
    }
    const ready = () => {
      if (at.id !== null || at.disposed) return
      const id = wv.getWebContentsId()
      void bridge.attach(id).then((answer) => {
        if (at.disposed) return
        const refused = field(answer, "error")
        if (typeof refused === "string") {
          setRelay({ on: false, problem: refused })
          return
        }
        at.id = id
        at.unsubscribe.push(
          bridge.onEvent((from, method, params) => {
            if (from === id) send({ method, params })
          }),
          bridge.onDetached((from) => {
            if (from !== id) return
            at.id = null
            at.ws?.close()
            setRelay({ on: false, problem: "The page's debugger was let go: the agent can't use this browser until the pane opens again." })
          }),
        )
        connect()
      })
    }
    wv.addEventListener("dom-ready", ready)
    return () => {
      at.disposed = true
      wv.removeEventListener("dom-ready", ready)
      at.cancelRetry?.()
      for (const u of at.unsubscribe) u()
      at.ws?.close()
      if (at.id !== null) bridge.detach(at.id)
    }
  }, [src, task.host_id, task.id, run])

  const go = (to: string) => {
    setError(null)
    setWent(to)
    if (src === "") setSrc(to)
    // A failure comes as did-fail-load.
    else ref.current?.loadURL(to).catch(() => undefined)
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <BrowserBar
        url={url}
        title={title}
        loading={loading}
        canGo={src !== ""}
        back={nav.back}
        forward={nav.forward}
        onGo={go}
        onBack={() => ref.current?.goBack()}
        onForward={() => ref.current?.goForward()}
        onReload={() => (error !== null && url !== "" ? go(url) : ref.current?.reload())}
        onStop={() => ref.current?.stop()}
        onClose={onClose}
        extra={
          <>
            <span
              title={relay.on ? "The agent uses this browser" : (relay.problem ?? "The agent isn't connected to this browser")}
              className={clsx("mx-1 h-1.5 w-1.5 shrink-0 rounded-full", relay.on ? "bg-emerald-400" : relay.problem === null ? "bg-faint" : "bg-amber-400")}
            />
            <IconButton title="The page's DevTools" disabled={src === ""} onClick={() => ref.current?.openDevTools()}>
              <Bug size={14} />
            </IconButton>
            {/* The desktop app opens a new window's web address in the system's browser. */}
            <IconButton title="Open in your browser" disabled={url === ""} onClick={() => window.open(url, "_blank", "noopener")}>
              <ExternalLink size={13} />
            </IconButton>
          </>
        }
      />
      <div className="relative min-h-0 flex-1">
        {src !== "" ? (
          <webview
            ref={ref}
            src={src}
            partition={PARTITION}
            {...ALLOW_POPUPS}
            className={clsx("absolute inset-0 h-full w-full bg-white", error !== null && "invisible")}
          />
        ) : (
          <NoPage />
        )}
        {error !== null && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-muted">
            <p className="max-w-md break-words text-red-400">{error}</p>
            {url !== "" && (
              <button className="rounded-md border border-line px-3 py-1 text-fg hover:bg-white/5" onClick={() => go(url)}>
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
