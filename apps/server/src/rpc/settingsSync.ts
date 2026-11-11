import { Effect, Option } from "effect"
import { SettingsSyncRpcs } from "@huntaway/contracts"
import { SettingsSync } from "../hosts/SettingsSync.ts"

export const SettingsSyncHandlers = SettingsSyncRpcs.toLayer(
  Effect.gen(function* () {
    const sync = yield* SettingsSync
    return SettingsSyncRpcs.of({
      "settingsSync.get": () => sync.status,
      "settingsSync.merge": ({ entries }) => Effect.map(sync.merge(entries), (merged) => ({ merged })),
      // No value (JSON has no undefined): the value that won stays.
      "settingsSync.resolve": ({ name, value }) => sync.resolve(name, value === undefined ? Option.none() : Option.some(value)),
    })
  }),
)
