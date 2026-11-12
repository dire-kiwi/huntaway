import { useAtomValue } from "@effect/atom-react"
import { hostSessionAtom, localHostIdAtom } from "@huntaway/client"
import type { HostId } from "@huntaway/contracts"
import { Eye } from "lucide-react"

/**
 * 9.1: on a read-only server (a rehearsal of an import, docs/plan/11-migration.md), a strip above the page saying so:
 * the board it is a copy of and when it was imported. Nothing on it can change anything (the server refuses).
 */
export function RehearsalBanner() {
  const local = useAtomValue(localHostIdAtom)
  return local === null ? null : <Banner host={local} />
}

function Banner({ host }: { host: HostId }) {
  const info = useAtomValue(hostSessionAtom(host)).info
  if (!info?.read_only) return null
  const when = info.rehearsal ? new Date(info.rehearsal.imported_at).toLocaleString() : null
  return (
    <div role="status" className="flex shrink-0 items-center justify-center gap-2 border-b border-accent/40 bg-accent/15 px-3 py-1 text-xs text-fg">
      <Eye size={13} className="shrink-0 text-accent" />
      <span className="min-w-0 truncate">
        A read-only rehearsal of {info.rehearsal ? <span className="font-mono">{info.rehearsal.from}</span> : "an imported board"}
        {when && <>, imported {when}</>}: it shows the board as it would be after the switch, and changes nothing.
      </span>
    </div>
  )
}
