import clsx from "clsx";
import { Copy, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { AGENTS, agentInfo, agentOf, api, canRunAgents, hostSupports, type Agent, type ClaudeConfig } from "../api";
import { usageKey, useStore } from "../store";
import { usageAlert } from "../usageConfigs";
import { CopyLoginModal } from "./Hosts";
import { Button, Field, Input, Modal, ModalFooter, useAsyncAction, useConfirm } from "./ui";

/** Hosts that can run agents and keep Claude configs of their own (API 20). */
const configHosts = (hosts: ReturnType<typeof useStore.getState>["hosts"]) => hosts.filter((h) => canRunAgents(h) && hostSupports(h, 20));

/** A config's directory, with its agent's default for a blank one. */
export const configDir = (c: ClaudeConfig) => c.config_dir || agentInfo(agentOf(c)).dir;

/** Marks a config that runs Codex rather than Claude Code. */
export function AgentBadge({ config }: { config: ClaudeConfig }) {
  if (agentOf(config) !== "codex") return null;
  return <span className="shrink-0 rounded bg-white/5 px-1 py-px text-[10.5px] text-muted">Codex</span>;
}

/** Profiles on the config's host that use it. */
function useUsedBy(c: ClaudeConfig) {
  return useStore(useShallow((s) => s.profiles.filter((p) => p.host_id === c.host_id && p.claude_config_ids?.includes(c.id)).map((p) => p.name)));
}

function ConfigRow({ config, label, canCopy, onEdit, onCopy }: { config: ClaudeConfig; label: string; canCopy: boolean; onEdit: () => void; onCopy: () => void }) {
  const usedBy = useUsedBy(config);
  const canShowUsage = useStore((s) => hostSupports(s.hosts.find((h) => h.id === config.host_id), 52));
  const canRestart = useStore((s) => hostSupports(s.hosts.find((h) => h.id === config.host_id), 91));
  // Usage that's been fetched and has no session limit: a plan without the 5-hour window.
  const noWindow = useStore((s) => {
    const u = s.usage[usageKey(config.host_id, config.id)];
    return !!u && !u.error && u.limits.length > 0 && !u.limits.some((l) => l.id === "session");
  });
  const [err, setErr] = useState<string | null>(null);
  const set = async (b: { show_usage?: boolean; restart_window?: boolean }) => {
    setErr(null);
    try {
      await api.updateClaudeConfig(config.host_id, config.id, b);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const confirm = useConfirm();
  const remove = () => {
    const used = usedBy.length ? ` It's taken off ${usedBy.join(", ")}; their threads that used it switch to the profile's default.` : "";
    confirm.ask({
      title: `Delete config ${config.name}`,
      body: `Delete the config "${config.name}"? The directory itself stays.${used}`,
      action: "Delete config",
      danger: true,
      onConfirm: () => api.deleteClaudeConfig(config.host_id, config.id),
    });
  };
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-3">
        <div className="w-28 shrink-0 truncate text-[12.5px]">{label}</div>
        <AgentBadge config={config} />
        <div className="min-w-0 flex-1 truncate text-[11.5px] text-faint">
          <span className="font-mono">{configDir(config)}</span>
          {usedBy.length > 0 && ` · ${usedBy.join(", ")}`}
        </div>
        {canShowUsage && (
          <label
            className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted"
            title="Check this login's plan limits and show what's left in the sidebar, for the profiles that use it. Off on new hosts, so copies of a login don't all ask."
          >
            <input type="checkbox" className="accent-accent" checked={!!config.show_usage} onChange={(e) => set({ show_usage: e.target.checked })} />
            Show usage
          </label>
        )}
        {canRestart && (
          <label
            className={clsx("flex shrink-0 items-center gap-1.5 text-[11.5px]", noWindow ? "text-faint" : "text-muted")}
            title={
              (noWindow ? "This login's plan has no 5-hour window, so nothing is sent. " : "") +
              "When this login's 5-hour session window ends, start the next one right away with a one-word prompt (Haiku, or a low-effort Codex turn), so a new window is always running. Only plans with a 5-hour limit are sent anything."
            }
          >
            <input type="checkbox" className="accent-accent" checked={!!config.restart_window} onChange={(e) => set({ restart_window: e.target.checked })} />
            Restart 5h window
          </label>
        )}
        {canCopy && (
          <Button size="sm" variant="ghost" onClick={onCopy} title="Copy this login and settings to another host">
            <Copy size={12} /> Copy login
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" title="Delete" onClick={remove}>
          <Trash2 size={13} />
        </Button>
      </div>
      {err && <div className="mt-1 text-xs text-red-400">{err}</div>}
      {confirm.dialog}
    </div>
  );
}

type Editing = { host: string; config?: ClaudeConfig; name?: string };

/** Every host's agent configs (Claude Code or Codex), shown together by name. */
export function ClaudeConfigsPanel() {
  const configs = useStore((s) => s.claudeConfigs);
  const hosts = useStore((s) => s.hosts);
  const online = configHosts(hosts);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [copying, setCopying] = useState<ClaudeConfig | null>(null);
  const names = useMemo(() => [...new Set(configs.map((c) => c.name))].sort((a, b) => a.localeCompare(b)), [configs]);
  const hostName = (id: string) => hosts.find((h) => h.id === id)?.name ?? id.slice(0, 8);
  if (online.length === 0) return null;
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Agent configs</h2>
        <Button size="sm" onClick={() => setEditing({ host: online.find((h) => h.local)?.id ?? online[0].id })}>
          <Plus size={13} /> Add config
        </Button>
      </div>
      <p className="mb-3 text-[12.5px] text-muted">
        A Claude Code or Codex config directory on a host, with its own login, settings and history. Profiles pick which configs their agents can use,
        and a project can pick its own; a thread's config decides which agent runs it. Configs with the same name on different hosts appear together.
      </p>
      <div className="space-y-3">
        {names.map((name) => {
          const rows = configs.filter((c) => c.name === name);
          const missing = online.filter((h) => !rows.some((c) => c.host_id === h.id));
          return (
            <div key={name} className="rounded-xl border border-line">
              <div className="border-b border-line px-4 py-2.5 text-[13px] font-medium">{name}</div>
              {rows.map((c) => (
                <ConfigRow
                  key={`${c.host_id}:${c.id}`}
                  config={c}
                  label={hostName(c.host_id)}
                  canCopy={online.length > 1}
                  onEdit={() => setEditing({ host: c.host_id, config: c })}
                  onCopy={() => setCopying(c)}
                />
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
        {names.length === 0 && <div className="rounded-xl border border-line px-4 py-3 text-[12.5px] text-faint">No agent configs yet.</div>}
      </div>
      {editing && <ConfigModal {...editing} onClose={() => setEditing(null)} />}
      {copying && <CopyLoginModal from={copying} onClose={() => setCopying(null)} />}
    </section>
  );
}

/** One host's Claude configs, for its page. */
export function HostClaudeConfigs({ hostId, canCopy }: { hostId: string; canCopy: boolean }) {
  const all = useStore((s) => s.claudeConfigs);
  const configs = all.filter((c) => c.host_id === hostId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [copying, setCopying] = useState<ClaudeConfig | null>(null);
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Agent configs on this host</h2>
        <Button size="sm" onClick={() => setEditing({ host: hostId })}>
          <Plus size={13} /> Add config
        </Button>
      </div>
      <div className="divide-y divide-line rounded-xl border border-line">
        {configs.map((c) => (
          <ConfigRow key={c.id} config={c} label={c.name} canCopy={canCopy} onEdit={() => setEditing({ host: hostId, config: c })} onCopy={() => setCopying(c)} />
        ))}
        {configs.length === 0 && <div className="px-4 py-3 text-[12.5px] text-faint">No agent configs yet.</div>}
      </div>
      {editing && <ConfigModal {...editing} onClose={() => setEditing(null)} />}
      {copying && <CopyLoginModal from={copying} onClose={() => setCopying(null)} />}
    </section>
  );
}

function ConfigModal({ host, config, name, onClose, onCreated }: Editing & { onClose: () => void; onCreated?: (c: ClaudeConfig) => void }) {
  const hostName = useStore((s) => s.hosts.find((h) => h.id === host)?.name);
  return (
    <Modal title={config ? `Edit config on ${hostName}` : `Add config on ${hostName}`} onClose={onClose}>
      <ConfigForm hostId={host} initial={config} name={name} onDone={(c) => (onCreated?.(c), onClose())} onCancel={onClose} />
    </Modal>
  );
}

function ConfigForm({
  hostId,
  initial,
  name: presetName,
  onDone,
  onCancel,
}: {
  hostId: string;
  initial?: ClaudeConfig;
  name?: string;
  onDone: (c: ClaudeConfig) => void;
  onCancel: () => void;
}) {
  const host = useStore((s) => s.hosts.find((h) => h.id === hostId));
  const agents = hostSupports(host, 25);
  // A config set up on another host under this name keeps its agent here.
  const sameName = useStore((s) => s.claudeConfigs.find((c) => presetName && c.name === presetName));
  const [agent, setAgentState] = useState<Agent>(agentOf(initial ?? sameName));
  const defaultDir = (a: Agent) => {
    const base = agentInfo(a).dir;
    return presetName ? `${base}-${presetName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : base;
  };
  const [name, setName] = useState(initial?.name ?? presetName ?? "");
  const [dir, setDir] = useState(initial?.config_dir ?? defaultDir(agent));
  const { busy, error: err, run } = useAsyncAction();
  const setAgent = (a: Agent) => {
    // Follow the agent while the directory is still the default one.
    if (!initial && dir === defaultDir(agent)) setDir(defaultDir(a));
    setAgentState(a);
  };
  const info = agentInfo(agent);
  const submit = () =>
    run(async () => {
      const body = { name: name.trim(), config_dir: dir.trim(), ...(agents ? { agent } : {}) };
      const c = initial ? await api.updateClaudeConfig(hostId, initial.id, body) : await api.createClaudeConfig(hostId, body);
      await useStore.getState().loadProfiles();
      onDone({ ...c, host_id: hostId });
    });
  return (
    <div className="space-y-3">
      <Field label="Name">
        <Input autoFocus={!presetName} value={name} placeholder="work / personal" onChange={(e) => setName(e.target.value)} disabled={!!presetName} />
      </Field>
      {agents && (
        <Field label="Agent" hint={initial ? "Threads that have started keep the agent their conversation is with." : undefined}>
          <div className="flex gap-1.5">
            {AGENTS.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setAgent(a.id)}
                className={clsx(
                  "rounded-md border px-2.5 py-1 text-[12.5px]",
                  agent === a.id ? "border-accent/60 bg-accent/10 text-fg" : "border-line text-muted hover:text-fg",
                )}
              >
                {a.label}
              </button>
            ))}
          </div>
        </Field>
      )}
      <Field
        label="Config directory"
        hint={`On that host. Passed as ${info.env}, so each config has its own login, settings and history. Run \`${info.env}=… ${agent}\` there once to log in, or copy a login from another host.`}
      >
        <Input className="font-mono text-[12px]" value={dir} onChange={(e) => setDir(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && submit()} />
      </Field>
      {initial && <div className="text-[12px] text-faint">Changing the directory moves agents to it, but threads already started keep their conversation in the old one.</div>}
      <ModalFooter className="space-y-3">
        {err && <div className="text-xs text-red-400">{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || busy} onClick={submit}>
            {busy && <Loader2 size={13} className="animate-spin" />} {initial ? "Save" : "Add config"}
          </Button>
        </div>
      </ModalFooter>
    </div>
  );
}

/**
 * Pick which of a host's Claude configs to use, in order: the first is the default, and with
 * more than one, new tasks ask which to use.
 */
export function ConfigPicker({ hostId, value, onChange }: { hostId: string; value: string[]; onChange: (ids: string[]) => void }) {
  const all = useStore((s) => s.claudeConfigs);
  const configs = all.filter((c) => c.host_id === hostId);
  const [adding, setAdding] = useState(false);
  // Picked ones first, in their order, then the rest.
  const rows = [...value.map((id) => configs.find((c) => c.id === id)).filter((c): c is ClaudeConfig => !!c), ...configs.filter((c) => !value.includes(c.id))];
  const picked = value.filter((id) => configs.some((c) => c.id === id));
  const toggle = (id: string, on: boolean) => onChange(on ? [...picked, id] : picked.filter((x) => x !== id));
  return (
    <div className="divide-y divide-line rounded-md border border-line">
      {rows.map((c) => {
        const i = picked.indexOf(c.id);
        return (
          <label key={c.id} className="group flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[12.5px]">
            <input type="checkbox" className="accent-accent" checked={i >= 0} onChange={(e) => toggle(c.id, e.target.checked)} />
            <span className={clsx(i < 0 && "text-muted")}>{c.name}</span>
            <AgentBadge config={c} />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{configDir(c)}</span>
            {i === 0 && picked.length > 1 && <span className="text-[11px] text-accent">default</span>}
            {i > 0 && (
              <button
                type="button"
                className="hidden text-[11px] text-faint group-hover:inline hover:text-fg"
                onClick={(e) => {
                  e.preventDefault();
                  onChange([c.id, ...picked.filter((x) => x !== c.id)]);
                }}
              >
                Make default
              </button>
            )}
          </label>
        );
      })}
      <button type="button" className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12px] text-faint hover:text-fg" onClick={() => setAdding(true)}>
        <Plus size={12} /> New config…
      </button>
      {adding && <ConfigModal host={hostId} onClose={() => setAdding(false)} onCreated={(c) => onChange([...picked, c.id])} />}
    </div>
  );
}

/** Which of several agent configs a thread uses. */
export function ConfigSelect({ configs, value, onChange, className }: { configs: ClaudeConfig[]; value: string; onChange: (id: string) => void; className?: string }) {
  const usage = useStore((s) => s.usage);
  // Which are running low or out, so another can be picked before the work starts.
  const alert = (c: ClaudeConfig) => usageAlert(usage[usageKey(c.host_id, c.id)]);
  return (
    <select className={className} title="Agent config" value={value} onChange={(e) => onChange(e.target.value)}>
      {configs.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
          {agentOf(c) === "codex" ? " (Codex)" : ""}
          {alert(c) ? ` · ${alert(c)!.short}` : ""}
        </option>
      ))}
    </select>
  );
}

/** A warning that `config` is running low on usage, or out of it, by where it's picked. */
export function ConfigUsageNote({ config, className }: { config: ClaudeConfig | undefined; className?: string }) {
  const u = useStore((s) => (config ? s.usage[usageKey(config.host_id, config.id)] : undefined));
  const alert = usageAlert(u);
  if (!config || !alert) return null;
  return (
    <span
      data-usage-alert={alert.level}
      className={clsx("flex items-center gap-1 text-[11.5px]", alert.level === "out" ? "text-red-300" : "text-st-attention", className)}
    >
      <TriangleAlert size={12} className="shrink-0" />
      <span>
        {config.name}: {alert.text}
      </span>
    </span>
  );
}
