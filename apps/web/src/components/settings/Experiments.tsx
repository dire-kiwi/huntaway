import { useAtomValue } from "@effect/atom-react"
import { experimentsAtom } from "@huntaway/client"
import { EXPERIMENTS, type ExperimentId } from "@huntaway/contracts"
import { useBoard } from "../../state/board"
import { useMutation } from "../../state/mutation"
import { Toggle } from "../ui"

/**
 * Settings → Experiments (docs/plan/09-frontend.md, Experiments): a switch for each feature still being tried, all off
 * at first. They are the page's own host's settings, so they hold in every browser and the desktop app, and settings
 * sync carries them to linked hosts.
 */
export function ExperimentsPanel() {
  const host = useBoard((s) => s.localHostId)
  const on = useAtomValue(experimentsAtom)
  const [{ error }, updateSettings] = useMutation("host.updateSettings")
  const set = (id: ExperimentId, value: boolean): void => {
    if (!host) return
    const rest = on.filter((e) => e !== id)
    void updateSettings(host, { patch: { experiments: value ? [...rest, id] : rest } })
  }
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold">Experiments</h2>
      <div className="space-y-4 rounded-xl border border-line p-4 text-[12.5px] text-muted">
        <p>Features that are still being tried. They may change or go away. Each is off until you switch it on, for the whole board.</p>
        {EXPERIMENTS.map((e) => (
          <div key={e.id} className="space-y-1">
            <Toggle checked={on.includes(e.id)} onChange={(v) => set(e.id, v)} label={e.name} />
            <p className="pl-10.5">{e.description}</p>
          </div>
        ))}
        {error && <p className="text-red-400">{error}</p>}
      </div>
    </section>
  )
}
