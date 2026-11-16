import { useAtomValue } from "@effect/atom-react"
import { experimentsAtom } from "@huntaway/client"
import { EXPERIMENTS, type ExperimentId } from "@huntaway/contracts"
import { useState } from "react"
import { useBoard } from "../../state/board"
import { useMutation } from "../../state/mutation"
import { ToggleField } from "../ui"
import { PanelHeading } from "./parts"

/**
 * Settings → Experiments (docs/plan/09-frontend.md, Experiments): a switch for each feature still being tried, all off
 * at first. They are the page's own host's settings, so they hold in every browser and the desktop app, and settings
 * sync carries them to linked hosts.
 */
export function ExperimentsPanel() {
  const host = useBoard((s) => s.localHostId)
  const on = useAtomValue(experimentsAtom)
  const [{ error }, updateSettings] = useMutation("host.updateSettings")
  // The list being saved, shown until the host's settings have it.
  const [saving, setSaving] = useState<ReadonlyArray<ExperimentId> | null>(null)
  const shown = saving ?? on
  const set = (id: ExperimentId, value: boolean): void => {
    if (!host) return
    const rest = shown.filter((e) => e !== id)
    const next = value ? [...rest, id] : rest
    setSaving(next)
    void updateSettings(host, { patch: { experiments: next } }).then(() => setSaving(null))
  }
  return (
    <section>
      <PanelHeading
        title="Experiments"
        description="Features that are still being tried, each off until you switch it on, for the whole board. They may change or go away."
      />
      <div className="mt-5 space-y-4">
        {EXPERIMENTS.map((e) => (
          <ToggleField key={e.id} checked={shown.includes(e.id)} onChange={(v) => set(e.id, v)} label={e.name} help={e.description} />
        ))}
        {error && <p className="text-[12.5px] text-red-400">{error}</p>}
      </div>
    </section>
  )
}
