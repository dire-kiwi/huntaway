import { Effect } from "effect"
import { HostRpcGroup } from "@huntaway/contracts"
import { Usage } from "../profiles/Usage.ts"
import { About } from "../settings/About.ts"
import { Folders } from "../settings/Folders.ts"
import { HostSettings } from "../settings/HostSettings.ts"

export const HostHandlers = HostRpcGroup.toLayer(
  Effect.gen(function* () {
    const about = yield* About
    const settings = yield* HostSettings
    const folders = yield* Folders
    const usage = yield* Usage
    return HostRpcGroup.of({
      "host.info": () => about.info,
      "host.settings": () => settings.get,
      "host.updateSettings": ({ patch }) => settings.update(patch),
      "host.listDirs": ({ path }) => folders.list(path),
      "host.usage": ({ refresh }) => usage.list(refresh ?? false),
    })
  }),
)
