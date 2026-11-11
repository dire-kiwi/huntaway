import type { HostInfo, ReleaseStatus, ServerStatus } from "@huntaway/contracts"
import { CircleAlert } from "lucide-react"
import { useCallback, useEffect, useState, type ReactNode } from "react"
import { rpc } from "../../../state/rpc"
import { timeAgo } from "../../ui"
import { compareVersions } from "../versions"

// What Settings → Server and a linked host's page share (the old Server.tsx's helpers): a host's `admin.status`, read
// now and again, and how its parts are said.

export const PHASES: Record<string, string> = {
  starting: "Starting…",
  building_ui: "Building the UI…",
  building_server: "Building the server…",
  downloading: "Downloading the release…",
  verifying: "Checking the download…",
  installing: "Installing the release…",
  restarting: "Restarting…",
  failed: "Restart failed",
}

export const short = (sha?: string | null): string => (sha ? sha.slice(0, 7) : "unknown")

export const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`

/** The release Update restarts onto: the staged one, once it's newer than the one running. */
export function stagedRelease(status: ServerStatus | null): string | null {
  const r = status?.release
  return r?.staged && compareVersions(r.staged, r.running) > 0 ? r.staged : null
}

/** `host`'s `admin.status`, read now, every `pollMs` and when the window gets the focus. */
export function useServerStatus(host: string | null, pollMs: number) {
  const [read, setRead] = useState<{ host: string; status: ServerStatus } | null>(null)
  const setStatus = useCallback(
    (status: ServerStatus) => {
      if (host) setRead({ host, status })
    },
    [host],
  )
  const refresh = useCallback(
    (): Promise<void> =>
      host
        ? rpc(host, "admin.status", undefined).then(
            (status) => setRead({ host, status }),
            () => {
              // Read again on the next poll.
            },
          )
        : Promise.resolve(),
    [host],
  )
  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), pollMs)
    const onFocus = () => void refresh()
    window.addEventListener("focus", onFocus)
    return () => {
      clearInterval(id)
      window.removeEventListener("focus", onFocus)
    }
  }, [refresh, pollMs])
  return { status: read?.host === host ? read.status : null, setStatus, refresh }
}

export function installName(shell: NonNullable<ReleaseStatus["shell"]>): string {
  const kind = { pacman: "pacman package", appimage: "AppImage", mac: "macOS app" }[shell.install] ?? "installed by hand"
  return shell.path ? `${kind}, ${shell.path}` : kind
}

/**
 * What the server is running: its version or commit and since when, its executable, the desktop app that started it,
 * and with `info` (`host.info`) the machine, its data folder and whether it is a read-only rehearsal.
 */
export function RunningServer({ status, info }: { status: ServerStatus; info?: HostInfo | null | undefined }) {
  const release = status.release
  return (
    <>
      <div>
        Running{" "}
        {release ? (
          <>
            <span className="font-mono text-fg">v{release.running}</span>
            {status.running_commit && <span className="font-mono"> ({short(status.running_commit)})</span>}
          </>
        ) : (
          <>
            <span className="font-mono text-fg">v{status.version}</span> at <span className="font-mono text-fg">{short(status.running_commit)}</span>
          </>
        )}
        {info && (
          <>
            {" "}
            on <span className="font-mono">{info.hostname}</span>
          </>
        )}
        , started {timeAgo(status.started_at)}
        {info?.read_only && <span className="text-accent">, read only (a rehearsal over an imported copy of the old board)</span>}
      </div>
      {release?.exe && (
        <div>
          From <span className="font-mono break-all">{release.exe}</span>
        </div>
      )}
      {release?.shell && (
        <div>
          Started by the desktop app{release.shell.version && ` v${release.shell.version}`} ({installName(release.shell)})
        </div>
      )}
      {info && (
        <div>
          Data folder <span className="font-mono">{info.data_dir}</span>
        </div>
      )}
    </>
  )
}

export function Warning({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md bg-st-attention/[0.08] px-3 py-2 text-[12.5px] text-amber-200/90">
      <CircleAlert size={14} className="mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  )
}
