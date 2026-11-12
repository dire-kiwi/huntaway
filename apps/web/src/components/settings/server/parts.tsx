import { useAtomValue } from "@effect/atom-react"
import { query, type QueryResult } from "@huntaway/client"
import type { HostInfo, ReleaseStatus, ServerStatus } from "@huntaway/contracts"
import type { Duration } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { CircleAlert } from "lucide-react"
import { useState, type ReactNode } from "react"
import { resultValue, timeAgo } from "../../ui"
import { compareVersions } from "../versions"

// What Settings → Server and a linked host's page share (the old Server.tsx's helpers): a host's `admin.status`, a
// polled query, and how its parts are said.

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

/** No host to read yet. */
const noStatus: Atom.Atom<QueryResult<"admin.status">> = Atom.make<QueryResult<"admin.status">>(AsyncResult.initial())

/**
 * `host`'s `admin.status`, read now and every `every` (and with `focus`, when the window gets the focus back); read again
 * after its `admin.*` changes and once the host has booted again (invalidate.ts). While the host doesn't answer, the last
 * status read stays, and `down` says so.
 */
export function useServerStatus(
  host: string | null,
  every: Duration.Input,
  options?: { readonly focus?: boolean | undefined },
): { status: ServerStatus | null; down: boolean } {
  const result = useAtomValue(host ? query("admin.status", host, undefined, { refresh: every, focus: options?.focus }) : noStatus)
  const current = resultValue(result)
  // A host's runtime that connects again starts its reads over: the last status stays meanwhile.
  const [last, setLast] = useState<{ readonly host: string; readonly status: ServerStatus } | null>(null)
  if (host && current && (last?.host !== host || last.status !== current)) setLast({ host, status: current })
  const status = current ?? (last?.host === host ? last.status : null)
  return { status, down: AsyncResult.isFailure(result) || (!current && status !== null) }
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
