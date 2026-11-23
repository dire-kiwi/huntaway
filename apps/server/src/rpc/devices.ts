import { Effect } from "effect"
import { DeviceRpcs, Invalid, Session } from "@huntaway/contracts"
import { Devices } from "../hosts/Devices.ts"

/** The board's paired devices (HE-91). */
export const DeviceHandlers = DeviceRpcs.toLayer(
  Effect.gen(function* () {
    const devices = yield* Devices
    return DeviceRpcs.of({
      "hub.devices.list": () => Effect.flatMap(Session, (s) => devices.list(s.device_id)),
      "hub.devices.startPairing": () => devices.startPairing,
      "hub.devices.stopPairing": () => devices.stopPairing,
      "hub.devices.rename": ({ id, name }) => devices.rename(id, name),
      "hub.devices.revoke": ({ id }) => devices.revoke(id),
      "hub.devices.unpair": () =>
        Effect.gen(function* () {
          const s = yield* Session
          if (s.kind !== "device" || s.device_id === null || s.via_link !== null)
            return yield* new Invalid({ field: "session", reason: "only a device paired with this board unpairs itself" })
          return yield* devices.revoke(s.device_id)
        }),
    })
  }),
)
