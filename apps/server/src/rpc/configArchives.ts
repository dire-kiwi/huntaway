import { Effect } from "effect"
import { ConfigArchiveRpcs, NotFound, Unavailable } from "@huntaway/contracts"
import { ConfigArchives } from "../profiles/ConfigArchives.ts"
import type { AgentConfigNotFound } from "../profiles/AgentConfigs.ts"
import type { ArchiveUnavailable } from "../profiles/ConfigArchives.ts"

// 6.11: an agent config's login and settings, exported and imported.
const notFound = (e: AgentConfigNotFound) => Effect.fail(new NotFound({ what: "agent config", id: e.id }))
const unavailable = (e: ArchiveUnavailable) => Effect.fail(new Unavailable({ what: "tar", reason: e.reason }))

export const ConfigArchiveHandlers = ConfigArchiveRpcs.toLayer(
  Effect.gen(function* () {
    const archives = yield* ConfigArchives
    return ConfigArchiveRpcs.of({
      "configs.exportArchive": ({ id }) =>
        archives.exportArchive(id).pipe(Effect.catchTags({ AgentConfigNotFound: notFound, ArchiveUnavailable: unavailable })),
      "configs.importArchive": ({ id, archive, overwrite }) =>
        archives.importArchive(id, archive, overwrite ?? false).pipe(Effect.catchTags({ AgentConfigNotFound: notFound, ArchiveUnavailable: unavailable })),
    })
  }),
)
