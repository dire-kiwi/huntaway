import type { ReleaseDownload, ReleaseStatus, ServerStatus } from "@huntaway/contracts"
import { Copy, Download, Loader2, RefreshCw, Undo2 } from "lucide-react"
import { useState } from "react"
import { rpc } from "../../../state/rpc"
import { Button, copyText, errorText, timeAgo, Toggle } from "../../ui"
import { compareVersions } from "../versions"
import { mb } from "./parts"

// Step 1 (docs/plan/09-frontend.md) of the old Server.tsx's release parts: a host's release checks (`--release-updates`)
// over `admin.checkRelease` and its `release_prereleases` setting, and the desktop app's own update (its preload's
// `shellUpdateKind` and `updateShell`).

/**
 * The release checks (`--release-updates`) of host `hostId`'s server: what they found, the background download, Check
 * now, prereleases and Roll back.
 */
export function Releases({
  hostId: host,
  release,
  onStatus,
  refresh,
  onRollback,
}: {
  hostId: string
  release: ReleaseStatus
  onStatus: (s: ServerStatus) => void
  refresh: () => Promise<unknown>
  onRollback: () => void
}) {
  const [checking, setChecking] = useState(false)
  // The toggle's new value until the server's status has it.
  const [prereleases, setPrereleases] = useState<boolean | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const latest = release.latest
  const check = async () => {
    if (checking) return
    setChecking(true)
    setErr(null)
    try {
      onStatus(await rpc(host, "admin.checkRelease", undefined))
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setChecking(false)
    }
  }
  const togglePrereleases = async (on: boolean) => {
    setPrereleases(on)
    setErr(null)
    try {
      // The server checks again with the new setting, and the status shows what it finds.
      await rpc(host, "host.updateSettings", { patch: { release_prereleases: on } })
      await refresh()
    } catch (e) {
      setErr(errorText(e))
    }
    setPrereleases(null)
  }
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-line p-4 text-[12.5px] text-muted">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5">
          <div>
            {latest ? (
              <>
                Latest release on <span className="font-mono">{release.repo}</span>:{" "}
                <a href={latest.url} target="_blank" rel="noreferrer" className="font-mono text-fg hover:underline">
                  v{latest.version}
                </a>
                {latest.prerelease && " (prerelease)"}
                {latest.published_at && `, published ${timeAgo(latest.published_at)}`}
                {!latest.newer && (compareVersions(latest.version, release.running) === 0 ? ", which this server runs" : ", older than this server")}
              </>
            ) : release.checked_at ? (
              <>
                No release on <span className="font-mono">{release.repo}</span> has a server for this platform
                {release.prereleases ? "" : " (not counting prereleases)"}
              </>
            ) : (
              <>
                Releases on <span className="font-mono">{release.repo}</span>
              </>
            )}
          </div>
          <div>{release.checked_at ? `Checked ${timeAgo(release.checked_at)}` : "Not checked yet"}</div>
        </div>
        <Button size="sm" onClick={() => void check()} disabled={checking}>
          {checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Check now
        </Button>
      </div>
      {release.error && (
        <div className="font-mono text-[11.5px] text-red-300">
          {release.error}
          {release.rate_limit_reset && (
            <div className="font-sans text-muted">
              GitHub&apos;s rate limit resets at {new Date(release.rate_limit_reset).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.
            </div>
          )}
        </div>
      )}
      {release.download && <DownloadLine download={release.download} />}
      {release.staged && compareVersions(release.staged, release.running) > 0 && (
        <div className="text-fg">v{release.staged} is downloaded and checked: Update restarts the server on it.</div>
      )}
      {release.bad.length > 0 && (
        <div>
          Not offered again (rolled back from, or didn&apos;t start): <span className="font-mono">{release.bad.map((v) => `v${v}`).join(", ")}</span>
        </div>
      )}
      {err && <div className="text-red-400">{err}</div>}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <Toggle checked={prereleases ?? release.prereleases} onChange={(on) => void togglePrereleases(on)} label="Include prereleases" />
        {release.rollback_to && (
          <Button size="sm" onClick={onRollback}>
            <Undo2 size={13} /> Roll back to {release.rollback_to === "bundled" ? "the bundled version" : `v${release.rollback_to}`}
          </Button>
        )}
      </div>
    </div>
  )
}

function DownloadLine({ download: d }: { download: ReleaseDownload }) {
  if (d.phase === "failed") {
    return (
      <div className="text-red-300">
        Downloading v{d.version} failed{d.error ? `: ${d.error}` : ""}. It&apos;s tried again on the next check.
      </div>
    )
  }
  const share = d.phase === "downloading" && d.total ? Math.min(1, d.bytes / d.total) : null
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Loader2 size={12} className="animate-spin text-accent" />
        {d.phase === "downloading"
          ? `Downloading v${d.version} in the background: ${mb(d.bytes)}${d.total ? ` of ${mb(d.total)}` : ""}`
          : d.phase === "verifying"
            ? `Checking the download of v${d.version}…`
            : `Unpacking v${d.version} and checking that it runs…`}
      </div>
      {share !== null && (
        <div className="h-1 w-full max-w-sm overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-accent" style={{ width: `${share * 100}%` }} />
        </div>
      )}
    </div>
  )
}

/** How the desktop app can install its own package (HA-68), or null where it can't (or isn't the desktop app). */
type ShellUpdateKind = "appimage" | "pacman"

/** Where the desktop app's own update is (its preload's `updateShell`). */
interface ShellUpdateProgress {
  readonly phase: "checking" | "downloading" | "installing" | "restarting"
  readonly version?: string | undefined
  readonly bytes?: number | undefined
  readonly total?: number | undefined
}

/** The desktop app's own update, where its preload has it: what kind of install it can replace, and the update. */
function shellUpdater(): { kind: ShellUpdateKind | null; update: ((onProgress: (p: ShellUpdateProgress) => void) => Promise<unknown>) | null } {
  const bridge: unknown = Reflect.get(window, "huntawayDesktop")
  if (typeof bridge !== "object" || bridge === null) return { kind: null, update: null }
  const kindOf: unknown = Reflect.get(bridge, "shellUpdateKind")
  const kind: unknown = typeof kindOf === "function" ? Reflect.apply(kindOf, bridge, []) : null
  const updateShell: unknown = Reflect.get(bridge, "updateShell")
  return {
    kind: kind === "appimage" || kind === "pacman" ? kind : null,
    update: typeof updateShell === "function" ? (onProgress) => Promise.resolve<unknown>(Reflect.apply(updateShell, bridge, [onProgress])) : null,
  }
}

/**
 * The latest release comes with a new desktop app, which the server can't install: how to get it, or (where the app
 * can install it itself, HA-68) a button. With `remote`, the app is a linked host's, which only that host's app can
 * update: it says how.
 */
export function ShellNotice({ release, remote }: { release: ReleaseStatus; remote?: boolean | undefined }) {
  const shell = release.shell
  const pkg = shell?.package
  const latest = release.latest
  // The app installs its own package where its install is one it can replace (an AppImage, the pacman package) and is
  // the one this server reports on.
  const [desktop] = useState(shellUpdater)
  const kind = desktop.kind
  const updateShell = !remote && kind && kind === shell?.install && pkg ? desktop.update : null
  const [progress, setProgress] = useState<ShellUpdateProgress | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  if (!shell) return null
  const command = shell.install === "pacman" && pkg ? `sudo pacman -U ${pkg.url}` : null
  const page = latest && (
    <a href={latest.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
      the release&apos;s page
    </a>
  )
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-accent/30 bg-accent/[0.06] p-4 text-[12.5px] text-muted">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium text-fg">The desktop app {remote ? "on this host " : ""}has an update</div>
          <div>
            {latest ? `v${latest.version}` : "The latest release"} comes with a new version of the app itself
            {shell.version && ` (this one is v${shell.version})`}, which
            {updateShell ? " the app can install itself." : remote ? " that host's app installs from its own Settings → Server." : " the board can't install."}
          </div>
        </div>
        {updateShell && (
          <Button
            size="sm"
            variant="primary"
            disabled={!!progress}
            onClick={() => {
              setProgress({ phase: "checking" })
              setErr(null)
              // On success the app quits and relaunches, so the progress stays.
              updateShell(setProgress).catch((e: unknown) => {
                setProgress(null)
                setErr(errorText(e))
              })
            }}
          >
            {progress ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} {kind === "pacman" ? "Install" : "Update app"}
          </Button>
        )}
      </div>
      {progress && <ShellProgress progress={progress} kind={kind} />}
      {command ? (
        <div>
          <div className="mb-1">{updateShell ? "Or install" : "Install"} its package with:</div>
          <div className="flex items-center gap-2 rounded-md border border-line bg-[#0c0c10] py-1.5 pr-1.5 pl-2.5">
            <code className="min-w-0 flex-1 font-mono text-[11.5px] break-all text-[#b9b9c8]">{command}</code>
            <Button
              size="sm"
              variant="ghost"
              title="Copy the command"
              onClick={() => {
                copyText(command)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              <Copy size={12} /> {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      ) : shell.install === "appimage" && pkg ? (
        <div>
          {updateShell && "Or "}
          <a href={pkg.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            {updateShell ? "download" : "Download"} the new AppImage
          </a>{" "}
          and put it in place of <span className="font-mono">{shell.path ?? "this one"}</span>.
        </div>
      ) : shell.install === "mac" ? (
        <div>Download the dmg from {page ?? "the latest release"} and open it, then drag Huntaway to Applications.</div>
      ) : (
        <div>Download it from {page ?? "the latest release"}.</div>
      )}
      {err && <div className="whitespace-pre-wrap text-red-400">{err}</div>}
    </div>
  )
}

function ShellProgress({ progress: p, kind }: { progress: ShellUpdateProgress; kind: ShellUpdateKind | null }) {
  const v = p.version ? `v${p.version}` : "the new app"
  const share = p.phase === "downloading" && p.total ? Math.min(1, (p.bytes ?? 0) / p.total) : null
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Loader2 size={12} className="animate-spin text-accent" />
        {p.phase === "checking"
          ? "Looking up the latest release…"
          : p.phase === "downloading"
            ? `Downloading ${v}: ${mb(p.bytes ?? 0)}${p.total ? ` of ${mb(p.total)}` : ""}`
            : p.phase === "installing"
              ? `Installing ${v}: enter your password when the system asks for it`
              : `${kind === "appimage" ? "Replaced the AppImage" : `Installed ${v}`}. Restarting the app…`}
      </div>
      {share !== null && (
        <div className="h-1 w-full max-w-sm overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-accent" style={{ width: `${share * 100}%` }} />
        </div>
      )}
    </div>
  )
}
