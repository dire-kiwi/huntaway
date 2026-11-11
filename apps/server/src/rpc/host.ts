import { Effect } from "effect"
import { HostRpcGroup } from "@huntaway/contracts"
import { About } from "../settings/About.ts"

export const HostHandlers = HostRpcGroup.toLayer(
  Effect.gen(function* () {
    const about = yield* About
    return HostRpcGroup.of({
      "host.info": () => about.info,
      // Replaced by 1.1 (HostSettings and the folder browser).
      "host.settings": () => Effect.die("not yet"),
      "host.updateSettings": () => Effect.die("not yet"),
      "host.listDirs": () => Effect.die("not yet"),
    })
  }),
)
