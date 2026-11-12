import { Effect } from "effect"
import { AnalyticsRpcs } from "@huntaway/contracts"
import { Analytics } from "../analytics/Analytics.ts"
import { Disk } from "../analytics/Disk.ts"

export const AnalyticsHandlers = AnalyticsRpcs.toLayer(
  Effect.gen(function* () {
    const analytics = yield* Analytics
    const disk = yield* Disk
    return AnalyticsRpcs.of({
      "analytics.report": ({ profile_id, from, to }) => analytics.report(profile_id, from, to),
      "analytics.contextStats": ({ profile_id, from, to }) => analytics.contextStats(profile_id, from, to),
      "analytics.tokenStats": ({ profile_id, from, to }) => analytics.tokenStats(profile_id, from, to),
      "analytics.diskUsage": ({ profile_id }) => disk.report(profile_id),
    })
  }),
)
