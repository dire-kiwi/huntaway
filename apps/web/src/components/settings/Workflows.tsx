import { useAtomValue } from "@effect/atom-react"
import { mutate, workflowsAtom, type HostProject as Project } from "@huntaway/client"
import { ProjectId, type Workflow, type WorkflowGraph } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Plus, Trash2, Workflow as WorkflowIcon } from "lucide-react"
import { useState } from "react"
import { useBoard } from "../../state/board"
import { useAction } from "../../state/mutation"
import { Button, Toggle, ToggleField, useConfirm } from "../ui"
import { rejectFailure } from "./agentTools/parts"
import { PRESETS, type Preset, type PresetSource } from "./workflows/presets"
import { graphText } from "./workflows/text"
import { WorkflowEditor } from "./workflows/WorkflowEditor"

// Step 1 (docs/plan/09-frontend.md): the project's workflows are `workflowsAtom`, read again on `workflows_changed`, so
// nothing here reloads them after a change. Every host has column nodes and keeps the Review tab's reviews out of
// projects that use workflows, so the old version checks and the graphs for hosts before column nodes are gone.

/** The project settings' Workflows tab: the project's workflows, each a graph of steps that runs on its tasks. */
export function ProjectWorkflows({ project }: { project: Project }) {
  const hostId = project.host_id
  const view = useAtomValue(workflowsAtom({ host_id: hostId, project_id: project.id }))
  const list = view.data
  // `replacesBoard`: creating it (on) switches the project to use workflows instead of the board's default.
  const [editing, setEditing] = useState<{ workflow: Workflow | null; name: string; graph: WorkflowGraph; replacesBoard: boolean } | null>(null)
  // Who reviews and summarises its tasks: its own, or else its profile's.
  const profile = useBoard((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id))
  // A switch's failure shows under the list until the next change; a delete's shows in its dialog.
  const [{ error: err }, act] = useAction()
  const [, runConfirmed] = useAction()
  const confirm = useConfirm()
  const settings: PresetSource = {
    auto_review: project.auto_review,
    auto_summary: project.auto_summary,
    review_rounds: project.review_rounds,
    reviewers: project.reviewers.length ? project.reviewers : (profile?.reviewers ?? []),
    summarizers: project.summarizers.length ? project.summarizers : (profile?.summarizers ?? []),
  }
  // The project, its workflows and the lists that show them change with the events that follow.
  /** Whether the project's workflows take its tasks across the board, instead of the board's own handling. */
  const switchToWorkflows = (on: boolean) => act(mutate("projects.update", hostId, { id: ProjectId.make(project.id), patch: { use_workflows: on } }))
  const start = (p: Preset) =>
    setEditing({ workflow: null, name: p.name === "Blank" ? "" : (p.title ?? p.name), graph: p.graph(settings), replacesBoard: p.replacesBoard === true })
  const edit = (w: Workflow) => setEditing({ workflow: w, name: w.name, graph: w.graph, replacesBoard: false })
  return (
    <div className="space-y-3" data-testid="workflows">
      {/* What a workflow is, is in the tab's help (project/ProjectSettings.tsx). */}
      <div className="rounded-md border border-line/70 bg-raised/40 p-2.5" data-testid="use-workflows">
        <ToggleField
          checked={project.use_workflows}
          onChange={(on) => void switchToWorkflows(on)}
          label="Use workflows instead of the board's default"
          help={
            <>
              <span className="block">
                <b className="font-medium text-fg">Off:</b> the board handles this project&apos;s tasks itself (the start and merge prompts, and the Review
                tab&apos;s reviews, fix rounds and summaries). Workflows only run when you run one from a task.
              </span>
              <span className="block">
                <b className="font-medium text-fg">On:</b> tasks entering a column start the workflows that are on, which take them across the board. Columns no
                workflow has a step for keep the board&apos;s handling, but the Review tab&apos;s reviews and summaries become a workflow (unless one
                that&apos;s on reviews in In review already).
              </span>
            </>
          }
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <Button key={p.name} size="sm" title={p.hint} onClick={() => start(p)}>
            <Plus size={13} /> {p.name === "Blank" ? "New workflow" : p.name}
          </Button>
        ))}
      </div>
      {list && list.length > 0 && (
        <div className="divide-y divide-line/70 rounded-md border border-line/70">
          {list.map((w) => (
            <div key={w.id} className="flex items-center gap-3 px-3 py-2">
              <Toggle checked={w.enabled} onChange={(enabled) => void act(mutate("workflows.update", hostId, { id: w.id, patch: { enabled } }))} label="" />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => edit(w)}>
                <div className={clsx("flex items-center gap-1.5 text-[13px]", !w.enabled && "text-faint")}>
                  <WorkflowIcon size={13} className="shrink-0 text-muted" />
                  <span className="truncate font-medium">{w.name}</span>
                </div>
                <div className="truncate text-[11.5px] text-faint">{graphText(w.graph)}</div>
              </button>
              <Button size="sm" variant="ghost" onClick={() => edit(w)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="Delete"
                onClick={() =>
                  confirm.ask({
                    title: `Delete workflow ${w.name}`,
                    body: `Delete the workflow "${w.name}"? Its runs stop, and their output goes from the tasks' tabs.`,
                    action: "Delete workflow",
                    danger: true,
                    onConfirm: () => runConfirmed(mutate("workflows.delete", hostId, { id: w.id })).then(rejectFailure),
                  })
                }
              >
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
        </div>
      )}
      {list && !list.length && <div className="text-[12px] text-faint">No workflows yet.</div>}
      {view.failed && <div className="text-xs text-red-400">Couldn't read the workflows: {view.failed}.</div>}
      {err && <div className="text-xs text-red-400">{err}</div>}
      {confirm.dialog}
      {editing && (
        <WorkflowEditor
          project={project}
          workflow={editing.workflow}
          initialName={editing.name}
          initialGraph={editing.graph}
          onSaved={(enabled) => {
            if (editing.replacesBoard && !editing.workflow && enabled && !project.use_workflows) void switchToWorkflows(true)
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
