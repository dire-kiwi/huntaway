import clsx from "clsx";
import { CircleAlert, GitCommitHorizontal, Loader2, RotateCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type ServerStatus } from "../api";
import { useStore } from "../store";
import { useNewUiBuild } from "../uiVersion";
import { Button, Modal, timeAgo, Toggle } from "./ui";

const PHASES: Record<string, string> = {
  starting: "Starting…",
  building_ui: "Building the UI…",
  building_server: "Building the server…",
  restarting: "Restarting…",
  failed: "Restart failed",
};

/** Status of the host serving this UI (the one a restart rebuilds). */
function useServerStatus(pollMs: number) {
  const host = useStore((s) => s.localHostId);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const refresh = useCallback(() => {
    if (host) api.serverStatus(host).then(setStatus).catch(() => {});
  }, [host]);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, pollMs);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh, pollMs]);
  return { status, refresh };
}

const short = (sha?: string | null) => (sha ? sha.slice(0, 7) : "unknown");

/** Sidebar prompt shown when the source checkout has commits this server isn't running. */
export function UpdateButton() {
  const { status } = useServerStatus(30_000);
  const live = useStore((s) => s.restart);
  const [open, setOpen] = useState(false);
  const busy = live && live.phase !== "failed";
  const pending = status?.new_commits?.length ?? 0;
  if (!busy && pending === 0 && !open) return null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="mb-1 flex h-8 w-full items-center gap-2.5 rounded-md bg-accent/10 px-2.5 text-[12.5px] text-accent hover:bg-accent/15"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}
        <span className="truncate">{busy ? PHASES[live.phase] : `${pending} new commit${pending === 1 ? "" : "s"} · Restart`}</span>
      </button>
      {open && status && <RestartModal status={status} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Sidebar prompt shown when the server has a newer UI build than this page is running. */
export function ReloadButton() {
  const fresh = useNewUiBuild();
  const live = useStore((s) => s.restart);
  // A restart reloads the page itself once it's done.
  if (!fresh || live) return null;
  return (
    <button
      onClick={() => window.location.reload()}
      title="The server has a newer version of the board than this page is running"
      className="mb-1 flex h-8 w-full items-center gap-2.5 rounded-md bg-accent/10 px-2.5 text-[12.5px] text-accent hover:bg-accent/15"
    >
      <RotateCw size={14} />
      <span className="truncate">New version · Reload</span>
    </button>
  );
}

/** Server section on the Settings page. */
export function ServerPanel() {
  const { status } = useServerStatus(15_000);
  const [open, setOpen] = useState(false);
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Server</h2>
        <Button size="sm" onClick={() => setOpen(true)} disabled={!status}>
          <RotateCw size={13} /> Rebuild &amp; restart
        </Button>
      </div>
      <div className="space-y-1.5 rounded-xl border border-line p-4 text-[12.5px] text-muted">
        {status ? (
          <>
            <div>
              Running <span className="font-mono text-fg">{short(status.running_commit)}</span>, started {timeAgo(status.started_at)}
            </div>
            {status.source_dir ? (
              <div>
                Source <span className="font-mono">{status.source_dir}</span> is at{" "}
                <span className="font-mono text-fg">{short(status.source_commit)}</span>
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
              <div>No source checkout found, so restart reuses the current binary. Start the server with --source-dir to enable rebuilds.</div>
            )}
          </>
        ) : (
          <div>Loading…</div>
        )}
      </div>
      {open && status && <RestartModal status={status} onClose={() => setOpen(false)} />}
    </section>
  );
}

export function RestartModal({ status, onClose }: { status: ServerStatus; onClose: () => void }) {
  const live = useStore((s) => s.restart);
  const [rebuild, setRebuild] = useState(!!status.source_dir);
  const [err, setErr] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  // Seed with the server's view in case the restart began elsewhere.
  const job = live ?? (status.restart ? { phase: status.restart.phase, error: status.restart.error, log: status.restart.log.split("\n") } : null);
  const inProgress = !!job && job.phase !== "failed";

  // Once the server goes down for the restart, wait for the new process, then reload for the new UI.
  useEffect(() => {
    if (job?.phase !== "restarting") return;
    setWaiting(true);
    const started = Date.now();
    const id = setInterval(async () => {
      try {
        const s = await api.serverStatus(useStore.getState().localHostId!);
        if (s.boot_id !== status.boot_id) {
          clearInterval(id);
          window.location.reload();
        }
      } catch {
        /* still restarting */
      }
      if (Date.now() - started > 120_000) {
        clearInterval(id);
        setErr("The server didn't come back within 2 minutes. Check its logs.");
      }
    }, 1000);
    return () => clearInterval(id);
  }, [job?.phase, status.boot_id]);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job?.log.length]);

  const start = async () => {
    setErr(null);
    useStore.setState({ restart: { phase: "starting", error: null, log: [] } });
    try {
      await api.restartServer(useStore.getState().localHostId!, { rebuild });
    } catch (e) {
      useStore.setState({ restart: null });
      setErr((e as Error).message);
    }
  };

  const commits = status.new_commits ?? [];
  return (
    <Modal title="Rebuild & restart server" onClose={inProgress ? () => {} : onClose} width="max-w-2xl">
      <div className="space-y-4 text-[13px]">
        {!job && (
          <>
            <p className="text-muted">
              {rebuild ? (
                <>
                  Rebuilds the UI (<code>npm run build</code>) and server (<code>cargo build --release</code>) from{" "}
                  <span className="font-mono text-fg">{status.source_dir}</span>, then restarts in place. If either build fails, the current server keeps
                  running.
                </>
              ) : (
                "Restarts the server process without rebuilding."
              )}
            </p>
            {commits.length > 0 && (
              <div className="rounded-lg border border-line bg-panel/60 p-3">
                <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-faint uppercase">
                  New on {status.source_branch ?? "the checkout"} since this server started
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
            {status.dirty && <Warning>The source checkout has uncommitted changes, and they'll be included in the build.</Warning>}
            {status.source_branch && status.source_branch !== "master" && status.source_branch !== "main" && (
              <Warning>
                The source checkout is on <span className="font-mono">{status.source_branch}</span>, not master.
              </Warning>
            )}
            {status.source_dir && <Toggle checked={rebuild} onChange={setRebuild} label="Rebuild before restarting" />}
          </>
        )}

        {job && (
          <div className="space-y-3">
            <div className={clsx("flex items-center gap-2", job.phase === "failed" ? "text-red-400" : "text-fg")}>
              {job.phase === "failed" ? <CircleAlert size={15} /> : <Loader2 size={15} className="animate-spin text-accent" />}
              {waiting && job.phase === "restarting" ? "Restarting, waiting for the server to come back…" : PHASES[job.phase] ?? job.phase}
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
            {job.phase === "failed" && <p className="text-[12px] text-muted">The server is still running the previous build.</p>}
          </div>
        )}

        {err && <div className="text-xs text-red-400">{err}</div>}
        <div className="flex justify-end gap-2">
          {!inProgress && (
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          )}
          {(!job || job.phase === "failed") && (
            <Button variant="primary" onClick={start}>
              <RotateCw size={13} /> {job ? "Try again" : rebuild ? "Rebuild & restart" : "Restart"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md bg-st-attention/[0.08] px-3 py-2 text-[12.5px] text-amber-200/90">
      <CircleAlert size={14} className="mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
