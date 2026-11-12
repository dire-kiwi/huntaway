import { documentsOnly, LABELS, taskLabels, type DocumentType, type HostTask as Task } from "@huntaway/client"
import { clsx } from "clsx"
import { useMutation } from "../../../../state/mutation"
import { isGroupTask } from "../../../boardHelpers"
import { LABEL_INFO } from "../../documentInfo"
import { Section } from "./Section"

// Where the agent writes each label's document (the old `api.document`'s `file`, a row per label) comes with task
// documents (6.2).

/** A task's labels, each a document its agent writes besides its other work, shown in a tab of the task: to add and
 *  take off (API 71). */
export function LabelsSection({ task }: { task: Task }) {
  const labels = taskLabels(task)
  const docsOnly = documentsOnly(task)
  const [{ error }, update] = useMutation("tasks.update")
  const err = error === null ? null : `Couldn't change the labels: ${error}`
  const toggle = (l: DocumentType) => {
    const next = labels.includes(l) ? labels.filter((x) => x !== l) : LABELS.filter((x) => x === l || labels.includes(x))
    void update(task.host_id, { id: task.id, patch: { labels: next } })
  }
  const where = isGroupTask(task) ? "group's repositories" : "project's repository"
  return (
    <Section title="Labels">
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1">
          {LABEL_INFO.map((i) => {
            const on = labels.includes(i.id)
            return (
              <button
                key={i.id}
                onClick={() => toggle(i.id)}
                aria-pressed={on}
                title={`${on ? "Take off" : "Add"} the ${i.label.toLowerCase()} label: ${i.hint}`}
                className={clsx(
                  "flex h-6 items-center gap-1 rounded-md border px-2 text-[12px]",
                  on ? "border-accent/50 bg-accent/10 text-accent" : "border-line text-muted hover:border-line-strong hover:text-fg",
                )}
              >
                {i.icon} {i.label}
              </button>
            )
          })}
        </div>
        <div className="text-[12.5px] text-muted">
          {docsOnly
            ? `Rather than changing code, its agent writes ${labels.length ? "a document for each label" : "a document for each label it's given"} in the task's own folder, reading the ${where}.`
            : labels.length
              ? "Besides its other work, its agent writes a document for each label in the task's own folder, shown in a tab here."
              : "A label has its agent write a document besides its other work: a plan to agree on first, an artifact or a diagram, each shown in a tab here."}{" "}
          {labels.length > 0 && "The board keeps a version from each turn."}
          {task.running && " A label changed while its agent works reaches it the next time it starts."}
        </div>
        {err && <div className="rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
      </div>
    </Section>
  )
}
