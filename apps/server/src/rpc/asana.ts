import { Effect } from "effect"
import { AsanaRpcs, External, NotFound, Unavailable } from "@huntaway/contracts"
import { Profiles } from "../profiles/Profiles.ts"

// 6.11: a profile's Asana search.
export const AsanaHandlers = AsanaRpcs.toLayer(
  Effect.gen(function* () {
    const profiles = yield* Profiles
    return AsanaRpcs.of({
      "profiles.asanaTasks": ({ profile_id, q }) =>
        profiles.asanaTasks(profile_id, q).pipe(
          Effect.catchTags({
            ProfileNotFound: (e) => Effect.fail(new NotFound({ what: "profile", id: e.id })),
            AsanaOff: (e) => Effect.fail(new Unavailable({ what: "asana", reason: e.reason })),
            AsanaFailed: (e) => Effect.fail(new External({ service: "Asana", reason: e.message })),
          }),
        ),
    })
  }),
)
