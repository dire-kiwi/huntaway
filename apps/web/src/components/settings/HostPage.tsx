import { canRunAgents, hostHas, type HostProfile as Profile } from "@huntaway/client"
import { LinkId } from "@huntaway/contracts"
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
import { HostVersion } from "./hosts/HostRow"
import { hubRpc } from "./hosts/hub"
import { SettingsSyncRow } from "./hosts/SettingsSync"
import { HostService, RemoteServer } from "./server/RemoteServer"

// Step 1 (docs/plan/09-frontend.md) for the host page (route "host"): its version and Update (hosts/HostRow's
// HostVersion), settings sync, agent configs (with Copy login, `hub.hosts.copyConfig`), profiles, terminal tools, this
// host's Server or a linked host's (server/RemoteServer, over that host's `admin.*`), its systemd service, Desktop, and
// taking a linked host off the board (`hub.hosts.remove`). Telemetry (Telemetry's HostTelemetry, 6.9) stands as a
// marked slot (`Slot` below) until it comes. A profile has agent configs on every host, so the old "Copy login" for a
// profile with a folder of its own is gone (logins are copied from configs: 6.11).

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
  const confirm = useConfirm()
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
            <HostVersion host={host} />
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
              {hostHas(host, "settings_sync") && (
                <section>
                  <h2 className="mb-1 text-[13px] font-semibold">Settings sync</h2>
                  <p className="mb-3 text-[12.5px] text-muted">
                    Keeps the agent defaults, terminal tools, and each profile&apos;s model, limits, approvals and board access the same on every host of this
                    board that has this on (profiles are matched by name). Folders, agent configs, logins and tokens stay each host&apos;s own.
                  </p>
                  <SettingsSyncRow host={host} />
                </section>
              )}
              {agents && <HostClaudeConfigs hostId={host.id} canCopy={hostCount > 1} />}
              {agents && <HostProfiles hostId={host.id} />}
              <section>
                <h2 className="mb-1 text-[13px] font-semibold">Terminal tools</h2>
                <p className="mb-3 text-[12.5px] text-muted">
                  TUI programs or scripts to open from a task, next to its Terminal tab. Each runs in its own tmux session in the task&apos;s worktree, through
                  your login shell, and keeps running while the board is open; a couple of minutes after the last board showing it closes, it ends.
                </p>
                <TerminalToolsRow host={host} />
              </section>
              <Slot title="Telemetry" area="6.9" />
              {host.local ? <ServerPanel /> : <RemoteServer hostId={host.id} />}
              <HostService hostId={host.id} />
              {agents && <HostDesktop hostId={host.id} />}
            </>
          )}

          {!host.local && (
            <section>
              <h2 className="mb-3 text-[13px] font-semibold">Remove</h2>
              <div className="flex items-center gap-3 rounded-xl border border-line px-4 py-3 text-[12.5px] text-muted">
                <span className="flex-1">Take this host off the board. Its projects, threads and agents stay on the host.</span>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    confirm.ask({
                      title: `Remove ${host.name}`,
                      body: `Remove ${host.name} from this board? Its projects, threads and agents stay on that host.`,
                      action: "Remove from board",
                      danger: true,
                      onConfirm: async () => {
                        await hubRpc("hub.hosts.remove", { id: LinkId.make(host.id) })
                        navigate({ name: "settings", tab: "hosts" }, true)
                      },
                    })
                  }
                >
                  <Trash2 size={12} /> Remove from board
                </Button>
              </div>
            </section>
          )}
          {confirm.dialog}
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
