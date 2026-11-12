import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Automation, AutomationList, AutomationPatch, AutomationRun, AutomationRuns, NewAutomation } from "../automation.ts"
import { Conflict, Invalid, NotFound } from "../errors.ts"
import { AutomationId, ProfileId, ProjectId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"

/**
 * A project's automations and a profile's routines (the old `/projects/{id}/automations`, `/profiles/{id}/automations`,
 * `/automations/{id}`, `…/run`, `…/runs`). Each change, and each run or delivery recorded, emits `automations_changed`.
 * One of `project_id` (its automations) or `profile_id` (its routines) names the owner.
 */
export class AutomationRpcs extends RpcGroup.make(
  Rpc.make("automations.list", {
    payload: { project_id: Schema.optionalKey(ProjectId), profile_id: Schema.optionalKey(ProfileId) },
    success: AutomationList,
    error: Schema.Union([NotFound, Invalid]),
  }).annotate(RequiredScope, "read"),
  Rpc.make("automations.get", { payload: { id: AutomationId }, success: Automation, error: NotFound }).annotate(RequiredScope, "read"),
  /** `Conflict` (`in_use`) for a routine whose profile's assistant runs on another host. */
  Rpc.make("automations.create", {
    payload: { project_id: Schema.optionalKey(ProjectId), profile_id: Schema.optionalKey(ProfileId), automation: NewAutomation },
    success: Automation,
    error: Schema.Union([NotFound, Invalid, Conflict]),
  }).annotate(RequiredScope, "settings"),
  Rpc.make("automations.update", {
    payload: { id: AutomationId, patch: AutomationPatch },
    success: Automation,
    error: Schema.Union([NotFound, Invalid]),
  }).annotate(RequiredScope, "settings"),
  /** Its runs go with it; the tasks it made stay. */
  Rpc.make("automations.delete", { payload: { id: AutomationId }, error: NotFound }).annotate(RequiredScope, "settings"),
  /**
   * Runs it now, on or off. A webhook's is a test delivery of `payload` (else the latest delivery's body, or `{}`) with
   * `event`, through its filters (not its signature check, deduplication or coalescing). The run once it's over.
   */
  Rpc.make("automations.run", {
    payload: { id: AutomationId, payload: Schema.optionalKey(Schema.Unknown), event: Schema.optionalKey(Schema.NullOr(Schema.String)) },
    success: AutomationRun,
    error: Schema.Union([NotFound, Invalid]),
  }).annotate(RequiredScope, "settings"),
  Rpc.make("automations.runs", { payload: { id: AutomationId }, success: AutomationRuns, error: NotFound }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
