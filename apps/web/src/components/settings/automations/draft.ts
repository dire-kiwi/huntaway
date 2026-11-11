import { DocumentLabel, Weekday, type Automation, type Filter, type Action, type NewAutomation, type Trigger } from "@huntaway/contracts"
import { SIMPLE_FILTERS, valueText } from "./text"

export const WEEKDAYS: ReadonlyArray<Weekday> = Weekday.literals
export const LABELS: ReadonlyArray<DocumentLabel> = DocumentLabel.literals

export type Unit = "minutes" | "hours" | "days"
export const UNIT_MINUTES: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 }

/** A filter as the form edits it. */
export interface DraftFilter {
  /** The form's own key for it, for React. */
  key: number
  path: string
  op: Filter["op"]
  value: unknown
}

export interface Draft {
  name: string
  enabled: boolean
  when: Trigger["kind"]
  cron: string
  /** A `datetime-local` value, in this browser's time zone. */
  at: string
  every: number
  unit: Unit
  time: string
  weekdays: Array<Weekday>
  /** Comma-separated lists for the simple filters. */
  simple: Record<(typeof SIMPLE_FILTERS)[number], string>
  /** Any other filters. */
  filters: Array<DraftFilter>
  coalesce: number
  coalesceKey: string
  /** A new signing secret ("" leaves it as it is). */
  secret: string
  removeSecret: boolean
  does: Action["kind"]
  title: string
  description: string
  taskType: "scratch" | ""
  labels: Array<DocumentLabel>
  config: string
  model: string
  effort: string
  status: "todo" | "backlog"
  start: boolean
  taskId: string
  message: string
  mode: "fresh" | "thread"
  active: boolean
  activeStart: string
  activeEnd: string
  activeDays: Array<Weekday>
  precheck: string
  /** Dollars a day, or "" for no limit. */
  budget: string
}

/** A `datetime-local` value for a time, in this browser's time zone. */
const pad = (n: number) => String(n).padStart(2, "0")

export const localInput = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const listText = valueText
export const splitList = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)

export function draftOf(a: Automation | null, routine = false): Draft {
  const d: Draft = {
    name: "",
    enabled: true,
    when: "daily",
    cron: "0 8 * * mon-fri",
    at: localInput(new Date(Date.now() + 3600_000).toISOString()),
    every: 1,
    unit: "days",
    time: "09:00",
    weekdays: ["mon", "tue", "wed", "thu", "fri"],
    simple: { event: "", action: "", labels: "" },
    filters: [],
    coalesce: 0,
    coalesceKey: "",
    secret: "",
    removeSecret: false,
    does: "create_task",
    title: "",
    description: "",
    taskType: "",
    labels: [],
    config: "",
    model: "",
    effort: "",
    status: "todo",
    start: false,
    taskId: "",
    message: "",
    mode: "fresh",
    active: false,
    activeStart: "08:00",
    activeEnd: "22:00",
    activeDays: [],
    precheck: "",
    budget: "",
  }
  if (routine) d.does = "message_assistant"
  if (!a) return d
  d.name = a.name
  d.enabled = a.enabled
  const t = a.trigger
  d.when = t.kind
  if (t.kind === "interval") {
    d.unit = t.every_minutes % 1440 === 0 ? "days" : t.every_minutes % 60 === 0 ? "hours" : "minutes"
    d.every = t.every_minutes / UNIT_MINUTES[d.unit]
  } else if (t.kind === "daily") {
    d.time = t.time
    d.weekdays = t.weekdays.length ? [...t.weekdays] : [...WEEKDAYS]
  } else if (t.kind === "cron") {
    d.cron = t.expr
  } else if (t.kind === "at") {
    d.at = localInput(t.at)
  } else {
    for (const f of t.filters) {
      const simple = SIMPLE_FILTERS.find((p) => p === f.path)
      if (simple && f.op === "in" && !d.simple[simple]) d.simple[simple] = listText(f.value)
      else d.filters.push({ key: d.filters.length, path: f.path, op: f.op, value: f.value })
    }
    d.coalesce = t.coalesce_seconds
    d.coalesceKey = t.coalesce_key
  }
  const act = a.action
  d.does = act.kind
  if (act.kind === "create_task") {
    d.title = act.title
    d.description = act.description
    d.taskType = act.task_type === "scratch" ? "scratch" : ""
    d.labels = [...(act.labels ?? [])]
    d.config = act.claude_config_id ?? ""
    d.model = act.model ?? ""
    d.effort = act.effort ?? ""
    d.status = act.status
    d.start = act.start
  } else if (act.kind === "send_to_task") {
    d.taskId = act.task_id
    d.message = act.message
  } else {
    d.message = act.message
    d.mode = act.mode
  }
  if (a.active_hours) {
    d.active = true
    d.activeStart = a.active_hours.start
    d.activeEnd = a.active_hours.end
    d.activeDays = [...a.active_hours.weekdays]
  }
  d.precheck = a.precheck ?? ""
  d.budget = a.budget_usd ? String(a.budget_usd) : ""
  return d
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export function inputOf(d: Draft, existing: Automation | null): Mutable<NewAutomation> {
  const trigger: NewAutomation["trigger"] =
    d.when === "interval"
      ? { kind: "interval", every_minutes: Math.round(d.every * UNIT_MINUTES[d.unit]) }
      : d.when === "daily"
        ? { kind: "daily", time: d.time, weekdays: d.weekdays.length === 7 ? [] : WEEKDAYS.filter((w) => d.weekdays.includes(w)) }
        : d.when === "cron"
          ? { kind: "cron", expr: d.cron.trim() }
          : d.when === "at"
            ? // As it was if it's unchanged, to the second, so the server doesn't take it for a new time.
              {
                kind: "at",
                at: existing?.trigger.kind === "at" && localInput(existing.trigger.at) === d.at ? existing.trigger.at : new Date(d.at).toISOString(),
              }
            : {
                kind: "webhook",
                filters: [
                  ...SIMPLE_FILTERS.filter((p) => splitList(d.simple[p]).length).map((p) => ({ path: p, op: "in" as const, value: splitList(d.simple[p]) })),
                  ...d.filters.filter((f) => f.path.trim()).map((f) => ({ path: f.path, op: f.op, value: f.value })),
                ],
                coalesce_seconds: Math.max(0, Math.round(d.coalesce || 0)),
                coalesce_key: d.coalesceKey,
              }
  const action: NewAutomation["action"] =
    d.does === "create_task"
      ? {
          kind: "create_task",
          title: d.title,
          description: d.description,
          task_type: d.taskType || null,
          labels: d.labels,
          claude_config_id: d.config || null,
          model: d.model.trim() || null,
          effort: d.effort || null,
          status: d.status,
          start: d.start,
        }
      : d.does === "send_to_task"
        ? { kind: "send_to_task", task_id: d.taskId, message: d.message }
        : { kind: "message_assistant", message: d.message, mode: d.mode }
  const b: Mutable<NewAutomation> = {
    name: d.name,
    enabled: d.enabled,
    trigger,
    action,
    active_hours: d.active
      ? { start: d.activeStart, end: d.activeEnd, weekdays: d.activeDays.length === 7 ? [] : WEEKDAYS.filter((w) => d.activeDays.includes(w)) }
      : null,
    precheck: d.precheck.trim() || null,
    budget_usd: Number(d.budget) > 0 ? Number(d.budget) : null,
  }
  if (d.when === "webhook") {
    // As it's typed: GitHub signs with it as it is (the server refuses one with spaces around it).
    if (d.secret.trim()) b.secret = d.secret
    else if (d.removeSecret && existing?.has_secret) b.secret = ""
  }
  return b
}
