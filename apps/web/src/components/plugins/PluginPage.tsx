import { useState } from "react"
import type { Route } from "../../router"
import { useBoard } from "../../state/board"
import { MenuButton } from "../ui"
import { PluginFrame } from "./PluginFrame"
import { usePlugins } from "./usePlugins"

// HE-34: a plugin's own page, `/<plugin id>/<path>` (docs/plan/15-plugins.md, Pages), on the page's own host: its frame
// fills the board's main area under a header with the plugin's name and the page's title.

export function PluginPage({ route }: { route: Extract<Route, { name: "plugin" }> }) {
  const host = useBoard((s) => s.localHostId)
  const plugin = usePlugins(host).find((p) => p.id === route.plugin)
  const [title, setTitle] = useState<string | null>(null)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5 narrow:px-3">
        <MenuButton />
        <h1 className="truncate text-[14px] font-semibold">{title ?? plugin?.name ?? route.plugin}</h1>
      </header>
      <div className="min-h-0 flex-1">
        {host && plugin?.error === null && (
          <PluginFrame key={route.path} host={host} plugin={route.plugin} slot="page" path={route.path} fill onTitle={setTitle} />
        )}
        {plugin?.error != null && <p className="p-5 text-[13px] text-red-400">{`${plugin.name} isn't running: ${plugin.error}`}</p>}
        {host && plugin === undefined && <p className="p-5 text-[13px] text-muted">{`This board has no page called ${route.plugin}.`}</p>}
      </div>
    </div>
  )
}
