import { AGENTS, agentInfo, agentOf, canRunAgents, mutate, usageKey, type Board, type HostAgentConfig as ClaudeConfig } from "@huntaway/client"
import { HostId, type Agent, type AgentConfig, type AgentConfigPatch } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Exit } from "effect"
import { Copy, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react"
import { useMemo, useState } from "react"
import { useShallow } from "../boardHelpers"
import { board, useBoard } from "../../state/board"
import { exitError, runExit, useAction, useMutation } from "../../state/mutation"
import { Button, Field, Input, Modal, ModalFooter, useConfirm } from "../ui"
import { usageAlert } from "../ui/usageConfigs"
import { CopyLoginModal, type CopyRequest } from "./hosts/CopyLoginModal"

// Copying a config's login to another host is 6.11's hosts/CopyLoginModal, given the board's hosts that run agents and
// the hub's `hub.hosts.copyConfig` (`CopyLogin` below).

/** The proxy fields a config's change sends. */
type ProxyFields = Pick<AgentConfigPatch, "api_url" | "api_key" | "management_key">

/** Rejects with why `exit` failed, for what shows a rejected promise's error (a confirm, the copy dialog). */
const orReject = <A, E>(exit: Exit.Exit<A, E>): Promise<A> =>
  Exit.isSuccess(exit) ? Promise.resolve(exit.value) : Promise.reject(new Error(exitError(exit) ?? "Stopped."))

/** Copies a config's login through the hub (`hub.hosts.copyConfig`, on the board's own host), giving the entries copied. */
const copyLogin = (r: CopyRequest): Promise<{ readonly files: ReadonlyArray<string> }> => {
  const hub = board.get().localHostId
  if (hub === null) return Promise.reject(new Error("This board's own host isn't known yet."))
  const payload = {
    config: r.config,
    from_host: HostId.make(r.from_host),
    to_host: HostId.make(r.to_host),
    overwrite: r.overwrite,
    ...(r.config_dir === undefined ? {} : { config_dir: r.config_dir }),
  }
  return runExit(mutate("hub.hosts.copyConfig", hub, payload))
    .then(orReject)
    .then((done) => ({ files: done.files ?? [] }))
}

/** Copying a config's login and settings to another host that runs agents and is connected, through the hub. */
function CopyLogin({ from, onClose }: { from: ClaudeConfig; onClose: () => void }) {
  const hosts = useBoard((s) => s.hosts)
  const targets = useMemo(() => configHosts(hosts).filter((h) => h.id !== from.host_id && h.connected), [hosts, from.host_id])
  return <CopyLoginModal from={from} hosts={targets} copy={copyLogin} onClose={onClose} />
}

/** Hosts that can run agents, which keep agent configs of their own. */
export const configHosts = (hosts: Board["hosts"]): Board["hosts"][number][] => hosts.filter((h) => canRunAgents(h))

/** A config's directory, with its agent's default for a blank one. */
export const configDir = (c: Pick<ClaudeConfig, "config_dir" | "agent">): string => c.config_dir || agentInfo(agentOf(c)).dir

/** The proxy a Claude Code config's agents go through: its own, or the one its settings.json sets. */
export const configProxy = (c: Pick<ClaudeConfig, "agent" | "api_url" | "settings_api_url">): string | null =>
  agentOf(c) === "claude" ? c.api_url || c.settings_api_url || null : null

/** Marks a config that runs Codex rather than Claude Code, or one whose agents go through a proxy. */
export function AgentBadge({ config }: { config: ClaudeConfig }) {
  const proxy = configProxy(config)
  if (proxy) {
    const how = config.api_url ? "" : " (set in its settings.json)"
    return (
      <span className="shrink-0 rounded bg-white/5 px-1 py-px text-[10.5px] text-muted" title={`Its agents go through ${proxy}${how}`}>
        Proxy
      </span>
    )
  }
  if (agentOf(config) !== "codex") return null
  return <span className="shrink-0 rounded bg-white/5 px-1 py-px text-[10.5px] text-muted">Codex</span>
}

/** Profiles on the config's host that use it. */
function useUsedBy(c: ClaudeConfig): string[] {
  return useBoard(useShallow((s) => s.profiles.filter((p) => p.host_id === c.host_id && p.claude_config_ids.includes(c.id)).map((p) => p.name)))
}

function ConfigRow({
  config,
  label,
  canCopy,
  onEdit,
  onCopy,
}: {
  config: ClaudeConfig
  label: string
  canCopy: boolean
  onEdit: () => void
  onCopy: () => void
}) {
  const usedBy = useUsedBy(config)
  const canShowUsage = true
  // Through a proxy, which picks the account, there's no one window to restart.
  const canRestart = !configProxy(config)
  // Usage that's been fetched and has no session limit: a plan without the 5-hour window.
  const noWindow = useBoard((s) => {
    const u = s.usage[usageKey(config.host_id, config.id)]
    return !!u && !u.error && u.limits.length > 0 && !u.limits.some((l) => l.id === "session")
  })
  const [{ error: err }, update] = useMutation("configs.update")
  const set = (patch: { show_usage?: boolean; restart_window?: boolean }): void => {
    void update(config.host_id, { id: config.id, patch })
  }
  const confirm = useConfirm()
  const remove = (): void => {
    const used = usedBy.length ? ` It's taken off ${usedBy.join(", ")}; their threads that used it switch to the profile's default.` : ""
    confirm.ask({
      title: `Delete config ${config.name}`,
      body: `Delete the config "${config.name}"? The directory itself stays.${used}`,
      action: "Delete config",
      danger: true,
      onConfirm: () => runExit(mutate("configs.delete", config.host_id, { id: config.id })).then(orReject),
    })
  }
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
            title={
              configProxy(config)
                ? "Check the proxy's Claude accounts' plan limits (with its management key) and show what's left in the sidebar, for the profiles that use it."
                : "Check this login's plan limits and show what's left in the sidebar, for the profiles that use it. Off on new hosts, so copies of a login don't all ask."
            }
          >
            <input type="checkbox" className="accent-accent" checked={config.show_usage} onChange={(e) => set({ show_usage: e.target.checked })} />
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
            <input type="checkbox" className="accent-accent" checked={config.restart_window} onChange={(e) => set({ restart_window: e.target.checked })} />
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
  )
}

interface Editing {
  host: string
  config?: ClaudeConfig | undefined
  name?: string | undefined
}

/** Every host's agent configs (Claude Code or Codex), shown together by name. */
export function ClaudeConfigsPanel() {
  const configs = useBoard((s) => s.claudeConfigs)
  const hosts = useBoard((s) => s.hosts)
  const online = configHosts(hosts)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [copying, setCopying] = useState<ClaudeConfig | null>(null)
  const names = useMemo(() => [...new Set(configs.map((c) => c.name))].toSorted((a, b) => a.localeCompare(b)), [configs])
  const hostName = (id: string): string => hosts.find((h) => h.id === id)?.name ?? id.slice(0, 8)
  const first = online.find((h) => h.local) ?? online[0]
  if (!first) return null
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Agent configs</h2>
        <Button size="sm" onClick={() => setEditing({ host: first.id })}>
          <Plus size={13} /> Add config
        </Button>
      </div>
      <p className="mb-3 text-[12.5px] text-muted">
        A Claude Code or Codex config directory on a host, with its own login, settings and history. Profiles pick which configs their agents can use, and a
        project can pick its own; a thread's config decides which agent runs it. Configs with the same name on different hosts appear together.
      </p>
      <div className="space-y-3">
        {names.map((name) => {
          const rows = configs.filter((c) => c.name === name)
          const missing = online.filter((h) => !rows.some((c) => c.host_id === h.id))
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
          )
        })}
        {names.length === 0 && <div className="rounded-xl border border-line px-4 py-3 text-[12.5px] text-faint">No agent configs yet.</div>}
      </div>
      {editing && <ConfigModal {...editing} onClose={() => setEditing(null)} />}
      {copying && <CopyLogin from={copying} onClose={() => setCopying(null)} />}
    </section>
  )
}

/** One host's Claude configs, for its page. */
export function HostClaudeConfigs({ hostId, canCopy }: { hostId: string; canCopy: boolean }) {
  const all = useBoard((s) => s.claudeConfigs)
  const configs = all.filter((c) => c.host_id === hostId)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [copying, setCopying] = useState<ClaudeConfig | null>(null)
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
          <ConfigRow
            key={c.id}
            config={c}
            label={c.name}
            canCopy={canCopy}
            onEdit={() => setEditing({ host: hostId, config: c })}
            onCopy={() => setCopying(c)}
          />
        ))}
        {configs.length === 0 && <div className="px-4 py-3 text-[12.5px] text-faint">No agent configs yet.</div>}
      </div>
      {editing && <ConfigModal {...editing} onClose={() => setEditing(null)} />}
      {copying && <CopyLogin from={copying} onClose={() => setCopying(null)} />}
    </section>
  )
}

function ConfigModal({ host, config, name, onClose, onCreated }: Editing & { onClose: () => void; onCreated?: ((c: AgentConfig) => void) | undefined }) {
  const hostName = useBoard((s) => s.hosts.find((h) => h.id === host)?.name)
  return (
    <Modal title={config ? `Edit config on ${hostName}` : `Add config on ${hostName}`} onClose={onClose}>
      <ConfigForm
        hostId={host}
        initial={config}
        name={name}
        onDone={(c) => {
          onCreated?.(c)
          onClose()
        }}
        onCancel={onClose}
      />
    </Modal>
  )
}

function ConfigForm({
  hostId,
  initial,
  name: presetName,
  onDone,
  onCancel,
}: {
  hostId: string
  initial?: ClaudeConfig | undefined
  name?: string | undefined
  onDone: (c: AgentConfig) => void
  onCancel: () => void
}) {
  // A config set up on another host under this name keeps its agent here.
  const sameName = useBoard((s) => s.claudeConfigs.find((c) => presetName && c.name === presetName))
  const [agent, setAgentState] = useState<Agent>(agentOf(initial ?? sameName))
  const defaultDir = (a: Agent): string => {
    const base = agentInfo(a).dir
    return presetName ? `${base}-${presetName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : base
  }
  const [name, setName] = useState(initial?.name ?? presetName ?? "")
  const [dir, setDir] = useState(initial?.config_dir ?? defaultDir(agent))
  const [apiUrl, setApiUrl] = useState(initial?.api_url ?? "")
  // The keys are never sent back: blank keeps the saved one.
  const [apiKey, setApiKey] = useState("")
  const [managementKey, setManagementKey] = useState("")
  const [{ busy, error: err }, run] = useAction()
  const setAgent = (a: Agent): void => {
    // Follow the agent while the directory is still the default one.
    if (!initial && dir === defaultDir(agent)) setDir(defaultDir(a))
    setAgentState(a)
  }
  const info = agentInfo(agent)
  const proxied = agent === "claude" && !!apiUrl.trim()
  // A proxy its settings.json sets, as it was when the form opened: its usage needs the management key too.
  const settingsProxy = agent === "claude" && !proxied && initial?.settings_api_url && initial.config_dir === dir.trim() ? initial.settings_api_url : null
  const mgmtKey = managementKey.trim() ? { management_key: managementKey.trim() } : {}
  /** What to send about the proxy: cleared (keys too) when it's taken away or the agent is Codex. */
  const proxyFields = (): ProxyFields => {
    // The management key stays for the proxy settings.json sets.
    if (settingsProxy) return { ...(initial?.api_url ? { api_url: null, api_key: null } : {}), ...mgmtKey }
    if (!proxied) return initial?.api_url ? { api_url: null, api_key: null, management_key: null } : {}
    return {
      api_url: apiUrl.trim(),
      ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      ...mgmtKey,
    }
  }
  const submit = (): void => {
    // A double press while it's saving does nothing, as before.
    if (busy) return
    const config = { name: name.trim(), config_dir: dir.trim(), agent, ...proxyFields() }
    void run(initial ? mutate("configs.update", hostId, { id: initial.id, patch: config }) : mutate("configs.create", hostId, { config })).then((exit) => {
      if (Exit.isSuccess(exit)) onDone(exit.value)
    })
  }
  return (
    <div className="space-y-3">
      <Field label="Name">
        <Input autoFocus={!presetName} value={name} placeholder="work / personal" onChange={(e) => setName(e.target.value)} disabled={!!presetName} />
      </Field>
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
      <Field
        label="Config directory"
        hint={`On that host. Passed as ${info.env}, so each config has its own login, settings and history. Run \`${info.env}=… ${agent}\` there once to log in, or copy a login from another host.`}
      >
        <Input
          className="font-mono text-[12px]"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) submit()
          }}
        />
      </Field>
      {initial && (
        <div className="text-[12px] text-faint">
          Changing the directory moves agents to it, but threads already started keep their conversation in the old one.
        </div>
      )}
      {agent === "claude" && (
        <Field
          label="Proxy (optional)"
          hint="An Anthropic-compatible proxy, such as CLIProxyAPI pooling several subscriptions. Its agents, titles and terminals send their requests there (ANTHROPIC_BASE_URL) instead of using the directory's login; the directory's settings, skills and history are still used."
        >
          <Input className="font-mono text-[12px]" value={apiUrl} placeholder="http://192.168.1.10:8317" onChange={(e) => setApiUrl(e.target.value)} />
        </Field>
      )}
      {proxied && (
        <>
          <Field label="Proxy API key" hint="One of the proxy's client keys (ANTHROPIC_AUTH_TOKEN). It stays on the host.">
            <Input
              type="password"
              autoComplete="off"
              className="font-mono text-[12px]"
              value={apiKey}
              placeholder={initial?.has_api_key ? "Saved; type a new one to replace it" : "sk-…"}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
        </>
      )}
      {settingsProxy && (
        <div className="text-[12px] text-faint">
          Its settings.json sends its requests to <span className="font-mono">{settingsProxy}</span>, so its usage is that proxy's Claude accounts' (with
          CLIProxyAPI's management key).
        </div>
      )}
      {(proxied || settingsProxy) && (
        <Field
          label="Management key (optional)"
          hint="CLIProxyAPI's management key, to show its Claude accounts' usage with Show usage (needs management.allow-remote: true in its config). It can act as any of those accounts, so it stays on the host."
        >
          <Input
            type="password"
            autoComplete="off"
            className="font-mono text-[12px]"
            value={managementKey}
            placeholder={initial?.has_management_key ? "Saved; type a new one to replace it" : ""}
            onChange={(e) => setManagementKey(e.target.value)}
          />
        </Field>
      )}
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
  )
}

/**
 * Pick which of a host's Claude configs to use, in order: the first is the default, and with
 * more than one, new tasks ask which to use.
 */
export function ConfigPicker({ hostId, value, onChange }: { hostId: string; value: ReadonlyArray<string>; onChange: (ids: string[]) => void }) {
  const all = useBoard((s) => s.claudeConfigs)
  const configs = all.filter((c) => c.host_id === hostId)
  const [adding, setAdding] = useState(false)
  // Picked ones first, in their order, then the rest.
  const rows = [...value.map((id) => configs.find((c) => c.id === id)).filter((c): c is ClaudeConfig => !!c), ...configs.filter((c) => !value.includes(c.id))]
  const picked = value.filter((id) => configs.some((c) => c.id === id))
  const toggle = (id: string, on: boolean): void => onChange(on ? [...picked, id] : picked.filter((x) => x !== id))
  return (
    <div className="divide-y divide-line rounded-md border border-line">
      {rows.map((c) => {
        const i = picked.indexOf(c.id)
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
                  e.preventDefault()
                  onChange([c.id, ...picked.filter((x) => x !== c.id)])
                }}
              >
                Make default
              </button>
            )}
          </label>
        )
      })}
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12px] text-faint hover:text-fg"
        onClick={() => setAdding(true)}
      >
        <Plus size={12} /> New config…
      </button>
      {adding && <ConfigModal host={hostId} onClose={() => setAdding(false)} onCreated={(c) => onChange([...picked, c.id])} />}
    </div>
  )
}

/** Which of several agent configs a thread uses. */
export function ConfigSelect({
  configs,
  value,
  onChange,
  className,
}: {
  configs: ReadonlyArray<ClaudeConfig>
  value: string
  onChange: (id: string) => void
  className?: string | undefined
}) {
  const usage = useBoard((s) => s.usage)
  // Which are running low or out, so another can be picked before the work starts.
  const alert = (c: ClaudeConfig): ReturnType<typeof usageAlert> => usageAlert(usage[usageKey(c.host_id, c.id)])
  return (
    <select className={className} title="Agent config" value={value} onChange={(e) => onChange(e.target.value)}>
      {configs.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
          {agentOf(c) === "codex" ? " (Codex)" : ""}
          {alert(c) ? ` · ${alert(c)?.short}` : ""}
        </option>
      ))}
    </select>
  )
}

/** A warning that `config` is running low on usage, or out of it, by where it's picked. */
export function ConfigUsageNote({ config, className }: { config: ClaudeConfig | undefined; className?: string | undefined }) {
  const u = useBoard((s) => (config ? s.usage[usageKey(config.host_id, config.id)] : undefined))
  const alert = usageAlert(u)
  if (!config || !alert) return null
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
  )
}
