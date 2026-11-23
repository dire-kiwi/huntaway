import { useAtomValue } from "@effect/atom-react"
import { pluginCall, pluginEventAtom, query } from "@huntaway/client"
import { TaskId } from "@huntaway/contracts"
import { Cause, Exit } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, View } from "react-native"
import { type FrameContext, frameDocument, frameMessage } from "../logic/frame"
import { frameBase, frameLink, type PageRef, pagePath, targetOfPath } from "../logic/links"
import { errorText, exitError, runExit } from "../state/action"
import { nowMillis } from "../state/clock"
import { openTarget } from "../state/open"
import { colors, frameVars } from "../theme"
import { type FrameHandle, FrameView } from "./frameView"
import { Empty } from "./ui"

// One of a plugin's pages in its frame (HE-99; docs/plan/15-plugins.md, Pages), as the web board's PluginFrame:
// rendered by the plugin on its host (`plugins.page`, read again on its events that say `reload`), and the app's end of
// the frame's bridge. The documents are the docs plugin's pages.

const NO_QUERY: Readonly<Record<string, string>> = {}

/** A query string (without its `?`) as `plugins.page` takes it. */
const queryOf = (search: string): Readonly<Record<string, string>> => (search === "" ? NO_QUERY : Object.fromEntries(new URLSearchParams(search)))

/** How long after one move of the app a frame's page may ask for the next: a page can't run the app away from the user. */
const MOVE_EVERY_MS = 700

export function PluginFrame({
  host,
  page,
  slot = "page",
  taskId = null,
  fill = false,
  onTitle,
  onEmpty,
  onRedirect,
  onLeave,
}: {
  readonly host: string
  readonly page: PageRef
  readonly slot?: FrameContext["slot"]
  readonly taskId?: string | null
  /** Fills what it is in (a page of its own); otherwise it is as tall as its page says. */
  readonly fill?: boolean
  readonly onTitle?: (title: string | null) => void
  /** Whether the plugin has nothing to show (a task's section). */
  readonly onEmpty?: (empty: boolean) => void
  /** The page is at another of the plugin's paths. */
  readonly onRedirect?: (to: PageRef) => void
  /** The page took the app somewhere else (a link of its own): what it is in closes, if it is over the screen. */
  readonly onLeave?: () => void
}) {
  const path = pagePath(page.path)
  const payload = useMemo(
    () => ({ plugin: page.plugin, slot, path, query: queryOf(page.search), task_id: taskId === null ? null : TaskId.make(taskId) }),
    [page.plugin, page.search, slot, path, taskId],
  )
  const result = useAtomValue(query("plugins.page", host, payload))
  const shown = AsyncResult.isSuccess(result) ? result.value : null
  const redirect = shown?.type === "redirect" ? shown.path : null
  useEffect(() => {
    if (redirect !== null) onRedirect?.({ plugin: page.plugin, path: redirect.replace(/^\/+/, ""), search: "" })
  }, [redirect, onRedirect, page.plugin])
  const title = shown?.type === "html" ? shown.title : null
  const empty = shown?.type === "html" && shown.empty
  useEffect(() => onTitle?.(title), [onTitle, title])
  useEffect(() => onEmpty?.(empty), [onEmpty, empty])
  if (shown === null) {
    if (AsyncResult.isFailure(result))
      return fill ? <Empty icon="alert-circle-outline" title="This page can't be shown." hint={errorText(Cause.squash(result.cause))} /> : null
    return fill ? <ActivityIndicator style={{ marginTop: 32 }} color={colors.accent} /> : null
  }
  if (shown.type === "redirect" || shown.empty) return null
  return (
    <Frame
      host={host}
      html={shown.html}
      title={shown.title ?? page.plugin}
      context={{ host, plugin: page.plugin, slot, path, task_id: taskId }}
      base={frameBase(page)}
      fill={fill}
      onLeave={onLeave}
    />
  )
}

function Frame({
  host,
  html,
  title,
  context,
  base,
  fill,
  onLeave,
}: {
  readonly host: string
  readonly html: string
  readonly title: string
  readonly context: FrameContext
  readonly base: string
  readonly fill: boolean
  readonly onLeave: (() => void) | undefined
}) {
  const frame = useRef<FrameHandle>(null)
  const moved = useRef(0)
  // Where the page is scrolled to, for when it is loaded again (an event of its plugin's said `reload`).
  const scrolled = useRef(0)
  const [height, setHeight] = useState(0)
  const { plugin, slot, path, task_id } = context
  const doc = useMemo(
    () => frameDocument(html, { vars: frameVars, context: { host, plugin, slot, path, task_id }, base, report: !fill, y: scrolled.current }),
    [html, host, plugin, slot, path, task_id, base, fill],
  )

  // The plugin's events, to its page.
  const event = useAtomValue(pluginEventAtom(host, plugin))
  useEffect(() => {
    if (event !== null) frame.current?.deliver({ iaPluginEvent: event })
  }, [event])

  const onMessage = useCallback(
    (data: unknown) => {
      const m = frameMessage(data)
      if (m === null) return
      if (m.kind === "height") return setHeight(m.height)
      if (m.kind === "scroll") {
        scrolled.current = m.y
        return
      }
      if (m.kind === "call") {
        const { id } = m
        return runExit(pluginCall(host, plugin, m.method, m.payload), (exit) =>
          frame.current?.deliver({
            iaPluginReply: Exit.isSuccess(exit) ? { id, ok: true, value: exit.value } : { id, ok: false, error: exitError(exit) ?? "interrupted" },
          }),
        )
      }
      const target = m.kind === "open" ? frameLink(m.url) : m.kind === "openTask" ? ({ kind: "task", id: m.id } as const) : targetOfBoardPath(m.path)
      const now = nowMillis()
      if (target === null || now - moved.current < MOVE_EVERY_MS) return
      moved.current = now
      onLeave?.()
      openTarget(target, { ask: true, host })
    },
    [host, plugin, onLeave],
  )

  return (
    <View style={fill ? { flex: 1, backgroundColor: colors.bg } : { height }}>
      <FrameView ref={frame} html={doc} title={title} height={fill ? null : height} onMessage={onMessage} />
    </View>
  )
}

/** Where a board path a page asked to go to leads (`/docs/<profile id>/d/<slug>/?details=1`). */
const targetOfBoardPath = (path: string) => {
  const at = path.indexOf("?")
  const hash = path.indexOf("#")
  const end = hash < 0 ? path.length : hash
  return at < 0 || at > end ? targetOfPath(path.slice(0, end)) : targetOfPath(path.slice(0, at), path.slice(at + 1, end))
}
