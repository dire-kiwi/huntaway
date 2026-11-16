import { Effect } from "effect"
import { TeleportRpcs } from "@huntaway/contracts"
import { Teleport } from "../spaces/Teleport.ts"

export const TeleportHandlers = TeleportRpcs.toLayer(
  Effect.gen(function* () {
    const teleport = yield* Teleport
    return TeleportRpcs.of({
      "teleport.sources": () => teleport.sources,
      "teleport.sites": ({ browser, profile }) => teleport.sites(browser, profile),
      "teleport.bring": (input) => teleport.bring(input),
      "teleport.imports": ({ id }) => teleport.imports(id),
      "teleport.remove": ({ import_id }) => teleport.remove(import_id),
    })
  }),
)
