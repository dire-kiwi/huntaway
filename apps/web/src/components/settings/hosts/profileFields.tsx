import { useAtomValue } from "@effect/atom-react"
import { agentOf, canRunAgents, type HostAgentConfig as ClaudeConfig, query } from "@huntaway/client"
import { clsx } from "clsx"
import { profileNames, useShallow } from "../../boardHelpers"
import { useBoard } from "../../../state/board"
import { resultError, resultValue } from "../../ui"

// The fields of a profile's form (docs/plan/09-frontend.md). gh's accounts are 6.11's `profiles.githubAccounts`.

const label = (c: ClaudeConfig | undefined): string => (c ? `${c.name}${agentOf(c) === "codex" ? " (Codex)" : ""}` : "")

/** One of a profile's configs for its assistant or its threads, or "" for its default (the first). */
export function ThreadConfigSelect({ configs, value, onChange }: { configs: ReadonlyArray<ClaudeConfig>; value: string; onChange: (id: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
    >
      <option value="">Default ({label(configs[0])})</option>
      {configs.map((c) => (
        <option key={c.id} value={c.id}>
          {label(c)}
        </option>
      ))}
    </select>
  )
}

/** This board's host, or a linked host with assistants, for a profile's assistant to run on. */
export function AssistantHostSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const local = useBoard((s) => s.hosts.find((h) => h.local))
  const hosts = useBoard(useShallow((s) => s.hosts.filter((h) => !h.local && h.connected)))
  const picked = useBoard((s) => s.hosts.find((h) => h.id === value))
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
    >
      <option value="">This host{local ? ` (${local.name})` : ""}</option>
      {hosts.map((h) => (
        <option key={h.id} value={h.id}>
          {h.name}
        </option>
      ))}
      {value && !hosts.some((h) => h.id === value) && <option value={value}>{picked ? `${picked.name} (offline)` : "A host that's gone"}</option>}
    </select>
  )
}

/** A GitHub account gh is signed in to on a host, or "" for the default (`inherit`, given gh's active account there). */
export function GithubAccountSelect({
  hostId,
  value,
  onChange,
  inherit,
}: {
  hostId: string
  value: string
  onChange: (account: string) => void
  inherit: (active: string | undefined) => string
}) {
  // The accounts gh is signed in to on the host, or why they couldn't be listed.
  const result = useAtomValue(query("profiles.githubAccounts", hostId, undefined))
  const failed = resultError(result)
  const list = failed === null ? (resultValue(result) ?? null) : { accounts: [], error: failed }
  const accounts = list?.accounts ?? []
  // gh's active account on github.com, or the only host's.
  const active = accounts.find((a) => a.active && a.host === "github.com") ?? accounts.find((a) => a.active)
  const missing = value && list && !accounts.some((a) => a.account === value)
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
        {(missing || (value && !list)) && (
          <option value={value}>
            {value}
            {missing ? " (not signed in to gh)" : ""}
          </option>
        )}
      </select>
      {list?.error && <div className="text-[11.5px] text-faint">Couldn't list gh's accounts: {list.error}</div>}
      {list && !list.error && accounts.length === 0 && (
        <div className="text-[11.5px] text-faint">gh isn't signed in to any accounts on this host (gh auth login).</div>
      )}
    </div>
  )
}

/** Which other profiles' agents may use a profile's board: by name, or `*` for all. */
export function AccessPicker({ own, value, onChange }: { own: string; value: ReadonlyArray<string>; onChange: (names: string[]) => void }) {
  const profiles = useBoard((s) => s.profiles)
  const all = value.includes("*")
  // Names saved earlier stay listed even if no host has that profile now.
  const names = [...new Set([...profileNames(profiles), ...value])].filter((n) => n !== own && n !== "*")
  const toggle = (n: string, on: boolean): void => onChange(on ? [...value, n] : value.filter((x) => x !== n))
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
  )
}

/** Hosts that can take agent work. */
export function HostSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const hosts = useBoard(useShallow((s) => s.hosts.filter((h) => canRunAgents(h))))
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
    >
      {hosts.map((h) => (
        <option key={h.id} value={h.id}>
          {h.name}
          {h.local ? " (this host)" : ""}
        </option>
      ))}
    </select>
  )
}
