import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { mutations, workflowsAtom, type HostProject as Project } from "@huntaway/client"
import { ProjectId, type Workflow, type WorkflowGraph } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Plus, Trash2, Workflow as WorkflowIcon } from "lucide-react"
import { useState } from "react"
import { useBoard } from "../../state/board"
import { Button, errorText, Toggle, useConfirm } from "../ui"
import { href } from "../../router"
import { navigate } from "../../state/route"
import { PRESETS, type Preset, type PresetSource } from "./workflows/presets"
import { graphText } from "./workflows/text"
import { WorkflowEditor } from "./workflows/WorkflowEditor"

// Step 1 (docs/plan/09-frontend.md): the project's workflows are `workflowsAtom`, read again on `workflows_changed`, so
// nothing here reloads them after a change. Every host has column nodes and keeps the Review tab's reviews out of
// projects that use workflows, so the old version checks and the graphs for hosts before column nodes are gone.

const GUIDE = href({ name: "guide", page: "workflows" })

/** The guide's Workflows page (the guide's own `GuideLink` comes with 6.12). */
function GuideLink() {
  return (
    <a
      href={GUIDE}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
        e.preventDefault()
        navigate(GUIDE)
      }}
      className="text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
    >
      Workflows
    </a>
  )
}

/** The project settings' Workflows tab: the project's workflows, each a graph of steps that runs on its tasks. */
export function ProjectWorkflows({ project }: { project: Project }) {
  const hostId = project.host_id
  const view = useAtomValue(workflowsAtom({ host_id: hostId, project_id: project.id }))
  const list = view.data
  const [err, setErr] = useState<string | null>(null)
  // `replacesBoard`: creating it (on) switches the project to use workflows instead of the board's default.
  const [editing, setEditing] = useState<{ workflow: Workflow | null; name: string; graph: WorkflowGraph; replacesBoard: boolean } | null>(null)
  // Who reviews and summarises its tasks: its own, or else its profile's.
  const profile = useBoard((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id))
  const updateProject = useAtomSet(mutations.projects.update, { mode: "promise" })
  const updateWorkflow = useAtomSet(mutations.workflows.update, { mode: "promise" })
  const deleteWorkflow = useAtomSet(mutations.workflows.delete, { mode: "promise" })
  const confirm = useConfirm()
  const settings: PresetSource = {
    auto_review: project.auto_review,
    auto_summary: project.auto_summary,
    review_rounds: project.review_rounds,
    reviewers: project.reviewers.length ? project.reviewers : (profile?.reviewers ?? []),
    summarizers: project.summarizers.length ? project.summarizers : (profile?.summarizers ?? []),
  }
  // The project, its workflows and the lists that show them change with the events that follow.
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(errorText(e))
    }
  }
  /** Whether the project's workflows take its tasks across the board, instead of the board's own handling. */
  const switchToWorkflows = (on: boolean) =>
    act(() => updateProject({ host: hostId, payload: { id: ProjectId.make(project.id), patch: { use_workflows: on } } }))
  const start = (p: Preset) =>
    setEditing({ workflow: null, name: p.name === "Blank" ? "" : (p.title ?? p.name), graph: p.graph(settings), replacesBoard: p.replacesBoard === true })
  const edit = (w: Workflow) => setEditing({ workflow: w, name: w.name, graph: w.graph, replacesBoard: false })
  return (
    <div className="space-y-3" data-testid="workflows">
      <p className="text-[12.5px] text-muted">
        A workflow is a task's way across the board. Each <i>column</i> step is a column: when a task enters it, its agent is sent the column's prompt (in In
        progress, that's what the agent starts with), and once that work is done the steps after it run. Those can be checks, agents that read the work in
        threads of their own (or process what the steps before them wrote, with a skill, in a fresh context), pull requests, messages to the task's agent, and
        the next column, which moves the task there. The prompt tells the agent what the board does when it's done. <i>Board's default</i> is what the board
        does without workflows (its prompts, and the Review tab's reviews and summaries), as one to change. <GuideLink /> in the guide explains each node, its
        inputs and outputs.
      </p>
      <div className="space-y-1.5 rounded-md border border-line/70 bg-raised/40 p-2.5" data-testid="use-workflows">
        <Toggle checked={project.use_workflows} onChange={(on) => void switchToWorkflows(on)} label="Use workflows instead of the board's default" />
        <p className="text-[11.5px] text-faint">
          {project.use_workflows
            ? "Tasks entering a column start the workflows that are on, which take them across the board. Columns no workflow has a step for keep the board's handling, but the Review tab's reviews and summaries don't run: workflows' steps review and summarise instead."
            : "The board handles this project's tasks itself: the start and merge prompts, and the Review tab's reviews, fix rounds and summaries. Workflows only run when you run one from a task. Turned on, the Review tab's reviews and summaries become a workflow (unless one that's on reviews in In review already), and Board's default starts a workflow that does what the board does, to change."}
        </p>
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
              <Toggle
                checked={w.enabled}
                onChange={(enabled) => void act(() => updateWorkflow({ host: hostId, payload: { id: w.id, patch: { enabled } } }))}
                label=""
              />
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
                    onConfirm: () => deleteWorkflow({ host: hostId, payload: { id: w.id } }),
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
