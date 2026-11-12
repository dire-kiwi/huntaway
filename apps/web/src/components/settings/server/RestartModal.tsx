import type { RestartState } from "@huntaway/client"
import type { ReleaseStatus, ServerStatus } from "@huntaway/contracts"
import { clsx } from "clsx"
import { CircleAlert, ExternalLink, GitCommitHorizontal, Loader2, RotateCw, Undo2 } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { board, useBoard } from "../../../state/board"
import { rpc } from "../../../state/rpc"
import { Markdown } from "../../task/thread/Markdown"
import { Button, errorText, Modal, ModalFooter, Toggle } from "../../ui"
import { PHASES, short, stagedRelease, Warning } from "./parts"

// Step 1 (docs/plan/09-frontend.md) of the old Server.tsx's RestartModal over `admin.restart`, `admin.update`,
// `admin.updateRelease` and `admin.rollback`. This host's restart is followed by its `restart` and `restart_log` events
// (the board's `restart`); a linked host's by its page, polling. The old "Copy again" (`recopy`) is dropped with the
// two-file database (docs/plan/14-dropped-and-open.md).

/** What a restart this dialog has just asked for shows until the host's first event of it arrives. */
const STARTING: RestartState = { phase: "starting", error: null, log: [] }

/**
 * Rebuild and restart, or with `update` first fast-forward the checkout to the commit its `--update-from` deployment runs.
 * With `release`, restart onto the staged release (`"update"`) or the one before this one (`"rollback"`) instead.
 * With a `hostId`, a linked host's server: it asks the same way, then closes once the restart (or release update or
 * rollback) has started, calling `onStarted`, and the host's page follows its progress.
 */
export function RestartModal({
  status,
  update,
  release,
  hostId,
  onStarted,
  onClose,
}: {
  status: ServerStatus
  update?: boolean | undefined
  release?: "update" | "rollback" | undefined
  hostId?: string | undefined
  onStarted?: (() => void) | undefined
  onClose: () => void
}) {
  const localHost = useBoard((s) => s.localHostId)
  const remote = !!hostId && hostId !== localHost
  // The board's restart events are the local host's.
  const live = useBoard((s) => (remote ? null : s.restart))
  const [rebuild, setRebuild] = useState(!!status.source_dir)
  const [err, setErr] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  // The commit to update to, kept from when the modal opened.
  const [target] = useState(!release && update && status.deployed_commits?.length ? (status.deployed?.commit ?? null) : null)
  // The release to update to, or what a rollback goes back to, also kept from when the modal opened.
  const [version] = useState(release === "update" ? stagedRelease(status) : release === "rollback" ? (status.release?.rollback_to ?? null) : null)
  const running = status.release?.running
  const logRef = useRef<HTMLPreElement>(null)
  // The board's restart state when this dialog asked for one: until it changes, the restart shows as starting.
  const [asked, setAsked] = useState<{ readonly from: RestartState | null } | null>(null)
  // Seed with the server's view in case the restart began elsewhere.
  const seeded = status.restart ? { phase: status.restart.phase, error: status.restart.error, log: status.restart.log.split("\n").filter(Boolean) } : null
  const current = remote ? null : asked && live === asked.from ? STARTING : (live ?? seeded)
  // Whether this dialog started a restart, or saw one running (begun before it opened, or elsewhere). A restart that had
  // failed before then isn't shown: it would stand in for what this dialog does (Roll back's warning, say).
  const [started, setStarted] = useState(false)
  const [watched, setWatched] = useState(!!current && current.phase !== "failed")
  if (current && current.phase !== "failed" && !watched) setWatched(true)
  const job = current && (current.phase !== "failed" || started || watched) ? current : null
  // A failed restart this dialog didn't start: its button goes back to this dialog's confirm rather than retrying.
  const inherited = job?.phase === "failed" && !started
  const inProgress = !!job && job.phase !== "failed"
  const phase = job?.phase
  const logLines = job?.log.length ?? 0

  // Once the server goes down for the restart, wait for the new process, then reload for the new UI.
  useEffect(() => {
    if (phase !== "restarting") return undefined
    const since = Date.now()
    const id = setInterval(() => {
      const host = board.get().localHostId
      if (host)
        rpc(host, "admin.status", undefined).then(
          (s) => {
            if (s.boot_id !== status.boot_id) {
              clearInterval(id)
              window.location.reload()
            }
          },
          () => {
            // Still restarting.
          },
        )
      if (Date.now() - since > 120_000) {
        clearInterval(id)
        setErr("The server didn't come back within 2 minutes. Check its logs.")
      }
    }, 1000)
    return () => clearInterval(id)
  }, [phase, status.boot_id])

  useLayoutEffect(() => {
    const el = logRef.current
    if (el && logLines > 0) el.scrollTop = el.scrollHeight
  }, [logLines])

  const call = async (host: string): Promise<boolean> => {
    if (release === "update") await rpc(host, "admin.updateRelease", { version: version ?? "" })
    else if (release === "rollback") await rpc(host, "admin.rollback", undefined)
    else if (target) return !(await rpc(host, "admin.update", { commit: target })).up_to_date
    else await rpc(host, "admin.restart", { rebuild })
    return true
  }

  const start = async () => {
    if (starting) return
    setErr(null)
    if (remote && hostId) {
      setStarting(true)
      try {
        await call(hostId)
        onStarted?.()
        onClose()
      } catch (e) {
        setErr(errorText(e))
        setStarting(false)
      }
      return
    }
    const host = board.get().localHostId
    if (!host) return
    setStarted(true)
    setAsked({ from: live })
    try {
      // Already on the deployed commit: nothing to restart for.
      if (!(await call(host))) {
        setAsked(null)
        onClose()
      }
    } catch (e) {
      setAsked(null)
      setStarted(false)
      setErr(errorText(e))
    }
  }

  const commits = (release ? [] : target ? status.deployed_commits : status.new_commits) ?? []
  const rollbackTo = version === "bundled" ? "the bundled version" : `v${version}`
  const action = release === "rollback" ? `Roll back to ${rollbackTo}` : release || target ? "Update & restart" : rebuild ? "Rebuild & restart" : "Restart"
  const title = release === "update" ? "Update Huntaway" : release === "rollback" ? "Roll back Huntaway" : target ? "Update server" : "Rebuild & restart server"
  return (
    <Modal title={title} onClose={inProgress ? () => {} : onClose} width="max-w-2xl">
      <div className="space-y-4 text-[13px]">
        {!job && release === "update" && version && status.release && <ReleaseUpdate release={status.release} version={version} remote={remote} />}
        {!job && release === "rollback" && (
          <>
            <p className="text-muted">
              Restarts the server on{" "}
              {version === "bundled" ? (
                "the version that came with the desktop app"
              ) : (
                <>
                  <span className="font-mono text-fg">v{version}</span>, the version before this one
                </>
              )}
              , and doesn&apos;t offer <span className="font-mono text-fg">v{running}</span> again.{" "}
              {remote ? "This page follows it until it's back." : "The board reloads once it's back."}
            </p>
            <Warning>
              v{running} may have migrated the database, and an older version might not work with it. Roll back only when v{running} doesn&apos;t work.
            </Warning>
          </>
        )}
        {!job && (
          <>
            {!release && (
              <p className="text-muted">
                {target ? (
                  <>
                    Fetches <span className="font-mono text-fg">{short(target)}</span>, which {status.update_from} runs, from origin and fast-forwards{" "}
                    <span className="font-mono text-fg">{status.source_dir}</span> to it. Then it rebuilds the UI and server and restarts in place. If either
                    build fails, the current server keeps running.
                  </>
                ) : rebuild ? (
                  <>
                    Rebuilds the UI and the shim from <span className="font-mono text-fg">{status.source_dir}</span> (installing its dependencies when its
                    lockfile changed), then restarts in place. If either build fails, the current server keeps running.
                  </>
                ) : (
                  "Restarts the server process without rebuilding."
                )}
              </p>
            )}
            {commits.length > 0 && (
              <div className="rounded-lg border border-line bg-panel/60 p-3">
                <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-faint uppercase">
                  {target
                    ? `Deployed at ${status.update_from}, not on this server`
                    : `New on ${status.source_branch ?? "the checkout"} since this server started`}
                </div>
                <ul className="max-h-40 space-y-0.5 overflow-y-auto font-mono text-[12px] text-muted">
                  {commits.map((c) => (
                    <li key={c} className="flex gap-2">
                      <GitCommitHorizontal size={13} className="mt-0.5 shrink-0 text-faint" />
                      <span className="truncate">{c}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {status.running_agents > 0 && (
              <p className="text-[12.5px] text-muted">
                {status.running_agents} agent{status.running_agents === 1 ? " is" : "s are"} running. They keep going during the restart and the new server
                picks them back up.
              </p>
            )}
            {!release &&
              status.dirty &&
              (target ? (
                <Warning>The source checkout has uncommitted changes, so it can&apos;t be updated. Commit or discard them first.</Warning>
              ) : (
                <Warning>The source checkout has uncommitted changes, and they&apos;ll be included in the build.</Warning>
              ))}
            {!release && status.source_branch && status.source_branch !== "master" && status.source_branch !== "main" && (
              <Warning>
                The source checkout is on <span className="font-mono">{status.source_branch}</span>, not master.
              </Warning>
            )}
            {status.source_dir && !target && !release && <Toggle checked={rebuild} onChange={setRebuild} label="Rebuild before restarting" />}
          </>
        )}

        {job && (
          <div className="space-y-3">
            <div className={clsx("flex items-center gap-2", job.phase === "failed" ? "text-red-400" : "text-fg")}>
              {job.phase === "failed" ? <CircleAlert size={15} /> : <Loader2 size={15} className="animate-spin text-accent" />}
              {job.phase === "restarting" ? "Restarting, waiting for the server to come back…" : (PHASES[job.phase] ?? job.phase)}
            </div>
            {job.error && <div className="rounded bg-red-500/10 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-red-300">{job.error}</div>}
            {job.log.length > 0 && (
              <pre
                ref={logRef}
                className="h-72 overflow-auto rounded-md border border-line bg-[#0c0c10] p-2 font-mono text-[11.5px] leading-[1.45] whitespace-pre-wrap text-[#b9b9c8]"
              >
                {job.log.join("\n")}
              </pre>
            )}
            {job.phase === "failed" && <p className="text-[12px] text-muted">The server is still running {release ? `v${running}` : "the previous build"}.</p>}
          </div>
        )}

        <ModalFooter className="space-y-4">
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex justify-end gap-2">
            {!inProgress && (
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            )}
            {(!job || job.phase === "failed") && (
              <Button
                variant={release === "rollback" && !inherited ? "danger" : "primary"}
                disabled={starting || (!!release && !version)}
                onClick={inherited ? () => setWatched(false) : () => void start()}
              >
                {starting ? <Loader2 size={13} className="animate-spin" /> : release === "rollback" ? <Undo2 size={13} /> : <RotateCw size={13} />}{" "}
                {inherited ? `${action}…` : job ? "Try again" : action}
              </Button>
            )}
          </div>
        </ModalFooter>
      </div>
    </Modal>
  )
}

/** What a release update does: the versions, the release's notes and what happens to the server, agents and board. */
function ReleaseUpdate({ release, version, remote }: { release: ReleaseStatus; version: string; remote: boolean }) {
  // The notes are the latest release's, which is the staged one unless a newer one came out meanwhile.
  const latest = release.latest?.version === version ? release.latest : null
  return (
    <>
      <div className="flex items-baseline gap-2 font-mono text-[15px]">
        <span className="text-muted">v{release.running}</span>
        <span className="text-faint">→</span>
        <span className="text-fg">v{version}</span>
        {latest?.prerelease && <span className="font-sans text-[11px] text-amber-300">prerelease</span>}
      </div>
      {latest && (
        <div className="rounded-lg border border-line bg-panel/60 p-3">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] font-semibold tracking-wide text-faint uppercase">
            <span>Release notes</span>
            <a
              href={latest.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 font-normal tracking-normal text-accent normal-case hover:underline"
            >
              On GitHub <ExternalLink size={11} />
            </a>
          </div>
          <div className="max-h-72 overflow-y-auto text-[12.5px]">
            {latest.notes?.trim() ? <Markdown text={latest.notes} /> : <span className="text-muted">This release has no notes.</span>}
          </div>
        </div>
      )}
      <p className="text-muted">
        Restarts the server on <span className="font-mono text-fg">v{version}</span>, which is downloaded and checked already, and{" "}
        {remote ? "this page follows it until it's back" : "the board reloads once it's back"}. If the restart fails, this server keeps running v
        {release.running}.
      </p>
      {release.shell?.outdated && (
        <p className="text-[12px] text-faint">
          The desktop app itself has an update too: {remote ? "this host's page" : "Settings → Server"} says how to install it.
        </p>
      )}
    </>
  )
}
