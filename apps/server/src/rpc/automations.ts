import { Effect } from "effect"
import { AutomationRpcs, Invalid, NotFound } from "@huntaway/contracts"
import type { ProfileId, ProjectId } from "@huntaway/contracts"
import { Automations } from "../automations/Automations.ts"
import type { AutomationNotFound, Owner } from "../automations/Automations.ts"
import type { ProfileNotFound } from "../profiles/Profiles.ts"
import type { ProjectNotFound } from "../projects/Projects.ts"

const automationNotFound = (e: AutomationNotFound) => Effect.fail(new NotFound({ what: "automation", id: e.id }))
const projectNotFound = (e: ProjectNotFound) => Effect.fail(new NotFound({ what: "project", id: e.id }))
const profileNotFound = (e: ProfileNotFound) => Effect.fail(new NotFound({ what: "profile", id: e.id }))

/** The owner a request names: a project (its automations) or a profile (its routines). */
const ownerOf = (p: { readonly project_id?: ProjectId | undefined; readonly profile_id?: ProfileId | undefined }): Effect.Effect<Owner, Invalid> =>
  p.project_id !== undefined
    ? Effect.succeed({ _tag: "Project", id: p.project_id })
    : p.profile_id !== undefined
      ? Effect.succeed({ _tag: "Profile", id: p.profile_id })
      : Effect.fail(new Invalid({ field: "project_id", reason: "give project_id (a project's automations) or profile_id (a profile's routines)" }))

export const AutomationHandlers = AutomationRpcs.toLayer(
  Effect.gen(function* () {
    const automations = yield* Automations
    return AutomationRpcs.of({
      "automations.list": (p) =>
        Effect.flatMap(ownerOf(p), automations.list).pipe(Effect.catchTags({ ProjectNotFound: projectNotFound, ProfileNotFound: profileNotFound })),
      "automations.get": ({ id }) => automations.get(id).pipe(Effect.catchTag("AutomationNotFound", automationNotFound)),
      "automations.create": (p) =>
        Effect.flatMap(ownerOf(p), (owner) => automations.create(owner, p.automation)).pipe(
          Effect.flatMap(automations.wire),
          Effect.catchTags({ ProjectNotFound: projectNotFound, ProfileNotFound: profileNotFound }),
        ),
      "automations.update": ({ id, patch }) =>
        automations
          .update(id, patch)
          .pipe(Effect.flatMap(automations.wire), Effect.catchTags({ AutomationNotFound: automationNotFound, ProjectNotFound: projectNotFound })),
      "automations.delete": ({ id }) => automations.delete(id).pipe(Effect.asVoid, Effect.catchTag("AutomationNotFound", automationNotFound)),
      "automations.run": ({ id, payload, event }) => automations.runNow(id, { payload, event }).pipe(Effect.catchTag("AutomationNotFound", automationNotFound)),
      "automations.runs": ({ id }) => automations.runs(id).pipe(Effect.catchTag("AutomationNotFound", automationNotFound)),
    })
  }),
)
