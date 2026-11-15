import { useAtomValue } from "@effect/atom-react"
import { pluginCall, pluginEventAtom, query } from "@huntaway/client"
import { TaskId } from "@huntaway/contracts"
import { Exit } from "effect"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { exitError, runExit } from "../../state/mutation"
import { navigate, openTask } from "../../state/route"
import { followsFrameInput, fromFrame, openable, trackBoardInput } from "../task/htmlFrame"
import { Loading } from "../ui/Loading"
import { boardVars, pluginFrame, type FrameContext } from "./frameSource"

// HE-34: one of a plugin's pages in its frame (docs/plan/15-plugins.md, Pages): rendered by the plugin on its host
// (`plugins.page`, read again on its events with `reload`), and the board's end of the frame's bridge.

const NO_QUERY: Readonly<Record<string, string>> = {}

/** A board path a frame asks to go to: the board's own, never another site's. */
const boardPath = (path: unknown): string | null => (typeof path === "string" && path.startsWith("/") && !path.startsWith("//") ? path : null)

export function PluginFrame({
  host,
  plugin,
  slot,
  path = "",
  taskId = null,
  fill = false,
  onTitle,
  onEmpty,
}: {
  host: string
  plugin: string
  slot: FrameContext["slot"]
  path?: string
  taskId?: string | null
  /** Fills its container (the plugin's page); otherwise it's as tall as its page says. */
  fill?: boolean
  onTitle?: (title: string | null) => void
  /** Whether the plugin has nothing to show (a task's panel). */
  onEmpty?: (empty: boolean) => void
}) {
  const payload = useMemo(() => ({ plugin, slot, path, query: NO_QUERY, task_id: taskId === null ? null : TaskId.make(taskId) }), [plugin, slot, path, taskId])
  const result = useAtomValue(query("plugins.page", host, payload))
  return (
    <Loading result={result}>
      {(page) =>
        page.type === "redirect" ? (
          <Redirect plugin={plugin} path={page.path} />
        ) : (
          <Frame
            host={host}
            html={page.html}
            empty={page.empty}
            title={page.title}
            context={{ host, plugin, slot, path, task_id: taskId }}
            fill={fill}
            onTitle={onTitle}
            onEmpty={onEmpty}
          />
        )
      }
    </Loading>
  )
}

/** A page that sends the board to another of the plugin's paths. */
function Redirect({ plugin, path }: { plugin: string; path: string }) {
  useEffect(() => navigate(`/${plugin}/${path.replace(/^\/+/, "")}`, { replace: true }), [plugin, path])
  return null
}

function Frame({
  host,
  html,
  empty,
  title,
  context,
  fill,
  onTitle,
  onEmpty,
}: {
  host: string
  html: string
  empty: boolean
  title: string | null
  context: FrameContext
  fill: boolean
  onTitle: ((title: string | null) => void) | undefined
  onEmpty: ((empty: boolean) => void) | undefined
}) {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const [height, setHeight] = useState(0)
  const { plugin, slot, path, task_id } = context

  useEffect(() => onTitle?.(title), [onTitle, title])
  useEffect(() => onEmpty?.(empty), [onEmpty, empty])

  useLayoutEffect(() => {
    frame.current?.setAttribute("srcdoc", pluginFrame(html, boardVars(), { host, plugin, slot, path, task_id }, !fill))
  }, [html, host, plugin, slot, path, task_id, fill])

  // The plugin's events, to its frame.
  const event = useAtomValue(pluginEventAtom(host, plugin))
  useEffect(() => {
    if (event !== null) frame.current?.contentWindow?.postMessage({ iaPluginEvent: event }, "*")
  }, [event])

  useEffect(() => {
    trackBoardInput()
    const reply = (id: number, answer: { ok: true; value: unknown } | { ok: false; error: string }) =>
      frame.current?.contentWindow?.postMessage({ iaPluginReply: { id, ...answer } }, "*")
    const onMessage = (e: MessageEvent) => {
      if (!fromFrame(frame.current, e.source) || !e.data || typeof e.data !== "object") return
      const m: unknown = e.data.iaPlugin
      if (m && typeof m === "object") {
        const kind = Reflect.get(m, "kind")
        if (kind === "call") {
          const id = Reflect.get(m, "id")
          const method = Reflect.get(m, "method")
          if (typeof id !== "number" || typeof method !== "string") return
          void runExit(pluginCall(host, plugin, method, Reflect.get(m, "payload"))).then((exit) =>
            reply(id, Exit.isSuccess(exit) ? { ok: true, value: exit.value } : { ok: false, error: exitError(exit) ?? "interrupted" }),
          )
        }
        // Moving the board needs the user's own click or key press in the frame.
        if (kind === "navigate" && navigator.userActivation?.isActive) {
          const to = boardPath(Reflect.get(m, "path"))
          if (to !== null) navigate(to)
        }
        if (kind === "openTask" && navigator.userActivation?.isActive) {
          const id = Reflect.get(m, "id")
          if (typeof id === "string") openTask(id)
        }
        if (kind === "height") {
          const h = Reflect.get(m, "height")
          if (typeof h === "number") setHeight(Math.min(Math.max(h, 0), 4000))
        }
        return
      }
      // A link of the page's (linksInNewTabs): the board's own open here, others in a new tab after the user's click.
      if (typeof e.data.iaOpen !== "string") return
      let url: URL
      try {
        url = new URL(e.data.iaOpen)
      } catch {
        return
      }
      if (url.origin === window.location.origin) {
        if (navigator.userActivation?.isActive) navigate(url.pathname + url.search + url.hash)
        return
      }
      if (openable(url.href) && followsFrameInput(frame.current)) window.open(url.href, "_blank", "noopener,noreferrer")
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [host, plugin])

  if (empty) return null
  return (
    <iframe
      ref={frame}
      title={title ?? plugin}
      sandbox="allow-scripts"
      className={fill ? "h-full w-full border-0" : "w-full border-0"}
      style={fill ? undefined : { height }}
    />
  )
}
