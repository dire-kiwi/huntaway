import { Schema } from "effect"
import { AutomationId, ProfileId, ProjectId, TaskId } from "./ids.ts"
import { DocumentLabel, Status } from "./task.ts"
import { Timestamp } from "./time.ts"

// A project's automations and a profile's routines (huntaway's wire/automations.ts; docs/plan/inventory/06-integrations.md
// 2.3, 3.2): what starts one, what it does, and its runs, as the board shows them. An automation's webhook token and
// secret, and a run's coalescing key and payload, are never sent.

/** A day of the week, as a schedule names it. */
export const Weekday = Schema.Literals(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])
export type Weekday = typeof Weekday.Type

export const FilterOp = Schema.Literals(["equals", "not_equals", "starts_with", "contains", "in", "not_in", "exists", "not_exists"])
export type FilterOp = typeof FilterOp.Type

/**
 * A condition on a webhook delivery. `path` names a value as a template does (`event`, `action`, `labels`,
 * `body.issue.user.login`…); `value` is a string, or for `in` and `not_in` a list (or a comma-separated string), kept
 * as it was given; null when there's none.
 */
export const Filter = Schema.Struct({ path: Schema.String, op: FilterOp, value: Schema.Unknown })
export type Filter = typeof Filter.Type

/**
 * What starts an automation. `interval`: every `every_minutes`, from when it's turned on (or its schedule changes).
 * `daily`: at `time` (`HH:MM`, in the host's time zone) on `weekdays` (none is every day). `cron`: when a cron
 * expression (`minute hour day-of-month month day-of-week`, in the host's time zone) matches. `at`: once (kept as UTC
 * RFC 3339), after which it turns itself off. `webhook`: each delivery to its URL that passes its `filters`;
 * deliveries within `coalesce_seconds` of the first make one run (0: each runs by itself), and only those whose
 * `coalesce_key` (a template) is the same go together.
 */
export const Trigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("interval"), every_minutes: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("daily"), time: Schema.String, weekdays: Schema.Array(Weekday) }),
  Schema.Struct({ kind: Schema.Literal("cron"), expr: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("at"), at: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("webhook"), filters: Schema.Array(Filter), coalesce_seconds: Schema.Int, coalesce_key: Schema.String }),
])
export type Trigger = typeof Trigger.Type

/** Where a routine's message goes: a fresh thread under the assistant (its last message is reported), or the assistant's own. */
export const AssistantMode = Schema.Literals(["fresh", "thread"])
export type AssistantMode = typeof AssistantMode.Type

/**
 * What an automation does. `create_task`: a task in the automation's project from these templates and settings
 * (`start` starts its agent). `send_to_task`: a message to a task of the automation's project. `message_assistant`: a
 * routine's message to its profile's assistant.
 */
export const Action = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create_task"),
    title: Schema.String,
    description: Schema.String,
    task_type: Schema.NullOr(Schema.Literal("scratch")),
    /** Left out when empty. */
    labels: Schema.optionalKey(Schema.Array(DocumentLabel)),
    claude_config_id: Schema.NullOr(Schema.String),
    model: Schema.NullOr(Schema.String),
    effort: Schema.NullOr(Schema.String),
    status: Schema.Literals(["todo", "backlog"]),
    start: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("send_to_task"), task_id: Schema.String, message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("message_assistant"), message: Schema.String, mode: AssistantMode }),
])
export type Action = typeof Action.Type

/** The hours a scheduled run may start in (`end` may be past midnight), on `weekdays` (none is every day), in the host's time zone. */
export const ActiveHours = Schema.Struct({ start: Schema.String, end: Schema.String, weekdays: Schema.Array(Weekday) })
export type ActiveHours = typeof ActiveHours.Type

// ---- what a request gives: the same, with what can be left out left out, and checked and tidied by the server ----

const FilterInput = Schema.Struct({ path: Schema.String, op: FilterOp, value: Schema.optionalKey(Schema.Unknown) })

/** A trigger as a request gives it: weekdays in any case and order, a webhook's settings left out for their defaults. */
export const TriggerInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("interval"), every_minutes: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("daily"), time: Schema.String, weekdays: Schema.optionalKey(Schema.Array(Schema.String)) }),
  Schema.Struct({ kind: Schema.Literal("cron"), expr: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("at"), at: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("webhook"),
    filters: Schema.optionalKey(Schema.Array(FilterInput)),
    coalesce_seconds: Schema.optionalKey(Schema.Int),
    coalesce_key: Schema.optionalKey(Schema.String),
  }),
])
export type TriggerInput = typeof TriggerInput.Type

/** An action as a request gives it: a create_task's settings left out for their defaults, a message's mode for `fresh`. */
export const ActionInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create_task"),
    title: Schema.String,
    description: Schema.optionalKey(Schema.String),
    /** `scratch`, null for a code task, or (as before labels) a label. */
    task_type: Schema.optionalKey(Schema.NullOr(Schema.String)),
    labels: Schema.optionalKey(Schema.Array(Schema.String)),
    claude_config_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
    model: Schema.optionalKey(Schema.NullOr(Schema.String)),
    effort: Schema.optionalKey(Schema.NullOr(Schema.String)),
    status: Schema.optionalKey(Schema.String),
    start: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("send_to_task"), task_id: Schema.String, message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("message_assistant"), message: Schema.String, mode: Schema.optionalKey(AssistantMode) }),
])
export type ActionInput = typeof ActionInput.Type

export const ActiveHoursInput = Schema.Struct({ start: Schema.String, end: Schema.String, weekdays: Schema.optionalKey(Schema.Array(Schema.String)) })
export type ActiveHoursInput = typeof ActiveHoursInput.Type

/** What `automations.create` takes (the old `POST /projects/{id}/automations` and `/profiles/{id}/automations`). */
export const NewAutomation = Schema.Struct({
  name: Schema.String,
  trigger: TriggerInput,
  action: ActionInput,
  /** Default true. */
  enabled: Schema.optionalKey(Schema.Boolean),
  /** A webhook's signing secret; blank is none. */
  secret: Schema.optionalKey(Schema.NullOr(Schema.String)),
  active_hours: Schema.optionalKey(Schema.NullOr(ActiveHoursInput)),
  precheck: Schema.optionalKey(Schema.NullOr(Schema.String)),
  budget_usd: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
})
export interface NewAutomation extends Schema.Schema.Type<typeof NewAutomation> {}

/**
 * What `automations.update` takes (the old `PATCH /automations/{id}`): what's left out stays. `secret` blank clears it;
 * `rotate_token` gives the webhook a new URL (the old one stops working); null clears active hours, precheck and budget.
 */
export const AutomationPatch = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  enabled: Schema.optionalKey(Schema.Boolean),
  trigger: Schema.optionalKey(TriggerInput),
  action: Schema.optionalKey(ActionInput),
  secret: Schema.optionalKey(Schema.NullOr(Schema.String)),
  rotate_token: Schema.optionalKey(Schema.Boolean),
  active_hours: Schema.optionalKey(Schema.NullOr(ActiveHoursInput)),
  precheck: Schema.optionalKey(Schema.NullOr(Schema.String)),
  budget_usd: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
})
export interface AutomationPatch extends Schema.Schema.Type<typeof AutomationPatch> {}

// ---- what the board sends ----

/** What made a run: its schedule, a webhook delivery, or a run by hand (a test delivery too). */
export const RunSource = Schema.Literals(["schedule", "webhook", "manual"])
export type RunSource = typeof RunSource.Type

/**
 * `pending` (waiting to coalesce), `coalesced` (into `batch_id`), `running`, `ok`, `failed`, `skipped` (missed, off, too
 * many waiting, outside its active hours, its precheck found nothing, over budget, or its last run is still going),
 * `filtered` (or an ignored ping), `duplicate` (`batch_id`: the earlier run) or `rejected` (a bad signature).
 */
export const AutomationRunStatus = Schema.Literals(["pending", "coalesced", "running", "ok", "failed", "skipped", "filtered", "duplicate", "rejected"])
export type AutomationRunStatus = typeof AutomationRunStatus.Type

/** How a routine's run in a thread of its own ended. */
export const RunOutcome = Schema.Literals(["quiet", "reported", "asked", "failed", "stopped"])
export type RunOutcome = typeof RunOutcome.Type

/** A run of an automation, or a webhook delivery that didn't make one. */
export const AutomationRun = Schema.Struct({
  id: Schema.String,
  automation_id: AutomationId,
  source: RunSource,
  status: AutomationRunStatus,
  detail: Schema.NullOr(Schema.String),
  /** For a routine's run in a fresh thread, once its agent has stopped. */
  outcome: Schema.NullOr(RunOutcome),
  /** What its agent's runs cost: once they ended, or so far while its thread (or the run that took its message) works. */
  cost_usd: Schema.NullOr(Schema.Finite),
  /** The task it created or messaged. */
  task_id: Schema.NullOr(TaskId),
  delivery_id: Schema.NullOr(Schema.String),
  /** A delivery's event and action, e.g. `issues.opened`. */
  event: Schema.NullOr(Schema.String),
  /** Deliveries in it (coalesced ones count). */
  count: Schema.Int,
  batch_id: Schema.NullOr(Schema.String),
  /** When it was due: a scheduled run's time, or when a coalesced one runs. */
  due_at: Schema.NullOr(Schema.String),
  created_at: Timestamp,
  finished_at: Schema.NullOr(Schema.String),
  /** The task it created or messaged, if it's still there. */
  task: Schema.optionalKey(Schema.Struct({ key: Schema.String, title: Schema.String, status: Status, running: Schema.Boolean })),
})
export interface AutomationRun extends Schema.Schema.Type<typeof AutomationRun> {}

/** A project's automation, or a profile's routine (no project). */
export const Automation = Schema.Struct({
  id: AutomationId,
  profile_id: ProfileId,
  /** null for a profile's routine. */
  project_id: Schema.NullOr(ProjectId),
  name: Schema.String,
  enabled: Schema.Boolean,
  trigger: Trigger,
  action: Action,
  active_hours: Schema.NullOr(ActiveHours),
  /** A bash command run before each run: exit 1 skips the run, and what it prints is `{{precheck}}`. */
  precheck: Schema.NullOr(Schema.String),
  /** What its runs may cost a day (in the host's time zone). */
  budget_usd: Schema.NullOr(Schema.Finite),
  /** When its schedule next runs (UTC); null for a webhook, or while it's off. */
  next_run_at: Schema.NullOr(Schema.String),
  last_run_at: Schema.NullOr(Schema.String),
  created_at: Timestamp,
  updated_at: Timestamp,
  /** What its runs kept cost, and today's in the host's time zone. */
  cost_usd: Schema.Finite,
  cost_today_usd: Schema.Finite,
  /** Only a webhook's: its path on its host (`/api/hooks/<id>/<token>`). */
  hook_path: Schema.optionalKey(Schema.String),
  /** Only a webhook's: whether it checks deliveries' signatures (the secret itself is never sent). */
  has_secret: Schema.optionalKey(Schema.Boolean),
  last_run: Schema.NullOr(AutomationRun),
})
export interface Automation extends Schema.Schema.Type<typeof Automation> {}

/** The host's time zone, which an automation's times of day are in: its name where the system says, and its offset now (`+13:00`). */
export const HostTimeZone = Schema.Struct({ name: Schema.NullOr(Schema.String), offset: Schema.String })
export interface HostTimeZone extends Schema.Schema.Type<typeof HostTimeZone> {}

/** A project's automations or a profile's routines, with the time zone their times are in. */
export const AutomationList = Schema.Struct({ automations: Schema.Array(Automation), time_zone: HostTimeZone })
export interface AutomationList extends Schema.Schema.Type<typeof AutomationList> {}

/** An automation's latest runs (newest first), and the latest delivery kept, to start a test delivery from. */
export const AutomationRuns = Schema.Struct({
  runs: Schema.Array(AutomationRun),
  latest_delivery: Schema.NullOr(Schema.Struct({ body: Schema.Unknown, event: Schema.NullOr(Schema.String) })),
})
export interface AutomationRuns extends Schema.Schema.Type<typeof AutomationRuns> {}
