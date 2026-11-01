import clsx from "clsx";
import { CircleAlert, Copy, Download, ExternalLink, GitCommitHorizontal, Loader2, RefreshCw, RotateCw, Undo2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type ReleaseDownload, type ReleaseStatus, type ServerStatus } from "../api";
import type { ShellUpdateKind, ShellUpdateProgress } from "../notifier";
import { useStore } from "../store";
import { useNewUiBuild } from "../uiVersion";
import { compareVersions } from "../versions";
import { Markdown } from "./Thread";
import { Button, copyText, Modal, ModalFooter, timeAgo, Toggle } from "./ui";

export const PHASES: Record<string, string> = {
  starting: "Starting…",
  building_ui: "Building the UI…",
  building_server: "Building the server…",
  downloading: "Downloading the release…",
  verifying: "Checking the download…",
  installing: "Installing the release…",
  restarting: "Restarting…",
  failed: "Restart failed",
};

/** Status of the host serving this UI (the one a restart rebuilds). */
function useServerStatus(pollMs: number) {
  const host = useStore((s) => s.localHostId);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const refresh = useCallback(() => {
    if (host) return api.serverStatus(host).then(setStatus).catch(() => {});
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
  return { status, setStatus, refresh };
}

const short = (sha?: string | null) => (sha ? sha.slice(0, 7) : "unknown");

/** The release Update restarts onto: the staged one, once it's newer than the one running. */
export function stagedRelease(status: ServerStatus | null): string | null {
  const r = status?.release;
  return r?.staged && compareVersions(r.staged, r.running) > 0 ? r.staged : null;
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/**
 * Sidebar prompt shown when the source checkout, or the deployment this server follows (`--update-from`), has commits it
 * isn't running, or a newer release is downloaded and ready (`--release-updates`). A release still downloading in the
 * background, or one whose download failed, needs no attention: Settings → Server shows those.
 */
export function UpdateButton() {
  const { status } = useServerStatus(30_000);
  const live = useStore((s) => s.restart);
  const [open, setOpen] = useState(false);
  const busy = live && live.phase !== "failed";
  const deployed = status?.deployed_commits?.length ?? 0;
  const pending = deployed || (status?.new_commits?.length ?? 0);
  const release = stagedRelease(status);
  if (!busy && pending === 0 && !release && !open) return null;
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
  const host = useStore((s) => s.localHostId);
  const { status, setStatus, refresh } = useServerStatus(15_000);
  const [open, setOpen] = useState<"restart" | "update" | "release" | "rollback" | null>(null);
  const deployed = status?.deployed;
  const ahead = status?.deployed_commits?.length ?? 0;
  const release = status?.release;
  const staged = stagedRelease(status);
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
            <div>
              Running{" "}
              {release ? (
                <>
                  <span className="font-mono text-fg">v{release.running}</span>
                  {status.running_commit && <span className="font-mono"> ({short(status.running_commit)})</span>}
                </>
              ) : (
                <span className="font-mono text-fg">{short(status.running_commit)}</span>
              )}
              , started {timeAgo(status.started_at)}
            </div>
            {release?.exe && (
              <div>
                From <span className="font-mono break-all">{release.exe}</span>
              </div>
            )}
            {release?.shell && <div>Started by the desktop app{release.shell.version && ` v${release.shell.version}`} ({installName(release.shell)})</div>}
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
      {status && release && host && <Releases hostId={host} release={release} onStatus={setStatus} refresh={refresh} onRollback={() => setOpen("rollback")} />}
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
  );
}

export function installName(shell: NonNullable<ReleaseStatus["shell"]>) {
  const kind = { pacman: "pacman package", appimage: "AppImage", mac: "macOS app" }[shell.install as string] ?? "installed by hand";
  return shell.path ? `${kind}, ${shell.path}` : kind;
}

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
  hostId: string;
  release: ReleaseStatus;
  onStatus: (s: ServerStatus) => void;
  refresh: () => Promise<unknown> | undefined;
  onRollback: () => void;
}) {
  const [checking, setChecking] = useState(false);
  // The toggle's new value until the server's status has it.
  const [prereleases, setPrereleases] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const latest = release.latest;
  const check = async () => {
    if (checking) return;
    setChecking(true);
    setErr(null);
    try {
      onStatus(await api.checkReleases(host));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const togglePrereleases = async (on: boolean) => {
    setPrereleases(on);
    setErr(null);
    try {
      // The server checks again with the new setting, and the status shows what it finds.
      await api.updateSettings(host, { release_prereleases: on });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
    setPrereleases(null);
  };
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
        <Button size="sm" onClick={check} disabled={checking}>
          {checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Check now
        </Button>
      </div>
      {release.error && (
        <div className="font-mono text-[11.5px] text-red-300">
          {release.error}
          {release.rate_limit_reset && (
            <div className="font-sans text-muted">
              GitHub's rate limit resets at {new Date(release.rate_limit_reset).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.
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
          Not offered again (rolled back from, or didn't start): <span className="font-mono">{release.bad.map((v) => `v${v}`).join(", ")}</span>
        </div>
      )}
      {err && <div className="text-red-400">{err}</div>}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <Toggle checked={prereleases ?? release.prereleases} onChange={togglePrereleases} label="Include prereleases" />
        {release.rollback_to && (
          <Button size="sm" onClick={onRollback}>
            <Undo2 size={13} /> Roll back to {release.rollback_to === "bundled" ? "the bundled version" : `v${release.rollback_to}`}
          </Button>
        )}
      </div>
    </div>
  );
}

function DownloadLine({ download: d }: { download: ReleaseDownload }) {
  if (d.phase === "failed") {
    return (
      <div className="text-red-300">
        Downloading v{d.version} failed{d.error ? `: ${d.error}` : ""}. It's tried again on the next check.
      </div>
    );
  }
  const share = d.phase === "downloading" && d.total ? Math.min(1, d.bytes / d.total) : null;
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
  );
}

/**
 * The latest release comes with a new desktop app, which the server can't install: how to get it, or (where the app
 * can install it itself, HA-68) a button. With `remote`, the app is a linked host's, which only that host's app can
 * update: it says how.
 */
export function ShellNotice({ release, remote }: { release: ReleaseStatus; remote?: boolean }) {
  const shell = release.shell!;
  const pkg = shell.package;
  const latest = release.latest;
  const desktop = window.huntawayDesktop;
  // The app installs its own package where its install is one it can replace (an AppImage, the pacman package) and is
  // the one this server reports on.
  const [kind] = useState(() => desktop?.shellUpdateKind?.() ?? null);
  const updateShell = !remote && kind && kind === shell.install && pkg ? desktop?.updateShell : undefined;
  const [progress, setProgress] = useState<ShellUpdateProgress | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const command = shell.install === "pacman" && pkg ? `sudo pacman -U ${pkg.url}` : null;
  const page = latest && (
    <a href={latest.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
      the release's page
    </a>
  );
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-accent/30 bg-accent/[0.06] p-4 text-[12.5px] text-muted">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium text-fg">The desktop app {remote ? "on this host " : ""}has an update</div>
          <div>
            {latest ? `v${latest.version}` : "The latest release"} comes with a new version of the app itself{shell.version && ` (this one is v${shell.version})`}, which
            {updateShell ? " the app can install itself." : remote ? " that host's app installs from its own Settings → Server." : " the board can't install."}
          </div>
        </div>
        {updateShell && (
          <Button
            size="sm"
            variant="primary"
            disabled={!!progress}
            onClick={() => {
              setProgress({ phase: "checking" });
              setErr(null);
              // On success the app quits and relaunches, so the progress stays.
              updateShell(setProgress).catch((e) => {
                setProgress(null);
                setErr((e as Error).message ?? String(e));
              });
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
                copyText(command);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
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
  );
}

function ShellProgress({ progress: p, kind }: { progress: ShellUpdateProgress; kind: ShellUpdateKind | null }) {
  const v = p.version ? `v${p.version}` : "the new app";
  const share = p.phase === "downloading" && p.total ? Math.min(1, (p.bytes ?? 0) / p.total) : null;
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
  );
}

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
  status: ServerStatus;
  update?: boolean;
  release?: "update" | "rollback";
  hostId?: string;
  onStarted?: () => void;
  onClose: () => void;
}) {
  const localHost = useStore((s) => s.localHostId);
  const remote = !!hostId && hostId !== localHost;
  // The websocket's restart events are the local host's.
  const live = useStore((s) => (remote ? null : s.restart));
  const [rebuild, setRebuild] = useState(!!status.source_dir);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [waiting, setWaiting] = useState(false);
  // The commit to update to, kept from when the modal opened.
  const [target] = useState(!release && update && status.deployed_commits?.length ? (status.deployed?.commit ?? null) : null);
  // The release to update to, or what a rollback goes back to, also kept from when the modal opened.
  const [version] = useState(release === "update" ? stagedRelease(status) : release === "rollback" ? (status.release?.rollback_to ?? null) : null);
  const running = status.release?.running;
  const logRef = useRef<HTMLPreElement>(null);
  // Seed with the server's view in case the restart began elsewhere.
  const current = remote ? null : (live ?? (status.restart ? { phase: status.restart.phase, error: status.restart.error, log: status.restart.log.split("\n") } : null));
  // Whether this dialog started a restart, or saw one running (begun before it opened, or elsewhere). A restart that had
  // failed before then isn't shown: it would stand in for what this dialog does (Roll back's warning, say).
  const [started, setStarted] = useState(false);
  const [watched, setWatched] = useState(!!current && current.phase !== "failed");
  useEffect(() => {
    if (current && current.phase !== "failed") setWatched(true);
  }, [current?.phase]);
  const job = current && (current.phase !== "failed" || started || watched) ? current : null;
  // A failed restart this dialog didn't start: its button goes back to this dialog's confirm rather than retrying.
  const inherited = job?.phase === "failed" && !started;
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
    if (starting) return;
    setErr(null);
    if (remote) {
      setStarting(true);
      try {
        if (release === "update") await api.updateRelease(hostId, version!);
        else if (release === "rollback") await api.rollbackRelease(hostId);
        else await api.restartServer(hostId, { rebuild });
        onStarted?.();
        onClose();
      } catch (e) {
        setErr((e as Error).message);
        setStarting(false);
      }
      return;
    }
    setStarted(true);
    useStore.setState({ restart: { phase: "starting", error: null, log: [] } });
    try {
      const host = useStore.getState().localHostId!;
      if (release === "update") await api.updateRelease(host, version!);
      else if (release === "rollback") await api.rollbackRelease(host);
      else if (target) {
        if ((await api.updateServer(host, target)).up_to_date) {
          useStore.setState({ restart: null });
          onClose();
        }
      } else await api.restartServer(host, { rebuild });
    } catch (e) {
      useStore.setState({ restart: null });
      setErr((e as Error).message);
    }
  };

  const commits = (release ? [] : target ? status.deployed_commits : status.new_commits) ?? [];
  const rollbackTo = version === "bundled" ? "the bundled version" : `v${version}`;
  const action =
    release === "rollback" ? `Roll back to ${rollbackTo}` : release || target ? "Update & restart" : rebuild ? "Rebuild & restart" : "Restart";
  const title = release === "update" ? "Update Huntaway" : release === "rollback" ? "Roll back Huntaway" : target ? "Update server" : "Rebuild & restart server";
  return (
    <Modal title={title} onClose={inProgress ? () => {} : onClose} width="max-w-2xl">
      <div className="space-y-4 text-[13px]">
        {!job && release === "update" && version && <ReleaseUpdate release={status.release!} version={version} remote={remote} />}
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
              , and doesn't offer <span className="font-mono text-fg">v{running}</span> again.{" "}
              {remote ? "This page follows it until it's back." : "The board reloads once it's back."}
            </p>
            <Warning>
              v{running} may have migrated the database, and an older version might not work with it. Roll back only when v{running} doesn't work.
            </Warning>
          </>
        )}
        {!job && (
          <>
            {!release && <p className="text-muted">
              {target ? (
                <>
                  Fetches <span className="font-mono text-fg">{short(target)}</span>, which {status.update_from} runs, from origin and fast-forwards{" "}
                  <span className="font-mono text-fg">{status.source_dir}</span> to it. Then it rebuilds the UI and server and restarts in place. If either
                  build fails, the current server keeps running.
                </>
              ) : rebuild ? (
                <>
                  Rebuilds the UI (<code>npm run build</code>) and server (<code>cargo build --release</code>) from{" "}
                  <span className="font-mono text-fg">{status.source_dir}</span>, then restarts in place. If either build fails, the current server keeps
                  running.
                </>
              ) : (
                "Restarts the server process without rebuilding."
              )}
            </p>}
            {commits.length > 0 && (
              <div className="rounded-lg border border-line bg-panel/60 p-3">
                <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-faint uppercase">
                  {target ? `Deployed at ${status.update_from}, not on this server` : `New on ${status.source_branch ?? "the checkout"} since this server started`}
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
            {!release && status.dirty &&
              (target ? (
                <Warning>The source checkout has uncommitted changes, so it can't be updated. Commit or discard them first.</Warning>
              ) : (
                <Warning>The source checkout has uncommitted changes, and they'll be included in the build.</Warning>
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
            {job.phase === "failed" && (
              <p className="text-[12px] text-muted">The server is still running {release ? `v${running}` : "the previous build"}.</p>
            )}
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
                onClick={inherited ? () => setWatched(false) : start}
              >
                {starting ? <Loader2 size={13} className="animate-spin" /> : release === "rollback" ? <Undo2 size={13} /> : <RotateCw size={13} />}{" "}
                {inherited ? `${action}…` : job ? "Try again" : action}
              </Button>
            )}
          </div>
        </ModalFooter>
      </div>
    </Modal>
  );
}

/** What a release update does: the versions, the release's notes and what happens to the server, agents and board. */
function ReleaseUpdate({ release, version, remote }: { release: ReleaseStatus; version: string; remote?: boolean }) {
  // The notes are the latest release's, which is the staged one unless a newer one came out meanwhile.
  const latest = release.latest?.version === version ? release.latest : null;
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
            <a href={latest.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-normal tracking-normal text-accent normal-case hover:underline">
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
