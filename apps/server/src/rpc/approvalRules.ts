import { Effect } from "effect"
import { ApprovalRulesRpcs, NotFound } from "@huntaway/contracts"
import { ApprovalRules } from "../agents/ApprovalRules.ts"
import type { ProfileNotFound } from "../profiles/Profiles.ts"

const profileNotFound = (e: ProfileNotFound) => Effect.fail(new NotFound({ what: "profile", id: e.id }))

export const ApprovalRulesHandlers = ApprovalRulesRpcs.toLayer(
  Effect.gen(function* () {
    const rules = yield* ApprovalRules
    return ApprovalRulesRpcs.of({
      "approvalRules.get": ({ profile_id }) => rules.get(profile_id).pipe(Effect.catchTag("ProfileNotFound", profileNotFound)),
      "approvalRules.set": ({ profile_id, update }) => rules.set(profile_id, update).pipe(Effect.catchTag("ProfileNotFound", profileNotFound)),
      "approvalRules.log": ({ profile_id, limit }) => rules.log({ profile_id, limit }).pipe(Effect.catchTag("ProfileNotFound", profileNotFound)),
    })
  }),
)
