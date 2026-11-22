import { useAtomValue } from "@effect/atom-react"
import type { Host } from "@huntaway/contracts"
import { LinkId } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Loader2, Server, Trash2 } from "lucide-react"
import { useState } from "react"
import { useBoard } from "../../../state/board"
import { useAction, useMutation } from "../../../state/mutation"
import { navigate } from "../../../state/route"
import { Button, Help, Input, Select, timeAgo, ToggleField, useConfirm } from "../../ui"
import { hubRpc, useHubMutation } from "./hub"
import { clusterOf, hostUpdateAtom, offerOf, updateHosts } from "./hostUpdate"
import { useUpdateCommit } from "./useUpdateCommit"

const MODE_LABEL: Record<Host["mode"], string> = {
  local: "this host",
  outbound: "linked by URL",
  inbound: "dials in",
  ssh: "over SSH",
  reverse: "links this host",
  hub: "this host dials in to it",
  mesh: "in the mesh",
}

/** What a host is for: its own setting as its board has it, else what it said when it connected (HE-46). */
export const roleOf = (host: Pick<Host, "id" | "role">, settings: Readonly<Record<string, { readonly role?: Host["role"] }>>): "projects" | "access" =>
  settings[host.id]?.role ?? host.role ?? "projects"

/** A commit, short. */
const short = (c: string | null | undefined) => (c ? c.slice(0, 7) : null)

/** Where the link stands, as the hub says, beside its name. */
function statusOf(host: Host): { label: string; dot: string } {
  if (host.local) return { label: host.connected ? "Connected" : "Reconnecting…", dot: host.connected ? "bg-emerald-400" : "bg-red-400" }
  switch (host.status) {
    case "needs_update":
      return { label: "Needs an update", dot: "bg-amber-400" }
    case "refused":
      return { label: "Refused", dot: "bg-red-400" }
    case "connecting":
      return { label: "Connecting…", dot: "bg-amber-400 animate-pulse-dot" }
    case "offline":
      return { label: "Offline", dot: "bg-red-400" }
    case "connected":
    case undefined:
    default:
      return host.connected ? { label: "Connected", dot: "bg-emerald-400" } : { label: "Connecting…", dot: "bg-amber-400 animate-pulse-dot" }
  }
}

/**
 * The version line: what the host runs, and whether it needs an update. A host on another protocol shows "needs an
 * update" (docs/plan/05-protocol.md, Versions). Update sends this board's code (its checkout as it is, `useUpdateCommit`)
 * or, to a host installed from a release, the release it runs (only a newer one) to the host, which rebuilds and
 * restarts (`hub.hosts.pushUpdate`, the host's `admin.update`), and to every other host that differs too, so the whole
 * cluster moves together (HE-76, hostUpdate.ts, which follows each to its end). Its phases show while it does; it is
 * over when the host comes back (a new boot), or reconnects on that commit or version. Agents keep running meanwhile.
 */
export function HostVersion({ host }: { host: Host }) {
  const local = useBoard((s) => s.hosts.find((h) => h.local))
  const hosts = useBoard((s) => s.hosts)
  const target = useUpdateCommit(local)
  const { phase, error, upToDate } = useAtomValue(hostUpdateAtom(host.id))
  const [, run] = useAction()
  const outdated = host.status === "needs_update"
  const behind = !host.local && !!host.commit && !!local?.commit && host.commit !== local.commit
  const offer = offerOf(host, local, target)
  // The hosts an Update here updates: this one and the others that differ.
  const cluster = clusterOf(host, hosts, local, target)
  const others = cluster.length - 1

  if (!host.version && !outdated) return null
  const update = () => void run(updateHosts(cluster, local, target))
  const to = offer.release ? `v${offer.to ?? "?"}` : short(offer.to)
  const what = offer.release ? "The host downloads this release and restarts onto it." : "Send this board's code to the host, which rebuilds and restarts."
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-faint">
      {host.version && (
        <span className="font-mono">
          v{host.version}
          {host.protocol !== null ? ` · protocol ${host.protocol}` : ""}
          {short(host.commit) ? ` · ${short(host.commit)}` : ""}
        </span>
      )}
      {outdated && (
        <span className="rounded bg-st-attention/15 px-1.5 py-px text-amber-300" title="It speaks another protocol than this board. Update it.">
          Needs an update
        </span>
      )}
      {behind && !outdated && <span className="text-muted">differs from this board ({short(local?.commit)})</span>}
      {offer.can && !phase && (
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={update}
          title={
            others > 0
              ? `${what} The ${others} other host${others === 1 ? "" : "s"} that differ${others === 1 ? "s" : ""} from this board update too. Agents keep running.`
              : `${what} Agents keep running.`
          }
        >
          Update to {to}
          {others > 0 ? ` · all ${others + 1} hosts` : ""}
        </button>
      )}
      {phase && <span className="text-st-progress">{phase.replace("_", " ")}…</span>}
      {upToDate && !phase && <span className="text-muted">already up to date</span>}
      {error && <span className="text-red-400">{error}</span>}
    </div>
  )
}

export function HostRow({ host }: { host: Host }) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(host.name)
  const [rename, update] = useHubMutation("hub.hosts.update")
  // The last rename's failure, until renaming again.
  const [showRenameError, setShowRenameError] = useState(true)
  const confirm = useConfirm()
  const status = statusOf(host)
  const startRename = () => {
    // From its name now, which may have changed since this row was first shown.
    setName(host.name)
    setShowRenameError(false)
    setRenaming(true)
  }
  const save = () => {
    setRenaming(false)
    const to = name.trim()
    if (!to || to === host.name || rename.busy) return
    setShowRenameError(true)
    void update({ id: LinkId.make(host.id), name: to })
  }
  const away = !host.local && host.status !== "connected" && host.status !== undefined
  // A host this one reaches through another is forgotten where its link is; one that links this one (or that this one
  // dials in to) comes back while that link is there.
  const through = useBoard((s) => (host.through ? (s.hosts.find((h) => h.id === host.through)?.name ?? null) : null))
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line px-4 py-3" data-host={host.id}>
      <Server size={15} className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <Input
            autoFocus
            aria-label="Host name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
              else if (e.key === "Escape") setRenaming(false)
            }}
            className="h-7 max-w-xs"
          />
        ) : (
          <div className="flex items-center gap-2 text-[13px] font-medium">
            {host.name}
            <span className={clsx("h-1.5 w-1.5 rounded-full", status.dot)} title={status.label} />
          </div>
        )}
        <div className="truncate text-[11.5px] text-faint">
          {host.mode === "mesh" && through ? `through ${through}` : MODE_LABEL[host.mode]}
          {host.url ? ` · ${host.url}` : ""}
          {away ? ` · ${status.label.toLowerCase()}${host.status_reason ? `: ${host.status_reason}` : ""}` : ""}
          {!host.connected && host.last_seen ? ` · last seen ${timeAgo(host.last_seen)}` : ""}
          {host.connected && host.agents === false ? " · board only (can't run agents)" : ""}
        </div>
        <HostVersion host={host} />
        {showRenameError && rename.error && <div className="mt-1 text-xs text-red-400">Couldn't rename it: {rename.error}</div>}
        <RoleField host={host} />
        <MeshToggle host={host} />
        <UplinkToggle host={host} />
      </div>
      <Button size="sm" onClick={() => navigate({ name: "host", hostId: host.id })}>
        Configure
      </Button>
      {!host.local && host.mode !== "mesh" && (
        <>
          <Button size="sm" variant="ghost" disabled={rename.busy} onClick={startRename}>
            {rename.busy && <Loader2 size={12} className="animate-spin" />} Rename
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Remove from this board (its data stays on the host)"
            aria-label={`Remove ${host.name}`}
            onClick={() =>
              confirm.ask({
                title: `Remove ${host.name}`,
                body: `Remove ${host.name} from this board? Its projects and agents stay on that host.`,
                action: "Remove from board",
                danger: true,
                onConfirm: () => hubRpc("hub.hosts.remove", { id: LinkId.make(host.id) }),
              })
            }
          >
            <Trash2 size={13} />
          </Button>
        </>
      )}
      {confirm.dialog}
    </div>
  )
}

/**
 * What a host is for (HE-46): one for projects is offered for new projects; one for access only is a way in to the board
 * (a public hub, say) and isn't. Set on the host itself, through its own session, so any host's can be set from here.
 */
function RoleField({ host }: { host: Host }) {
  const settings = useBoard((s) => s.hostSettings)
  const [state, update] = useMutation("host.updateSettings")
  const role = roleOf(host, settings)
  if (!host.connected) return null
  const reachable = settings[host.id] !== undefined
  return (
    <div className="mt-2 flex items-center gap-1.5 text-[12.5px]">
      <span className="text-muted">For</span>
      {reachable ? (
        <Select
          aria-label={`What ${host.name} is for`}
          className="h-7 rounded-md border border-line bg-panel px-1.5 text-[12.5px] outline-none"
          value={role}
          disabled={state.busy}
          onChange={(v) => void update(host.id, { patch: { role: v === "access" ? "access" : "projects" } })}
        >
          <option value="projects">Projects</option>
          <option value="access">Access only</option>
        </Select>
      ) : (
        <span>{role === "access" ? "Access only" : "Projects"}</span>
      )}
      <Help label="What this host is for">
        A host for projects holds projects and runs their agents. A host for access only is a way in to the board, like a public hub: it isn&apos;t offered for
        new projects. With settings sync on, its settings, skills and MCP servers are kept the same as the other hosts&apos; either way.
      </Help>
      {state.error && <span className="text-xs text-red-400">{state.error}</span>}
    </div>
  )
}

/**
 * Whether the host this one links may reach this board back, and the hosts it reaches (HE-46). On by default: linking
 * two hosts either way makes one board of them, with each one's hosts on the other's.
 */
function MeshToggle({ host }: { host: Host }) {
  const [action, update] = useHubMutation("hub.hosts.update")
  if (host.mesh === undefined) return null
  return (
    <div className="mt-2 space-y-1">
      <ToggleField
        checked={host.mesh}
        onChange={(on) => {
          if (!action.busy) void update({ id: LinkId.make(host.id), mesh: on })
        }}
        label={`Let ${host.name} reach this board`}
        help={
          <>
            <span className="block">
              On, {host.name}&apos;s board shows this host and the hosts it reaches, and their projects, as this board shows {host.name}&apos;s, and settings
              sync (skills and MCP servers too) reaches the hosts beyond it. Off, only this host reaches {host.name}.
            </span>
            {host.mode === "inbound" && (
              <span className="block">
                {host.name} dials in with the hub token, which any host given it holds, so a host that dials in for the first time starts with this off, and any
                host given that token could claim to be {host.name} while it is away. Off, settings don&apos;t sync with {host.name} either, nor through it.
              </span>
            )}
          </>
        }
      />
      {action.error && <div className="text-xs text-red-400">{action.error}</div>}
    </div>
  )
}

/**
 * Whether a linked host's agents can use this board's tools, up the link. Off by default: an assistant host's agents can
 * then create and message tasks on this board's projects, with the access their profile has here.
 */
function UplinkToggle({ host }: { host: Host }) {
  const [action, update] = useHubMutation("hub.hosts.update")
  if (host.local || host.mode === "mesh" || host.mode === "reverse" || host.mode === "hub" || !(host.uplink || host.connected)) return null
  return (
    <div className="mt-2 space-y-1">
      <ToggleField
        checked={host.uplink}
        onChange={(on) => {
          if (!action.busy) void update({ id: LinkId.make(host.id), uplink: on })
        }}
        label="Let this host's agents use this board"
        help={
          <>
            <span className="block">
              Agents on {host.name}, in the profiles whose assistant runs there, can list, read, create and change this board&apos;s projects and tasks (and its
              other hosts&apos;), with the access that profile has here. Off, they only see their own host&apos;s board and the hosts it links.
            </span>
            {host.mode === "inbound" && (
              <span className="block">
                {host.name} dials in to this board, which knows it only by the id it gives with the hub token: any host given that token could claim to be it. A
                host linked over SSH or by URL can&apos;t be stood in for.
              </span>
            )}
          </>
        }
      />
      {/* What's at stake while it's on stays in sight. */}
      {host.uplink && host.mode === "inbound" && (
        <div className="text-[11.5px] text-amber-200/90">It dials in, so any host given the hub token could claim to be it.</div>
      )}
      {action.error && <div className="text-xs text-red-400">{action.error}</div>}
    </div>
  )
}
