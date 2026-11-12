import { useAtomValue } from "@effect/atom-react"
import { automationsAtom, mutate, type HostProject as Project } from "@huntaway/client"
import type { Automation } from "@huntaway/contracts"
import { Plus } from "lucide-react"
import { useState } from "react"
import { useAction } from "../../state/mutation"
import { Button, useConfirm } from "../ui"
import { rejectFailure } from "./agentTools/parts"
import { AutomationEditor } from "./automations/AutomationEditor"
import { ProjectAutomationRow } from "./automations/AutomationRow"
import { TestDelivery } from "./automations/TestDelivery"

/** A project's automations: tasks created, or messages sent to a task, on a schedule or from a webhook. */
export function ProjectAutomations({ project }: { project: Project }) {
  const hostId = project.host_id
  // Read again as they change (the board's `automations_changed`).
  const { data, failed } = useAtomValue(automationsAtom({ host_id: hostId, project_id: project.id }))
  const list = data?.automations ?? null
  const tz = data?.time_zone ?? null
  // A switch's or a run's failure shows under the list until the next change, or a save in the editor; a delete's shows
  // in its dialog.
  const [changed, run] = useAction()
  const [, runConfirmed] = useAction()
  const [seen, setSeen] = useState<unknown>(undefined)
  const err = changed.failure !== undefined && changed.failure !== seen ? changed.error : null
  const [editing, setEditing] = useState<Automation | "new" | null>(null)
  const [testing, setTesting] = useState<Automation | null>(null)
  const confirm = useConfirm()
  return (
    <div className="space-y-3" data-testid="automations">
      <Button size="sm" onClick={() => setEditing("new")}>
        <Plus size={13} /> New automation
      </Button>
      {list && list.length > 0 && (
        <div className="divide-y divide-line/70 rounded-md border border-line/70">
          {list.map((a) => (
            <ProjectAutomationRow
              key={a.id}
              automation={a}
              project={project}
              tz={tz}
              onToggle={(enabled) => void run(mutate("automations.update", hostId, { id: a.id, patch: { enabled } }))}
              onEdit={() => setEditing(a)}
              onRun={() => (a.trigger.kind === "webhook" ? setTesting(a) : void run(mutate("automations.run", hostId, { id: a.id })))}
              onDelete={() =>
                confirm.ask({
                  title: `Delete automation ${a.name}`,
                  body: `Delete the automation "${a.name}"? Its run history goes with it.`,
                  action: "Delete automation",
                  danger: true,
                  onConfirm: () => runConfirmed(mutate("automations.delete", hostId, { id: a.id })).then(rejectFailure),
                })
              }
            />
          ))}
        </div>
      )}
      {list && !list.length && <div className="text-[12px] text-faint">No automations yet.</div>}
      {(err ?? failed) && <div className="text-xs text-red-400">{err ?? failed}</div>}
      {confirm.dialog}
      {editing && (
        <AutomationEditor
          owner={{ hostId, profileId: project.profile_id, project }}
          automation={editing === "new" ? null : editing}
          tz={tz}
          onSaved={() => setSeen(changed.failure)}
          onClose={() => setEditing(null)}
        />
      )}
      {testing && <TestDelivery hostId={hostId} automation={testing} onClose={() => setTesting(null)} />}
    </div>
  )
}
