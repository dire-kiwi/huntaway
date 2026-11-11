import { Effect, Stream } from "effect"
import { LinkRpcs, Session } from "@huntaway/contracts"
import { LinkConnections } from "../hosts/LinkConnections.ts"
import { Links } from "../hosts/Links.ts"

export const LinkHandlers = LinkRpcs.toLayer(
  Effect.gen(function* () {
    const links = yield* Links
    const connections = yield* LinkConnections
    return LinkRpcs.of({
      "link.hello": (theirs) => links.hello(theirs),
      "link.attach": (hello) => Stream.unwrap(Effect.map(Effect.service(Session), (session) => connections.attach(hello, session))),
      "link.upcalls": () => Stream.empty,
    })
  }),
)
