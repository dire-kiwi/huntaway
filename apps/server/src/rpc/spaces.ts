import { Effect } from "effect"
import { SpacesRpcs } from "@huntaway/contracts"
import { SignIns } from "../spaces/SignIns.ts"
import { Spaces } from "../spaces/Spaces.ts"

export const SpacesHandlers = SpacesRpcs.toLayer(
  Effect.gen(function* () {
    const spaces = yield* Spaces
    const signIns = yield* SignIns
    return SpacesRpcs.of({
      "spaces.status": () => spaces.status,
      "spaces.create": (input) => spaces.create(input),
      "spaces.start": ({ id }) => spaces.start(id),
      "spaces.stop": ({ id }) => spaces.stop(id),
      "spaces.delete": ({ id }) => spaces.remove(id),
      "spaces.syncAgents": ({ id }) => spaces.syncAgents(id),
      "spaces.setAgentTools": ({ enabled }) => spaces.setAgentTools(enabled),
      "spaces.view": ({ id, interactive }) => spaces.view(id, interactive ?? true),
      "signIns.list": ({ profile_id }) => signIns.list(profile_id),
      "signIns.create": (input) => signIns.create(input),
      "signIns.update": (input) => signIns.update(input),
      "signIns.delete": ({ id }) => signIns.remove(id),
      // The board's own sign-ins use a driver session of their own, not an agent's.
      "spaces.signIn": ({ id, sign_in_id }) => signIns.signIn(id, "board", sign_in_id, {}),
    })
  }),
)
