import { DocumentLabel } from "@huntaway/contracts"
import type { Action, ActionInput, Trigger, TriggerInput, Weekday } from "@huntaway/contracts"

// An automation's trigger and action as a row keeps them, read leniently (docs/plan/inventory/09-data-model.md: readers
// never throw on what an older build wrote): left-out fields take their defaults, and a create_task's `task_type` that
// is a label (from before labels) is a label.

const isWeekday = (d: string): d is Weekday => ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].includes(d)

export const storedTrigger = (t: TriggerInput): Trigger => {
  switch (t.kind) {
    case "daily":
      return { kind: "daily", time: t.time, weekdays: (t.weekdays ?? []).map((d) => d.toLowerCase()).filter(isWeekday) }
    case "webhook":
      return {
        kind: "webhook",
        filters: (t.filters ?? []).map((f) => ({ path: f.path, op: f.op, value: f.value ?? null })),
        coalesce_seconds: t.coalesce_seconds ?? 0,
        coalesce_key: t.coalesce_key ?? "",
      }
    case "interval":
    case "cron":
    case "at":
      return t
    default:
      return t
  }
}

export const storedAction = (a: ActionInput): Action => {
  switch (a.kind) {
    case "create_task": {
      const label = DocumentLabel.literals.find((l) => l === a.task_type)
      const labels = DocumentLabel.literals.filter((l) => l === label || (a.labels ?? []).includes(l))
      return {
        kind: "create_task",
        title: a.title,
        description: a.description ?? "",
        task_type: a.task_type === "scratch" ? "scratch" : null,
        ...(labels.length > 0 ? { labels } : {}),
        claude_config_id: a.claude_config_id ?? null,
        model: a.model ?? null,
        effort: a.effort ?? null,
        status: a.status === "backlog" ? "backlog" : "todo",
        start: a.start ?? false,
      }
    }
    case "send_to_task":
      return a
    case "message_assistant":
      return { kind: "message_assistant", message: a.message, mode: a.mode ?? "fresh" }
    default:
      return a
  }
}
