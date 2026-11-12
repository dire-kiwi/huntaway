import { Effect } from "effect"
import { NotFound, PenRpcs } from "@huntaway/contracts"
import { Actor } from "../platform/Changes.ts"
import type { ProfileNotFound } from "../profiles/Profiles.ts"
import { Pens } from "../tasks/Pens.ts"
import type { PenNotFound } from "../tasks/Pens.ts"

const profileNotFound = (e: ProfileNotFound) => Effect.fail(new NotFound({ what: "profile", id: e.id }))
const penNotFound = (e: PenNotFound) => Effect.fail(new NotFound({ what: "pen", id: e.id }))

export const PenHandlers = PenRpcs.toLayer(
  Effect.gen(function* () {
    const pens = yield* Pens
    return PenRpcs.of({
      "pens.list": ({ profile_id }) => pens.list(profile_id).pipe(Effect.catchTag("ProfileNotFound", profileNotFound)),
      "pens.create": ({ pen }) => pens.create(pen).pipe(Effect.catchTag("ProfileNotFound", profileNotFound)),
      "pens.update": ({ id, patch }) => pens.update(id, patch).pipe(Effect.catchTag("PenNotFound", penNotFound)),
      // Only a pen's own thread is refused (`Conflict`), and a session is never one.
      "pens.delete": ({ id }) => pens.delete(id, Actor.user).pipe(Effect.asVoid, Effect.catchTags({ PenNotFound: penNotFound, Conflict: Effect.die })),
      "pens.thread": ({ profile_id }) => pens.thread(profile_id).pipe(Effect.catchTag("ProfileNotFound", profileNotFound)),
      "pens.penThread": ({ id }) => pens.penThread(id).pipe(Effect.catchTag("PenNotFound", penNotFound)),
    })
  }),
)
