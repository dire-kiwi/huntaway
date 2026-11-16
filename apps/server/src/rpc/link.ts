import { Effect, Stream } from "effect"
import { LinkRpcs, Session } from "@huntaway/contracts"
import { LinkConnections } from "../hosts/LinkConnections.ts"
import { Links } from "../hosts/Links.ts"
import { Relay } from "../hosts/Relay.ts"
import { Uplink } from "../hosts/Uplink.ts"

export const LinkHandlers = LinkRpcs.toLayer(
  Effect.gen(function* () {
    const links = yield* Links
    const connections = yield* LinkConnections
    const uplink = yield* Uplink
    const relay = yield* Relay
    return LinkRpcs.of({
      "link.hello": (theirs) => links.hello(theirs),
      "link.attach": (hello, { client }) => Stream.unwrap(Effect.map(Effect.service(Session), (session) => connections.attach(hello, session, client))),
      "link.upcalls": (hello) => Stream.unwrap(Effect.map(Effect.service(Session), (session) => uplink.offer(hello, session))),
      "link.ticket": ({ path, session }, { client }) => Effect.map(relay.forDialIn(client, path, session), (ticket) => ({ ticket })),
      "link.upcallResult": (result) => Effect.flatMap(Effect.service(Session), (session) => uplink.answer(session, result)),
    })
  }),
)
