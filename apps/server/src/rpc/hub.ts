import { Effect } from "effect"
import { HubHostRpcs, Session } from "@huntaway/contracts"
import { CopyConfig } from "../hosts/CopyConfig.ts"
import { Discovery } from "../hosts/Discovery.ts"
import { Links } from "../hosts/Links.ts"
import { Relay } from "../hosts/Relay.ts"
import { HostUpdates } from "../update/HostUpdates.ts"

export const HubHostHandlers = HubHostRpcs.toLayer(
  Effect.gen(function* () {
    const links = yield* Links
    const relay = yield* Relay
    const hostUpdates = yield* HostUpdates
    const discovery = yield* Discovery
    const copyConfig = yield* CopyConfig
    return HubHostRpcs.of({
      "hub.hosts.watch": () => links.watch,
      "hub.hosts.list": () => links.list,
      "hub.hosts.add": ({ url, token }) => links.add(url, token),
      "hub.hosts.addSsh": ({ target, ssh_port, remote_port }) => links.addSsh(target, ssh_port ?? 22, remote_port ?? 7879),
      "hub.hosts.sshKey": () => Effect.map(links.sshKey, (public_key) => ({ public_key })),
      "hub.hosts.join": ({ url }) => links.join(url),
      "hub.hosts.discover": () => discovery.discover,
      "hub.hosts.update": ({ id, name, uplink }) => links.update(id, { name, uplink }),
      "hub.hosts.remove": ({ id }) => links.remove(id),
      "hub.hosts.copyConfig": (input) => copyConfig.copy(input),
      "hub.hosts.pushUpdate": ({ id }) => hostUpdates.push(id),
      "hub.hosts.openRelay": ({ host_id, path }) =>
        Effect.gen(function* () {
          return { ticket: yield* relay.open(yield* Session, host_id, path ?? "/api/rpc") }
        }),
    })
  }),
)
