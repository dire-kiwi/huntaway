import { Effect } from "effect"
import { HubHostRpcs, Session, Unavailable } from "@huntaway/contracts"
import { Links } from "../hosts/Links.ts"
import { Relay } from "../hosts/Relay.ts"

/** What comes with a later plan task: finding hosts and copying configs (7.5). */
const later = (what: string) => Effect.fail(new Unavailable({ what, reason: "not on this server yet" }))

export const HubHostHandlers = HubHostRpcs.toLayer(
  Effect.gen(function* () {
    const links = yield* Links
    const relay = yield* Relay
    return HubHostRpcs.of({
      "hub.hosts.watch": () => links.watch,
      "hub.hosts.list": () => links.list,
      "hub.hosts.add": ({ url, token }) => links.add(url, token),
      "hub.hosts.addSsh": ({ target, ssh_port, remote_port }) => links.addSsh(target, ssh_port ?? 22, remote_port ?? 7879),
      "hub.hosts.sshKey": () => Effect.map(links.sshKey, (public_key) => ({ public_key })),
      "hub.hosts.join": ({ url }) => links.join(url),
      "hub.hosts.discover": () => later("finding hosts"),
      "hub.hosts.update": ({ id, name, uplink }) => links.update(id, { name, uplink }),
      "hub.hosts.remove": ({ id }) => links.remove(id),
      "hub.hosts.copyConfig": () => later("copying a config between hosts"),
      "hub.hosts.openRelay": ({ host_id, path }) =>
        Effect.gen(function* () {
          return { ticket: yield* relay.open(yield* Session, host_id, path ?? "/api/rpc") }
        }),
    })
  }),
)
