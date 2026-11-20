import { useEffect, useState } from "react"
import type { Route } from "../../router"
import { useBoard } from "../../state/board"
import { navigate, usePluginQuery } from "../../state/route"
import { MenuButton } from "../ui"
import { PluginFrame } from "./PluginFrame"
import { pluginHost } from "./pluginHost"
import { usePluginList } from "./usePlugins"

// HE-34: a plugin's own page, `/<plugin id>/<path>` (docs/plan/15-plugins.md, Pages), on the page's own host: its frame
// fills the board's main area under a header with the plugin's name and the page's title. A first segment that names
// no plugin of the host's (an old link, a mistyped address) goes home, as it did before plugins, once the list is read.
// HE-60: a path that starts with a profile's id (every document's) is that profile's host's page, not the hub's.
// HE-63: the page is given the address's query string, less the board's own parameters (`pluginQuery`).

export function PluginPage({ route }: { route: Extract<Route, { name: "plugin" }> }) {
  const host = useBoard((s) => pluginHost(s, route.path))
  const plugins = usePluginList(host)
  const search = usePluginQuery()
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
