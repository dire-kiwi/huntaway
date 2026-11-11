import { canRunAgents, type HostProfile as Profile } from "@huntaway/client"
import { clsx } from "clsx"
import { ChevronLeft, Plus, Server, Trash2 } from "lucide-react"
import { useState } from "react"
import { profileConfigLabel } from "../boardHelpers"
import { useBoard } from "../../state/board"
import { navigate } from "../../state/route"
import { rpc } from "../../state/rpc"
import { Button, IconButton, MenuButton, Modal, timeAgo, useConfirm } from "../ui"
import { HostClaudeConfigs } from "./ClaudeConfigs"
import { AgentDefaultsRow } from "./hosts/AgentDefaults"
import { ProfileForm } from "./hosts/ProfileForm"
import { ServerPanel } from "./Server"
import { HostDesktop } from "./HostDesktop"
import { TerminalToolsRow } from "./hosts/TerminalTools"

// Step 1 (docs/plan/09-frontend.md) for the host page (route "host"). Its sections from other areas stand as marked
// slots (`Slot` below) until they come: settings sync and the host's version (hosts/SettingsSync, hosts/HostRow's
// HostVersion: M7, HE-6), telemetry (Telemetry's HostTelemetry, 6.9),
// a linked host's server and its systemd service (Server's RemoteServer and HostService:
// `admin.*`, HE-6) and taking a host off the board (`hub.hosts.remove`, HE-6). A profile has agent configs on every
// host, so the old "Copy login" for a profile with a folder of its own is gone (logins are copied from configs: 6.11).

const MODE: Record<string, string> = { local: "this hub's own host", outbound: "linked by URL", inbound: "dials in", ssh: "over SSH" }

/** A section another area brings: its heading, and that it is not on this server yet. */
function Slot({ title, area }: { title: string; area: string }) {
  return (
    <section data-not-yet={area}>
      <h2 className="mb-1 text-[13px] font-semibold">{title}</h2>
      <p className="text-[12.5px] text-faint">Not yet on this server.</p>
    </section>
  )
}

/** Everything about one host, configured from this board. */
export function HostPage({ hostId }: { hostId: string }) {
  const host = useBoard((s) => s.hosts.find((h) => h.id === hostId))
  const hostCount = useBoard((s) => s.hosts.length)
  if (!host) return <div className="p-8 text-muted">Host not found.</div>
  const agents = canRunAgents(host)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <MenuButton />
        <IconButton className="no-drag" onClick={() => navigate({ name: "settings", tab: "hosts" })}>
          <ChevronLeft size={16} />
        </IconButton>
        <button className="no-drag text-[12.5px] text-muted hover:text-fg" onClick={() => navigate({ name: "settings", tab: "hosts" })}>
          Settings
        </button>
        <span className="text-faint">/</span>
        <Server size={14} className="text-muted" />
        <h1 className="text-[14px] font-semibold">{host.name}</h1>
        <span className={clsx("h-1.5 w-1.5 rounded-full", host.connected ? "bg-emerald-400" : "bg-red-400")} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-8 p-6">
          <section className="space-y-1 text-[12.5px] text-muted">
            <div>
              {MODE[host.mode] ?? host.mode}
              {host.url ? ` · ${host.url}` : ""}
              {!host.connected && host.last_seen ? ` · offline, last seen ${timeAgo(host.last_seen)}` : ""}
            </div>
            {/* HE-6: HostVersion (hosts/HostRow): its version and commit, and whether it needs an update. */}
            {host.version && <div>v{host.version}</div>}
            {host.connected && !agents && <div>Board only: this host can&apos;t run agents (no claude or ia-shim). New projects go on hosts that can.</div>}
          </section>

          {!host.connected ? (
            <p className="text-[13px] text-muted">This host is offline. Its settings can be changed once it reconnects.</p>
          ) : (
            <>
              {agents && (
                <section>
                  <h2 className="mb-1 text-[13px] font-semibold">Agent defaults</h2>
                  <p className="mb-3 text-[12.5px] text-muted">
                    For every agent on this host. A model set on a thread, project or profile, an effort set on a thread, or a permission mode set on a thread
                    or project, takes precedence.
                  </p>
                  <AgentDefaultsRow host={host} showName={false} />
                </section>
              )}
              <Slot title="Settings sync" area="HE-6" />
              {agents && <HostClaudeConfigs hostId={host.id} canCopy={hostCount > 1} />}
              {agents && <HostProfiles hostId={host.id} />}
              <TerminalToolsRow host={host} />
              <Slot title="Telemetry" area="6.9" />
              {host.local ? <ServerPanel /> : <Slot title="Server" area="HE-6" />}
              {agents && <HostDesktop hostId={host.id} />}
            </>
          )}

          {!host.local && <Slot title="Remove" area="HE-6" />}
        </div>
      </div>
    </div>
  )
}

function HostProfiles({ hostId }: { hostId: string }) {
  const all = useBoard((s) => s.profiles)
  const claudeConfigs = useBoard((s) => s.claudeConfigs)
  const profiles = all.filter((p) => p.host_id === hostId)
  const [editing, setEditing] = useState<Profile | "new" | null>(null)
  const confirm = useConfirm()
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Profiles on this host</h2>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus size={13} /> Add profile
        </Button>
      </div>
      <div className="divide-y divide-line rounded-xl border border-line">
        {profiles.map((p) => (
          <div key={p.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="w-28 shrink-0 truncate text-[12.5px]">{p.name}</div>
            <div className="min-w-0 flex-1 truncate text-[11.5px] text-faint">
              {profileConfigLabel({ claudeConfigs }, p)}
              {p.default_model ? ` · ${p.default_model}` : ""}
            </div>
            <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              title="Delete"
              onClick={() =>
                confirm.ask({
                  title: `Delete profile ${p.name}`,
                  body: `Delete profile "${p.name}" on this host, with all its projects and tasks here?`,
                  action: "Delete profile",
                  danger: true,
                  onConfirm: () => rpc(p.host_id, "profiles.delete", { id: p.id }),
                })
              }
            >
              <Trash2 size={13} />
            </Button>
          </div>
        ))}
        {profiles.length === 0 && <div className="px-4 py-3 text-[12.5px] text-faint">No profiles yet.</div>}
      </div>
      {editing && (
        <Modal title={editing === "new" ? "Add profile" : `Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <ProfileForm hostId={hostId} initial={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
        </Modal>
      )}
      {confirm.dialog}
    </section>
  )
}
