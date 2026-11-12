import { Exit } from "effect"
import { mutate, type HostProject as Project } from "@huntaway/client"
import { ProjectId, type Workflow, type WorkflowGraph } from "@huntaway/contracts"
import { useState } from "react"
import { exitError, useAction } from "../../../state/mutation"
import { toJson, useConfirm } from "../../ui"

/** The workflow's name and whether it's on, saving it, and closing the editor (asking first when there are changes). */
export function useSave({
  project,
  workflow,
  initialName,
  initialGraph,
  graph,
  setErr,
  onSaved,
  onClose,
}: {
  project: Project
  workflow: Workflow | null
  initialName: string
  initialGraph: WorkflowGraph
  graph: WorkflowGraph
  setErr: (err: string | null) => void
  /** With whether the saved workflow is on. */
  onSaved: (enabled: boolean) => void
  onClose: () => void
}) {
  const hostId = project.host_id
  const [name, setName] = useState(initialName)
  const [enabled, setEnabled] = useState(workflow?.enabled ?? true)
  const [{ busy }, run] = useAction()
  const confirm = useConfirm()
  const dirty = name !== initialName || toJson(graph) !== toJson(initialGraph) || enabled !== (workflow?.enabled ?? true)

  // The list follows with the event the change makes.
  const save = () => {
    setErr(null)
    if (!name.trim()) return setErr("Give it a name.")
    const change = workflow
      ? mutate("workflows.update", hostId, { id: workflow.id, patch: { name: name.trim(), graph, enabled } })
      : mutate("workflows.create", hostId, { workflow: { project_id: ProjectId.make(project.id), name: name.trim(), graph, enabled } })
    void run(change).then((exit) => {
      if (!Exit.isSuccess(exit)) return setErr(exitError(exit))
      onSaved(enabled)
      onClose()
    })
    return undefined
  }
  const close = () =>
    dirty
      ? confirm.ask({
          title: "Discard changes",
          body: "Close the workflow without saving your changes?",
          action: "Discard",
          danger: true,
          onConfirm: () => onClose(),
        })
      : onClose()
  return { name, setName, enabled, setEnabled, busy, confirm, save, close }
}
