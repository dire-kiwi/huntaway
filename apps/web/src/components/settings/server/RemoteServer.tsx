import { Exit } from "effect"
import { Download, Loader2, RotateCw } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useMutation } from "../../../state/mutation"
import { Button, Modal } from "../../ui"
import { PHASES, RunningServer, stagedRelease, useServerStatus } from "./parts"
import { Releases, ShellNotice } from "./Releases"
import { RestartModal } from "./RestartModal"

// The old HostPage's RemoteServer and HostService (docs/plan/09-frontend.md): a linked host's server and any host's
// systemd service, over that host's `admin.*` through the hub's relay, followed by polling its `admin.status` (a linked
// host's restart events reach its own board stream, which goes down with it).

/**
 * A linked host's server, followed by polling it: Rebuild & restart, and for a host with release updates
 * (`--release-updates`) its version, the release checks and download, Update, Check now and Roll back.
 */
export function RemoteServer({ hostId }: { hostId: string }) {
  // The boot id before the restart: it's over when that changes, or the restart fails.
  const [watching, setWatching] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const { status, down } = useServerStatus(hostId, watching ? "1.5 seconds" : downloading ? "3 seconds" : "10 seconds")
  const [asking, setAsking] = useState<"restart" | "release" | "rollback" | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  // A background download's progress is worth following more closely.
  const nowDownloading = !!status?.release?.download && status.release.download.phase !== "failed"
  if (nowDownloading !== downloading) setDownloading(nowDownloading)
  if (watching && status && (status.boot_id !== watching || status.restart?.phase === "failed")) setWatching(null)
  const job = status?.restart
  const log = job?.log

  useEffect(() => {
    const el = logRef.current
    if (el && log) el.scrollTop = el.scrollHeight
  }, [log])

  const busy = !!watching
  const release = status?.release
  const staged = stagedRelease(status)
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Server</h2>
        <div className="flex gap-2">
          {staged && (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => setAsking("release")}>
              <Download size={13} /> Update to v{staged}
            </Button>
          )}
          {/* Asks first, as this board's own Rebuild & restart does: it says what the restart takes in and what's running. */}
          <Button size="sm" disabled={!status || busy} onClick={() => setAsking("restart")}>
            <RotateCw size={13} /> {status?.source_dir ? <>Rebuild &amp; restart</> : "Restart"}
          </Button>
        </div>
      </div>
      <div className="space-y-2 rounded-xl border border-line p-4 text-[12.5px] text-muted">
        {status ? (
          <>
            <RunningServer status={status} />
            {status.source_dir ? (
              <div>
                Builds from <span className="font-mono">{status.source_dir}</span>
                {status.source_branch && (
                  <>
                    {" "}
                    on <span className="font-mono">{status.source_branch}</span>
                  </>
                )}
                {status.new_commits?.length ? <span className="text-accent">, {status.new_commits.length} new commit(s) there</span> : null}
              </div>
            ) : (
              !release && <div>Not running from a source checkout, so it can restart but not rebuild.</div>
            )}
            <div>Agents keep running through a restart.</div>
          </>
        ) : (
          <div>{down ? "It doesn't answer." : "Loading…"}</div>
        )}
        {busy && (
          <div className="flex items-center gap-2 pt-1 text-fg">
            <Loader2 size={14} className="animate-spin text-accent" />
            {down ? "Restarting, waiting for it to come back…" : (PHASES[job?.phase ?? "starting"] ?? job?.phase)}
          </div>
        )}
        {job?.phase === "failed" && <div className="rounded bg-red-500/10 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-red-300">{job.error}</div>}
        {(busy || job?.phase === "failed") && log && (
          <pre
            ref={logRef}
            className="h-48 overflow-auto rounded-md border border-line bg-[#0c0c10] p-2 font-mono text-[11px] whitespace-pre-wrap text-[#b9b9c8]"
          >
            {log}
          </pre>
        )}
      </div>
      {status && release && (
        <Releases
          hostId={hostId}
          release={release}
          onRollback={() => {
            setAsking("rollback")
          }}
        />
      )}
      {release?.shell?.outdated && <ShellNotice release={release} remote />}
      {asking && status && (
        <RestartModal
          status={status}
          hostId={hostId}
          release={asking === "release" ? "update" : asking === "rollback" ? "rollback" : undefined}
          onStarted={() => setWatching(status.boot_id)}
          onClose={() => setAsking(null)}
        />
      )}
    </section>
  )
}

/**
 * A host on Linux with systemd: whether it runs as a user service, and if not, Install service, which writes the unit,
 * turns lingering on and restarts the host under it. It's how a host is kept running now that a hub no longer starts one
 * over SSH.
 */
export function HostService({ hostId }: { hostId: string }) {
  // The boot id before the switch.
  const [watching, setWatching] = useState<string | null>(null)
  const { status } = useServerStatus(hostId, watching ? "1.5 seconds" : "30 seconds")
  const [asking, setAsking] = useState(false)
  const [{ error: err }, installService] = useMutation("admin.installService")
  if (watching && status && (status.boot_id !== watching || status.restart?.phase === "failed")) setWatching(null)
  const svc = status?.service
  if (!status || !svc) return null
  const failed = !watching && status.restart?.phase === "failed" ? status.restart : null
  const install = () => {
    const boot = status.boot_id
    void installService(hostId, undefined).then((exit) => {
      if (!Exit.isSuccess(exit)) return
      setWatching(boot)
      setAsking(false)
    })
  }
  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Service</h2>
        {!svc.running && !svc.other && (
          <Button size="sm" disabled={!!watching} onClick={() => setAsking(true)}>
            {svc.installed ? "Restart under the service" : "Install service"}
          </Button>
        )}
      </div>
      <div className="space-y-1 text-[12.5px] text-muted">
        {svc.running ? (
          <div>
            Runs as the user service <span className="font-mono text-fg">{svc.unit}</span>
            {svc.enabled ? (svc.linger ? ", started at boot." : `, started when ${svc.user} logs in.`) : ", which isn't enabled."}
          </div>
        ) : svc.other ? (
          <div>
            Runs as the systemd service <span className="font-mono text-fg">{svc.other}</span>, which keeps it running.
          </div>
        ) : svc.installed ? (
          <div>
            <span className="font-mono text-fg">{svc.unit}</span> is installed, but this server was started some other way. Restart it under the service to have
            systemd keep it running.
          </div>
        ) : (
          <div>Run this host as a user systemd service, so it starts at boot and comes back if it stops. A hub that links it over SSH needs it running.</div>
        )}
        {svc.running && !svc.linger && (
          <div>
            Lingering is off for {svc.user}: <span className="font-mono">sudo loginctl enable-linger {svc.user}</span> on that machine starts it at boot.
          </div>
        )}
        {watching && (
          <div className="flex items-center gap-2 pt-1 text-fg">
            <Loader2 size={14} className="animate-spin text-accent" /> Restarting under {svc.unit}…
          </div>
        )}
        {failed && <div className="rounded bg-red-500/10 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-red-300">{failed.error}</div>}
      </div>
      {asking && (
        <Modal title={svc.installed ? `Restart under ${svc.unit}` : "Install service"} onClose={() => setAsking(false)}>
          <div className="space-y-3 text-[12.5px] text-muted">
            <p>
              This writes <span className="font-mono break-all text-fg">{svc.path}</span> to run this server with the flags and settings it has now, enables it,
              turns lingering on for {svc.user} (so it starts at boot), and restarts the host under it.
            </p>
            <p>Agents keep running through the restart, and stopping or restarting the service later leaves them running too.</p>
            {err && <div className="rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{err}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAsking(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={install}>
                {svc.installed ? "Restart under it" : "Install & restart"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}
