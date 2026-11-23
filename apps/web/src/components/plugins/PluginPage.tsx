import { type Board, pluginHost } from "@huntaway/client"
import { ChevronLeft } from "lucide-react"
import { useEffect, useState } from "react"
import { parse, parseModal, parsePanel, type Route } from "../../router"
import { useBoard } from "../../state/board"
import { navigate, useCameFrom, usePluginQuery } from "../../state/route"
import { MenuButton } from "../ui"
import { PluginFrame } from "./PluginFrame"
import { usePluginList } from "./usePlugins"

// HE-34: a plugin's own page, `/<plugin id>/<path>` (docs/plan/15-plugins.md, Pages), on the page's own host: its frame
// fills the board's main area under a header with the plugin's name and the page's title. A first segment that names
// no plugin of the host's (an old link, a mistyped address) goes home, as it did before plugins, once the list is read.
// HE-60: a path that starts with a profile's id (every document's) is that profile's host's page, not the hub's.
// HE-63: the page is given the address's query string, less the board's own parameters (`pluginQuery`).
// HE-86: opened from another of the board's pages (a task's link to a document), the header links back to it, beside
// the page's own links (the docs plugin's "All documents"); it is kept in the history entries (`cameFrom`).

/** What the board's page at `to` (a path and query) is, for the back link: its task, project, profile… */
function backLabel(b: Board, to: string): string | null {
  const [path = "", search = ""] = to.split("?")
  const q = `?${search}`
  const taskId = parseModal(q) ?? parsePanel(q)?.taskId
  if (taskId !== undefined) return b.tasks[taskId]?.key ?? null
  const r = parse(path)
  switch (r.name) {
    case "task":
      return b.tasks[r.taskId]?.key ?? null
    case "board":
    case "projectSettings":
      return b.projects.find((p) => p.id === r.projectId)?.name ?? null
    case "group":
      return r.group
    case "profile":
    case "assistant":
      return r.profile
    case "settings":
      return "Settings"
    case "analytics":
      return "Analytics"
    case "guide":
      return "Guide"
    case "host":
      return b.hosts.find((h) => h.id === r.hostId)?.name ?? null
    case "home":
      return "Home"
    case "plugin":
    default:
      return null
  }
}

/** The link back to the page the plugin's pages were opened from. */
function BackLink({ to }: { to: string }) {
  const label = useBoard((b) => backLabel(b, to))
  return (
    <a
      href={to}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        navigate(to)
      }}
      className="no-drag flex shrink-0 items-center gap-0.5 text-[13px] text-muted hover:text-fg"
      title={`Back to ${label ?? "where you were"}`}
    >
      <ChevronLeft size={14} />
      <span className="max-w-48 truncate">{label === null ? "Back" : `Back to ${label}`}</span>
    </a>
  )
}

export function PluginPage({ route }: { route: Extract<Route, { name: "plugin" }> }) {
  const host = useBoard((s) => pluginHost(s, route.path))
  const plugins = usePluginList(host)
  const search = usePluginQuery()
  const from = useCameFrom()
  const plugin = plugins?.find((p) => p.id === route.plugin)
  const unknown = plugins !== null && plugin === undefined
  const [title, setTitle] = useState<string | null>(null)
  useEffect(() => {
    if (unknown) navigate("/", { replace: true })
  }, [unknown])
  if (plugin === undefined) return null
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5 narrow:px-3">
        <MenuButton />
        {from !== null && <BackLink to={from} />}
        <h1 className="truncate text-[14px] font-semibold">{title ?? plugin.name}</h1>
      </header>
      <div className="min-h-0 flex-1">
        {host && plugin.error === null && (
          <PluginFrame
            key={`${host}/${route.path}?${search}`}
            host={host}
            plugin={route.plugin}
            slot="page"
            path={route.path}
            search={search}
            fill
            onTitle={setTitle}
          />
        )}
        {plugin.error !== null && <p className="p-5 text-[13px] text-red-400">{`${plugin.name} isn't running: ${plugin.error}`}</p>}
      </div>
    </div>
  )
}
