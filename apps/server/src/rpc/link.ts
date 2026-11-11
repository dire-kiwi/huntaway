import { Effect, Stream } from "effect"
import { LinkRefused, LinkRpcs } from "@huntaway/contracts"
import { Links } from "../hosts/Links.ts"

export const LinkHandlers = LinkRpcs.toLayer(
  Effect.gen(function* () {
    const links = yield* Links
    return LinkRpcs.of({
      "link.hello": (theirs) => links.hello(theirs),
      "link.attach": () => Stream.fail(new LinkRefused({ reason: "this hub doesn't take hosts that dial in yet" })),
      "link.upcalls": () => Stream.empty,
    })
  }),
)
