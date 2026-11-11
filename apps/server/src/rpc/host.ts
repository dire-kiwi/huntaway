import { Effect } from "effect"
import { HostRpcGroup } from "@huntaway/contracts"
import { About } from "../settings/About.ts"
import { Folders } from "../settings/Folders.ts"
import { HostSettings } from "../settings/HostSettings.ts"

export const HostHandlers = HostRpcGroup.toLayer(
  Effect.gen(function* () {
    const about = yield* About
    const settings = yield* HostSettings
    const folders = yield* Folders
    return HostRpcGroup.of({
      "host.info": () => about.info,
      "host.settings": () => settings.get,
      "host.updateSettings": ({ patch }) => settings.update(patch),
      "host.listDirs": ({ path }) => folders.list(path),
    })
  }),
)
