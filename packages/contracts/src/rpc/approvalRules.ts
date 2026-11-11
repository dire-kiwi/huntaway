import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { ApprovalAction, ApprovalRulesUpdate, ApprovalRulesView } from "../approval.ts"
import { Invalid, NotFound } from "../errors.ts"
import { ProfileId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"

/**
 * A profile's approval rules and its action log (the old `/profiles/{id}/approval-rules` and `/approval-log`). Saving
 * emits `approval_rules`; the rules hold from a thread's next run on.
 */
export class ApprovalRulesRpcs extends RpcGroup.make(
  Rpc.make("approvalRules.get", { payload: { profile_id: ProfileId }, success: ApprovalRulesView, error: NotFound }).annotate(RequiredScope, "read"),
  /** A pattern given twice (in any case), a pattern with spaces, over 200 rules or an expiry over a week are `Invalid`. */
  Rpc.make("approvalRules.set", {
    payload: { profile_id: ProfileId, update: ApprovalRulesUpdate },
    success: ApprovalRulesView,
    error: Schema.Union([NotFound, Invalid]),
  }).annotate(RequiredScope, "settings"),
  /** The calls the profile's rules asked about or turned away, newest first: `limit` of them (200 unless given, at most 500). */
  Rpc.make("approvalRules.log", {
    payload: { profile_id: ProfileId, limit: Schema.optional(Schema.Int) },
    success: Schema.Array(ApprovalAction),
    error: NotFound,
  }).annotate(RequiredScope, "read"),
).middleware(Auth) {}
