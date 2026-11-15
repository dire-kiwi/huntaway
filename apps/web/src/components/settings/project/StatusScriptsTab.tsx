import type { Status } from "@huntaway/contracts"
import type { ProjectForm } from "./ProjectSettings"
import { Field, Textarea } from "../../ui"

/** The project's status script, and a script per column (blank is none). The variables they get are in the tab's help. */
export function ProjectStatusScripts({
  project,
  statuses,
  onChange,
}: {
  project: ProjectForm
  statuses: ReadonlyArray<{ readonly id: Status; readonly label: string }>
  onChange: <K extends "status_script" | "status_scripts">(k: K, v: ProjectForm[K]) => void
}) {
  const columns = project.status_scripts
  return (
    <div className="space-y-4">
      <Field label="Any column" help="Runs on every move, before the column's own script.">
        <Textarea
          rows={2}
          className="font-mono text-[12px]"
          placeholder={'notify-send "$IA_TASK_KEY moved to $IA_NEW_STATUS"'}
          value={project.status_script}
          onChange={(e) => onChange("status_script", e.target.value)}
        />
      </Field>
      {statuses.map((s) => (
        <Field key={s.id} label={s.label}>
          <Textarea
            rows={2}
            className="font-mono text-[12px]"
            placeholder={`Runs when a task moves to ${s.label}`}
            value={columns[s.id] ?? ""}
            onChange={(e) => onChange("status_scripts", { ...columns, [s.id]: e.target.value })}
          />
        </Field>
      ))}
    </div>
  )
}
