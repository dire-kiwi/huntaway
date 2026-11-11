import type { Host } from "@huntaway/contracts"
import { LinkId } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Loader2, Server, Trash2 } from "lucide-react"
import { useState } from "react"
import { useBoard } from "../../../state/board"
import { navigate } from "../../../state/route"
import { Button, Input, timeAgo, Toggle, useAsyncAction, useConfirm } from "../../ui"
import { hubRpc } from "./hub"

const MODE_LABEL: Record<Host["mode"], string> = {
  local: "this host",
  outbound: "linked by URL",
  inbound: "dials in",
  ssh: "over SSH",
}

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
 * update" and nothing else (docs/plan/05-protocol.md, Versions). Update sends this board's code (or the release it
 * runs) to the host, which rebuilds and restarts (`hub.hosts.pushUpdate`, the host's `admin.update`); it is over when
 * the host comes back on the board's commit or version. Agents keep running meanwhile.
 */
export function HostVersion({ host }: { host: Host }) {
  const local = useBoard((s) => s.hosts.find((h) => h.local))
  const update = useAsyncAction()
  const [sent, setSent] = useState<"updating" | "up to date" | null>(null)
  const outdated = host.status === "needs_update"
  const behind = !host.local && !!host.commit && !!local?.commit && host.commit !== local.commit
  const release = host.updates_from === "releases"
  const olderRelease = release && !!local?.version && !!host.version && local.version !== host.version
  const live = host.status === "connected" || outdated
  const canUpdate = !host.local && live && (outdated || behind || olderRelease)
  // The host back on the board's code ends "updating".
  const arrived = sent === "updating" && !canUpdate
  if (!host.version && !outdated) return null
  const push = () =>
    void update.run(async () => {
      setSent(null)
      const r = await hubRpc("hub.hosts.pushUpdate", { id: LinkId.make(host.id) })
      setSent(r.up_to_date ? "up to date" : "updating")
    })
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
      {canUpdate && sent !== "updating" && (
        <button
          type="button"
          className="text-accent hover:underline disabled:opacity-50"
          disabled={update.busy}
          onClick={push}
          title={
            release
              ? "The host downloads this release and restarts onto it. Agents keep running."
              : "Send this board's code to the host, which rebuilds and restarts. Agents keep running."
          }
        >
          {update.busy ? "Updating…" : `Update to ${release ? `v${local?.version ?? "?"}` : (short(local?.commit) ?? "this board's code")}`}
        </button>
      )}
      {sent === "updating" && !arrived && <span className="text-st-progress">updating…</span>}
      {sent === "up to date" && <span className="text-muted">already up to date</span>}
      {update.error && <span className="text-red-400">{update.error}</span>}
    </div>
  )
}

export function HostRow({ host }: { host: Host }) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(host.name)
  const rename = useAsyncAction()
  const confirm = useConfirm()
  const status = statusOf(host)
  const startRename = () => {
    // From its name now, which may have changed since this row was first shown.
    setName(host.name)
    rename.setError(null)
    setRenaming(true)
  }
  const save = () => {
    setRenaming(false)
    const to = name.trim()
    if (to && to !== host.name) void rename.run(() => hubRpc("hub.hosts.update", { id: LinkId.make(host.id), name: to }))
  }
  const away = !host.local && host.status !== "connected" && host.status !== undefined
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
          {MODE_LABEL[host.mode]}
          {host.url ? ` · ${host.url}` : ""}
          {away ? ` · ${status.label.toLowerCase()}${host.status_reason ? `: ${host.status_reason}` : ""}` : ""}
          {!host.connected && host.last_seen ? ` · last seen ${timeAgo(host.last_seen)}` : ""}
          {host.connected && host.agents === false ? " · board only (can't run agents)" : ""}
        </div>
        <HostVersion host={host} />
        {rename.error && <div className="mt-1 text-xs text-red-400">Couldn't rename it: {rename.error}</div>}
        <UplinkToggle host={host} />
      </div>
      <Button size="sm" onClick={() => navigate({ name: "host", hostId: host.id })}>
        Configure
      </Button>
      {!host.local && (
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
 * Whether a linked host's agents can use this board's tools, up the link. Off by default: an assistant host's agents can
 * then create and message tasks on this board's projects, with the access their profile has here.
 */
function UplinkToggle({ host }: { host: Host }) {
  const action = useAsyncAction()
  if (host.local || !(host.uplink || host.connected)) return null
  return (
    <div className="mt-2 space-y-1">
      <Toggle
        checked={host.uplink}
        onChange={(on) => void action.run(() => hubRpc("hub.hosts.update", { id: LinkId.make(host.id), uplink: on }))}
        label="Let this host's agents use this board"
      />
      <div className="text-[11.5px] text-faint">
        {host.uplink
          ? `Agents on ${host.name}, in the profiles whose assistant runs there, can list, read, create and change this board's projects and tasks (and its other hosts'), with the access that profile has here.`
          : `Agents on ${host.name} only see their own host's board and the hosts it links.`}
        {host.mode === "inbound" &&
          ` ${host.name} dials in to this board, which knows it only by the id it gives with the hub token: any host given that token could claim to be it. A host linked over SSH or by URL can't be stood in for.`}
      </div>
      {action.error && <div className="text-xs text-red-400">{action.error}</div>}
    </div>
  )
}
