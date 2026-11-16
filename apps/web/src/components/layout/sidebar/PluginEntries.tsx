import { Blocks } from "lucide-react"
import type { Route } from "../../../router"
import { useBoard } from "../../../state/board"
import { navigate } from "../../../state/route"
import { usePlugins } from "../../plugins/usePlugins"
import { NavItem } from "./NavItem"

/** HE-34: the plugins' pages (docs/plan/15-plugins.md), the page's own host's: the docs plugin's documents among them. */
export function PluginEntries({ route }: { route: Route }) {
  const host = useBoard((s) => s.localHostId)
  const pages = usePlugins(host).filter((p) => p.nav !== null && p.error === null)
  if (pages.length === 0) return null
  return (
    <nav aria-label="Plugins" className="space-y-0.5">
      {pages.map((p) => (
        <NavItem
          key={p.id}
          active={route.name === "plugin" && route.plugin === p.id}
          onClick={() => navigate({ name: "plugin", plugin: p.id, path: "" })}
          title={p.description ?? p.name}
          icon={<Blocks size={15} />}
        >
          {p.nav?.title ?? p.name}
        </NavItem>
      ))}
    </nav>
  )
}
