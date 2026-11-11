import { useAtomValue } from "@effect/atom-react"
import { automationsAtom, type HostProject as Project } from "@huntaway/client"
import type { Automation } from "@huntaway/contracts"
import { Plus } from "lucide-react"
import { useState } from "react"
import { useRpc } from "../../state/rpc"
import { Button, errorText, useConfirm } from "../ui"
import { AutomationEditor } from "./automations/AutomationEditor"
import { ProjectAutomationRow } from "./automations/AutomationRow"
import { TestDelivery } from "./automations/TestDelivery"

/** A project's automations: tasks created, or messages sent to a task, on a schedule or from a webhook. */
export function ProjectAutomations({ project }: { project: Project }) {
  const hostId = project.host_id
  const rpc = useRpc()
  // Read again as they change (the board's `automations_changed`).
  const { data, failed } = useAtomValue(automationsAtom({ host_id: hostId, project_id: project.id }))
  const list = data?.automations ?? null
  const tz = data?.time_zone ?? null
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<Automation | "new" | null>(null)
  const [testing, setTesting] = useState<Automation | null>(null)
  const confirm = useConfirm()
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(errorText(e))
    }
  }
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
              onToggle={(enabled) => void run(() => rpc(hostId, "automations.update", { id: a.id, patch: { enabled } }))}
              onEdit={() => setEditing(a)}
              onRun={() => (a.trigger.kind === "webhook" ? setTesting(a) : run(() => rpc(hostId, "automations.run", { id: a.id })))}
              onDelete={() =>
                confirm.ask({
                  title: `Delete automation ${a.name}`,
                  body: `Delete the automation "${a.name}"? Its run history goes with it.`,
                  action: "Delete automation",
                  danger: true,
                  onConfirm: () => rpc(hostId, "automations.delete", { id: a.id }),
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
          onSaved={() => setErr(null)}
          onClose={() => setEditing(null)}
        />
      )}
      {testing && <TestDelivery hostId={hostId} automation={testing} onClose={() => setTesting(null)} />}
    </div>
  )
}
