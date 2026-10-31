import clsx from "clsx";
import { Copy, KeyRound, Plus, Server, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  agentInfo,
  agentOf,
  api,
  canRunAgents,
  EFFORTS,
  hostCompat,
  hostSupports,
  MODEL_ALIASES,
  PERMISSION_MODES,
  type ClaudeConfig,
  type Compat,
  type GithubAccount,
  type Host,
  type HostSettings,
  type Profile,
  type TerminalTool,
} from "../api";
import { useShallow } from "zustand/react/shallow";
import { defaultCloneDir } from "../githubRepos";
import { navigate } from "../router";
import { defaultAgentHost, profileConfigLabel, profileNames, useStore } from "../store";
import { ConfigPicker } from "./ClaudeConfigs";
import { AsanaAccount, ASANA_TOGGLE_API, LINKS_API, usesAsana } from "./ExternalLinks";
import { Button, Field, IconButton, Input, Modal, ModalFooter, timeAgo, Toggle } from "./ui";

const MODE_LABEL: Record<Host["mode"], string> = {
  local: "this host",
  outbound: "linked by URL",
  inbound: "dials in",
  ssh: "over SSH",
};

// ---------- hosts ----------

export function HostsPanel() {
  const hosts = useStore((s) => s.hosts);
  const [adding, setAdding] = useState(false);
  const [joining, setJoining] = useState(false);
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Hosts</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setJoining(true)}>
            <KeyRound size={13} /> Connect from elsewhere
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus size={13} /> Add host
          </Button>
        </div>
      </div>
      <p className="mb-3 text-[12.5px] text-muted">
        Each host keeps its own projects, tasks and agent threads. This board shows every connected host, and any other board linked to a host sees the
        same data. Configure a host (agent defaults, agent configs, profiles, rebuild &amp; restart) from its page.
      </p>
      <div className="space-y-2">
        {hosts.map((h) => (
          <HostRow key={h.id} host={h} />
        ))}
      </div>
      <ScratchHostRow />
      {adding && <AddHostModal onClose={() => setAdding(false)} />}
      {joining && <JoinModal onClose={() => setJoining(false)} />}
    </section>
  );
}

/** A board that can't run agents picks which host runs its scratch tasks. */
function ScratchHostRow() {
  const local = useStore((s) => s.hosts.find((h) => h.local));
  const hosts = useStore(useShallow((s) => s.hosts.filter((h) => !h.local && canRunAgents(h))));
  const picked = useStore((s) => (local ? s.hostSettings[local.id]?.scratch_host : null)) ?? "";
  const [err, setErr] = useState<string | null>(null);
  if (!local || canRunAgents(local) || hosts.length === 0) return null;
  const save = async (id: string) => {
    setErr(null);
    try {
      const settings = await api.updateSettings(local.id, { scratch_host: id || null });
      useStore.setState((s) => ({ hostSettings: { ...s.hostSettings, [local.id]: settings } }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="mt-3 rounded-xl border border-line px-4 py-3">
      <Field label="Scratch task host" hint="This board can't run agents, so new scratch tasks (which are in no project) run on this host.">
        <select value={picked} onChange={(e) => save(e.target.value)} className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none">
          <option value="">Automatic (first available host)</option>
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
          {picked && !hosts.some((h) => h.id === picked) && <option value={picked}>Unavailable host</option>}
        </select>
      </Field>
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
    </div>
  );
}

const COMPAT_BADGE: Record<Exclude<Compat, "ok">, { label: string; hint: string }> = {
  outdated: { label: "Outdated", hint: "Older than this board; newer features are hidden for it. Update it to get them." },
  incompatible: { label: "Too old", hint: "Too old for this board to use. Update it." },
  board_outdated: { label: "Board too old", hint: "This host needs a newer board. Update the host serving this page." },
};

/**
 * The commit an Update sends a host: the hub's checkout as it is (which can be ahead of the server running it), or
 * without a checkout the commit it runs.
 */
function useUpdateCommit(local: Host | undefined) {
  const [checkout, setCheckout] = useState<string | null>(null);
  useEffect(() => {
    if (!local) return;
    let alive = true;
    api
      .serverStatus(local.id)
      .then((s) => alive && setCheckout(s.source_dir ? (s.source_commit ?? null) : null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [local?.id, local?.commit]);
  return checkout ?? local?.commit ?? null;
}

/** Version line plus an Update action for linked hosts running other code than this board. */
export function HostVersion({ host }: { host: Host }) {
  const local = useStore((s) => s.hosts.find((h) => h.local));
  const target = useUpdateCommit(local);
  const [phase, setPhase] = useState<string | null>(null);
  // The host's boot id before the update: it's over when that changes, as the restart's state goes with the old server.
  const [boot, setBoot] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const compat = hostCompat(host);
  const short = (c?: string | null) => (c ? c.slice(0, 7) : null);
  const behind = !!host.commit && !!local?.commit && host.commit !== local.commit;
  const differs = !!host.commit && !!target && host.commit !== target;
  // API 3+ hosts can update from their own origin, so any hub that knows its commit can update them.
  const canUpdate = !host.local && host.connected && !!target && hostSupports(host, 3) && (differs || compat !== "ok");

  // While the host rebuilds, show its progress; done when it comes back (a new boot) or reconnects on the new commit.
  useEffect(() => {
    if (!phase) return;
    const id = setInterval(async () => {
      try {
        const st = await api.serverStatus(host.id);
        if (boot && st.boot_id !== boot) {
          setPhase(null);
          setBoot(null);
        } else if (st.restart?.phase === "failed") {
          setErr(st.restart.error ?? "update failed");
          setPhase(null);
        } else if (st.restart) setPhase(st.restart.phase);
      } catch {
        setPhase("restarting");
      }
    }, 1500);
    return () => clearInterval(id);
  }, [phase, boot, host.id]);
  useEffect(() => {
    if (phase && target && host.commit === target) setPhase(null);
  }, [host.commit, target, phase]);

  const update = async () => {
    setErr(null);
    setPhase("starting");
    try {
      setBoot(await api.serverStatus(host.id).then((st) => st.boot_id, () => null));
      const r = await api.updateHost(host.id);
      if (r.up_to_date) setPhase(null);
    } catch (e) {
      setErr((e as Error).message);
      setPhase(null);
    }
  };
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-faint">
      {host.connected && (
        <span className="font-mono">
          v{host.version || "?"} · api {host.api_version ?? 0}
          {short(host.commit) ? ` · ${short(host.commit)}` : ""}
        </span>
      )}
      {compat !== "ok" && host.connected && (
        <span className="rounded bg-st-attention/15 px-1.5 py-px text-amber-300" title={COMPAT_BADGE[compat].hint}>
          {COMPAT_BADGE[compat].label}
        </span>
      )}
      {behind && compat === "ok" && <span className="text-muted">differs from this board ({short(local?.commit)})</span>}
      {canUpdate && !phase && (
        <button className="text-accent hover:underline" onClick={update} title="Send this board's code to the host, which rebuilds and restarts. Agents keep running.">
          Update to {short(target)}
        </button>
      )}
      {!host.local && host.connected && !hostSupports(host, 3) && (behind || compat !== "ok") && (
        <span>update it by hand once (git pull in its checkout, then Rebuild &amp; restart on its page)</span>
      )}
      {phase && <span className="text-st-progress">{phase.replace("_", " ")}…</span>}
      {err && <span className="text-red-400">{err}</span>}
    </div>
  );
}

function HostRow({ host }: { host: Host }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(host.name);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line px-4 py-3">
      <Server size={15} className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setRenaming(false);
              if (name.trim() && name !== host.name) api.renameHost(host.id, name.trim());
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="h-7 max-w-xs"
          />
        ) : (
          <div className="flex items-center gap-2 text-[13px] font-medium">
            {host.name}
            <span className={clsx("h-1.5 w-1.5 rounded-full", host.connected ? "bg-emerald-400" : "bg-red-400")} title={host.connected ? "Connected" : "Offline"} />
          </div>
        )}
        <div className="truncate text-[11.5px] text-faint">
          {MODE_LABEL[host.mode] ?? host.mode}
          {host.url ? ` · ${host.url}` : ""}
          {!host.connected && host.last_seen ? ` · last seen ${timeAgo(host.last_seen)}` : ""}
          {host.connected && host.agents === false ? " · board only (can't run agents)" : ""}
        </div>
        <HostVersion host={host} />
      </div>
      <Button size="sm" onClick={() => navigate({ name: "host", hostId: host.id })}>
        Configure
      </Button>
      {!host.local && (
        <>
          <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
            Rename
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Remove from this board (its data stays on the host)"
            onClick={() => {
              if (confirm(`Remove ${host.name} from this board? Its projects and agents stay on that host.`)) api.removeHost(host.id);
            }}
          >
            <Trash2 size={13} />
          </Button>
        </>
      )}
    </div>
  );
}

function AddHostModal({ onClose }: { onClose: () => void }) {
  const [how, setHow] = useState<"ssh" | "url">("ssh");
  return (
    <Modal title="Add a host" onClose={onClose} width="max-w-2xl">
      <div className="mb-4 flex gap-1 rounded-lg border border-line bg-panel p-0.5 text-[12.5px]">
        {(
          [
            ["ssh", "Over SSH"],
            ["url", "By URL and token"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} onClick={() => setHow(k)} className={clsx("flex-1 rounded-md px-2 py-1", how === k ? "bg-raised text-fg" : "text-muted hover:text-fg")}>
            {label}
          </button>
        ))}
      </div>
      {how === "ssh" ? <AddSshHost onClose={onClose} /> : <AddUrlHost onClose={onClose} />}
    </Modal>
  );
}

/** Start a host on a machine over SSH, with a key restricted to that job. */
function AddSshHost({ onClose }: { onClose: () => void }) {
  const [target, setTarget] = useState("");
  const [bin, setBin] = useState("");
  const [port, setPort] = useState("7878");
  const [sshPort, setSshPort] = useState("22");
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.sshKey().then((k) => setKey(k.public_key)).catch((e) => setErr(e.message));
  }, []);
  const p = Number(port) || 7878;
  const binPath = bin.trim() || "/path/to/huntaway";
  const line = key ? `restrict,port-forwarding,permitopen="127.0.0.1:${p}",command="${binPath} ssh-host --port ${p}" ${key}` : "…";
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.addSshHost({ target: target.trim(), ssh_port: Number(sshPort) || 22, remote_port: p });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-muted">
        This board starts <code>huntaway</code> on the machine if it isn't running, then connects through an SSH tunnel. The host only listens on that
        machine's localhost, and its agents keep running if the connection drops.
      </p>
      <div className="grid grid-cols-[1fr_90px] gap-3">
        <Field label="SSH target">
          <Input autoFocus value={target} onChange={(e) => setTarget(e.target.value)} placeholder="user@host" className="font-mono text-[12px]" />
        </Field>
        <Field label="SSH port">
          <Input value={sshPort} onChange={(e) => setSshPort(e.target.value)} className="font-mono text-[12px]" />
        </Field>
      </div>
      <div className="grid grid-cols-[1fr_90px] gap-3">
        <Field label="huntaway on that machine" hint="Absolute path; ia-shim must sit next to it (cargo build --release).">
          <Input value={bin} onChange={(e) => setBin(e.target.value)} placeholder="/home/you/huntaway/server/target/release/huntaway" className="font-mono text-[12px]" />
        </Field>
        <Field label="Host port">
          <Input value={port} onChange={(e) => setPort(e.target.value)} className="font-mono text-[12px]" />
        </Field>
      </div>
      <Field label="Add this line to ~/.ssh/authorized_keys on that machine" hint="The key can only run huntaway ssh-host and forward to the host's port.">
        <CopyLine value={line} />
      </Field>
      <ModalFooter className="space-y-4">
        {err && <div className="rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !target.includes("@")} onClick={submit}>
            {busy ? "Connecting…" : "Start & connect"}
          </Button>
        </div>
      </ModalFooter>
    </div>
  );
}

function AddUrlHost({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("http://");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.addHost(url.trim(), token.trim());
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-muted">
        For a host that's already running and reachable from this board, e.g. over Tailscale. Get its token with <code>huntaway token</code> on that
        machine.
      </p>
      <Field label="URL">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://buildbox:7878" className="font-mono text-[12px]" />
      </Field>
      <Field label="Token">
        <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} className="font-mono text-[12px]" />
      </Field>
      <ModalFooter className="space-y-4">
        {err && <div className="text-xs text-red-400">{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !token.trim() || url.length < 10} onClick={submit}>
            Add host
          </Button>
        </div>
      </ModalFooter>
    </div>
  );
}

function JoinModal({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<{ hub_token: string; host_token: string; command: string } | null>(null);
  useEffect(() => {
    api.joinInfo().then(setInfo).catch(() => {});
  }, []);
  return (
    <Modal title="Connect hosts and boards" onClose={onClose} width="max-w-2xl">
      <div className="space-y-5 text-[12.5px] text-muted">
        <div className="space-y-2">
          <div className="font-medium text-fg">A host that can't be reached directly</div>
          <p>Run this on it. It dials out to this board, so it needs no open ports. Swap in an address it can reach this machine on.</p>
          <CopyLine value={info?.command ?? "…"} />
        </div>
        <div className="space-y-2">
          <div className="font-medium text-fg">Another board using this host</div>
          <p>In that board's Settings → Hosts → Add host, enter this machine's URL and token:</p>
          <CopyLine value={info?.host_token ?? "…"} secret />
        </div>
        <p className="text-faint">These tokens give full control of agents on this machine; share them only over a trusted network.</p>
      </div>
    </Modal>
  );
}

function CopyLine({ value, secret }: { value: string; secret?: boolean }) {
  const [show, setShow] = useState(!secret);
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={show ? value : "•".repeat(24)} className="font-mono text-[11.5px]" />
      {secret && (
        <Button size="sm" onClick={() => setShow(!show)}>
          {show ? "Hide" : "Reveal"}
        </Button>
      )}
      <Button size="sm" onClick={() => navigator.clipboard?.writeText(value)}>
        <Copy size={12} /> Copy
      </Button>
    </div>
  );
}

// ---------- profiles (per host, merged by name) ----------

export function ProfilesPanel() {
  const profiles = useStore((s) => s.profiles);
  const hosts = useStore((s) => s.hosts);
  const claudeConfigs = useStore((s) => s.claudeConfigs);
  const [editing, setEditing] = useState<{ host: string; profile?: Profile; name?: string } | null>(null);
  const [copying, setCopying] = useState<Profile | null>(null);
  const names = useMemo(() => profileNames(profiles), [profiles]);
  const hostName = (id: string) => hosts.find((h) => h.id === id)?.name ?? id.slice(0, 8);
  const online = hosts.filter(canRunAgents);
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Profiles</h2>
        <Button size="sm" disabled={!defaultAgentHost()} onClick={() => setEditing({ host: defaultAgentHost()! })}>
          <Plus size={13} /> Add profile
        </Button>
      </div>
      <p className="mb-3 text-[12.5px] text-muted">
        Profiles are set up on each host and appear together by name. Each picks which of its host's agent configs (Claude Code or Codex) its agents use; with more than one,
        new tasks ask which.
      </p>
      <div className="space-y-3">
        {names.map((name) => {
          const rows = profiles.filter((p) => p.name === name);
          const missing = online.filter((h) => !rows.some((p) => p.host_id === h.id));
          return (
            <div key={name} className="rounded-xl border border-line">
              <div className="border-b border-line px-4 py-2.5 text-[13px] font-medium">{name}</div>
              {rows.map((p) => (
                <div key={`${p.host_id}:${p.id}`} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="w-28 shrink-0 truncate text-[12px] text-muted">{hostName(p.host_id)}</div>
                  <div className={clsx("min-w-0 flex-1 truncate text-[11.5px] text-faint", !p.claude_config_ids && "font-mono")}>
                    {profileConfigLabel({ claudeConfigs }, p)}
                    {p.default_model ? ` · ${p.default_model}` : ""}
                    {p.github_account ? ` · GitHub: ${p.github_account}` : ""}
                    {p.clone_dir ? ` · clones into ${p.clone_dir}` : ""}
                    {!usesAsana(p) ? " · Asana off" : p.asana_user ? ` · Asana: ${p.asana_user}` : ""}
                    {p.agent_access?.length ? ` · agents from ${p.agent_access.includes("*") ? "every profile" : p.agent_access.join(", ")} can use it` : ""}
                  </div>
                  {/* Hosts with separate configs copy logins from Claude configs. */}
                  {online.length > 1 && !p.claude_config_ids && (
                    <Button size="sm" variant="ghost" onClick={() => setCopying(p)} title="Copy this Claude login and settings to another host">
                      <Copy size={12} /> Copy login
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ host: p.host_id, profile: p })}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (confirm(`Delete profile "${p.name}" on ${hostName(p.host_id)}, with all its projects and tasks there?`)) api.deleteProfile(p.host_id, p.id);
                    }}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
              {missing.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2 text-[11.5px] text-faint">
                  Not set up on:
                  {missing.map((h) => (
                    <button key={h.id} className="text-accent hover:underline" onClick={() => setEditing({ host: h.id, name })}>
                      {h.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {editing && (
        <Modal title={editing.profile ? `Edit profile on ${hostName(editing.host)}` : "Add profile"} onClose={() => setEditing(null)}>
          <ProfileForm hostId={editing.host} initial={editing.profile} name={editing.name} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
        </Modal>
      )}
      {copying && <CopyLoginModal from={copying} onClose={() => setCopying(null)} />}
    </section>
  );
}

export function ProfileForm({
  hostId,
  initial,
  name: presetName,
  onDone,
  onCancel,
}: {
  hostId: string;
  initial?: Profile;
  name?: string;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const hosts = useStore(useShallow((s) => s.hosts.filter(canRunAgents)));
  const [host, setHost] = useState(hostId);
  const [name, setName] = useState(initial?.name ?? presetName ?? "");
  const [dir, setDir] = useState(initial?.claude_config_dir || "~/.claude");
  const [configIds, setConfigIds] = useState<string[]>(initial?.claude_config_ids ?? []);
  const [model, setModel] = useState(initial?.default_model ?? "");
  const [access, setAccess] = useState<string[]>(initial?.agent_access ?? []);
  const [github, setGithub] = useState(initial?.github_account ?? "");
  const [cloneDir, setCloneDir] = useState(initial?.clone_dir ?? "");
  const [asana, setAsana] = useState(usesAsana(initial));
  // Its Asana connection is saved as it's changed, so it follows the store rather than the form.
  const liveProfile = useStore((s) => s.profiles.find((p) => p.host_id === initial?.host_id && p.id === initial?.id));
  const [err, setErr] = useState<string | null>(null);
  const separate = hostSupports(hosts.find((h) => h.id === host), 20);
  const sharing = hostSupports(hosts.find((h) => h.id === host), 23);
  const accounts = hostSupports(hosts.find((h) => h.id === host), 50);
  const cloning = hostSupports(hosts.find((h) => h.id === host), 55);
  const linking = hostSupports(hosts.find((h) => h.id === host), LINKS_API);
  const asanaToggle = hostSupports(hosts.find((h) => h.id === host), ASANA_TOGGLE_API);
  const hostConfigs = useStore(useShallow((s) => s.claudeConfigs.filter((c) => c.host_id === host)));
  // With no configs on the host yet, the directory typed here becomes the first.
  const pick = separate && hostConfigs.length > 0;
  const submit = async () => {
    try {
      const configs = pick ? { claude_config_ids: configIds } : { claude_config_dir: dir };
      const body = {
        name: name.trim(),
        default_model: model || null,
        ...configs,
        ...(sharing ? { agent_access: access } : {}),
        ...(accounts ? { github_account: github || null } : {}),
        ...(cloning ? { clone_dir: cloneDir.trim() || null } : {}),
        ...(asanaToggle ? { asana_enabled: asana } : {}),
      };
      if (initial) await api.updateProfile(initial.host_id, initial.id, body);
      else {
        await api.createProfile(host, body);
        await useStore.getState().loadAll();
      }
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="space-y-3">
      {!initial && hosts.length > 1 && (
        <Field label="Host">
          <HostSelect value={host} onChange={(h) => (setHost(h), setConfigIds([]))} />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input value={name} placeholder="work / personal" onChange={(e) => setName(e.target.value)} disabled={!!presetName} />
        </Field>
        <Field label="Default model">
          <Input value={model} placeholder="claude default" onChange={(e) => setModel(e.target.value)} />
        </Field>
      </div>
      {pick ? (
        <Field label="Agent configs" hint="The ones its agents can use; projects can pick their own. With more than one, new tasks ask which, starting with the default.">
          <ConfigPicker hostId={host} value={configIds} onChange={setConfigIds} />
        </Field>
      ) : (
        <Field
          label="Claude config directory"
          hint={
            separate
              ? "On that host. Saved as a Claude config named after the profile, passed as CLAUDE_CONFIG_DIR, so it has its own login, settings and history."
              : "On that host. Passed as CLAUDE_CONFIG_DIR, so each profile has its own login, settings and history."
          }
        >
          <Input className="font-mono text-[12px]" value={dir} onChange={(e) => setDir(e.target.value)} />
        </Field>
      )}
      {accounts && (
        <Field
          label="GitHub account"
          hint="The account its agents act as on GitHub through their gh tools (pull requests, issues, the API, pushes over HTTPS), from gh's logins on this host. Projects can pick their own."
        >
          <GithubAccountSelect hostId={host} value={github} onChange={setGithub} inherit={(active) => `gh's active account${active ? ` (${active})` : ""}`} />
        </Field>
      )}
      {cloning && (
        <Field label="Clone folder" hint="Where Add project's GitHub tab clones repositories on this host, each into a folder named after it.">
          <Input className="font-mono text-[12px]" value={cloneDir} placeholder={defaultCloneDir(name)} onChange={(e) => setCloneDir(e.target.value)} spellCheck={false} />
        </Field>
      )}
      {/* Not a Field, whose label would pass clicks anywhere in it on to the toggle. */}
      {linking && (initial || asanaToggle) && (
        <div className="space-y-1.5">
          <span className="block text-xs font-medium text-muted">Asana</span>
          {asanaToggle && <Toggle checked={asana} onChange={setAsana} label="Link tasks to Asana tasks" />}
          {asana && initial && <AsanaAccount hostId={host} profile={liveProfile ?? initial} />}
          <span className="block text-xs text-faint">
            {!asana
              ? "Off: the board leaves Asana out of this profile's tasks. A token it has is kept for when it's turned on again."
              : initial
                ? "Finds the Asana tasks you link tasks to, with a personal access token kept on this host."
                : "Finds the Asana tasks you link tasks to. Connect it with a personal access token once the profile is created."}
          </span>
        </div>
      )}
      {sharing && (
        <Field
          label="Agents from other profiles"
          hint="Agents in these profiles can list, read, create and change this profile's projects and tasks with their board tools. Tasks they create here run with this profile's Claude configs."
        >
          <AccessPicker own={name.trim()} value={access} onChange={setAccess} />
        </Field>
      )}
      <ModalFooter className="space-y-3">
        {err && <div className="text-xs text-red-400">{err}</div>}
        <div className="flex justify-end gap-2">
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button variant="primary" disabled={!name.trim()} onClick={submit}>
            {initial ? "Save" : "Create profile"}
          </Button>
        </div>
      </ModalFooter>
    </div>
  );
}

/** A GitHub account gh is signed in to on a host, or "" for the default (`inherit`, given gh's active account there). */
export function GithubAccountSelect({
  hostId,
  value,
  onChange,
  inherit,
}: {
  hostId: string;
  value: string;
  onChange: (account: string) => void;
  inherit: (active: string | undefined) => string;
}) {
  const [list, setList] = useState<{ accounts: GithubAccount[]; error: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    setList(null);
    api
      .githubAccounts(hostId)
      .then((l) => live && setList(l))
      .catch((e) => live && setList({ accounts: [], error: (e as Error).message }));
    return () => {
      live = false;
    };
  }, [hostId]);
  const accounts = list?.accounts ?? [];
  // gh's active account on github.com, or the only host's.
  const active = accounts.find((a) => a.active && a.host === "github.com") ?? accounts.find((a) => a.active);
  const missing = value && list && !accounts.some((a) => a.account === value);
  return (
    <div className="space-y-1">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
      >
        <option value="">{inherit(active?.account)}</option>
        {accounts.map((a) => (
          <option key={a.account} value={a.account}>
            {a.account}
            {a.ok ? "" : " (login not working)"}
          </option>
        ))}
        {/* Saved before, but gh isn't signed in to it (any more). */}
        {(missing || (value && !list)) && <option value={value}>{value}{missing ? " (not signed in to gh)" : ""}</option>}
      </select>
      {list?.error && <div className="text-[11.5px] text-faint">Couldn't list gh's accounts: {list.error}</div>}
      {list && !list.error && accounts.length === 0 && <div className="text-[11.5px] text-faint">gh isn't signed in to any accounts on this host (gh auth login).</div>}
    </div>
  );
}

/** Which other profiles' agents may use a profile's board: by name, or `*` for all. */
function AccessPicker({ own, value, onChange }: { own: string; value: string[]; onChange: (names: string[]) => void }) {
  const profiles = useStore((s) => s.profiles);
  const all = value.includes("*");
  // Names saved earlier stay listed even if no host has that profile now.
  const names = [...new Set([...profileNames(profiles), ...value])].filter((n) => n !== own && n !== "*");
  const toggle = (n: string, on: boolean) => onChange(on ? [...value, n] : value.filter((x) => x !== n));
  return (
    <div className="divide-y divide-line rounded-md border border-line">
      {names.map((n) => (
        <label key={n} className={clsx("flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[12.5px]", all && "opacity-50")}>
          <input type="checkbox" className="accent-accent" disabled={all} checked={all || value.includes(n)} onChange={(e) => toggle(n, e.target.checked)} />
          {n}
        </label>
      ))}
      <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[12.5px]">
        <input type="checkbox" className="accent-accent" checked={all} onChange={(e) => onChange(e.target.checked ? ["*"] : [])} />
        <span className="text-muted">Every profile, including ones added later</span>
      </label>
    </div>
  );
}

/** Hosts that can take agent work. */
export function HostSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const hosts = useStore(useShallow((s) => s.hosts.filter(canRunAgents)));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none">
      {hosts.map((h) => (
        <option key={h.id} value={h.id}>
          {h.name}
          {h.local ? " (this host)" : ""}
        </option>
      ))}
    </select>
  );
}

/** Copy a Claude config's login (or, on hosts before API 20, a profile's) to another host. */
export function CopyLoginModal({ from, onClose }: { from: ClaudeConfig | Profile; onClose: () => void }) {
  const isConfig = "config_dir" in from;
  const codex = isConfig && agentOf(from) === "codex";
  const baseDir = agentInfo(codex ? "codex" : "claude").dir;
  const fromDir = (isConfig ? from.config_dir : from.claude_config_dir) || baseDir;
  // Codex configs need hosts that know about them (API 25).
  const minApi = codex ? 25 : 20;
  const hosts = useStore(useShallow((s) => s.hosts.filter((h) => canRunAgents(h) && h.id !== from.host_id && (!isConfig || hostSupports(h, minApi)))));
  const profiles = useStore((s) => s.profiles);
  const configs = useStore((s) => s.claudeConfigs);
  const [to, setTo] = useState(hosts[0]?.id ?? "");
  const existing = isConfig
    ? configs.find((c) => c.host_id === to && c.name === from.name)
    : profiles.find((p) => p.host_id === to && p.name === from.name);
  const existingDir = existing && (("config_dir" in existing ? existing.config_dir : existing.claude_config_dir) || baseDir);
  const [dir, setDir] = useState(fromDir);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string[] | null>(null);
  const fromName = useStore((s) => s.hosts.find((h) => h.id === from.host_id)?.name);
  const what = isConfig ? "config" : "profile";
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.copyClaudeConfig({
        ...(isConfig ? { config: from.name } : { profile: from.name }),
        from_host: from.host_id,
        to_host: to,
        config_dir: existing ? undefined : dir,
        overwrite,
      });
      setDone(r.files);
      useStore.getState().loadAll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Copy "${from.name}" login from ${fromName}`} onClose={onClose}>
      <div className="space-y-4 text-[12.5px]">
        <p className="text-muted">
          {codex
            ? "Copies the Codex login (auth.json), config.toml, AGENTS.md, skills, rules and prompts from "
            : "Copies the Claude credentials, settings, skills, agents, commands and plugins from "}
          <span className="font-mono">{fromDir}</span>. Session history and caches stay behind.
        </p>
        {hosts.length === 0 ? (
          <p className="text-faint">No other host can take it{isConfig ? " (hosts need updating to have agent configs)" : ""}.</p>
        ) : (
          <Field label="To host">
            <select value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none">
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {existing ? (
          <div className="space-y-2">
            <div className="text-muted">
              Into its existing "{from.name}" {what} at <span className="font-mono">{existingDir}</span>.
            </div>
            <Toggle checked={overwrite} onChange={setOverwrite} label="Replace an existing login there" />
          </div>
        ) : (
          to && (
            <Field label="Config directory on that host" hint={`A "${from.name}" ${what} is created there with this directory.`}>
              <Input value={dir} onChange={(e) => setDir(e.target.value)} className="font-mono text-[12px]" />
            </Field>
          )
        )}
        <ModalFooter className="space-y-4">
          {err && <div className="rounded bg-red-500/10 p-2 text-red-300">{err}</div>}
          {done && <div className="rounded bg-emerald-500/10 p-2 text-emerald-300">Copied {done.join(", ")}.</div>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {done ? "Close" : "Cancel"}
            </Button>
            {!done && (
              <Button variant="primary" disabled={busy || !to} onClick={submit}>
                Copy login
              </Button>
            )}
          </div>
        </ModalFooter>
      </div>
    </Modal>
  );
}

// ---------- agent defaults (per host) ----------

const selectClass = "h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none";

export function AgentDefaultsRow({ host, showName }: { host: Host; showName: boolean }) {
  const [settings, setSettings] = useState<HostSettings | null>(null);
  const [custom, setCustom] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api
      .settings(host.id)
      .then((s) => {
        setSettings(s);
        setCustom(!!s.default_model && !MODEL_ALIASES.includes(s.default_model));
      })
      .catch((e) => setErr(e.message));
  }, [host.id]);
  const save = async (b: Partial<HostSettings>) => {
    setErr(null);
    try {
      setSettings(await api.updateSettings(host.id, b));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  if (!settings) return err ? <div className="text-xs text-red-400">{err}</div> : null;
  return (
    <div className="rounded-xl border border-line px-4 py-3">
      {showName && <div className="mb-2 text-[12.5px] font-medium">{host.name}</div>}
      <div className={clsx("grid gap-3", hostSupports(host, 2) ? "grid-cols-3" : "grid-cols-2")}>
        <Field label="Model">
          {custom ? (
            <Input
              autoFocus
              defaultValue={settings.default_model ?? ""}
              placeholder="model id, e.g. claude-opus-5-5"
              className="font-mono text-[12px]"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (!v) setCustom(false);
                if (v !== (settings.default_model ?? "")) save({ default_model: v || null });
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <select
              className={selectClass}
              value={settings.default_model ?? ""}
              onChange={(e) => (e.target.value === "__custom" ? setCustom(true) : save({ default_model: e.target.value || null }))}
            >
              <option value="">Claude's default</option>
              {MODEL_ALIASES.map((m) => (
                <option key={m} value={m}>
                  {m[0].toUpperCase() + m.slice(1)} (latest)
                </option>
              ))}
              <option value="__custom">Specific model…</option>
            </select>
          )}
        </Field>
        <Field label="Effort">
          <select className={selectClass} value={settings.default_effort ?? ""} onChange={(e) => save({ default_effort: (e.target.value || null) as HostSettings["default_effort"] })}>
            <option value="">Claude's default</option>
            {EFFORTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </Field>
        {hostSupports(host, 2) && (
          <Field label="Permission mode">
            <select
              className={selectClass}
              value={settings.default_permission_mode ?? ""}
              title="For threads whose project doesn't pick a mode"
              onChange={(e) => save({ default_permission_mode: (e.target.value || null) as HostSettings["default_permission_mode"] })}
            >
              <option value="">Ask (default)</option>
              {PERMISSION_MODES.filter((m) => m.id !== "default").map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
    </div>
  );
}

// ---------- terminal tools (per host) ----------

const NO_TOOLS: TerminalTool[] = [];

/** TUI programs offered as shortcuts in every task's terminal on this host. */
export function TerminalToolsRow({ host }: { host: Host }) {
  const saved = useStore((s) => s.hostSettings[host.id]?.terminal_tools) ?? NO_TOOLS;
  const loaded = useStore((s) => !!s.hostSettings[host.id]);
  const [draft, setDraft] = useState<TerminalTool[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    useStore.getState().loadHostSettings(host.id);
  }, [host.id]);
  const rows = draft ?? saved;
  const edit = (i: number, b: Partial<TerminalTool>) => setDraft(rows.map((t, j) => (j === i ? { ...t, ...b } : t)));
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const terminal_tools = rows.map((t) => ({ ...t, name: t.name.trim(), command: t.command.trim() })).filter((t) => t.name || t.command);
      const settings = await api.updateSettings(host.id, { terminal_tools });
      useStore.setState((s) => ({ hostSettings: { ...s.hostSettings, [host.id]: settings } }));
      setDraft(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!loaded) return null;
  return (
    <div className="space-y-2 rounded-xl border border-line px-4 py-3">
      {rows.length === 0 && <div className="text-[12.5px] text-faint">No tools yet.</div>}
      {rows.map((t, i) => (
        <div key={t.id || `new-${i}`} className="flex items-center gap-2">
          <div className="w-36 shrink-0">
            <Input value={t.name} placeholder="Name, e.g. git" onChange={(e) => edit(i, { name: e.target.value })} />
          </div>
          <div className="min-w-0 flex-1">
            <Input
              value={t.command}
              placeholder="Command, e.g. lazygit or ~/bin/review.sh"
              className="font-mono text-[12px]"
              onChange={(e) => edit(i, { command: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && draft && save()}
            />
          </div>
          <IconButton title="Remove" onClick={() => setDraft(rows.filter((_, j) => j !== i))}>
            <Trash2 size={13} />
          </IconButton>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={() => setDraft([...rows, { id: "", name: "", command: "" }])}>
          <Plus size={13} /> Add tool
        </Button>
        {draft && (
          <>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => (setDraft(null), setErr(null))}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={save}>
              Save
            </Button>
          </>
        )}
      </div>
      {err && <div className="text-xs text-red-400">{err}</div>}
    </div>
  );
}
