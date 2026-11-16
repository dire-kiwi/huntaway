import { useBoard } from "../../state/board"
import { PluginFrame } from "../plugins/PluginFrame"
import { usePlugins } from "../plugins/usePlugins"
import { PanelHeading } from "./parts"

/**
 * HE-34: Settings → Plugins (docs/plan/15-plugins.md): the plugins this page's host runs, what each adds (its page,
 * its MCP server's tools), why one isn't running, and each one's own section of settings, in its frame.
 */
export function PluginsPanel() {
  const host = useBoard((s) => s.localHostId)
  const plugins = usePlugins(host)
  return (
    <section>
      <PanelHeading
        title="Plugins"
        description="What this host's plugins add to the board."
        help="A plugin can add a page to the sidebar, an MCP server for agents, and a section of settings of its own, shown here. A project turns a plugin's MCP server off in its Skills and MCP settings."
      />
      <div className="mt-5 space-y-4">
        {plugins.length === 0 && <p className="text-[12.5px] text-muted">This host runs no plugins.</p>}
        {plugins.map((p) => (
          <div key={p.id} className="space-y-2 rounded-xl border border-line p-4 text-[12.5px] text-muted">
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-medium text-fg">{p.name}</span>
              <span className="font-mono text-[11.5px] text-faint">
                {p.id} {p.version}
              </span>
            </div>
            {p.description && <p>{p.description}</p>}
            {p.mcp && (
              <p>
                Agents get its MCP server, <span className="font-mono">{`mcp__${p.id}`}</span>
                {p.mcp.tools.length > 0 && `: ${p.mcp.tools.join(", ")}`}.
              </p>
            )}
            {p.error !== null && <p className="text-red-400">{`It isn't running: ${p.error}`}</p>}
            {host && p.error === null && p.settings && (
              <div className="pt-1">
                <PluginFrame host={host} plugin={p.id} slot="settings" />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
