import { Effect } from "effect"
import { External, NotFound, PushRpcs } from "@huntaway/contracts"
import { Push } from "../push/Push.ts"

const notFound = (e: { readonly id: string }) => Effect.fail(new NotFound({ what: "subscription", id: e.id }))

export const PushHandlers = PushRpcs.toLayer(
  Effect.gen(function* () {
    const push = yield* Push
    return PushRpcs.of({
      "hub.push.info": () => push.info,
      "hub.push.subscribe": (input) => push.subscribe(input),
      "hub.push.update": ({ id, name, events }) => push.update(id, { name, events }).pipe(Effect.catchTag("SubscriptionNotFound", notFound)),
      "hub.push.unsubscribe": ({ id }) => push.unsubscribe(id).pipe(Effect.catchTag("SubscriptionNotFound", notFound)),
      "hub.push.test": ({ id }) =>
        push
          .test(id)
          .pipe(Effect.catchTags({ SubscriptionNotFound: notFound, PushFailed: (e) => Effect.fail(new External({ service: "push", reason: e.reason })) })),
    })
  }),
)
