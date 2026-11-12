import { useAtomValue } from "@effect/atom-react"
import { query, type QueryResult } from "@huntaway/client"
import type { HostInfo } from "@huntaway/contracts"
import { AsyncResult, Atom } from "effect/reactivity"
import { Download, Loader2, RotateCw } from "lucide-react"
import { useState } from "react"
import { useBoard } from "../../state/board"
import { Button, resultError, resultValue, timeAgo } from "../ui"
import { PHASES, RunningServer, short, stagedRelease, useServerStatus } from "./server/parts"
import { Releases, ShellNotice } from "./server/Releases"
import { RestartModal } from "./server/RestartModal"
import { useNewUiBuild } from "./uiVersion"

// Settings → Server (docs/plan/09-frontend.md): what this server runs and where (`admin.status`, polled and read again on
// focus, with `host.info`'s machine and data folder), restarting and rebuilding, following a deployment, releases
// (check, download, Update, Roll back: settings/server/), the desktop app's own update, and the sidebar's Update button.
// The old database line (which file, Copy again) and the threads' batch rebuild are dropped
// (docs/plan/14-dropped-and-open.md: the two-file database scheme, moving threads onto items).

/** No host to ask yet. */
const noInfo: Atom.Atom<QueryResult<"host.info">> = Atom.make<QueryResult<"host.info">>(AsyncResult.initial())

/** What `host` says of itself (`host.info`), read while it's shown; null until then. */
export function useHostInfo(host: string | null): { info: HostInfo | null; error: string | null } {
  const result = useAtomValue(host ? query("host.info", host, undefined) : noInfo)
  return { info: resultValue(result) ?? null, error: resultError(result) }
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

/**
 * Sidebar prompt shown when the source checkout, or the deployment this server follows (`--update-from`), has commits it
 * isn't running, or a newer release is downloaded and ready (`--release-updates`). A release still downloading in the
 * background, or one whose download failed, needs no attention: Settings → Server shows those.
 */
export function UpdateButton() {
  const host = useBoard((s) => s.localHostId)
  const { status } = useServerStatus(host, "30 seconds", { focus: true })
  const live = useBoard((s) => s.restart)
  const [open, setOpen] = useState(false)
  const busy = live && live.phase !== "failed"
  const deployed = status?.deployed_commits?.length ?? 0
  const pending = deployed || (status?.new_commits?.length ?? 0)
  const release = stagedRelease(status)
  if (!busy && pending === 0 && !release && !open) return null
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="mb-1 flex h-8 w-full items-center gap-2.5 rounded-md bg-accent/10 px-2.5 text-[12.5px] text-accent hover:bg-accent/15"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}
        <span className="truncate">
          {busy
            ? (PHASES[live.phase] ?? live.phase)
            : release
              ? `v${release} · Update`
              : `${pending} new commit${pending === 1 ? "" : "s"} · ${deployed ? "Update" : "Restart"}`}
        </span>
      </button>
      {open && status && <RestartModal status={status} update={deployed > 0} release={release ? "update" : undefined} onClose={() => setOpen(false)} />}
    </>
  )
}

/** Server section on the Settings page: the host serving this UI. */
export function ServerPanel() {
  const host = useBoard((s) => s.localHostId)
  const { info } = useHostInfo(host)
  const { status } = useServerStatus(host, "15 seconds", { focus: true })
  const [open, setOpen] = useState<"restart" | "update" | "release" | "rollback" | null>(null)
  const deployed = status?.deployed
  const ahead = status?.deployed_commits?.length ?? 0
  const release = status?.release
  const staged = stagedRelease(status)
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Server</h2>
        <div className="flex gap-2">
          {staged && (
            <Button size="sm" variant="primary" onClick={() => setOpen("release")}>
              <Download size={13} /> Update to v{staged}
            </Button>
          )}
          {ahead > 0 && (
            <Button size="sm" variant="primary" onClick={() => setOpen("update")}>
              <Download size={13} /> Update to {short(deployed?.commit)}
            </Button>
          )}
          <Button size="sm" onClick={() => setOpen("restart")} disabled={!status}>
            <RotateCw size={13} /> {status?.source_dir || !release ? "Rebuild & restart" : "Restart"}
          </Button>
        </div>
      </div>
      <div className="space-y-1.5 rounded-xl border border-line p-4 text-[12.5px] text-muted">
        {status ? (
          <>
            <RunningServer status={status} info={info} />
            {status.source_dir ? (
              <div>
                Source <span className="font-mono">{status.source_dir}</span> is at <span className="font-mono text-fg">{short(status.source_commit)}</span>
                {status.source_branch && (
                  <>
                    {" "}
                    on <span className="font-mono">{status.source_branch}</span>
                  </>
                )}
                {status.new_commits?.length ? (
                  <span className="text-accent">, {status.new_commits.length} commit(s) ahead of the running server</span>
                ) : (
                  <span>, the same as the running server</span>
                )}
              </div>
            ) : (
              !release && <div>No source checkout found, so restart reuses the current binary. Start the server with --source-dir to enable rebuilds.</div>
            )}
            {status.update_from && (
              <div>
                Follows <span className="font-mono">{status.update_from}</span>
                {deployed?.commit && (
                  <>
                    , which runs <span className="font-mono text-fg">{short(deployed.commit)}</span>
                    {ahead > 0 ? (
                      <span className="text-accent">, {ahead} commit(s) ahead of this server</span>
                    ) : deployed.commit === status.running_commit ? (
                      <span>, the same as this server</span>
                    ) : null}
                  </>
                )}
                {deployed ? ` (checked ${timeAgo(deployed.checked_at)})` : ", not checked yet"}
                {deployed?.error && <div className="mt-1 font-mono text-[11.5px] text-red-300">{deployed.error}</div>}
              </div>
            )}
          </>
        ) : (
          <div>Loading…</div>
        )}
      </div>
      {status && release && host && <Releases hostId={host} release={release} onRollback={() => setOpen("rollback")} />}
      {release?.shell?.outdated && <ShellNotice release={release} />}
      {open && status && (
        <RestartModal
          status={status}
          update={open === "update"}
          release={open === "release" ? "update" : open === "rollback" ? "rollback" : undefined}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  )
}
