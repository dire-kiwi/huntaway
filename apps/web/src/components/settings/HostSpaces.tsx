import { useAtomValue } from "@effect/atom-react"
import { agentOf, mutate, query } from "@huntaway/client"
import { AgentConfigId, type Host, type Space, type SpaceView } from "@huntaway/contracts"
import { clsx } from "clsx"
import { type Effect, Exit } from "effect"
import type { AtomRegistry } from "effect/reactivity"
import { ExternalLink, Loader2, Monitor, Play, Plus, RefreshCw, Square, Trash2 } from "lucide-react"
import { useState } from "react"
import { useBoard } from "../../state/board"
import { useAction } from "../../state/mutation"
import { Button, Field, Input, Modal, ModalFooter, resultError, resultValue, timeAgo, Toggle, useConfirm } from "../ui"

/**
 * Spaces on a host (HE-35): Linux desktops in Docker, each with Cua's spacesd and Cua Driver, and Claude Code and Codex
 * signed in with the configs it was given. Opening one shows its desktop in spacesd's viewer, relayed by the host's
 * server; a Space made with a direct link can also be opened straight from its container. The host's page mounts it.
 */
export function HostSpaces({ host }: { host: Host }) {
  const hostId = host.id
  const [fast, setFast] = useState(false)
  const result = useAtomValue(query("spaces.status", hostId, undefined, { refresh: fast ? "2 seconds" : "15 seconds" }))
  const st = resultValue(result) ?? null
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<{ readonly space: Space; readonly view: SpaceView } | null>(null)
  const [doing, setDoing] = useState<string | null>(null)
  const [action, run] = useAction()
  const confirm = useConfirm()
  const preparing = !!st?.spaces.some((s) => s.state === "preparing")
  if (preparing !== fast) setFast(preparing)
  if (!st) return null

  const act = <A, E>(what: string, change: Effect.Effect<A, E, AtomRegistry.AtomRegistry>) => {
    setDoing(what)
    return run(change)
  }
  const busy = action.busy ? doing : null
  const err = action.error ?? resultError(result)

  return (
    <section>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Spaces</h2>
        {st.docker.available && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={13} /> New Space
          </Button>
        )}
      </div>
      <p className="mb-3 text-[12.5px] text-muted">Linux desktops in Docker with Cua Driver, Claude Code and Codex, that you watch and use from the board.</p>
      {!st.docker.available ? (
        <div className="text-[12.5px] text-muted">Docker isn&apos;t available on this host{st.docker.reason ? `: ${st.docker.reason}` : "."}</div>
      ) : st.spaces.length === 0 ? (
        <div className="text-[12.5px] text-faint">No Spaces yet. The first one pulls {st.base_image} (about 1.4 GB) and builds on it.</div>
      ) : (
        <div className="divide-y divide-line rounded-xl border border-line">
          {st.spaces.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
              <span
                className={clsx(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  s.state === "running" ? "bg-emerald-400" : s.state === "preparing" ? "bg-amber-400" : s.state === "failed" ? "bg-red-400" : "bg-line-strong",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-fg">{s.name}</div>
                <div className={clsx("truncate", s.state === "failed" ? "text-red-300" : "text-muted")} title={s.detail ?? undefined}>
                  {s.state === "preparing" && <Loader2 size={11} className="mr-1 inline animate-spin" />}
                  {s.detail ?? s.state}
                  {s.state !== "preparing" && s.created_at ? ` · made ${timeAgo(s.created_at)}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {s.state === "running" && (
                  <Button
                    size="sm"
                    disabled={!!busy}
                    onClick={() =>
                      void act(`open:${s.id}`, mutate("spaces.view", hostId, { id: s.id })).then((exit) => {
                        if (Exit.isSuccess(exit)) setViewing({ space: s, view: exit.value })
                      })
                    }
                  >
                    {busy === `open:${s.id}` ? <Loader2 size={12} className="animate-spin" /> : <Monitor size={12} />} Open
                  </Button>
                )}
                {s.state === "running" && (s.claude_config_id || s.codex_config_id) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Copy the configs' sign-ins in again (they go in without refresh tokens, so they expire)"
                    disabled={!!busy}
                    onClick={() => void act(`sync:${s.id}`, mutate("spaces.syncAgents", hostId, { id: s.id }))}
                  >
                    {busy === `sync:${s.id}` ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Sign-ins
                  </Button>
                )}
                {(s.state === "stopped" || s.state === "failed") && (
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void act(`start:${s.id}`, mutate("spaces.start", hostId, { id: s.id }))}>
                    {busy === `start:${s.id}` ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Start
                  </Button>
                )}
                {s.state === "running" && (
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void act(`stop:${s.id}`, mutate("spaces.stop", hostId, { id: s.id }))}>
                    {busy === `stop:${s.id}` ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />} Stop
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  title="Delete"
                  aria-label={`Delete ${s.name}`}
                  disabled={!!busy}
                  onClick={() =>
                    confirm.ask({
                      title: `Delete ${s.name}`,
                      body: `Delete the Space “${s.name}” and everything in it? This can't be undone.`,
                      action: "Delete",
                      danger: true,
                      onConfirm: () => act(`delete:${s.id}`, mutate("spaces.delete", hostId, { id: s.id })),
                    })
                  }
                >
                  <Trash2 size={12} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {st.docker.available && (
        <div className="mt-3">
          <Toggle
            checked={st.agent_tools}
            onChange={(v) => void act("agent-tools", mutate("spaces.setAgentTools", hostId, { enabled: v }))}
            label={<span>Let agents on this host make and use Spaces (from their next run)</span>}
          />
        </div>
      )}
      {err && <div className="mt-2 rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{err}</div>}
      {creating && <NewSpaceModal hostId={hostId} onClose={() => setCreating(false)} />}
      {viewing && <SpaceViewer host={host} space={viewing.space} view={viewing.view} onClose={() => setViewing(null)} />}
      {confirm.dialog}
    </section>
  )
}

const selectClass = "h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] text-fg outline-none focus:border-accent/60"

function NewSpaceModal({ hostId, onClose }: { hostId: string; onClose: () => void }) {
  const configs = useBoard((s) => s.claudeConfigs).filter((c) => c.host_id === hostId)
  const claudes = configs.filter((c) => agentOf(c) === "claude")
  const codexes = configs.filter((c) => agentOf(c) === "codex")
  const [name, setName] = useState("")
  const [claude, setClaude] = useState(claudes[0]?.id ?? "")
  const [codex, setCodex] = useState(codexes[0]?.id ?? "")
  const [direct, setDirect] = useState(false)
  const [action, run] = useAction()
  const submit = () => {
    if (name.trim() === "" || action.busy) return
    void run(
      mutate("spaces.create", hostId, {
        name: name.trim(),
        claude_config_id: claude === "" ? null : AgentConfigId.make(claude),
        codex_config_id: codex === "" ? null : AgentConfigId.make(codex),
        direct,
      }),
    ).then((exit) => {
      if (Exit.isSuccess(exit)) onClose()
    })
  }
  return (
    <Modal title="New Space" onClose={onClose} onSubmit={submit}>
      <div className="space-y-4">
        <Field label="Name">
          <Input autoFocus value={name} placeholder="Browser tests" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Claude Code signed in as">
          <select className={selectClass} value={claude} onChange={(e) => setClaude(e.target.value)}>
            <option value="">Not signed in</option>
            {claudes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Codex signed in as">
          <select className={selectClass} value={codex} onChange={(e) => setCodex(e.target.value)}>
            <option value="">Not signed in</option>
            {codexes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Toggle checked={direct} onChange={setDirect} label={<span>Direct link: reachable on this host&apos;s network, not only through the board</span>} />
        {action.error && <div className="rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{action.error}</div>}
      </div>
      <ModalFooter className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={name.trim() === "" || action.busy} onClick={submit}>
          {action.busy && <Loader2 size={12} className="animate-spin" />} Create
        </Button>
      </ModalFooter>
    </Modal>
  )
}

/** Where the board reaches the host: this page's own server, a linked host's URL, else its machine's name. */
const hostAddress = (host: Host): { readonly origin: string | null; readonly hostname: string } => {
  if (host.local) return { origin: location.origin, hostname: location.hostname }
  const url = host.url ? URL.parse(host.url) : null
  return url ? { origin: url.origin, hostname: url.hostname } : { origin: null, hostname: host.name }
}

/** A Space's desktop: spacesd's viewer through the host's relay, in a frame when the host is this page's own server. */
function SpaceViewer({ host, space, view, onClose }: { host: Host; space: Space; view: SpaceView; onClose: () => void }) {
  const at = hostAddress(host)
  const relay = at.origin ? `${at.origin}${view.relay_path}${view.fragment}` : null
  const direct = view.direct_port ? `http://${at.hostname}:${view.direct_port}/viewer/${view.fragment}` : null
  return (
    <Modal
      title={
        <span className="flex items-center gap-3">
          {space.name}
          {relay && (
            <a className="flex items-center gap-1 text-[12px] font-normal text-accent hover:underline" href={relay} target="_blank" rel="noreferrer">
              <ExternalLink size={12} /> New window
            </a>
          )}
          {direct && (
            <a
              className="flex items-center gap-1 text-[12px] font-normal text-accent hover:underline"
              href={direct}
              target="_blank"
              rel="noreferrer"
              title="Straight from the Space's container, not through the board's server"
            >
              <ExternalLink size={12} /> Direct
            </a>
          )}
        </span>
      }
      onClose={onClose}
      width="max-w-[min(96vw,1600px)]"
    >
      {host.local && relay ? (
        <iframe
          title={`${space.name}'s desktop`}
          src={relay}
          className="h-[78vh] w-full rounded-md border border-line bg-black"
          allow="clipboard-read; clipboard-write; fullscreen; keyboard-map; microphone"
          // Not same-origin: the viewer (Cua's code, served through this host) can't reach the board's storage or token.
          sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-pointer-lock"
        />
      ) : (
        <div className="text-[12.5px] text-muted">This host&apos;s desktop opens in its own window: use New window{direct ? " or Direct" : ""} above.</div>
      )}
    </Modal>
  )
}
