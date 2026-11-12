import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { canRunAgents, nearbyHostsAtom } from "@huntaway/client"
import { LinkId } from "@huntaway/contracts"
import { Loader2, Radar, RefreshCw } from "lucide-react"
import { useShallow } from "../../boardHelpers"
import { useBoard } from "../../../state/board"
import { useMutation } from "../../../state/mutation"
import { Button, Field, resultError, resultValue } from "../../ui"

/**
 * Hosts found on the LAN and Tailscale that aren't on this board yet, each offered for linking by URL. Finding them
 * (`hub.hosts.discover`) comes with discovery (docs/plan/13-milestones.md, 7.5); until then the search says so.
 */
export function NearbyHosts({ onLink }: { onLink: (url: string) => void }) {
  const hosts = useBoard((s) => s.hosts)
  const result = useAtomValue(nearbyHostsAtom)
  const search = useAtomRefresh(nearbyHostsAtom)
  const found = resultValue(result)
  const err = resultError(result)
  const busy = result.waiting
  // Those linked since the search are left out too, by id or URL.
  const unlinked = (found?.hosts ?? []).filter((d) => !d.linked && !hosts.some((h) => (d.host_id && h.id === d.host_id) || h.url === d.url))
  const where = found?.tailscale ? "on this network or Tailscale" : "on this network"
  return (
    <div className="mt-3 rounded-xl border border-line px-4 py-3">
      <div className="flex items-center gap-2">
        <Radar size={14} className="shrink-0 text-muted" />
        <div className="flex-1 text-[12.5px] font-medium">Nearby hosts</div>
        <Button size="sm" variant="ghost" disabled={busy} onClick={search} title="Search again">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} {busy ? "Searching…" : "Search again"}
        </Button>
      </div>
      {err ? (
        <div className="mt-1 text-xs text-red-400">Couldn't search: {err}</div>
      ) : found && unlinked.length === 0 ? (
        <div className="mt-1 text-[11.5px] text-faint">
          No other hosts found {where}, or linked from the hosts linked here. A host answers when it listens beyond localhost (not <code>--host 127.0.0.1</code>
          ); on Tailscale, one on its default port is found whatever its version.
        </div>
      ) : (
        <div className="mt-2 space-y-1.5">
          {unlinked.map((d) => (
            <div key={d.url} className="flex items-center gap-3 rounded-lg bg-panel px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium">{d.name}</div>
                <div className="truncate text-[11.5px] text-faint">
                  {d.via === "mesh" ? `Linked from ${d.through ?? "a linked host"}` : d.via === "tailscale" ? "Tailscale" : "LAN"} · {d.url}
                  {d.version ? ` · v${d.version}` : ""}
                </div>
              </div>
              <Button size="sm" onClick={() => onLink(d.url)}>
                Link
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** A board that can't run agents picks which host runs its scratch tasks. */
export function ScratchHostRow() {
  const local = useBoard((s) => s.hosts.find((h) => h.local))
  const hosts = useBoard(useShallow((s) => s.hosts.filter((h) => !h.local && canRunAgents(h))))
  const picked = useBoard((s) => (local ? s.hostSettings[local.id]?.scratch_host : null)) ?? ""
  const [{ error: err }, updateSettings] = useMutation("host.updateSettings")
  if (!local || canRunAgents(local) || hosts.length === 0) return null
  // The host's settings event puts the choice on the board.
  const save = (id: string) => void updateSettings(local.id, { patch: { scratch_host: id ? LinkId.make(id) : null } })
  return (
    <div className="mt-3 rounded-xl border border-line px-4 py-3">
      <Field label="Scratch task host" hint="This board can't run agents, so new scratch tasks (which are in no project) run on this host.">
        <select
          value={picked}
          onChange={(e) => save(e.target.value)}
          className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
        >
          <option value="">Automatic (first available host)</option>
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
          {picked && !hosts.some((h) => String(h.id) === String(picked)) && <option value={picked}>Unavailable host</option>}
        </select>
      </Field>
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
    </div>
  )
}
