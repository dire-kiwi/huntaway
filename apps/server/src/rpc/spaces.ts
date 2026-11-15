import { Effect } from "effect"
import { SpacesRpcs } from "@huntaway/contracts"
import { Spaces } from "../spaces/Spaces.ts"

export const SpacesHandlers = SpacesRpcs.toLayer(
  Effect.gen(function* () {
    const spaces = yield* Spaces
    return SpacesRpcs.of({
      "spaces.status": () => spaces.status,
      "spaces.create": (input) => spaces.create(input),
      "spaces.start": ({ id }) => spaces.start(id),
      "spaces.stop": ({ id }) => spaces.stop(id),
      "spaces.delete": ({ id }) => spaces.remove(id),
      "spaces.syncAgents": ({ id }) => spaces.syncAgents(id),
      "spaces.view": ({ id, interactive }) => spaces.view(id, interactive ?? true),
    })
  }),
)
