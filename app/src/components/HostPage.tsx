import clsx from "clsx";
import { ChevronLeft, Copy, Download, Loader2, Plus, RotateCw, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, canRunAgents, hostSupports, type Profile, type ServerStatus } from "../api";
import { navigate } from "../router";
import { profileConfigLabel, useStore } from "../store";
import { HostClaudeConfigs } from "./ClaudeConfigs";
import { AgentDefaultsRow, CopyLoginModal, HostVersion, ProfileForm, TerminalToolsRow } from "./Hosts";
import { installName, PHASES, Releases, RestartModal, ServerPanel, ShellNotice, stagedRelease } from "./Server";
import { Button, IconButton, MenuButton, Modal, timeAgo, useConfirm } from "./ui";

const MODE: Record<string, string> = { local: "this hub's own host", outbound: "linked by URL", inbound: "dials in", ssh: "over SSH" };

/** Everything about one host, configured from this board (through the hub's proxy). */
export function HostPage({ hostId }: { hostId: string }) {
  const host = useStore((s) => s.hosts.find((h) => h.id === hostId));
  const hostCount = useStore((s) => s.hosts.length);
  const confirm = useConfirm();
  if (!host) return <div className="p-8 text-muted">Host not found.</div>;
  const agents = canRunAgents(host);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <MenuButton />
        <IconButton className="no-drag" onClick={() => navigate({ name: "settings" })}>
          <ChevronLeft size={16} />
        </IconButton>
        <button className="no-drag text-[12.5px] text-muted hover:text-fg" onClick={() => navigate({ name: "settings" })}>
          Settings
        </button>
        <span className="text-faint">/</span>
        <Server size={14} className="text-muted" />
        <h1 className="text-[14px] font-semibold">{host.name}</h1>
        <span className={clsx("h-1.5 w-1.5 rounded-full", host.connected ? "bg-emerald-400" : "bg-red-400")} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-8 p-6">
          <section className="space-y-1 text-[12.5px] text-muted">
            <div>
              {MODE[host.mode] ?? host.mode}
              {host.url ? ` · ${host.url}` : ""}
              {!host.connected && host.last_seen ? ` · offline, last seen ${timeAgo(host.last_seen)}` : ""}
            </div>
            <HostVersion host={host} />
            {host.connected && !agents && <div>Board only: this host can't run agents (no claude or ia-shim). New projects go on hosts that can.</div>}
          </section>

          {!host.connected ? (
            <p className="text-[13px] text-muted">This host is offline. Its settings can be changed once it reconnects.</p>
          ) : (
            <>
              {agents && (
                <section>
                  <h2 className="mb-1 text-[13px] font-semibold">Agent defaults</h2>
                  <p className="mb-3 text-[12.5px] text-muted">For every agent on this host. A model set on a thread, project or profile, an effort set on a thread, or a permission mode set on a thread or project, takes precedence.</p>
                  <AgentDefaultsRow host={host} showName={false} />
                </section>
              )}
              {agents && hostSupports(host, 20) && <HostClaudeConfigs hostId={host.id} canCopy={hostCount > 1} />}
              {agents && <HostProfiles hostId={host.id} canCopy={hostCount > 1} />}
              {hostSupports(host, 13) && (
                <section>
                  <h2 className="mb-1 text-[13px] font-semibold">Terminal tools</h2>
                  <p className="mb-3 text-[12.5px] text-muted">
                    TUI programs or scripts to open from a task, next to its Terminal tab. Each runs in its own tmux session in the task's worktree,
                    through your login shell, and keeps running while the board is open; a couple of minutes after the last board showing it closes, it
                    ends.
                  </p>
                  <TerminalToolsRow host={host} />
                </section>
              )}
              {host.local ? <ServerPanel /> : <RemoteServer hostId={host.id} />}
            </>
          )}

          {!host.local && (
            <section>
              <h2 className="mb-3 text-[13px] font-semibold">Remove</h2>
              <div className="flex items-center gap-3 rounded-xl border border-line px-4 py-3 text-[12.5px] text-muted">
                <span className="flex-1">Take this host off the board. Its projects, threads and agents stay on the host.</span>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    confirm.ask({
                      title: `Remove ${host.name}`,
                      body: `Remove ${host.name} from this board? Its projects, threads and agents stay on that host.`,
                      action: "Remove from board",
                      danger: true,
                      onConfirm: async () => {
                        await api.removeHost(host.id);
                        navigate({ name: "settings" }, true);
                      },
                    })
                  }
                >
                  <Trash2 size={12} /> Remove from board
                </Button>
              </div>
            </section>
          )}
          {confirm.dialog}
        </div>
      </div>
    </div>
  );
}

function HostProfiles({ hostId, canCopy }: { hostId: string; canCopy: boolean }) {
  const all = useStore((s) => s.profiles);
  const claudeConfigs = useStore((s) => s.claudeConfigs);
  const profiles = all.filter((p) => p.host_id === hostId);
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  const [copying, setCopying] = useState<Profile | null>(null);
  const confirm = useConfirm();
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Profiles on this host</h2>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus size={13} /> Add profile
        </Button>
      </div>
      <div className="divide-y divide-line rounded-xl border border-line">
        {profiles.map((p) => (
          <div key={p.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="w-28 shrink-0 truncate text-[12.5px]">{p.name}</div>
            <div className={clsx("min-w-0 flex-1 truncate text-[11.5px] text-faint", !p.claude_config_ids && "font-mono")}>
              {profileConfigLabel({ claudeConfigs }, p)}
              {p.default_model ? ` · ${p.default_model}` : ""}
            </div>
            {/* Hosts with separate configs copy logins from Claude configs. */}
            {canCopy && !p.claude_config_ids && (
              <Button size="sm" variant="ghost" onClick={() => setCopying(p)} title="Copy this Claude login and settings to another host">
                <Copy size={12} /> Copy login
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              title="Delete"
              onClick={() =>
                confirm.ask({
                  title: `Delete profile ${p.name}`,
                  body: `Delete profile "${p.name}" on this host, with all its projects and tasks here?`,
                  action: "Delete profile",
                  danger: true,
                  onConfirm: () => api.deleteProfile(p.host_id, p.id),
                })
              }
            >
              <Trash2 size={13} />
            </Button>
          </div>
        ))}
        {profiles.length === 0 && <div className="px-4 py-3 text-[12.5px] text-faint">No profiles yet.</div>}
      </div>
      {editing && (
        <Modal title={editing === "new" ? "Add profile" : `Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <ProfileForm hostId={hostId} initial={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
        </Modal>
      )}
      {copying && <CopyLoginModal from={copying} onClose={() => setCopying(null)} />}
      {confirm.dialog}
    </section>
  );
}

/**
 * A linked host's server, followed by polling it: Rebuild & restart, and for a host with release updates
 * (`--release-updates`, API 88) its version, the release checks and download, Update, Check now and Roll back.
 */
function RemoteServer({ hostId }: { hostId: string }) {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [watching, setWatching] = useState<string | null>(null); // boot id before the restart
  const [down, setDown] = useState(false);
  const [asking, setAsking] = useState<"restart" | "release" | "rollback" | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  // A background download's progress is worth following more closely.
  const downloading = !!status?.release?.download && status.release.download.phase !== "failed";

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const s = await api.serverStatus(hostId);
        if (!alive) return;
        setStatus(s);
        setDown(false);
        if (watching && s.boot_id !== watching) setWatching(null);
        if (s.restart?.phase === "failed") setWatching(null);
      } catch {
        if (alive) setDown(true);
      }
    };
    poll();
    const id = setInterval(poll, watching ? 1500 : downloading ? 3000 : 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [hostId, watching, downloading]);
  const refresh = useCallback(() => api.serverStatus(hostId).then(setStatus, () => {}), [hostId]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [status?.restart?.log]);

  const job = status?.restart;
  const busy = !!watching;
  const release = status?.release;
  const staged = stagedRelease(status);
  const short = (c?: string | null) => (c ? c.slice(0, 7) : "unknown");
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
          <div>Loading…</div>
        )}
        {busy && (
          <div className="flex items-center gap-2 pt-1 text-fg">
            <Loader2 size={14} className="animate-spin text-accent" />
            {down ? "Restarting, waiting for it to come back…" : (PHASES[job?.phase ?? "starting"] ?? job?.phase)}
          </div>
        )}
        {job?.phase === "failed" && <div className="rounded bg-red-500/10 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-red-300">{job.error}</div>}
        {(busy || job?.phase === "failed") && job?.log && (
          <pre ref={logRef} className="h-48 overflow-auto rounded-md border border-line bg-[#0c0c10] p-2 font-mono text-[11px] whitespace-pre-wrap text-[#b9b9c8]">
            {job.log}
          </pre>
        )}
      </div>
      {status && release && <Releases hostId={hostId} release={release} onStatus={setStatus} refresh={refresh} onRollback={() => setAsking("rollback")} />}
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
  );
}
