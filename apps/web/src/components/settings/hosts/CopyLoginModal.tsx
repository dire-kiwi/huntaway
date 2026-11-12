import { agentInfo, agentOf, type CallError, type HostAgentConfig as ClaudeConfig } from "@huntaway/client"
import { HostId } from "@huntaway/contracts"
import { Effect, Exit, Schema } from "effect"
import type { AtomRegistry } from "effect/reactivity"
import { useState } from "react"
import { useBoard } from "../../../state/board"
import { useAction } from "../../../state/mutation"
import { Button, errorText, Field, Input, Modal, ModalFooter, Toggle } from "../../ui"
import { hubMutate } from "./hub"

// Copying a config's login to another host (docs/plan/09-frontend.md "Step 1 as done for 6.11") is the hub's
// (`hub.hosts.copyConfig`, which exports the archive on one host with `configs.exportArchive` and imports it on the other
// with `configs.importArchive`); whoever mounts this (ClaudeConfigs and the host page's configs) gives the hosts it can
// go to. A profile's own config folder is gone with `claude_config_dir`, so only a config is copied.

/** A host a login can be copied to: one that runs agents, other than the config's own. */
export interface CopyTarget {
  readonly id: string
  readonly name: string
}

/** What copying asks for: the config (by name) on `from_host`, into `to_host`'s config of that name, or a new one at `config_dir`. */
export interface CopyRequest {
  readonly config: string
  readonly from_host: string
  readonly to_host: string
  /** For a host that has no config of that name: the folder of the one made there. */
  readonly config_dir?: string | undefined
  readonly overwrite: boolean
}

/** What a copy gives: the entries copied. */
interface Copied {
  readonly files: ReadonlyArray<string>
}

/** Copies a config's login through the hub (`hub.hosts.copyConfig`), giving the entries copied. */
const copyThroughHub = (r: CopyRequest) =>
  hubMutate("hub.hosts.copyConfig", {
    config: r.config,
    from_host: HostId.make(r.from_host),
    to_host: HostId.make(r.to_host),
    overwrite: r.overwrite,
    ...(r.config_dir === undefined ? {} : { config_dir: r.config_dir }),
  }).pipe(Effect.map((done): Copied => ({ files: done.files ?? [] })))

/** The copy given by whoever mounts this was refused: `reason` is what it said. */
class CopyRefused extends Schema.TaggedError<CopyRefused, { readonly brand: unique symbol }>()("CopyRefused", { reason: Schema.String }) {}

/** Copy a config's login to another host. */
export function CopyLoginModal({
  from,
  hosts,
  copy,
  onClose,
}: {
  from: ClaudeConfig
  /** The hosts it can be copied to. */
  hosts: ReadonlyArray<CopyTarget>
  /** Copies it, giving the entries copied; through the hub (`hub.hosts.copyConfig`) without it. */
  copy?: ((request: CopyRequest) => Promise<Copied>) | undefined
  onClose: () => void
}) {
  const codex = agentOf(from) === "codex"
  const baseDir = agentInfo(codex ? "codex" : "claude").dir
  const fromDir = from.config_dir || baseDir
  const configs = useBoard((s) => s.claudeConfigs)
  const [to, setTo] = useState(hosts[0]?.id ?? "")
  const existing = configs.find((c) => c.host_id === to && c.name === from.name)
  const existingDir = existing && (existing.config_dir || baseDir)
  const [dir, setDir] = useState(fromDir)
  const [overwrite, setOverwrite] = useState(false)
  const [{ busy, error: err }, run] = useAction()
  const [done, setDone] = useState<ReadonlyArray<string> | null>(null)
  const fromName = useBoard((s) => s.hosts.find((h) => h.id === from.host_id)?.name)
  const submit = () => {
    const request: CopyRequest = { config: from.name, from_host: from.host_id, to_host: to, config_dir: existing ? undefined : dir, overwrite }
    const copying: Effect.Effect<Copied, CopyRefused | CallError<"hub.hosts.copyConfig">, AtomRegistry.AtomRegistry> = copy
      ? Effect.tryPromise({ try: () => copy(request), catch: (e) => new CopyRefused({ reason: errorText(e) }) })
      : copyThroughHub(request)
    void run(copying).then((exit) => {
      if (Exit.isSuccess(exit)) setDone(exit.value.files)
    })
  }
  return (
    <Modal title={`Copy "${from.name}" login from ${fromName ?? "this host"}`} onClose={onClose}>
      <div className="space-y-4 text-[12.5px]">
        <p className="text-muted">
          {codex
            ? "Copies the Codex login (auth.json), config.toml, AGENTS.md, skills, rules and prompts from "
            : "Copies the Claude credentials, settings, skills, agents, commands and plugins from "}
          <span className="font-mono">{fromDir}</span>. Session history and caches stay behind.
        </p>
        {hosts.length === 0 ? (
          <p className="text-faint">No other host can take it.</p>
        ) : (
          <Field label="To host">
            <select
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
            >
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
              Into its existing "{from.name}" config at <span className="font-mono">{existingDir}</span>.
            </div>
            <Toggle checked={overwrite} onChange={setOverwrite} label="Replace an existing login there" />
          </div>
        ) : (
          to && (
            <Field label="Config directory on that host" hint={`A "${from.name}" config is created there with this directory.`}>
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
  )
}
