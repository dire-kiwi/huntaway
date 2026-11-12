import { useAtomValue } from "@effect/atom-react"
import { mutate, query } from "@huntaway/client"
import type { Host, SyncEntry } from "@huntaway/contracts"
import { Effect } from "effect"
import { Atom, type AtomRegistry } from "effect/reactivity"
import { useBoard } from "../../../state/board"
import { useAction } from "../../../state/mutation"
import { Button, localeString, resultError, resultValue, toJson, Toggle } from "../../ui"

// A host's settings sync (docs/plan/09-frontend.md), over `settingsSync.get` and `settingsSync.resolve`, switched with
// the host's `settings_sync` setting (`host.updateSettings`).

/** A synced setting's name as the user knows it: `profile/work/limit_wait` is "work: limit wait". */
export function syncLabel(name: string): string {
  const parts = name.split("/")
  const words = (parts.at(-1) ?? "").replaceAll("_", " ")
  if (parts[0] === "profile" && parts.length === 3) {
    let profile = parts[1] ?? ""
    try {
      profile = decodeURIComponent(profile)
    } catch {
      // Shown as it is.
    }
    return `${profile}: ${words}`
  }
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A synced setting's value, short enough for a line. */
export function syncValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "not set"
  if (v === true) return "on"
  if (v === false) return "off"
  let text = typeof v === "string" ? v : toJson(v)
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) text = v.length ? v.join(", ") : "none"
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

/**
 * Whether a host keeps its settings the same as the board's other hosts (capability `settings_sync`), and the values
 * that were overwritten because two hosts changed a setting while apart, each of which can be used instead.
 */
export function SettingsSyncRow({ host }: { host: Host }) {
  // Read again after a change here, and when the host says its settings changed, which a sync that changed its entries
  // does too (invalidate.ts).
  const result = useAtomValue(query("settingsSync.get", host.id, undefined))
  const [action, run] = useAction()
  const busy = action.busy
  const err = action.error ?? resultError(result)
  const hosts = useBoard((s) => s.hosts)
  /** Runs a change, then waits for the status read again after it, as what it shows. */
  const change = <A, E>(effect: Effect.Effect<A, E, AtomRegistry.AtomRegistry>) =>
    void run(Effect.andThen(effect, Atom.getResult(query("settingsSync.get", host.id, undefined), { suspendOnWaiting: true }).pipe(Effect.ignore)))
  const sync = resultValue(result)
  if (!sync) return err ? <div className="text-xs text-red-400">{err}</div> : null
  const hostName = (id: string) => hosts.find((h) => h.id === id)?.name ?? "another host"
  const lost = sync.entries.filter((e) => e.lost.length)
  const resolve = (e: SyncEntry, value?: unknown) =>
    change(mutate("settingsSync.resolve", host.id, value === undefined ? { name: e.name } : { name: e.name, value }))
  return (
    <div className="rounded-xl border border-line px-4 py-3">
      <Toggle
        checked={sync.enabled}
        onChange={(on) => change(mutate("host.updateSettings", host.id, { patch: { settings_sync: on } }))}
        label="Sync this host's settings"
      />
      <p className="mt-1 text-[12px] text-faint">
        {sync.enabled
          ? "A setting changed here goes to the other hosts, and theirs come here. If two hosts change the same setting while one is disconnected, the later change wins and the other value is listed below."
          : "Off: this host keeps its own settings. When it's turned on, it takes the values of the hosts already syncing where they differ, and its own are listed here to use instead. Turn it on first on the host whose settings the others should take."}
      </p>
      {sync.enabled && lost.length > 0 && (
        <div className="mt-3 space-y-2" data-testid="sync-lost">
          <div className="text-[12.5px] font-medium">Overwritten values</div>
          {lost.map((e) => (
            <div key={e.name} className="rounded-lg border border-line px-3 py-2 text-[12.5px]">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="font-medium">{syncLabel(e.name)}</span>
                  <span className="text-muted">
                    {" "}
                    is <span className="font-mono text-[12px] text-fg">{syncValue(e.value)}</span>, set on {hostName(e.changed_by)}
                  </span>
                </div>
                <Button disabled={busy} onClick={() => resolve(e)} title="Keep the value it has, and drop the others">
                  Keep
                </Button>
              </div>
              {e.lost.map((l) => (
                <div key={`${l.by} ${l.at}`} className="mt-1.5 flex items-center justify-between gap-3 text-muted">
                  <div className="min-w-0 truncate" title={typeof l.value === "string" ? l.value : toJson(l.value)}>
                    {hostName(l.by)} had <span className="font-mono text-[12px] text-fg">{syncValue(l.value)}</span>
                    {l.at ? ` (${localeString(l.at)})` : " (from before it synced)"}
                  </div>
                  <Button disabled={busy} onClick={() => resolve(e, l.value)}>
                    Use this
                  </Button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
    </div>
  )
}
