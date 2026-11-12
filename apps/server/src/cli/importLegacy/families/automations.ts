import { Effect, Result, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { Action, ActionInput, ActiveHours, ActiveHoursInput, Trigger, TriggerInput } from "@huntaway/contracts"
import type { Weekday } from "@huntaway/contracts"
import { AutomationRow, RunRow } from "../../../automations/AutomationRepo.ts"
import { DeliveryJson, sortedJson } from "../../../automations/delivery.ts"
import { storedAction, storedTrigger } from "../../../automations/stored.ts"
import { keyOf } from "../family.ts"
import type { Family, NewRow, TableCheck } from "../family.ts"
import { orDefault, orNull, readOld } from "./common.ts"

// Automations and their runs (docs/plan/11-migration.md, Table by table). Tokens and secrets are kept, so webhook URLs
// registered elsewhere still work. A trigger, an action and active hours are written as the new server reads them (the
// old reader's defaults filled in), so a stored `create_task`'s `task_type` of `plan`, `artifact` or `diagram` (from
// before labels) becomes that label. A rehearsal writes the automations without their credentials: a fresh random
// token (the column is NOT NULL, and nothing outside knows it) and no secret.

export const OldAutomation = Schema.Struct({
  id: Schema.String,
  profile_id: Schema.String,
  project_id: orNull(Schema.String),
  name: Schema.String,
  enabled: orDefault(Schema.Finite, 1),
  trigger: Schema.String,
  action: Schema.String,
  token: Schema.String,
  secret: orNull(Schema.String),
  next_run_at: orNull(Schema.String),
  last_run_at: orNull(Schema.String),
  active_hours: orNull(Schema.String),
  precheck: orNull(Schema.String),
  budget_usd: orNull(Schema.Finite),
  created_at: Schema.String,
  updated_at: Schema.String,
})
export type OldAutomation = typeof OldAutomation.Type

export const OldAutomationRun = Schema.Struct({
  id: Schema.String,
  automation_id: Schema.String,
  source: Schema.String,
  status: Schema.String,
  detail: orNull(Schema.String),
  task_id: orNull(Schema.String),
  agent_run_id: orNull(Schema.String),
  delivery_id: orNull(Schema.String),
  event: orNull(Schema.String),
  count: orDefault(Schema.Int, 1),
  batch_key: orNull(Schema.String),
  batch_id: orNull(Schema.String),
  payload: orNull(Schema.String),
  due_at: orNull(Schema.String),
  outcome: orNull(Schema.String),
  cost_usd: orNull(Schema.Finite),
  created_at: Schema.String,
  finished_at: orNull(Schema.String),
})

const decodeTrigger = Schema.decodeUnknownResult(Schema.fromJsonString(TriggerInput))
const decodeAction = Schema.decodeUnknownResult(Schema.fromJsonString(ActionInput))
const decodeHours = Schema.decodeUnknownResult(Schema.fromJsonString(ActiveHoursInput))
const isWeekday = Schema.is(Schema.Literals(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))

/** A stored trigger as the new server keeps it, or the text as it was when it does not read (the row then fails). */
export const convertTrigger = (text: string): string =>
  Result.match(decodeTrigger(text), { onFailure: () => text, onSuccess: (t) => sortedJson(storedTrigger(t)) })

/** A stored action as the new server keeps it: a `task_type` that is a label becomes the label. */
export const convertAction = (text: string): string =>
  Result.match(decodeAction(text), { onFailure: () => text, onSuccess: (a) => sortedJson(storedAction(a)) })

/**
 * Active hours as the new server keeps them: weekdays left out are none (every day), as the old reader had them, and in
 * lower case. Unreadable ones read as none in the old reader, so they are none here, with a note.
 */
export const convertActiveHours = (text: string | null): { readonly value: string | null; readonly unreadable: boolean } => {
  if (text === null || text === "") return { value: null, unreadable: false }
  return Result.match(decodeHours(text), {
    onFailure: () => ({ value: null, unreadable: true }),
    onSuccess: (h) => {
      const weekdays: ReadonlyArray<Weekday> = (h.weekdays ?? []).map((d) => d.toLowerCase()).filter(isWeekday)
      return { value: sortedJson({ start: h.start, end: h.end, weekdays }), unreadable: false }
    },
  })
}

/**
 * An automation as the new table has it. `freshToken`, in a rehearsal, replaces its token, and its secret is left out.
 */
export const convertAutomation = (a: OldAutomation, freshToken: string | null): NewRow => ({
  ...a,
  trigger: convertTrigger(a.trigger),
  action: convertAction(a.action),
  active_hours: convertActiveHours(a.active_hours).value,
  token: freshToken ?? a.token,
  secret: freshToken === null ? a.secret : null,
})

/** A token as the new server makes one: 32 random bytes in hex. */
const randomToken = Effect.sync(() => Array.from(SecureRandom.randomBytesUnsafe(32), (b) => b.toString(16).padStart(2, "0")).join(""))

const byId = keyOf("id")
const automationRows: TableCheck = { row: AutomationRow, json: { trigger: Trigger, action: Action, active_hours: ActiveHours }, key: byId }
const runRows: TableCheck = { row: RunRow, json: { payload: DeliveryJson }, key: byId }

export const automations: Family = {
  name: "automations",
  reads: ["automations", "automation_runs"],
  writes: ["automations", "automation_runs"],
  run: (io) =>
    Effect.gen(function* () {
      const rows: Array<NewRow> = []
      for (const a of yield* readOld(io, "automations", OldAutomation, byId)) {
        if (convertActiveHours(a.active_hours).unreadable)
          yield* io.report.note("automations", `${a.id}.active_hours`, "unreadable active hours, which the old board read as none: imported as none")
        rows.push(convertAutomation(a, io.ctx.rehearsal ? yield* randomToken : null))
      }
      const written = yield* io.write("automations", automationRows, rows)
      if (io.ctx.rehearsal) yield* io.report.withheld("automations", written)
      yield* io.write("automation_runs", runRows, yield* readOld(io, "automation_runs", OldAutomationRun, byId))
    }),
}
