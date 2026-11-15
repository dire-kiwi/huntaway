import type { HostTask as Task } from "@huntaway/client"
import { clsx } from "clsx"
import { withKeys } from "../../../board/ConfirmTodos"
import { Section } from "./Section"

/** The agent's todo list (HA-316) in full, as its card shows the start of it, with how far through it is. Nothing without one. */
export function TodosSection({ task }: { task: Task }) {
  const todos = task.todos ?? []
  if (!todos.length) return null
  const done = todos.filter((t) => t.status === "completed").length
  return (
    <Section
      title="Todo list"
      right={
        <span className="text-[11.5px] text-faint">
          {done}/{todos.length}
        </span>
      }
    >
      <ul className="space-y-1 text-[12.5px] leading-snug" aria-label="Todo list">
        {withKeys(todos).map(({ item: t, key }) => (
          <li
            key={key}
            className={clsx("flex gap-1.5", t.status === "completed" ? "text-faint line-through" : t.status === "in_progress" ? "text-fg" : "text-muted")}
          >
            <span className="shrink-0">{t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : "○"}</span>
            <span className="min-w-0 break-words">{t.text}</span>
          </li>
        ))}
      </ul>
    </Section>
  )
}
