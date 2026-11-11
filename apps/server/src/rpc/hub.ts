import { Effect } from "effect"
import { HubHostRpcs, Session, Unavailable } from "@huntaway/contracts"
import { CopyConfig } from "../hosts/CopyConfig.ts"
import { Discovery } from "../hosts/Discovery.ts"
import { Links } from "../hosts/Links.ts"
import { Relay } from "../hosts/Relay.ts"

/** What comes with a later plan task: SSH links (7.3). */
const later = (what: string) => Effect.fail(new Unavailable({ what, reason: "not on this server yet" }))

export const HubHostHandlers = HubHostRpcs.toLayer(
  Effect.gen(function* () {
    const links = yield* Links
    const relay = yield* Relay
    const discovery = yield* Discovery
    const copyConfig = yield* CopyConfig
    return HubHostRpcs.of({
      "hub.hosts.watch": () => links.watch,
      "hub.hosts.list": () => links.list,
      "hub.hosts.add": ({ url, token }) => links.add(url, token),
      "hub.hosts.addSsh": () => later("linking over SSH"),
      "hub.hosts.sshKey": () => later("the hub's SSH key"),
      "hub.hosts.join": ({ url }) => links.join(url),
      "hub.hosts.discover": () => discovery.discover,
      "hub.hosts.update": ({ id, name, uplink }) => links.update(id, { name, uplink }),
      "hub.hosts.remove": ({ id }) => links.remove(id),
      "hub.hosts.copyConfig": (input) => copyConfig.copy(input),
      "hub.hosts.openRelay": ({ host_id, path }) =>
        Effect.gen(function* () {
          return { ticket: yield* relay.open(yield* Session, host_id, path ?? "/api/rpc") }
        }),
    })
  }),
)
