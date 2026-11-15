// HE-34: a plugin's page in its frame (docs/plan/15-plugins.md, Pages). The page is the plugin's HTML, shown as
// documents are: in a sandboxed frame (scripts, no same origin) under FRAME_CSP, so nothing in it reaches the network
// or the board's own storage. Its :root has the board's theme as CSS variables (`--color-bg`, `--font-sans`…), and
// `window.huntaway` is the bridge to the board: `call` a method of the plugin on its host, `navigate` to a board path,
// `openTask`, `onEvent` for the plugin's events, and `context` (the plugin, the slot, the path, the task).
import { frameDoc } from "../task/htmlFrame"
import { toJson } from "../ui/json"

/** What a frame's page is told of where it is. */
export interface FrameContext {
  readonly host: string
  readonly plugin: string
  readonly slot: "page" | "settings" | "task"
  readonly path: string
  readonly task_id: string | null
}

/** The board's theme as declarations for the frame's :root: its colours and fonts, and its colour scheme. */
export function boardVars(root: Element = document.documentElement): string {
  const style = getComputedStyle(root)
  const vars: Array<string> = []
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i)
    if (name.startsWith("--color-") || name.startsWith("--font-")) vars.push(`${name}:${style.getPropertyValue(name).trim()}`)
  }
  const scheme = style.colorScheme && style.colorScheme !== "normal" ? style.colorScheme : "dark"
  return [`color-scheme:${scheme}`, ...vars].join(";")
}

/**
 * The bridge, as source in the frame, before the page's own scripts. Messages to the board are `{iaPlugin: {kind, …}}`:
 * `call` (answered with `{iaPluginReply: {id, ok, value | error}}`), `navigate`, `openTask`, and `height` when the board
 * sizes the frame to its page (`report`). The board sends the plugin's events as `{iaPluginEvent: event}`.
 */
function bridge(context: FrameContext, report: boolean) {
  type Waiting = { resolve: (v: unknown) => void; reject: (e: Error) => void }
  const waiting = new Map<number, Waiting>()
  const listeners: Array<(event: unknown) => void> = []
  let next = 0
  // It runs as source in the frame, so everything it uses is in it.
  const board = parent
  const post = (message: Record<string, unknown>) => board.postMessage({ iaPlugin: message }, "*")
  const huntaway = {
    context,
    call(method: string, payload?: unknown): Promise<unknown> {
      next += 1
      const id = next
      const { promise, resolve, reject } = Promise.withResolvers<unknown>()
      waiting.set(id, { resolve, reject })
      post({ kind: "call", id, method, payload: payload ?? null })
      return promise
    },
    navigate(path: string) {
      post({ kind: "navigate", path })
    },
    openTask(id: string) {
      post({ kind: "openTask", id })
    },
    onEvent(listener: (event: unknown) => void) {
      listeners.push(listener)
    },
  }
  Object.assign(window, { huntaway })
  addEventListener("message", (e) => {
    if (e.source !== board || !e.data || typeof e.data !== "object") return
    const reply = e.data.iaPluginReply
    if (reply && typeof reply.id === "number") {
      const w = waiting.get(reply.id)
      waiting.delete(reply.id)
      if (w) {
        if (reply.ok) w.resolve(reply.value)
        else w.reject(new Error(String(reply.error)))
      }
    }
    if (e.data.iaPluginEvent) for (const listener of listeners) listener(e.data.iaPluginEvent)
  })
  if (report) {
    const tell = () => post({ kind: "height", height: Math.ceil(document.documentElement.getBoundingClientRect().height) })
    addEventListener("load", tell)
    new ResizeObserver(tell).observe(document.documentElement)
  }
}

/** A string as a script's argument: inside a <script>, so nothing in it closes it. */
const arg = (v: unknown) => toJson(v).replace(/</g, "\\u003c")

/** The frame's page for a plugin's `html`, with the board's theme (`vars`, from boardVars) and the bridge. */
export function pluginFrame(html: string, vars: string, context: FrameContext, report: boolean): string {
  const page =
    `<!doctype html><meta charset="utf-8"><style>:root{${vars}}html,body{margin:0}${report ? "html{overflow:hidden}" : ""}</style>\n` +
    `<script>(${String(bridge)})(${arg(context)}, ${report})</script>\n${html}`
  return frameDoc(page, 0, 0)
}
