import { Result } from "effect"
import { DocumentLabel, Effort, Invalid } from "@huntaway/contracts"
import type { Action, ActionInput, ActiveHours, ActiveHoursInput, Filter, Trigger, TriggerInput, Weekday } from "@huntaway/contracts"
import { MAX_TEXT_CHARS, validPath, wanted } from "./delivery.ts"
import { cronNext, isoOf, parseAt, parseCron, parseDailyTime, weekdayIndex } from "./schedule.ts"
import type { Zone } from "./schedule.ts"

// What an automation is and how what a request gives is checked and tidied (huntaway's automations.ts and
// automations/check.ts; docs/plan/inventory/06-integrations.md 2.3, 3.2): plain functions, with the old texts as the
// reasons of `Invalid`. What needs the database (a message's task, the agent config) is `Automations`'.

/** The shortest and longest intervals a schedule can have. */
export const MIN_INTERVAL_MINUTES = 5
export const MAX_INTERVAL_MINUTES = 60 * 24 * 31
/** A time-of-day run this late (the server was down or asleep) is skipped rather than run. */
export const LATE_GRACE = 10 * 60_000
/** How often the scheduler looks for runs that are due. */
export const TICK = "5 seconds"
/** The largest webhook body taken (a bigger one gets a 413). */
export const MAX_BODY = 1 << 20
/** Deliveries an automation takes a minute; more get a 429. */
export const RATE_PER_MINUTE = 60
/** Coalesced runs an automation can have waiting at once. */
export const MAX_PENDING = 20
export const MAX_COALESCE_SECONDS = 3600
/** How long a delivery's id is kept, so the same delivery sent again is dropped. */
export const DEDUPE_DAYS = 7
export const MAX_FILTERS = 16
/** Runs kept per automation: up to `KEEP_RUNS`, of those older than `DEDUPE_DAYS` only `KEEP_RECENT`; payloads for `KEEP_PAYLOADS`. */
export const KEEP_RUNS = 1000
export const KEEP_RECENT = 50
export const KEEP_PAYLOADS = 5

export const WEEKDAYS: ReadonlyArray<Weekday> = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

const bad = (field: string, reason: string) => Result.fail(new Invalid({ field, reason }))
const chars = (s: string) => Array.from(s).length
const bytes = (s: string) => new TextEncoder().encode(s).length
const pad = (n: number) => String(n).padStart(2, "0")
const hm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`

/** Rust's `{:?}` of a list of strings. */
const debugList = (l: ReadonlyArray<string>) => `[${l.map((x) => `"${x}"`).join(", ")}]`

/** Weekdays in order, each once; all seven is none (every day). */
export const checkWeekdays = (field: string, weekdays: ReadonlyArray<string>): Result.Result<ReadonlyArray<Weekday>, Invalid> => {
  const days = new Set<number>()
  for (const d of weekdays) {
    const w = weekdayIndex(d)
    if (w === null) return bad(field, `weekdays must be from ${debugList(WEEKDAYS)}`)
    days.add(w)
  }
  const sorted = [...days].toSorted((a, b) => a - b)
  return Result.succeed(sorted.length === 7 ? [] : sorted.flatMap((d) => WEEKDAYS.slice(d, d + 1)))
}

/** A trigger as it's stored: checked, and tidied (weekdays in order, a cron's spaces, an `at` in UTC). */
export const checkTrigger = (t: TriggerInput, now: number, zone: Zone): Result.Result<Trigger, Invalid> =>
  Result.gen(function* () {
    switch (t.kind) {
      case "interval":
        if (!(t.every_minutes >= MIN_INTERVAL_MINUTES && t.every_minutes <= MAX_INTERVAL_MINUTES)) {
          return yield* bad("trigger", `every_minutes must be from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES} (31 days)`)
        }
        return { kind: "interval", every_minutes: t.every_minutes }
      case "daily": {
        const at = parseDailyTime(t.time)
        if (at === null) return yield* bad("trigger", "time must be a time of day like 09:30")
        return { kind: "daily", time: hm(at), weekdays: yield* checkWeekdays("trigger", t.weekdays ?? []) }
      }
      case "cron": {
        const expr = t.expr
          .split(/\s+/u)
          .filter((x) => x !== "")
          .join(" ")
        const cron = parseCron(expr, zone)
        if (Result.isFailure(cron)) return yield* bad("trigger", cron.failure)
        if (cronNext(cron.success, zone, now) === null) return yield* bad("trigger", `the cron expression ${expr} never matches`)
        return { kind: "cron", expr }
      }
      case "at": {
        const when = parseAt(t.at, zone)
        if (when === null) return yield* bad("trigger", "at must be a time like 2026-11-05 09:30 (in the host's time zone) or 2026-11-04T20:30:00Z")
        return { kind: "at", at: isoOf(when) }
      }
      case "webhook": {
        const filters = t.filters ?? []
        const coalesceSeconds = t.coalesce_seconds ?? 0
        const coalesceKey = t.coalesce_key ?? ""
        if (filters.length > MAX_FILTERS) return yield* bad("trigger", `a webhook can have at most ${MAX_FILTERS} filters`)
        const out: Array<Filter> = []
        for (const f of filters) {
          const path = f.path.trim()
          const value = f.value ?? null
          if (!validPath(path)) {
            return yield* bad("trigger", `filter path "${f.path}" must name a value, like event, action, labels or body.issue.title`)
          }
          const needsValue = !(f.op === "exists" || f.op === "not_exists")
          if (needsValue && wanted({ op: f.op, value }).length === 0) return yield* bad("trigger", `the filter on ${path} needs a value`)
          out.push({ path, op: f.op, value })
        }
        if (coalesceSeconds < 0 || coalesceSeconds > MAX_COALESCE_SECONDS) {
          return yield* bad("trigger", `coalesce_seconds must be at most ${MAX_COALESCE_SECONDS}`)
        }
        if (bytes(coalesceKey) > 500) return yield* bad("trigger", "coalesce_key is too long")
        return { kind: "webhook", filters: out, coalesce_seconds: coalesceSeconds, coalesce_key: coalesceKey.trim() }
      }
      default:
        return yield* bad("trigger", "unknown trigger")
    }
  })

/** The hours a run may start in, as they're stored (none for any time). */
export const checkActiveHours = (v: ActiveHoursInput | null | undefined): Result.Result<ActiveHours | null, Invalid> =>
  Result.gen(function* () {
    if (v === null || v === undefined) return null
    const start = parseDailyTime(v.start)
    const end = parseDailyTime(v.end)
    if (start === null || end === null) return yield* bad("active_hours", "active_hours' start and end must be times of day like 08:00")
    if (start === end) return yield* bad("active_hours", "active_hours' start and end can't be the same (leave active_hours out for any time)")
    return { start: hm(start), end: hm(end), weekdays: yield* checkWeekdays("active_hours", v.weekdays ?? []) }
  })

/** A precheck command as it's stored (none for blank). */
export const checkPrecheck = (v: string | null | undefined): Result.Result<string | null, Invalid> => {
  if (v === null || v === undefined || v.trim() === "") return Result.succeed(null)
  if (chars(v) <= 4000) return Result.succeed(v.trim())
  return bad("precheck", "precheck must be a command of up to 4000 characters")
}

/** A budget a day as it's stored (none for no limit). */
export const checkBudget = (v: number | null | undefined): Result.Result<number | null, Invalid> => {
  if (v === null || v === undefined || v === 0) return Result.succeed(null)
  if (Number.isFinite(v) && v > 0 && v <= 10_000) return Result.succeed(v)
  return bad("budget_usd", "budget_usd must be a number of dollars from 0 (no limit) to 10000")
}

/** A name: 1 to 100 characters, trimmed. */
export const checkName = (v: string | null | undefined): Result.Result<string, Invalid> => {
  const n = v?.trim() ?? ""
  if (n !== "" && chars(n) <= 100) return Result.succeed(n)
  return bad("name", "name must be 1 to 100 characters")
}

/** A webhook's signing secret as it's stored: none for blank; as given otherwise (GitHub signs with it as it's given). */
export const checkSecret = (v: string | null | undefined): Result.Result<string | null, Invalid> => {
  if (v === null || v === undefined || v === "") return Result.succeed(null)
  if (v.trim() !== v) return bad("secret", "secret can't start or end with spaces or line breaks")
  if (bytes(v) <= 200) return Result.succeed(v)
  return bad("secret", "secret must be a string of up to 200 characters")
}

/** What an automation belongs to: a project, or (a routine) a profile. */
export type OwnerKind = "project" | "routine"

/** An action whose create_task's config is still to be picked against the project's (`Automations`). */
export type CheckedAction = Action

const blank = (v: string | null | undefined): string | null => {
  const t = v?.trim() ?? ""
  return t === "" ? null : t
}

/**
 * An action as it's stored, but for what needs the database (a message's task, a task's agent config): a routine can
 * only message the assistant, and a project's automation can't.
 */
export const checkAction = (owner: OwnerKind, a: ActionInput): Result.Result<CheckedAction, Invalid> =>
  Result.gen(function* () {
    if (owner === "routine") {
      if (a.kind !== "message_assistant") return yield* bad("action", "a routine (a profile's automation) can only message the assistant (message_assistant)")
      if (a.message.trim() === "") return yield* bad("action", "the message can't be blank")
      if (chars(a.message) > MAX_TEXT_CHARS) return yield* bad("action", "the message is too long")
      return { kind: "message_assistant", message: a.message, mode: a.mode ?? "fresh" }
    }
    if (a.kind === "message_assistant") return yield* bad("action", "message_assistant is for a profile's routines, not a project's automations")
    if (a.kind === "send_to_task") {
      if (a.message.trim() === "") return yield* bad("action", "the message can't be blank")
      if (chars(a.message) > MAX_TEXT_CHARS) return yield* bad("action", "the message is too long")
      return { kind: "send_to_task", task_id: a.task_id.trim(), message: a.message }
    }
    const description = a.description ?? ""
    if (a.title.trim() === "") return yield* bad("action", "the task's title can't be blank")
    if (chars(a.title) > 500 || chars(description) > MAX_TEXT_CHARS) return yield* bad("action", "the task's title or description is too long")
    let taskType = blank(a.task_type)
    // A label as its type, as before labels.
    const given = (a.labels ?? []).map((l) => l.trim())
    if (taskType !== null && DocumentLabel.literals.some((l) => l === taskType)) {
      given.push(taskType)
      taskType = null
    }
    const unknown = given.find((l) => !DocumentLabel.literals.some((x) => x === l))
    if (unknown !== undefined) {
      return yield* bad("action", `unknown label "${unknown}": labels are some of ${debugList(DocumentLabel.literals)}`)
    }
    const labels = DocumentLabel.literals.filter((l) => given.includes(l))
    if (taskType !== null && taskType !== "scratch") return yield* bad("action", `task_type must be one of ${debugList(["scratch"])}`)
    const effort = blank(a.effort)
    if (effort !== null && !Effort.literals.some((e) => e === effort)) return yield* bad("action", `effort must be one of ${debugList(Effort.literals)}`)
    const status = a.status ?? "todo"
    if (status !== "todo" && status !== "backlog") {
      return yield* bad("action", "status must be todo or backlog (a task that's started moves to in_progress)")
    }
    return {
      kind: "create_task",
      title: a.title.trim(),
      description,
      task_type: taskType === null ? null : "scratch",
      ...(labels.length > 0 ? { labels } : {}),
      claude_config_id: blank(a.claude_config_id),
      model: blank(a.model),
      effort,
      status,
      start: a.start ?? false,
    }
  })

/** A profile's routine, rather than a project's automation. */
export const isRoutine = (a: { readonly project_id: string | null }): boolean => a.project_id === null

/** Where deliveries go, on this host. */
export const hookPath = (a: { readonly id: string; readonly token: string }): string => `/api/hooks/${a.id}/${a.token}`
