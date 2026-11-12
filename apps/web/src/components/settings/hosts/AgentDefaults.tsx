import { EFFORTS, MODEL_ALIASES, PERMISSION_MODES } from "@huntaway/client"
import { HostEffort, PermissionMode, type Host, type HostSettingsPatch } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Schema } from "effect"
import { useState } from "react"
import { useBoard } from "../../../state/board"
import { rpc } from "../../../state/rpc"
import { errorText, Field, Input } from "../../ui"

// Step 1 (docs/plan/09-frontend.md). The host's settings are the board's (`hostSettings`, kept by its
// `settings_changed` events), so nothing is read here. The old "Keep threads as items" switch is gone: every thread is
// items (docs/plan/14-dropped-and-open.md, "Moving threads onto items").

const selectClass = "h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
const isEffort = Schema.is(HostEffort)
const isMode = Schema.is(PermissionMode)

export function AgentDefaultsRow({ host, showName }: { host: Pick<Host, "id" | "name">; showName: boolean }) {
  const settings = useBoard((s) => s.hostSettings[host.id])
  // A specific model being typed, with none saved yet, stays a field.
  const [typing, setTyping] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const save = async (patch: HostSettingsPatch): Promise<void> => {
    setErr(null)
    try {
      await rpc(host.id, "host.updateSettings", { patch })
    } catch (e) {
      setErr(errorText(e))
    }
  }
  if (!settings) return null
  const custom = typing || (!!settings.default_model && !MODEL_ALIASES.includes(settings.default_model))
  return (
    <div className="rounded-xl border border-line px-4 py-3">
      {showName && <div className="mb-2 text-[12.5px] font-medium">{host.name}</div>}
      <div className={clsx("grid grid-cols-3 gap-3")}>
        <Field label="Model">
          {custom ? (
            <Input
              key={settings.default_model ?? ""}
              autoFocus={typing}
              defaultValue={settings.default_model ?? ""}
              placeholder="model id, e.g. claude-opus-5-5"
              className="font-mono text-[12px]"
              onBlur={(e) => {
                const v = e.target.value.trim()
                setTyping(false)
                if (v !== (settings.default_model ?? "")) void save({ default_model: v || null })
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur()
              }}
            />
          ) : (
            <select
              className={selectClass}
              value={settings.default_model ?? ""}
              onChange={(e) => {
                if (e.target.value === "__custom") setTyping(true)
                else void save({ default_model: e.target.value || null })
              }}
            >
              <option value="">Claude&apos;s default</option>
              {MODEL_ALIASES.map((m) => (
                <option key={m} value={m}>
                  {m.charAt(0).toUpperCase() + m.slice(1)} (latest)
                </option>
              ))}
              <option value="__custom">Specific model…</option>
            </select>
          )}
        </Field>
        <Field label="Effort">
          <select
            className={selectClass}
            value={settings.default_effort ?? ""}
            onChange={(e) => {
              const v = e.target.value
              void save({ default_effort: isEffort(v) ? v : null })
            }}
          >
            <option value="">Claude&apos;s default</option>
            {EFFORTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Permission mode">
          <select
            className={selectClass}
            value={settings.default_permission_mode ?? ""}
            title="For threads whose project doesn't pick a mode"
            onChange={(e) => {
              const v = e.target.value
              void save({ default_permission_mode: isMode(v) ? v : null })
            }}
          >
            <option value="">Ask (default)</option>
            {PERMISSION_MODES.filter((m) => m.id !== "default").map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
    </div>
  )
}
