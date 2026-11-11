import type { HostInfo } from "@huntaway/contracts"
import { RotateCw } from "lucide-react"
import { useEffect, useState } from "react"
import { useBoard } from "../../state/board"
import { rpc } from "../../state/rpc"
import { errorText } from "../ui"
import { useNewUiBuild } from "./uiVersion"

// Step 1 (docs/plan/09-frontend.md) for settings/Server.tsx. What this server runs and where comes from `host.info`.
// Restarting, rebuilding, following a deployment, releases (check, download, Update, Roll back), the desktop shell's
// notice, the service and the sidebar's Update button are the update area's (`admin.*`, M8, board task HE-6, not on
// this server yet): their place is marked below, and HE-6 brings the old components (`RestartModal`, `Releases`,
// `RunningServer`, `UpdateButton`…). The old database line (which file, Copy again) and the threads' batch rebuild are
// dropped (docs/plan/14-dropped-and-open.md: the two-file database scheme, moving threads onto items).

const short = (sha?: string | null): string => (sha ? sha.slice(0, 7) : "unknown")

/** What `host` says of itself (`host.info`), read when it's shown; null until then. */
export function useHostInfo(host: string | null): { info: HostInfo | null; error: string | null } {
  const [read, setRead] = useState<{ host: string; info: HostInfo | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!host) return undefined
    const req = { live: true }
    rpc(host, "host.info", undefined).then(
      (info) => {
        if (req.live) setRead({ host, info, error: null })
      },
      (e: unknown) => {
        if (req.live) setRead({ host, info: null, error: errorText(e) })
      },
    )
    return () => {
      req.live = false
    }
  }, [host])
  return read?.host === host ? read : { info: null, error: null }
}

/** Sidebar prompt shown when the server has a newer UI build than this page is running. */
export function ReloadButton() {
  const fresh = useNewUiBuild()
  const live = useBoard((s) => s.restart)
  // A restart reloads the page itself once it's done.
  if (!fresh || live) return null
  return (
    <button
      onClick={() => window.location.reload()}
      title="The server has a newer version of the board than this page is running"
      className="mb-1 flex h-8 w-full items-center gap-2.5 rounded-md bg-accent/10 px-2.5 text-[12.5px] text-accent hover:bg-accent/15"
    >
      <RotateCw size={14} />
      <span className="truncate">New version · Reload</span>
    </button>
  )
}

/** What a server runs: its version and commit, the machine, and its data folder. */
export function RunningServer({ info }: { info: HostInfo }) {
  return (
    <>
      <div>
        Running Huntaway <span className="font-mono text-fg">v{info.version}</span>
        {info.commit && (
          <>
            {" "}
            at <span className="font-mono text-fg">{short(info.commit)}</span>
          </>
        )}{" "}
        on <span className="font-mono">{info.hostname}</span>
        {info.read_only && <span className="text-accent">, read only (a rehearsal over an imported copy of the old board)</span>}
      </div>
      <div>
        Data folder <span className="font-mono">{info.data_dir}</span>
      </div>
      {info.updates_from && <div>Updates from {info.updates_from === "checkout" ? "its source checkout" : "GitHub's releases"}.</div>}
    </>
  )
}

/** Server section on the Settings page: the host serving this UI. */
export function ServerPanel() {
  const host = useBoard((s) => s.localHostId)
  const { info, error } = useHostInfo(host)
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Server</h2>
        {/* HE-6: Update to vX / Update to <commit> / Rebuild & restart (admin.restart, admin.updateRelease…). */}
      </div>
      <div className="space-y-1.5 rounded-xl border border-line p-4 text-[12.5px] text-muted">
        {info ? <RunningServer info={info} /> : error ? <div className="text-red-400">{error}</div> : <div>Loading…</div>}
        {/* HE-6: its source checkout or deployment and their new commits, and the release checks (admin.status). */}
        <div className="text-faint">Restarting, updates and releases are not yet on this server.</div>
      </div>
    </section>
  )
}
