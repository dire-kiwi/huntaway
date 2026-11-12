import { Effect } from "effect"
import { TelemetryRpcs } from "@huntaway/contracts"
import { Lag } from "../platform/Lag.ts"
import { Telemetry } from "../platform/Telemetry.ts"

export const TelemetryHandlers = TelemetryRpcs.toLayer(
  Effect.gen(function* () {
    const telemetry = yield* Telemetry
    const lag = yield* Lag
    return TelemetryRpcs.of({
      "admin.telemetry": () => telemetry.status,
      "admin.updateTelemetry": ({ patch }) => telemetry.update(patch),
      "admin.testTelemetry": ({ patch }) => telemetry.test(patch),
      "admin.eventLoop": ({ reset }) => Effect.tap(lag.report, () => (reset === true ? lag.reset : Effect.void)),
    })
  }),
)
