import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import { HostClient } from "./HostClient.ts"
import { hubRuntime } from "./sessions.ts"

// Reads of the hub's own that are not in its directory (`hub.hosts.*`, docs/plan/05-protocol.md): queries the Hosts
// settings mount while they show them. Linking, renaming and forgetting are plain calls on the hub (`useRpc`), and the
// directory's next answer shows them.

/** The hub's SSH public key, for a host's `authorized_keys` (Add host, over SSH). */
export const hubSshKeyAtom = hubRuntime.atom(
  Effect.gen(function* () {
    const client = yield* HostClient
    return yield* client("hub.hosts.sshKey", undefined)
  }),
)

/** What a host needs to dial in to the hub, which the browser reaches at `url` (its `location.origin`). */
export const hubJoinAtom = Atom.family((url: string) =>
  hubRuntime.atom(
    Effect.gen(function* () {
      const client = yield* HostClient
      return yield* client("hub.hosts.join", { url })
    }),
  ),
)

/** Hosts found nearby (the LAN, Tailscale) or through linked hosts; refreshed to search again. */
export const nearbyHostsAtom = hubRuntime.atom(
  Effect.gen(function* () {
    const client = yield* HostClient
    return yield* client("hub.hosts.discover", undefined)
  }),
)
