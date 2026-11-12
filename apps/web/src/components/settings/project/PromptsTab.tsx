import { useAtomValue } from "@effect/atom-react"
import { AGENTS, LABELS, query, type DocumentType, type HostProject as Project } from "@huntaway/client"
import { Agent, type DefaultPrompts, type SystemPromptOptions } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Schema } from "effect"
import { useState } from "react"
import { resultError, resultValue, Textarea, Toggle } from "../../ui"
import type { ProjectForm, SetField } from "./ProjectSettings"

/** A prompt a project can have its own of. */
type PromptField = keyof DefaultPrompts

const isAgent = Schema.is(Agent)

/** The Prompts tab: the project's prompts and the system prompt its threads get. */
export function PromptsTab({ project, form, set }: { project: Project; form: ProjectForm; set: SetField }) {
  return (
    <>
      <ProjectPrompts project={form} onChange={set} />

      <SystemPromptPreview project={project} />
    </>
  )
}

const PROMPTS: { field: PromptField; label: string; hint: string }[] = [
  {
    field: "start_prompt",
    label: "In progress: starting a task",
    hint: "Sent to the task's agent when it starts, after the task's title and description (and before any message it's started with).",
  },
  {
    field: "review_prompt",
    label: "In review: reviewing its changes",
    hint: "What the reviewer looks for, when reviews are on. It comes after where the changes are; the board adds how to report the verdict.",
  },
  {
    field: "merge_prompt",
    label: "Ready for merge: merging it",
    hint: "How the agent merges. It comes after which branch to merge into which; the board adds asking you if it can't merge, and moving the task to Done.",
  },
]

/** The instructions in the prompts the board sends as a task moves across it: the host's default
 * until the project has its own. */
function ProjectPrompts({ project, onChange }: { project: ProjectForm; onChange: (field: PromptField, v: string | null) => void }) {
  const result = useAtomValue(query("host.defaultPrompts", project.host_id, undefined))
  const defaults = resultValue(result)
  const err = resultError(result)
  return (
    <div className="space-y-5">
      {err && <div className="text-xs text-red-400">Couldn&apos;t load the default prompts: {err}</div>}
      {defaults &&
        PROMPTS.map(({ field, label, hint }) => {
          const own = project[field]
          const custom = own != null
          return (
            <div key={field} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted">{label}</span>
                <span className={clsx("rounded px-1.5 text-[11px]", custom ? "bg-accent/15 text-accent" : "bg-line text-faint")}>
                  {custom ? "Custom" : "Default"}
                </span>
                {custom && (
                  <button type="button" className="ml-auto text-[12px] text-muted hover:text-fg" onClick={() => onChange(field, null)}>
                    Reset to default
                  </button>
                )}
              </div>
              <Textarea
                rows={4}
                className="text-[12.5px]"
                value={own ?? defaults[field]}
                // Back to the default text is the default, so later changes to it apply.
                onChange={(e) => onChange(field, e.target.value === defaults[field] ? null : e.target.value)}
              />
              <span className="block text-xs text-faint">{hint}</span>
            </div>
          )
        })}
    </div>
  )
}

const pickerClass = "h-7 rounded-md border border-line bg-panel px-1.5 text-[12.5px] text-fg outline-none"

/** What the agent of a new thread in the project is told on top of its agent's own system prompt, for the options a
 *  thread is made with. Read-only: it's the board's, from the project's saved settings. */
function SystemPromptPreview({ project }: { project: Project }) {
  const [type, setType] = useState<NonNullable<SystemPromptOptions["type"]>>("task")
  const [labels, setLabels] = useState<ReadonlyArray<DocumentType>>([])
  const [worktree, setWorktree] = useState<boolean | null>(null)
  const [runtime, setRuntime] = useState<Agent | null>(null)
  // Unset until it's switched, the thread's mode is the one it inherits (the project's, else the host's).
  const [plan, setPlan] = useState<boolean | null>(null)
  const worktrees = worktree ?? (project.use_worktrees && project.is_git)
  const options: SystemPromptOptions = {
    type,
    labels,
    ...(type === "task" ? { worktree: worktrees } : {}),
    ...(runtime ? { runtime } : {}),
    ...(plan === null ? {} : { permission_mode: plan ? "plan" : "default" }),
  }
  // Read again when the project or the host's default mode changes, as they go into it (invalidate.ts).
  const result = useAtomValue(query("projects.systemPrompt", project.host_id, { id: project.id, options }))
  const err = resultError(result)
  // The last preview stays while other options are read.
  const read = resultValue(result)
  const [preview, setPreview] = useState(read)
  if (read !== undefined && read !== preview) setPreview(read)
  const shownRuntime = runtime ?? preview?.runtime ?? "claude"
  return (
    <div className="space-y-2.5 border-t border-line pt-5">
      <div className="space-y-1">
        <span className="block text-xs font-medium text-muted">System prompt</span>
        <span className="block text-xs text-faint">
          What the board adds to the agent's own system prompt for a new thread in this project, with the options picked here and the project's saved settings.
          It's for the project's next task number, with a placeholder title and id. It isn't editable.
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <select
          className={pickerClass}
          title="Type"
          aria-label="Type"
          value={type}
          onChange={(e) => setType(e.target.value === "scratch" ? "scratch" : "task")}
        >
          <option value="task">Task</option>
          <option value="scratch">Scratch task</option>
        </select>
        <select
          className={pickerClass}
          title="Agent"
          aria-label="Agent"
          value={shownRuntime}
          onChange={(e) => {
            const v = e.target.value
            if (isAgent(v)) setRuntime(v)
          }}
        >
          {AGENTS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1" role="group" aria-label="Labels">
          {LABELS.map((l) => {
            const on = labels.includes(l)
            return (
              <button
                key={l}
                type="button"
                aria-pressed={on}
                onClick={() => setLabels(on ? labels.filter((x) => x !== l) : LABELS.filter((x) => x === l || labels.includes(x)))}
                className={clsx(
                  "rounded-md border px-2 py-0.5 text-[12px]",
                  on ? "border-accent/50 bg-accent/15 text-accent" : "border-line text-muted hover:text-fg",
                )}
              >
                {l}
              </button>
            )
          })}
        </div>
        {type === "task" && <Toggle checked={worktrees} onChange={setWorktree} label="Own worktree" />}
        {shownRuntime === "codex" && <Toggle checked={plan ?? preview?.permission_mode === "plan"} onChange={setPlan} label="Plan mode" />}
      </div>
      {err ? (
        <div className="text-xs text-red-400">Couldn&apos;t load the system prompt: {err}</div>
      ) : (
        <pre
          aria-label="System prompt"
          className={clsx(
            "max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-line bg-panel px-2.5 py-2 font-sans text-[12.5px] text-fg",
            !preview && "text-faint",
          )}
        >
          {preview?.text ?? "Loading…"}
        </pre>
      )}
    </div>
  )
}
