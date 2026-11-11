import { Context, Effect, Layer } from "effect"
import { Invalid, Unavailable } from "@huntaway/contracts"
import type { Conflict, HostOffline, LinkId, UpdateResult } from "@huntaway/contracts"
import { LinkConnections } from "../hosts/LinkConnections.ts"
import { Identity } from "../platform/Identity.ts"
import { Updater } from "./Updater.ts"

// A hub's Update of a linked host (inventory 05 §2.2, §9 "Update"; the old `update_host`): the hub sends what it runs,
// as `Updater.bodyFor` makes it (an incremental bundle after the commit the host runs, else its commit, else its
// release version), to the host's `admin.update`, part of the stable core, so a host on another protocol takes it too.
// The host decides and refuses (wrong branch, dirty checkout, not a fast-forward, a commit not on its origin).

export class HostUpdates extends Context.Service<
  HostUpdates,
  {
    readonly push: (id: LinkId) => Effect.Effect<UpdateResult, Invalid | HostOffline | Conflict | Unavailable>
  }
>()("huntaway-server/update/HostUpdates") {
  static readonly layer = Layer.effect(
    HostUpdates,
    Effect.gen(function* () {
      const connections = yield* LinkConnections
      const updater = yield* Updater
      const identity = yield* Identity
      const push = Effect.fn("HostUpdates.push")(function* (id: LinkId) {
        if (String(id) === String(identity.hostId)) return yield* new Invalid({ field: "id", reason: "use Rebuild & restart for this host" })
        const live = yield* connections.live(id)
        const body = yield* updater.bodyFor(live.hello.commit)
        return yield* live.client("admin.update", body).pipe(
          Effect.catchTags({
            RpcClientError: () => Effect.fail(new Unavailable({ what: `host ${live.hello.name}`, reason: "the connection to it broke during the update" })),
            Unauthorized: () =>
              Effect.fail(new Unavailable({ what: `host ${live.hello.name}`, reason: "it didn't accept this hub's token for it; link it again" })),
            Forbidden: () => Effect.fail(new Unavailable({ what: `host ${live.hello.name}`, reason: "it didn't let this hub update it" })),
          }),
        )
      })
      return HostUpdates.of({ push })
    }),
  )
}
