import { Effect } from "effect"
import { AdminRpcs } from "@huntaway/contracts"
import { Releases } from "../update/Releases.ts"
import { Service } from "../update/Service.ts"
import { Updater } from "../update/Updater.ts"

export const AdminHandlers = AdminRpcs.toLayer(
  Effect.gen(function* () {
    const updater = yield* Updater
    const releases = yield* Releases
    const service = yield* Service
    return AdminRpcs.of({
      "admin.status": () => updater.status,
      "admin.restart": ({ rebuild }) => updater.restart(rebuild ?? false),
      "admin.update": (request) => updater.update(request),
      "admin.checkRelease": () => Effect.andThen(releases.check, updater.status),
      "admin.updateRelease": ({ version }) => releases.update(version),
      "admin.rollback": () => releases.rollback,
      "admin.installService": () => service.installAndSwitch,
    })
  }),
)
